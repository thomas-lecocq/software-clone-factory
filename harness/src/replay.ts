/**
 * Replays chosen fixtures against the clone and prints every blocking difference with both values,
 * writing nothing. It exists for the analyst, whose spent batch lies outside `fixtures/` where
 * `verify` cannot see it: without it, each analysis began by rebuilding this script. With
 * `--clone <dir>`, a patched copy of the clone is replayed instead, to test a hypothesis.
 * Usage: npx tsx harness/src/replay.ts <target> <fixture.json|dir>... [--clone <dir>] [--port 4800]
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadAdapter } from "./adapter.ts";
import { startCloneProcess } from "./clone-process.ts";
import { FixtureSchema, targetDir, type Fixture } from "./fixtures.ts";
import type { Json } from "./json.ts";
import { blocking, diff, PolicySchema } from "./policy.ts";

function fixtureFiles(paths: string[]): string[] {
  return paths.flatMap((p) =>
    statSync(p).isDirectory()
      ? readdirSync(p)
          .filter((f) => f.endsWith(".json") && f !== "failures.json")
          .sort()
          .map((f) => join(p, f))
      : [p],
  );
}

const show = (v: Json | undefined): string => {
  const s = v === undefined ? "absent" : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { clone: { type: "string" }, port: { type: "string", default: "4800" } },
  });
  const [target, ...paths] = positionals;
  if (target === undefined || paths.length === 0) {
    throw new Error("usage: replay.ts <target> <fixture.json|dir>... [--clone <dir>]");
  }
  const adapter = await loadAdapter(target);
  const policy = PolicySchema.parse(
    JSON.parse(readFileSync(join(targetDir(target), "policy.json"), "utf8")),
  );
  // A patched copy runs from a scratch target beside the real one, so its relative imports of the
  // harness resolve as the clone's do.
  let cloneTarget = target;
  const scratch = `_replay-${String(process.pid)}`;
  if (values.clone !== undefined) {
    mkdirSync(targetDir(scratch), { recursive: true });
    cpSync(values.clone, join(targetDir(scratch), "clone"), { recursive: true });
    cloneTarget = scratch;
  }
  const fixtures: Fixture[] = fixtureFiles(paths).map((f) =>
    FixtureSchema.parse(JSON.parse(readFileSync(f, "utf8"))),
  );
  const clone = await startCloneProcess(cloneTarget, adapter.cloneEntry, Number(values.port));
  let failed = 0;
  try {
    for (const f of fixtures) {
      await fetch(`${clone.url}/__reset`, { method: "POST" });
      const actual = await adapter
        .run({ id: f.id, rules: f.rules, input: f.input }, { kind: "clone", url: clone.url })
        .catch((e: unknown) => ({ error: String(e) }));
      const noise = f.noise.map((path) => ({ path, mode: "ignore" as const, why: "noise" }));
      const diffs = blocking(
        diff({ ...policy, fields: [...policy.fields, ...noise] }, f.observed, actual),
      );
      if (diffs.length === 0) {
        console.log(`PASS ${f.id}`);
        continue;
      }
      failed += 1;
      console.log(`FAIL ${f.id} (${String(diffs.length)} field(s))`);
      for (const d of diffs) {
        console.log(
          `  ${d.path}\n    expected ${show(d.expected)}\n    actual   ${show(d.actual)}`,
        );
      }
    }
  } finally {
    await clone.close();
    if (cloneTarget !== target) rmSync(targetDir(scratch), { recursive: true, force: true });
  }
  console.log(`${String(fixtures.length - failed)} of ${String(fixtures.length)} pass`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
