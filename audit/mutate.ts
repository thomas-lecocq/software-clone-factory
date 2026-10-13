/**
 * Measures the verifier the way the auditors are measured: plant a known bug and see whether it is
 * caught. Each mutant is a copy of the clone with one small change in any of its files (a rounding
 * mode, a comparison, a constant, a boolean operator); every dev fixture is replayed against it,
 * screens included,
 * and it is killed at the first fixture that differs. Only fixtures the unchanged clone passes
 * count: a known divergence would "kill" every mutant. A surviving mutant is either harmless (an
 * equivalent change) or a behaviour no fixture pins: each one is listed for a human to read.
 * Usage: npx tsx audit/mutate.ts <target> [--mutants 40] [--seed 1]
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadAdapter } from "../harness/src/adapter.ts";
import { startCloneProcess } from "../harness/src/clone-process.ts";
import { loadFixtures, targetDir } from "../harness/src/fixtures.ts";
import { diff, PolicySchema, type Policy } from "../harness/src/policy.ts";

interface Operator {
  name: string;
  pattern: RegExp;
  replace: (match: string) => string;
}

const OPERATORS: Operator[] = [
  { name: "round to floor", pattern: /Math\.round\(/g, replace: () => "Math.floor(" },
  { name: "floor to ceil", pattern: /Math\.floor\(/g, replace: () => "Math.ceil(" },
  { name: "strict to loose <", pattern: / < /g, replace: () => " <= " },
  { name: "loose to strict <=", pattern: / <= /g, replace: () => " < " },
  { name: "strict to loose >", pattern: / > /g, replace: () => " >= " },
  { name: "loose to strict >=", pattern: / >= /g, replace: () => " > " },
  { name: "equal to not equal", pattern: / === /g, replace: () => " !== " },
  { name: "and to or", pattern: / && /g, replace: () => " || " },
  {
    name: "constant plus one",
    pattern: /(?<![\w.])([2-9]|[1-9]\d+)(?![\w.])/g,
    replace: (m) => String(Number(m) + 1),
  },
];

// The clone's entry module only wires the server; every other file can carry behaviour.
const SKIP = new Set(["server.ts"]);

interface Site {
  file: string;
  operator: Operator;
  index: number;
  line: number;
  before: string;
}

function sites(cloneDir: string): Site[] {
  const out: Site[] = [];
  for (const file of readdirSync(cloneDir).filter((f) => f.endsWith(".ts") && !SKIP.has(f))) {
    const text = readFileSync(join(cloneDir, file), "utf8");
    // Comments and string literals are skipped by blanking them, keeping offsets intact.
    const code = text
      .replace(/\/\/.*$/gm, (c) => " ".repeat(c.length))
      .replace(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (c) => " ".repeat(c.length));
    for (const operator of OPERATORS) {
      for (const m of code.matchAll(operator.pattern)) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({ file, operator, index: m.index, line, before: m[0] });
      }
    }
  }
  return out;
}

function pick<T>(xs: T[], n: number, seed: number): T[] {
  let a = seed;
  const r = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...xs];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy.slice(0, n);
}

// The first fixture whose replay differs from the recording, or null when all match.
async function firstDivergence(
  adapter: Awaited<ReturnType<typeof loadAdapter>>,
  target: string,
  policy: Policy,
  fixtures: ReturnType<typeof loadFixtures>,
  port: number,
  stopAtFirst: boolean,
): Promise<string[]> {
  const clone = await startCloneProcess(target, adapter.cloneEntry, port);
  const failing: string[] = [];
  try {
    for (const f of fixtures) {
      await fetch(`${clone.url}/__reset`, { method: "POST" });
      const actual = await adapter
        .run({ id: f.id, rules: f.rules, input: f.input }, { kind: "clone", url: clone.url })
        .catch((e: unknown) => ({ error: String(e) }));
      const noise = f.noise.map((path) => ({ path, mode: "ignore" as const, why: "noise" }));
      if (
        diff({ ...policy, fields: [...policy.fields, ...noise] }, f.observed, actual).length > 0
      ) {
        failing.push(f.id);
        if (stopAtFirst) break;
      }
    }
  } finally {
    await clone.close();
  }
  return failing;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { mutants: { type: "string", default: "40" }, seed: { type: "string", default: "1" } },
  });
  const target = positionals[0];
  if (target === undefined) throw new Error("usage: mutate.ts <target> [--mutants n] [--seed s]");
  const adapter = await loadAdapter(target);
  const cloneDir = join(targetDir(target), "clone");
  const policy: Policy = PolicySchema.parse(
    JSON.parse(readFileSync(join(targetDir(target), "policy.json"), "utf8")),
  );
  const all = loadFixtures(target, ["dev"]);
  const baseline = new Set(await firstDivergence(adapter, target, policy, all, 4699, false));
  const fixtures = all.filter((f) => !baseline.has(f.id));
  console.log(
    `${String(fixtures.length)} logic fixtures pass on the unchanged clone; ${String(baseline.size)} excluded`,
  );
  const chosen = pick(sites(cloneDir), Number(values.mutants), Number(values.seed));
  const scratch = `_mutant-${String(process.pid)}`;
  const results: Record<string, unknown>[] = [];
  let port = 4700;
  for (const [i, s] of chosen.entries()) {
    const dir = targetDir(scratch);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(cloneDir, join(dir, "clone"), { recursive: true });
    const path = join(dir, "clone", s.file);
    const text = readFileSync(path, "utf8");
    writeFileSync(
      path,
      text.slice(0, s.index) + s.operator.replace(s.before) + text.slice(s.index + s.before.length),
    );
    const label = `${s.file}:${String(s.line)} ${s.operator.name} (${s.before.trim()})`;
    let outcome: "killed" | "survived" | "invalid" = "survived";
    let by: string | null = null;
    try {
      port += 1;
      const failing = await firstDivergence(adapter, scratch, policy, fixtures, port, true);
      if (failing[0] !== undefined) {
        outcome = "killed";
        by = failing[0];
      }
    } catch {
      outcome = "invalid";
    }
    results.push({ mutant: label, outcome, killed_by: by });
    console.log(
      `${String(i + 1)}/${String(chosen.length)} ${outcome.padEnd(8)} ${label}${by ? ` by ${by}` : ""}`,
    );
  }
  rmSync(targetDir(scratch), { recursive: true, force: true });
  const valid = results.filter((r) => r.outcome !== "invalid");
  const killed = valid.filter((r) => r.outcome === "killed").length;
  const summary = {
    at: new Date().toISOString(),
    target,
    fixtures: fixtures.length,
    scope: "every clone file except its entry module; every dev fixture the unchanged clone passes",
    excluded_known_failures: [...baseline].sort(),
    mutants: chosen.length,
    valid: valid.length,
    killed,
    survived: valid.length - killed,
    results,
  };
  const out = join(import.meta.dirname, "results");
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, `mutation-${summary.at.replace(/[:.]/g, "-")}.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(
    `killed ${String(killed)} of ${String(valid.length)} valid mutants (${String(chosen.length - valid.length)} invalid)`,
  );
}

await main();
