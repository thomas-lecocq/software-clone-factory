/**
 * The verifier: the only code path that scores the clone. It refuses to run on an evaluator that
 * differs from the lock, or whose lock differs from the committed one, replays every fixture
 * against a freshly reset clone, and writes the verdict, the reports, the coverage table, the
 * generated gap list, the builder's compact failure file and one line per run in the run log.
 * Per-case holdout results go only to `holdout-*` files, never copied into a builder sandbox.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadAdapter, type TargetAdapter } from "./adapter.ts";
import { checkLock, loadFixtures, sha256, targetDir, type Split } from "./fixtures.ts";
import type { Json } from "./json.ts";
import { batchOf, breakerLogs, fidelityReport, holdoutLooks, type Tally } from "./fidelity.ts";
import { loadLedger, ruleStatuses, type RuleResult } from "./ledger.ts";
import { logTiming, secondsSince } from "./timings.ts";
import {
  blocking,
  diff,
  PolicySchema,
  type FieldDiff,
  type Policy,
  type PolicyField,
} from "./policy.ts";

export interface CaseResult {
  id: string;
  split: Split;
  rules: string[];
  pass: boolean;
  crashed: boolean;
  diffs: FieldDiff[];
  // Perceptual differences: reported, never counted against the case.
  reported: FieldDiff[];
}

const PreviousVerdict = z.object({
  cases: z.array(z.object({ id: z.string(), pass: z.boolean() })),
});

const withNoise = (policy: Policy, noise: string[]): Policy => ({
  ...policy,
  fields: [
    ...policy.fields,
    ...noise.map((path) => ({ path, mode: "ignore" as const, why: "recorded noise" })),
  ],
});

const show = (v: Json | undefined): string => (v === undefined ? "absent" : JSON.stringify(v));

export async function verify(target: string, splits: Split[], port = 4599): Promise<number> {
  const started = performance.now();
  const dir = targetDir(target);
  const problems = [...checkLock(target), ...committedLockProblems(target)];
  if (problems.length > 0) {
    console.error(
      `evaluator integrity check failed, refusing to score:\n  ${problems.join("\n  ")}`,
    );
    return 2;
  }
  const policy = PolicySchema.parse(JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")));
  const rules = loadLedger(target);
  const fixtures = loadFixtures(target, splits);
  const adapter = await loadAdapter(target);
  // Rule tags are specification, not recorded output: take them from the current probe set so a
  // rule found later can claim the fixtures that already exhibit it.
  const tags = new Map(adapter.probes().map((p) => [p.id, p.rules]));
  const clone = await adapter.startClone(port);

  const cases: CaseResult[] = [];
  let determinism: { identical: number; total: number };
  try {
    for (const f of fixtures) {
      const reset = await fetch(`${clone.url}/__reset`, { method: "POST" });
      if (!reset.ok)
        throw new Error(`clone reset failed with HTTP ${reset.status}; refusing to score`);
      let actual: Record<string, Json>;
      let crashed = false;
      try {
        actual = await adapter.run(
          { id: f.id, rules: f.rules, input: f.input },
          { kind: "clone", url: clone.url },
        );
      } catch (e) {
        crashed = true;
        actual = { error: String(e) };
      }
      const all = diff(withNoise(policy, f.noise), f.observed, actual);
      const diffs = blocking(all);
      const reported = all.filter((d) => d.report);
      const rules = tags.get(f.id) ?? f.rules;
      const pass = diffs.length === 0;
      cases.push({ id: f.id, split: f.split, rules, pass, crashed, diffs, reported });
    }
    determinism = await replayTwice(
      adapter,
      clone.url,
      sample(fixtures.filter((f) => f.split === "dev")),
    );
  } finally {
    await clone.close();
  }

  const out = join(dir, "verify");
  mkdirSync(out, { recursive: true });
  logRegressions(
    dir,
    out,
    cases.filter((c) => c.split === "dev"),
  );
  const dev = cases.filter((c) => c.split === "dev");
  const held = cases.filter((c) => c.split === "holdout");
  // Files an implementer may read carry dev details and holdout totals only. Per-case holdout
  // results go to files whose name contains "holdout", which the guard hides from subagents.
  const devVerdict = {
    splits,
    cases: dev,
    holdout: { pass: held.filter((c) => c.pass).length, total: held.length },
    rules: ruleStatuses(rules, dev).map((s) => ({
      id: s.rule.id,
      status: s.status,
      pass: s.pass,
      total: s.total,
    })),
  };
  writeFileSync(join(out, "verdict.json"), `${JSON.stringify(devVerdict, null, 2)}\n`);
  writeFileSync(join(out, "failures.json"), `${JSON.stringify(builderFailures(cases), null, 2)}\n`);
  writeFileSync(
    join(out, "report.md"),
    report(target, splits, dev, held, ruleStatuses(rules, dev), policy, fixtures, "dev"),
  );
  const statuses = ruleStatuses(rules, cases);
  if (held.length > 0) {
    const heldVerdict = {
      cases: held.map((c) => ({
        id: c.id,
        rules: c.rules,
        pass: c.pass,
        crashed: c.crashed,
        diff_count: c.diffs.length,
      })),
      rules: statuses.map((s) => ({
        id: s.rule.id,
        status: s.status,
        pass: s.pass,
        total: s.total,
      })),
    };
    writeFileSync(join(out, "holdout-verdict.json"), `${JSON.stringify(heldVerdict, null, 2)}\n`);
    writeFileSync(
      join(out, "holdout-report.md"),
      report(target, splits, dev, held, statuses, policy, fixtures, "all"),
    );
  }
  writeFileSync(join(dir, "GAPS.generated.md"), gaps(ruleStatuses(rules, dev), policy));
  writeFileSync(
    join(out, "coverage.md"),
    coverage(
      rules.map((r) => r.id),
      dev,
      held,
    ),
  );
  const run = {
    at: new Date().toISOString(),
    splits,
    dev: { pass: dev.filter((c) => c.pass).length, total: dev.length },
    holdout: { pass: held.filter((c) => c.pass).length, total: held.length },
    crashed: cases.filter((c) => c.crashed).length,
    lock: sha256(readFileSync(join(dir, "fixtures.lock"), "utf8")).slice(0, 12),
    git: inGit(),
    ...gitState(),
    sandbox: process.env.RH_SANDBOX === "1",
  };
  appendFileSync(join(out, "runs.jsonl"), `${JSON.stringify(run)}\n`);
  const tally = (cs: CaseResult[]): Tally => ({
    pass: cs.filter((c) => c.pass).length,
    total: cs.length,
  });
  const gapsFile = join(dir, "GAPS.md");
  writeFileSync(
    join(out, "fidelity-report.md"),
    fidelityReport({
      target,
      at: run.at,
      dev: tally(dev),
      batches: Object.fromEntries(
        [...new Set(held.filter((c) => c.id.startsWith("hold-")).map((c) => batchOf(c.id)))].map(
          (b) => [b, tally(held.filter((c) => c.id.startsWith("hold-") && batchOf(c.id) === b))],
        ),
      ),
      hashHoldout: tally(held.filter((c) => !c.id.startsWith("hold-"))),
      pixelsReported: cases
        .filter((c) => c.split === "dev")
        .reduce((n, c) => n + c.reported.length, 0),
      statuses: ruleStatuses(rules, dev),
      holdoutRules: new Set(held.flatMap((c) => c.rules)),
      determinism,
      integrity: {
        lockIntact: true,
        lockHash: run.lock,
        commit: run.commit,
        dirty: run.dirty,
        sandbox: run.sandbox,
        holdoutLooks: holdoutLooks(join(out, "runs.jsonl"), run.lock),
      },
      gaps: existsSync(gapsFile) ? readFileSync(gapsFile, "utf8") : null,
      breakerLogs: breakerLogs(dir),
      policySincePlan: policySincePlan(target),
    }),
  );

  logTiming(target, "verify", {
    splits,
    cases: cases.length,
    seconds: secondsSince(started),
    sandbox: run.sandbox,
  });
  const failed = cases.filter((c) => !c.pass).length;
  console.log(`${cases.length - failed} of ${cases.length} fixtures pass (${splits.join(" + ")})`);
  return failed === 0 ? 0 : 1;
}

// Ten dev fixtures spread over the sorted list, so that every kind of probe tends to be sampled.
function sample<T extends { id: string }>(xs: T[], n = 10): T[] {
  const sorted = [...xs].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.length <= n) return sorted;
  return Array.from({ length: n }, (_, i) => sorted[Math.floor((i * sorted.length) / n)]).filter(
    (x): x is T => x !== undefined,
  );
}

// Determinism: the same probe, each time after a reset, must give the same output.
async function replayTwice(
  adapter: TargetAdapter,
  url: string,
  fixtures: { id: string; rules: string[]; input: Json }[],
): Promise<{ identical: number; total: number }> {
  const exact: Policy = { canonicalIds: true, fields: [] };
  let identical = 0;
  for (const f of fixtures) {
    const runs: Record<string, Json>[] = [];
    for (let i = 0; i < 2; i += 1) {
      await fetch(`${url}/__reset`, { method: "POST" });
      runs.push(
        await adapter.run(f, { kind: "clone", url }).catch((e: unknown) => ({ error: String(e) })),
      );
    }
    const [a, b] = runs;
    if (a && b && !("error" in a) && diff(exact, a, b).length === 0) identical += 1;
  }
  return { identical, total: fixtures.length };
}

// A lock rewritten locally proves nothing: in a git checkout the lock must equal the committed
// one. Outside git (a builder sandbox) the check is skipped and the run log records it.
export function committedLockProblems(target: string): string[] {
  let committed: string;
  try {
    committed = execFileSync("git", ["show", `HEAD:targets/${target}/fixtures.lock`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // Fail closed: only a builder sandbox, which has no git history by design, may skip this.
    return process.env.RH_SANDBOX === "1"
      ? []
      : ["cannot read the committed lock (not a git checkout, or not committed); refusing"];
  }
  const local = readFileSync(join(targetDir(target), "fixtures.lock"), "utf8");
  return committed === local ? [] : ["fixtures.lock differs from the committed lock"];
}

// Outputs of verify itself never make a tree dirty. The `:(exclude,glob)` form is required: the
// short `:!targets/*/verify` excluded nothing, and every run was logged as dirty.
function gitState(): { commit: string | null; dirty: boolean | null } {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const status = execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--",
        "harness",
        "targets",
        ":(exclude,glob)targets/*/verify/**",
        ":(exclude,glob)targets/*/GAPS.generated.md",
        ":(exclude,glob)targets/*/failures.jsonl",
        ":(exclude,glob)targets/*/timings.jsonl",
      ],
      {
        encoding: "utf8",
      },
    );
    return { commit, dirty: status.trim() !== "" };
  } catch {
    return { commit: null, dirty: null };
  }
}

function policySincePlan(target: string): string[] | null {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const plan = git(
      "log",
      "--diff-filter=A",
      "--format=%H",
      "--",
      `targets/${target}/analysis-plan.md`,
    );
    if (plan === "") return null;
    const changes = git(
      "log",
      "--format=%h %s",
      `${plan}..HEAD`,
      "--",
      `targets/${target}/policy.json`,
    );
    const dirty = git("status", "--porcelain", "--", `targets/${target}/policy.json`) !== "";
    return [
      ...(changes === "" ? [] : changes.split("\n")),
      ...(dirty ? ["uncommitted changes"] : []),
    ];
  } catch {
    return null;
  }
}

function inGit(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Rule 5 of docs/verification.md, light version: a case that passed last run and fails now is recorded
// with its root cause left for a session that did not write the change.
function logRegressions(dir: string, out: string, cases: CaseResult[]): void {
  const prevPath = join(out, "verdict.json");
  if (!existsSync(prevPath)) return;
  const prev = PreviousVerdict.safeParse(JSON.parse(readFileSync(prevPath, "utf8")));
  if (!prev.success) return;
  const passedBefore = new Set(prev.data.cases.filter((c) => c.pass).map((c) => c.id));
  for (const c of cases.filter((x) => !x.pass && passedBefore.has(x.id))) {
    const entry = {
      at: new Date().toISOString(),
      what: "regression",
      fixture_broken: c.id,
      rules: c.rules,
      root_cause: null,
      retry_if: null,
    };
    appendFileSync(join(dir, "failures.jsonl"), `${JSON.stringify(entry)}\n`);
  }
}

function builderFailures(
  cases: CaseResult[],
): Record<string, { fixture: string; diffs: FieldDiff[] }[]> {
  const byRule: Record<string, { fixture: string; diffs: FieldDiff[] }[]> = {};
  for (const c of cases.filter((x) => !x.pass && x.split === "dev")) {
    for (const r of c.rules) (byRule[r] ??= []).push({ fixture: c.id, diffs: c.diffs.slice(0, 5) });
  }
  return byRule;
}

function report(
  target: string,
  splits: Split[],
  dev: CaseResult[],
  held: CaseResult[],
  statuses: RuleResult[],
  policy: Policy,
  fixtures: { id: string; noise: string[] }[],
  scope: "dev" | "all",
): string {
  const cases = scope === "dev" ? dev : [...dev, ...held];
  const count = (s: Split): string => {
    const mine = cases.filter((c) => c.split === s);
    return `${mine.filter((c) => c.pass).length} of ${mine.length}`;
  };
  const lines = [
    `# Verification report: ${target}`,
    "",
    "Generated by `npm run verify`. Do not edit.",
    "",
    `- Evaluator lock: intact`,
    `- Fixtures passing: ${[...dev, ...held].filter((c) => c.pass).length} of ${dev.length + held.length}`,
    ...splits.map(
      (s) =>
        `  - ${s}: ${s === "holdout" ? `${held.filter((c) => c.pass).length} of ${held.length}` : count(s)}`,
    ),
    `- Crashed runs (adapter or clone threw): ${[...dev, ...held].filter((c) => c.crashed).length}`,
    scope === "dev"
      ? "- Rules and cases below: dev split only. Holdout detail: `holdout-report.md`."
      : "",
    "",
    "## Rules",
    "",
    "| Rule | Area | Provenance | Status | Fixtures passing |",
    "|---|---|---|---|---|",
    ...statuses.map(
      (s) =>
        `| ${s.rule.id} | ${s.rule.area} | ${s.rule.provenance.kind} | ${s.status} | ${s.pass} of ${s.total} |`,
    ),
    "",
    "## Cases",
    "",
    ...cases.map((c) => {
      const head = `- ${c.pass ? "PASS" : "FAIL"} \`${c.id}\` (${c.split}; ${c.rules.join(", ")})`;
      if (c.pass || c.split === "holdout")
        return c.pass ? head : `${head}: ${c.diffs.length} field(s) differ`;
      const d = c.diffs
        .slice(0, 3)
        .map((x) => `\n  - \`${x.path}\`: expected ${show(x.expected)}, got ${show(x.actual)}`);
      return head + d.join("");
    }),
    "",
    "## Pixels (reported, never scored)",
    "",
    ...pixelLines(cases.filter((c) => c.split === "dev")),
    "",
    "## Declared blind spots",
    "",
    ...policy.fields.map(fieldLine),
    ...fixtures
      .filter((f) => f.noise.length > 0)
      .map((f) => `- \`${f.id}\`: recorded noise on ${f.noise.join(", ")}`),
    "",
  ];
  return lines.join("\n");
}

