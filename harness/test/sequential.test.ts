import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { targetDir, writeFixture, writeLock } from "../src/fixtures.ts";
import { verify } from "../src/verify.ts";

// A synthetic target: a clone that echoes `x`, except for the values listed in FAIL.
function makeTarget(t: string, fail: number[]): void {
  const dir = targetDir(t);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "clone"), { recursive: true });
  writeFileSync(join(dir, "policy.json"), '{"canonicalIds":false,"fields":[]}');
  writeFileSync(join(dir, "rules.json"), '{"rules":[]}');
  writeFileSync(
    join(dir, "adapter.ts"),
    [
      'import { z } from "zod";',
      'import type { TargetAdapter } from "../../harness/src/adapter.ts";',
      "const X = z.object({ x: z.number() });",
      "const adapter: TargetAdapter = {",
      "  probes: () => [],",
      '  cloneEntry: "clone/server.ts",',
      "  run: async (probe, side) => {",
      '    if (side.kind !== "clone") throw new Error("no target in this test");',
      "    const r = await fetch(`${side.url}/v?x=${String(X.parse(probe.input).x)}`);",
      "    return { v: z.number().parse(await r.json()) };",
      "  },",
      "};",
      "export default adapter;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "clone", "server.ts"),
    [
      'import { startCloneServer } from "../../../harness/src/clone-kit.ts";',
      `const FAIL = ${JSON.stringify(fail)};`,
      "export const startClone = (port: number) =>",
      "  startCloneServer(",
      "    {",
      "      seed: () => ({}),",
      "      handle: (req) => {",
      '        const x = Number(req.query.get("x"));',
      "        return { status: 200, body: FAIL.includes(x) ? -1 : x };",
      "      },",
      "    },",
      "    port,",
      "  );",
      "",
    ].join("\n"),
  );
  let x = 0;
  for (const stage of [1, 2, 3]) {
    for (const n of ["001", "002", "003"]) {
      x += 1;
      writeFixture(t, {
        id: `hold-t-s${String(stage)}-${n}`,
        rules: ["T-01"],
        input: { x },
        observed: { v: x },
        noise: [],
        recorded_at: "2026-10-13T00:00:00Z",
      });
    }
  }
  writeLock(t);
}

const Run = z.object({
  sets: z.array(z.string()),
  sequential: z.object({ stopped_after_stage: z.number().nullable() }),
});

function lastRun(t: string): z.infer<typeof Run> {
  const lines = readFileSync(join(targetDir(t), "verify", "runs.jsonl"), "utf8")
    .trim()
    .split("\n");
  return Run.parse(JSON.parse(lines.at(-1) ?? "{}"));
}

describe("sequential testing", () => {
  const sandbox = process.env.RH_SANDBOX;
  // These synthetic targets are not committed, so the committed-lock check is skipped here.
  process.env.RH_SANDBOX = "1";
  afterAll(() => {
    rmSync(targetDir("_seq-fail"), { recursive: true, force: true });
    rmSync(targetDir("_seq-pass"), { recursive: true, force: true });
    if (sandbox === undefined) delete process.env.RH_SANDBOX;
    else process.env.RH_SANDBOX = sandbox;
  });

  it("stops after the stage where failures exceed the tolerance, leaving later stages unscored", async () => {
    makeTarget("_seq-fail", [2, 3]);
    const code = await verify("_seq-fail", ["holdout"], 4641, undefined, {
      batch: "hold-t",
      maxFailures: 1,
    });
    expect(code).toBe(1);
    const run = lastRun("_seq-fail");
    expect(run.sequential.stopped_after_stage).toBe(1);
    expect(run.sets).toEqual(["hold-t-s1"]);
  }, 60_000);

  it("scores every stage when failures stay within the tolerance", async () => {
    makeTarget("_seq-pass", [8]);
    const code = await verify("_seq-pass", ["holdout"], 4642, undefined, {
      batch: "hold-t",
      maxFailures: 1,
    });
    expect(code).toBe(0);
    const run = lastRun("_seq-pass");
    expect(run.sequential.stopped_after_stage).toBeNull();
    expect(run.sets).toEqual(["hold-t-s1", "hold-t-s2", "hold-t-s3"]);
  }, 60_000);
});
