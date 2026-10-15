/**
 * The reliability card: the fidelity report's headline, on one screen, with badges. Its level is
 * computed from a pre-registered holdout batch only (A: below 1 % at 99 %, B: below 1 % at 95 %,
 * C: measured, with its bound), and every figure comes from a run or a measurement file, so the
 * card can be read at a glance without saying more than the report.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { upperBound, type BatchPlan, type Tally } from "./fidelity.ts";

export interface CardInput {
  target: string;
  at: string;
  batches: Record<string, Tally>;
  plans: Record<string, BatchPlan>;
  looks: Record<string, number>;
  dev: Tally;
  // Dev cases a breaker chose to make the clone fail (`dev-brk-` probes). Once the builder has
  // learnt them they say nothing about generalisation; only a new round tests the clone again.
  adversarial: Tally;
  // The latest breaker round when it was proposed against the clone being scored: the one figure
  // on the card from outside the measured distribution.
  unseenRound: { file: string; tally: Tally } | null;
  determinism: { identical: number; total: number };
  lockHash: string;
  commit: string | null;
  dirty: boolean | null;
  mutation: { killed: number; valid: number; at: string } | null;
  auditors: { found: number; planted: number } | null;
  tasks: TaskFacts | null;
}

export interface TaskFacts {
  at: string;
  model: string;
  pairs: number;
  sameOutcome: number;
  successClone: number;
  successTarget: number;
}

const TaskSummary = z.object({
  at: z.string(),
  model: z.string(),
  pairs: z.number(),
  same_outcome: z.number(),
  success_clone: z.number(),
  success_target: z.number(),
});

// The latest task-validation run for the target (`harness/src/tasks.ts`), if any.
export function taskFacts(targetDirectory: string): TaskFacts | null {
  const dir = join(targetDirectory, "tasks");
  if (!existsSync(dir)) return null;
  const latest = readdirSync(dir)
    .filter((f) => f.startsWith("results-") && f.endsWith(".json"))
    .sort()
    .at(-1);
  if (latest === undefined) return null;
  const r = TaskSummary.safeParse(JSON.parse(readFileSync(join(dir, latest), "utf8")));
  if (!r.success) return null;
  return {
    at: r.data.at,
    model: r.data.model,
    pairs: r.data.pairs,
    sameOutcome: r.data.same_outcome,
    successClone: r.data.success_clone,
    successTarget: r.data.success_target,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(2)} %`;

// shields.io static badge: dashes and underscores are doubled, the rest URL-encoded.
function badge(label: string, message: string, color: string): string {
  const enc = (s: string): string => encodeURIComponent(s.replace(/-/g, "--").replace(/_/g, "__"));
  return `![${label}: ${message}](https://img.shields.io/badge/${enc(label)}-${enc(message)}-${color}?style=flat-square)`;
}

export function level(t: Tally): { name: string; claim: string; color: string } {
  const k = t.total - t.pass;
  if (t.total > 0 && upperBound(k, t.total, 0.01) < 0.01)
    return { name: "A", claim: "below 1 % of cases diverge, at 99 % confidence", color: "2ea44f" };
  if (t.total > 0 && upperBound(k, t.total) < 0.01)
    return { name: "B", claim: "below 1 % of cases diverge, at 95 % confidence", color: "97ca00" };
  return {
    name: "C",
    claim: `measured: below ${pct(upperBound(k, t.total))} at 95 % confidence`,
    color: "dfb317",
  };
}

// A staged batch's stages (`hold-b4-s1`, `hold-b4-s2`…) are read together as one batch.
const baseOf = (prefix: string): string => prefix.replace(/-s\d+$/, "");

// The batch a card speaks about: the latest one with a plan, its stages summed. A staged batch
// stopped early has fewer stages scored than planned: the rest are still fresh.
function latestBatch(c: CardInput): {
  name: string;
  tally: Tally;
  plan: BatchPlan;
  looks: number;
  staged: { scored: number; planned: number } | null;
} | null {
  const scoredKeys = Object.keys(c.batches).filter((b) => c.plans[b] !== undefined);
  const base = [...new Set(scoredKeys.map(baseOf))].sort((x, y) => x.localeCompare(y)).at(-1);
  if (base === undefined) return null;
  const mine = scoredKeys.filter((k) => baseOf(k) === base);
  const planned = Object.keys(c.plans).filter((k) => baseOf(k) === base && k !== base);
  const tally = mine.reduce<Tally>(
    (t, k) => ({
      pass: t.pass + (c.batches[k]?.pass ?? 0),
      total: t.total + (c.batches[k]?.total ?? 0),
    }),
    { pass: 0, total: 0 },
  );
  const plan = c.plans[mine[0] ?? ""];
  if (plan === undefined) return null;
  const looks = Math.max(...mine.map((k) => c.looks[k] ?? 1));
  const staged = planned.length > 1 ? { scored: mine.length, planned: planned.length } : null;
  return { name: base, tally, plan, looks, staged };
}

export function reliabilityCard(c: CardInput): string {
  const latest = latestBatch(c);
  const t = latest?.tally;
  const plan = latest?.plan;
  const batch = latest?.name ?? null;
  const looks = latest?.looks ?? 0;
  const staged = latest?.staged ?? null;
  const rated = t !== undefined && plan !== undefined && plan.preRegistered !== "no";
  const lvl = rated ? level(t) : null;
  const k = t === undefined ? 0 : t.total - t.pass;
  const badges = [
    lvl
      ? badge("reliability", `level ${lvl.name}`, lvl.color)
      : badge("reliability", "unrated", "lightgrey"),
    t
      ? badge("holdout", `${String(t.pass)}/${String(t.total)}`, k === 0 ? "2ea44f" : "dfb317")
      : "",
    c.unseenRound
      ? badge(
          "breaker, unseen",
          `${String(c.unseenRound.tally.pass)}/${String(c.unseenRound.tally.total)}`,
          shareColor(c.unseenRound.tally),
        )
      : badge(
          "breaker probes",
          `${String(c.adversarial.pass)}/${String(c.adversarial.total)}`,
          "blue",
        ),
    c.mutation
      ? badge("mutants caught", `${String(c.mutation.killed)}/${String(c.mutation.valid)}`, "blue")
      : "",
    c.auditors
      ? badge("auditor recall", `${String(c.auditors.found)}/${String(c.auditors.planted)}`, "blue")
      : "",
  ].filter((b) => b !== "");
  const row = (k: string, v: string): string => `| **${k}** | ${v} |`;
  return [
    `# Reliability card: ${c.target}`,
    "",
    "Generated by `npm run verify` on " + c.at + ". Details: `fidelity-report.md`.",
    "",
    badges.join(" "),
    "",
    "| | |",
    "| --- | --- |",
    row("Level", lvl ? `**${lvl.name}**: ${lvl.claim}` : "unrated: no pre-registered batch"),
    row(
      "Measured on",
      t && batch && plan
        ? `batch \`${batch}-\`, ${String(t.pass)} of ${String(t.total)}; plan \`${plan.file}\`${plan.preRegistered === "yes" ? ", committed first" : ""}; ${looks <= 1 ? "first and only look" : `${String(looks)} looks, its claim rests on the first (\`measurements.md\`)`}${staged && staged.scored < staged.planned ? `; stopped after stage ${String(staged.scored)} of ${String(staged.planned)}, the other ${String(staged.planned - staged.scored)} still fresh` : ""}`
        : "none",
    ),
    row(
      "Bound",
      t
        ? `${pct(upperBound(k, t.total))} at 95 %, ${pct(upperBound(k, t.total, 0.01))} at 99 %`
        : "none",
    ),
    row(
      "Breaker probes",
      c.unseenRound
        ? `\`${c.unseenRound.file}\`, proposed against this clone: ${String(c.unseenRound.tally.pass)} of ${String(c.unseenRound.tally.total)} pass, outside the measured distribution; earlier rounds: ${String(c.adversarial.pass)} of ${String(c.adversarial.total)}, dev cases the builder may have learnt`
        : c.adversarial.total === 0
          ? "no breaker round yet"
          : `${String(c.adversarial.pass)} of ${String(c.adversarial.total)} pass; they are dev cases the builder may have learnt, so only a new breaker round tests the clone out of distribution`,
    ),
    row("Dev (training)", `${String(c.dev.pass)} of ${String(c.dev.total)}`),
    row(
      "Determinism",
      `${String(c.determinism.identical)} of ${String(c.determinism.total)} replays identical after reset`,
    ),
    row(
      "Mutation testing",
      c.mutation
        ? `${String(c.mutation.killed)} of ${String(c.mutation.valid)} planted bugs caught by the fixtures (run ${c.mutation.at.slice(0, 10)})`
        : "not run",
    ),
    row(
      "Auditors",
      c.auditors
        ? `found ${String(c.auditors.found)} of ${String(c.auditors.planted)} planted defects`
        : "not measured",
    ),
    row(
      "Agent tasks",
      c.tasks
        ? `an agent (${c.tasks.model}) gets the same outcome on the clone as on the original in ${String(c.tasks.sameOutcome)} of ${String(c.tasks.pairs)} task runs; it succeeds in ${String(c.tasks.successClone)} on the clone, ${String(c.tasks.successTarget)} on the original (run ${c.tasks.at.slice(0, 10)})`
        : "not measured",
    ),
    row(
      "Evaluator",
      `lock \`${c.lockHash}\`, commit ${c.commit ?? "none"}${c.dirty === true ? " with uncommitted changes" : ", clean tree"}`,
    ),
    "",
  ].join("\n");
}

const Mutation = z.object({
  at: z.string(),
  target: z.string(),
  killed: z.number(),
  valid: z.number(),
});
const AuditRun = z.object({ planted: z.array(z.object({ found: z.boolean() })) });

// The latest mutation run for the target, and the auditor recall over every series, if any.
export function auditFacts(repo: string, target: string): Pick<CardInput, "mutation" | "auditors"> {
  const dir = join(repo, "audit", "results");
  if (!existsSync(dir)) return { mutation: null, auditors: null };
  const files = readdirSync(dir).sort();
  const mutation =
    files
      .filter((f) => f.startsWith("mutation-") && f.endsWith(".json"))
      .map((f) => Mutation.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8"))))
      .filter((r) => r.success && r.data.target === target)
      .map((r) =>
        r.success ? { killed: r.data.killed, valid: r.data.valid, at: r.data.at } : null,
      )
      .at(-1) ?? null;
  let found = 0;
  let planted = 0;
  for (const f of files.filter((n) => n.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const r = AuditRun.safeParse(JSON.parse(line));
      if (!r.success) continue;
      planted += r.data.planted.length;
      found += r.data.planted.filter((p) => p.found).length;
    }
  }
  return { mutation, auditors: planted > 0 ? { found, planted } : null };
}

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const LEVEL_FILL: Record<string, string> = { A: "#2ea44f", B: "#7cb305", C: "#d4a72c" };

// The same facts as the Markdown card, drawn: the level large, one gauge per measure. Every
// number is the card's; the drawing adds nothing.
export function reliabilitySvg(c: CardInput): string {
  const latest = latestBatch(c);
  const t = latest?.tally;
  const rated = t !== undefined && latest !== null && latest.plan.preRegistered !== "no";
  const lvl = rated ? level(t) : null;
  const k = t === undefined ? 0 : t.total - t.pass;
  const gauges: [string, number, number][] = [
    ...(t ? ([["Holdout", t.pass, t.total]] as [string, number, number][]) : []),
    ...(c.tasks
      ? ([["Agent tasks agree", c.tasks.sameOutcome, c.tasks.pairs]] as [string, number, number][])
      : []),
    ...(c.mutation
      ? ([["Mutants caught", c.mutation.killed, c.mutation.valid]] as [string, number, number][])
      : []),
    ...(c.auditors
      ? ([["Auditor recall", c.auditors.found, c.auditors.planted]] as [string, number, number][])
      : []),
    ["Determinism", c.determinism.identical, c.determinism.total],
    ...(c.unseenRound
      ? ([["Breaker, unseen", c.unseenRound.tally.pass, c.unseenRound.tally.total]] as [
          string,
          number,
          number,
        ][])
      : c.adversarial.total > 0
        ? ([["Breaker probes (dev)", c.adversarial.pass, c.adversarial.total]] as [
            string,
            number,
            number,
          ][])
        : []),
  ];
  const width = 680;
  const top = 92;
  const rowH = 30;
  const height = top + gauges.length * rowH + 52;
  const barX = 420;
  const barW = 170;
  const rows = gauges
    .map(([label, n, d], i) => {
      const y = top + i * rowH;
      const share = d === 0 ? 0 : n / d;
      const fill =
        share === 1 ? "#2ea44f" : share >= 0.9 ? "#7cb305" : share >= 0.75 ? "#d4a72c" : "#cf222e";
      return [
        `<text x="236" y="${String(y + 14)}" class="label">${xml(label)}</text>`,
        `<rect x="${String(barX)}" y="${String(y + 3)}" width="${String(barW)}" height="12" rx="6" class="track"/>`,
        `<rect x="${String(barX)}" y="${String(y + 3)}" width="${String(Math.round(barW * share))}" height="12" rx="6" fill="${fill}"/>`,
        `<text x="${String(barX + barW + 12)}" y="${String(y + 14)}" class="value">${String(n)}/${String(d)}</text>`,
      ].join("");
    })
    .join("\n  ");
  const claim = lvl ? lvl.claim : "unrated: no pre-registered batch";
  const footer = [
    latest ? `batch ${latest.name}-` : "no batch",
    t ? `bound ${pct(upperBound(k, t.total))} at 95 %` : "",
    latest ? (latest.looks <= 1 ? "first and only look" : `${String(latest.looks)} looks`) : "",
    c.commit ? `commit ${c.commit}` : "",
    c.at.slice(0, 10),
  ]
    .filter((s) => s !== "")
    .join("  ·  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="Reliability card: ${xml(c.target)}, level ${lvl?.name ?? "unrated"}">
  <style>
    .card { fill: #ffffff; stroke: #d0d7de; }
    .title { font: 600 20px system-ui, -apple-system, Segoe UI, sans-serif; fill: #1f2328; }
    .claim { font: 400 13px system-ui, -apple-system, Segoe UI, sans-serif; fill: #59636e; }
    .label { font: 500 13px system-ui, -apple-system, Segoe UI, sans-serif; fill: #1f2328; }
    .value { font: 600 13px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #1f2328; }
    .foot { font: 400 11px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #59636e; }
    .track { fill: #eaeef2; }
    .grade { font: 700 72px system-ui, -apple-system, Segoe UI, sans-serif; fill: #ffffff; }
    .caption { font: 600 11px system-ui, -apple-system, Segoe UI, sans-serif; fill: #59636e; letter-spacing: 0.08em; }
  </style>
  <rect x="0.5" y="0.5" width="${String(width - 1)}" height="${String(height - 1)}" rx="14" class="card"/>
  <text x="28" y="40" class="title">Reliability card · ${xml(c.target)}</text>
  <text x="28" y="62" class="claim">${xml(claim)}</text>
  <circle cx="112" cy="${String(top + 66)}" r="62" fill="${lvl ? (LEVEL_FILL[lvl.name] ?? "#8c959f") : "#8c959f"}"/>
  <text x="112" y="${String(top + 91)}" text-anchor="middle" class="grade">${xml(lvl?.name ?? "?")}</text>
  <text x="112" y="${String(top + 150)}" text-anchor="middle" class="caption">LEVEL</text>
  ${rows}
  <text x="28" y="${String(height - 22)}" class="foot">${xml(footer)}</text>
</svg>
`;
}

const shareColor = (t: Tally): string =>
  t.pass === t.total ? "2ea44f" : t.pass * 2 >= t.total ? "dfb317" : "e05d44";

const RoundFile = z.object({ probes: z.array(z.object({ id: z.string() })) });

const commitTime = (cwd: string, args: string[]): number | null => {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%ct", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : Number(out);
  } catch {
    return null;
  }
};

// Breaker probes split by round. The latest round counts as unseen when it was first committed
// after the clone last changed: no builder pass could have learnt it.
export function breakerFacts(
  dir: string,
  dev: { id: string; pass: boolean }[],
): { adversarial: Tally; unseenRound: { file: string; tally: Tally } | null } {
  const rounds = readdirSync(dir)
    .filter((f) => /^breaker-round\d+\.json$/.test(f))
    .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]));
  const ids = (f: string): Set<string> =>
    new Set(
      RoundFile.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))).probes.map((p) => p.id),
    );
  const tallyOf = (set: Set<string>): Tally => {
    const cs = dev.filter((c) => set.has(c.id));
    return { pass: cs.filter((c) => c.pass).length, total: cs.length };
  };
  const latest = rounds.at(-1);
  const added = latest ? commitTime(dir, ["--diff-filter=A", "--", latest]) : null;
  const cloneChanged = commitTime(dir, ["--", "clone"]);
  const unseen =
    latest !== undefined && added !== null && cloneChanged !== null && added > cloneChanged;
  const earlier = new Set((unseen ? rounds.slice(0, -1) : rounds).flatMap((f) => [...ids(f)]));
  return {
    adversarial: tallyOf(earlier),
    unseenRound: unseen && latest ? { file: latest, tally: tallyOf(ids(latest)) } : null,
  };
}