function fieldLine(f: PolicyField): string {
  const how =
    f.mode === "tolerance"
      ? `tolerance ${f.by}`
      : f.mode === "perceptual"
        ? `perceptual, reported above ${f.max_share * 100} % of cells, never scored`
        : f.mode === "mask"
          ? `mask /${f.pattern}/`
          : f.mode;
  return `- \`${f.path}\` (${how}): ${f.why}`;
}

function pixelLines(cases: CaseResult[]): string[] {
  const rows = cases.flatMap((c) =>
    c.reported.map(
      (d) =>
        `- \`${c.id}\` \`${d.path}\`: ${((d.report?.share ?? 1) * 100).toFixed(1)} % of cells differ`,
    ),
  );
  return rows.length > 0 ? rows : ["No perceptual difference above threshold."];
}

function gaps(statuses: RuleResult[], policy: Policy): string {
  const open = statuses.filter((s) => s.status !== "verified");
  return [
    "# Gaps (generated)",
    "",
    "Generated by `npm run verify` from the rule ledger and the verdict. The hand-written",
    "account of divergences is `GAPS.md`.",
    "",
    ...(open.length === 0 ? ["All rules have passing fixtures."] : []),
    ...open.map((s) =>
      s.status === "unverified"
        ? `- ${s.rule.id}: not covered by a fixture; behaviour inferred from ${s.rule.provenance.ref}; unverified.`
        : `- ${s.rule.id}: failing, ${s.pass} of ${s.total} fixtures pass. ${s.rule.statement}`,
    ),
    "",
    "Fields not compared exactly:",
    "",
    ...policy.fields.map(fieldLine),
    "",
  ].join("\n");
}

// Per rule: how many fixtures pin it in each split. A rule with no holdout fixture has only
// training evidence; a rule with no fixture at all is unverified.
function coverage(ids: string[], dev: CaseResult[], held: CaseResult[]): string {
  const n = (cs: CaseResult[], id: string): number => cs.filter((c) => c.rules.includes(id)).length;
  return [
    "# Coverage (generated)",
    "",
    "Fixtures per rule and split, from `npm run verify`. Counts only.",
    "",
    "| Rule | Dev fixtures | Holdout fixtures | Evidence |",
    "| --- | --- | --- | --- |",
    ...ids.map((id) => {
      const d = n(dev, id);
      const h = n(held, id);
      const evidence = d + h === 0 ? "none" : h === 0 ? "dev only" : "dev and holdout";
      return `| ${id} | ${d} | ${h} | ${evidence} |`;
    }),
    "",
  ].join("\n");
}
