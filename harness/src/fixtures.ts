/**
 * Fixtures are the frozen evaluator: a probe's input and the target's recorded output. This
 * module owns their on-disk format, the dev/holdout split and the hash lock that `verify` checks
 * before every run.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { JsonSchema } from "./json.ts";

export const FixtureSchema = z.object({
  id: z.string(),
  rules: z.array(z.string()).min(1),
  input: JsonSchema,
  observed: z.record(z.string(), JsonSchema),
  noise: z.array(z.string()).describe("paths that differed between two recordings of this probe"),
  recorded_at: z.string(),
  recorded_with: z.record(z.string(), JsonSchema).optional(),
});
export type Fixture = z.infer<typeof FixtureSchema>;
export type Split = "dev" | "holdout";

const LockSchema = z.object({
  policy: z.string(),
  fixtures: z.record(z.string(), z.string()),
  // Everything that shapes the score besides fixtures: the target's driver code and the harness.
  code: z.record(z.string(), z.string()).optional(),
});

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

// A quarter of ordinary probes go to the holdout by hash of their ID. A probe whose ID starts with
// `hold-` belongs to a dedicated, pre-registered holdout batch and never goes to dev. One whose ID
// starts with `dev-` was designed after seeing failures, so it can train but never certify.
export function splitOf(id: string): Split {
  if (id.startsWith("hold-")) return "holdout";
  if (id.startsWith("dev-")) return "dev";
  return Number.parseInt(sha256(id).slice(0, 2), 16) % 4 === 0 ? "holdout" : "dev";
}

export function targetDir(target: string): string {
  return join(import.meta.dirname, "..", "..", "targets", target);
}

const fixturesDir = (target: string, split: Split): string =>
  join(targetDir(target), "fixtures", split);

export function fixturePath(target: string, id: string): string {
  return join(fixturesDir(target, splitOf(id)), `${id}.json`);
}

export function writeFixture(target: string, f: Fixture): void {
  mkdirSync(fixturesDir(target, splitOf(f.id)), { recursive: true });
  writeFileSync(fixturePath(target, f.id), `${JSON.stringify(f, null, 2)}\n`);
}

export function loadFixtures(target: string, splits: Split[]): (Fixture & { split: Split })[] {
  return splits.flatMap((split) => {
    const dir = fixturesDir(target, split);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => ({
        ...FixtureSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))),
        split,
      }));
  });
}

const lockPath = (target: string): string => join(targetDir(target), "fixtures.lock");
const policyPath = (target: string): string => join(targetDir(target), "policy.json");

function currentHashes(target: string): z.infer<typeof LockSchema> {
  const fixtures: Record<string, string> = {};
  for (const split of ["dev", "holdout"] as const) {
    const dir = fixturesDir(target, split);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort()) {
      fixtures[`${split}/${f}`] = sha256(readFileSync(join(dir, f), "utf8"));
    }
  }
  return {
    policy: sha256(readFileSync(policyPath(target), "utf8")),
    fixtures,
    code: codeHashes(target),
  };
}

function claudeFiles(dir: string): [string, string][] {
  if (!existsSync(dir)) return [];
  return (
    readdirSync(dir, { withFileTypes: true, recursive: true })
      // Hidden files (.DS_Store and the like) and local settings are machine-specific, not evaluator.
      .filter(
        (d) =>
          d.isFile() &&
          !d.name.startsWith(".") &&
          !d.name.endsWith(".log") &&
          d.name !== "settings.local.json",
      )
      .map((d): [string, string] => {
        const p = join(d.parentPath, d.name);
        return [`.claude/${p.slice(dir.length + 1)}`, p];
      })
  );
}

function codeHashes(target: string): Record<string, string> {
  const harness = join(import.meta.dirname, "..");
  const files: [string, string][] = [
    ...readdirSync(targetDir(target))
      .filter((n) => n.endsWith(".ts"))
      .map((n): [string, string] => [`target/${n}`, join(targetDir(target), n)]),
    ...readdirSync(join(harness, "src"))
      .filter((n) => n.endsWith(".ts"))
      .map((n): [string, string] => [`harness/src/${n}`, join(harness, "src", n)]),
    ...readdirSync(join(harness, "hooks")).map((n): [string, string] => [
      `harness/hooks/${n}`,
      join(harness, "hooks", n),
    ]),
    // The agent image decides what an implementer can run and see.
    ...readdirSync(join(harness, "docker")).map((n): [string, string] => [
      `harness/docker/${n}`,
      join(harness, "docker", n),
    ]),
    ...readdirSync(harness)
      .filter((n) => n.endsWith(".sh"))
      .map((n): [string, string] => [`harness/${n}`, join(harness, n)]),
    // The target's data files shape probes and rule tags too (rules, breaker rounds, batch seeds);
    // only the lock itself and the policy, hashed apart, are left out.
    ...readdirSync(targetDir(target))
      .filter((n) => n.endsWith(".json") && n !== "fixtures.lock" && n !== "policy.json")
      .map((n): [string, string] => [`target/${n}`, join(targetDir(target), n)]),
    ...["package.json", "package-lock.json"]
      .map((n): [string, string] => [n, join(harness, "..", n)])
      .filter(([, p]) => existsSync(p)),
    ...claudeFiles(join(harness, "..", ".claude")),
  ];
  return Object.fromEntries(
    files
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, p]) => [k, sha256(readFileSync(p, "utf8"))]),
  );
}

export function writeLock(target: string): void {
  writeFileSync(lockPath(target), `${JSON.stringify(currentHashes(target), null, 2)}\n`);
}

// Returns the list of mismatches; empty means the evaluator is intact.
export function checkLock(target: string): string[] {
  if (!existsSync(lockPath(target))) return ["fixtures.lock is missing"];
  const locked = LockSchema.parse(JSON.parse(readFileSync(lockPath(target), "utf8")));
  const now = currentHashes(target);
  const problems: string[] = [];
  if (locked.policy !== now.policy) problems.push("policy.json changed");
  if (locked.code === undefined) problems.push("lock has no code hashes (run relock)");
  // A builder sandbox has no holdout, no batch seed and no fixtures/holdout folder, by design; only
  // there may they be missing. On the host a missing holdout is a broken evaluator.
  const sandbox = process.env.RH_SANDBOX === "1";
  for (const [f, h] of Object.entries(locked.code ?? {})) {
    if (sandbox && f.includes("holdout") && now.code?.[f] === undefined) continue;
    if (now.code?.[f] !== h) problems.push(`${f} changed`);
  }
  for (const f of Object.keys(now.code ?? {})) {
    if (locked.code?.[f] === undefined) problems.push(`${f} not in lock`);
  }
  const holdoutAbsent = sandbox && !existsSync(fixturesDir(target, "holdout"));
  for (const [f, h] of Object.entries(locked.fixtures)) {
    if (holdoutAbsent && f.startsWith("holdout/")) continue;
    if (now.fixtures[f] === undefined) problems.push(`${f} missing`);
    else if (now.fixtures[f] !== h) problems.push(`${f} changed`);
  }
  for (const f of Object.keys(now.fixtures)) {
    if (locked.fixtures[f] === undefined) problems.push(`${f} not in lock`);
  }
  return problems;
}
