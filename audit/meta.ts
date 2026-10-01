/**
 * Measures the auditor instead of trusting it. Each run copies the repository, plants a few known
 * defects from `defects.json`, relocks and commits the copy as a single snapshot (so git history
 * gives nothing away), runs the auditor prompt in the agent container, and matches its findings
 * against what was planted. Recall is planted defects found over planted; findings that match no
 * planted defect are listed for a human to adjudicate, since only they decide precision.
 * Usage: npx tsx audit/meta.ts [--runs 3] [--per-run 4] [--seed 1] [--dry]
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { upperBound } from "../harness/src/fidelity.ts";
import { JsonSchema, type Json } from "../harness/src/json.ts";

const Defect = z.object({
  id: z.string(),
  category: z.string(),
  file: z.string(),
  edits: z.array(z.object({ find: z.string(), replace: z.string() })).optional(),
  append: z.string().optional(),
});
type Defect = z.infer<typeof Defect>;

const Findings = z.object({
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.number().nullable().optional(),
      category: z.string(),
      summary: z.string(),
      evidence: z.string().optional(),
    }),
  ),
});
type Finding = z.infer<typeof Findings>["findings"][number];

// The totals `claude -p --output-format json` prints at the end of a run.
const RunTotals = z.object({
  duration_ms: z.number(),
  num_turns: z.number(),
  total_cost_usd: z.number(),
  modelUsage: JsonSchema.optional(),
});

const repo = join(import.meta.dirname, "..");
const image = "software-clone-factory-agent";

function shuffled<T>(xs: T[], seed: number): T[] {
  let a = seed;
  const r = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function plant(copy: string, d: Defect): void {
  const path = join(copy, d.file);
  let text = readFileSync(path, "utf8");
  for (const e of d.edits ?? []) {
    const n = text.split(e.find).length - 1;
    if (n !== 1) throw new Error(`defect ${d.id}: anchor found ${String(n)} times in ${d.file}`);
    text = text.replace(e.find, () => e.replace);
  }
  if (d.append !== undefined) text += d.append;
  writeFileSync(path, text);
}

function prepareCopy(defects: Defect[]): string {
  const copy = mkdtempSync(join(tmpdir(), "scf-audit-"));
  execFileSync("rsync", [
    "-a",
    ...["--exclude", ".git", "--exclude", "node_modules", "--exclude", "audit"],
    ...["--exclude", "*.env", "--exclude", ".env*", "--exclude", ".scrub*"],
    ...["--exclude", "targets/*/logs", "--exclude", "logs"],
    `${repo}/`,
    `${copy}/`,
  ]);
  for (const d of defects) plant(copy, d);
  const targets = readdirSync(join(copy, "targets"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name);
  for (const t of targets) {
    execFileSync("docker", [
      ...["run", "--rm", "--network", "none", "-v", `${copy}:/work`, image],
      ...["tsx", "harness/src/cli.ts", "relock", t, "--reason", "snapshot of the audited copy"],
    ]);
  }
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", copy, ...args], { stdio: "ignore" });
  };
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.name=Snapshot",
    "-c",
    "user.email=snapshot@example.com",
    "commit",
    "-qm",
    "Snapshot",
  );
  return copy;
}

function runAuditor(copy: string, log: string): { findings: Finding[]; cost: Json } {
  const prompt = readFileSync(join(import.meta.dirname, "auditor.md"), "utf8");
  const r = spawnSync(
    "docker",
    [
      ...["run", "--rm", "--env-file", join(repo, ".agent.env"), "-v", `${copy}:/work`, image],
      ...["claude", "-p", prompt, "--model", "claude-opus-5-5"],
      ...["--permission-mode", "acceptEdits", "--allowedTools", "Bash Read Write Edit Grep Glob"],
      ...["--disallowedTools", "WebFetch WebSearch", "--output-format", "json"],
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(log, `${r.stdout}\n--- stderr\n${r.stderr}`);
  const totals = RunTotals.safeParse(JSON.parse(r.stdout || "{}"));
  const cost = totals.success
    ? {
        seconds: totals.data.duration_ms / 1000,
        turns: totals.data.num_turns,
        cost_usd: totals.data.total_cost_usd,
        models: totals.data.modelUsage ?? null,
      }
    : null;
  const out = join(copy, "audit-findings.json");
  if (!existsSync(out)) return { findings: [], cost };
  return { findings: Findings.parse(JSON.parse(readFileSync(out, "utf8"))).findings, cost };
}

const norm = (f: string): string => f.replace(/^(\.\/|\/work\/)/, "");

function main(): void {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "3" },
      "per-run": { type: "string", default: "4" },
      seed: { type: "string", default: "1" },
      // Plants, relocks and commits the copies, then stops and keeps them for inspection.
      dry: { type: "boolean", default: false },
    },
  });
  const runs = Number(values.runs);
  const perRun = Number(values["per-run"]);
  const library = z
    .object({ defects: z.array(Defect) })
    .parse(JSON.parse(readFileSync(join(import.meta.dirname, "defects.json"), "utf8"))).defects;
  // Each defect is planted at most once per series, so that recall is over distinct defects.
  const order = shuffled(library, Number(values.seed));
  if (runs * perRun > order.length) throw new Error("not enough defects for that many runs");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(import.meta.dirname, "results");
  mkdirSync(outDir, { recursive: true });
  let planted = 0;
  let found = 0;
  for (let i = 0; i < runs; i += 1) {
    const defects = order.slice(i * perRun, (i + 1) * perRun);
    const copy = prepareCopy(defects);
    if (values.dry) {
      console.log(
        `run ${String(i + 1)}: ${defects.map((d) => d.id).join(", ")} planted in ${copy}`,
      );
      continue;
    }
    try {
      const { findings, cost } = runAuditor(copy, join(outDir, `${stamp}-run${String(i + 1)}.log`));
      // One finding counts for one defect: two defects in the same file need two findings there.
      const used = new Set<Finding>();
      const hit = defects.map((d) => {
        const match = findings.find((f) => !used.has(f) && norm(f.file) === d.file);
        if (match) used.add(match);
        return { id: d.id, found: match !== undefined };
      });
      const unmatched = findings.filter((f) => !used.has(f));
      planted += defects.length;
      found += hit.filter((h) => h.found).length;
      const line = { run: i + 1, seed: Number(values.seed), planted: hit, unmatched, cost };
      appendFileSync(join(outDir, `${stamp}.jsonl`), `${JSON.stringify(line)}\n`);
      console.log(
        `run ${String(i + 1)}: ${String(hit.filter((h) => h.found).length)} of ${String(defects.length)} planted defects found, ${String(unmatched.length)} other findings to adjudicate`,
      );
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
  const lower = 1 - upperBound(planted - found, planted);
  console.log(
    `recall ${String(found)} of ${String(planted)}; one-sided 95 % lower bound ${(lower * 100).toFixed(1)} %`,
  );
}

main();
