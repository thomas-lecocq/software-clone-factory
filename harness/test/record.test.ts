import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkLock, fixturePath, targetDir, writeLock } from "../src/fixtures.ts";
import { record } from "../src/record.ts";

const t = "_record-test";

describe("parallel recording", () => {
  afterAll(() => {
    rmSync(targetDir(t), { recursive: true, force: true });
  });

  it("records probes at once, reports a failing one, and still locks the rest", async () => {
    const dir = targetDir(t);
    mkdirSync(join(dir, "clone"), { recursive: true });
    writeFileSync(join(dir, "policy.json"), '{"canonicalIds":false,"fields":[]}');
    writeFileSync(
      join(dir, "adapter.ts"),
      [
        'import { z } from "zod";',
        'import type { TargetAdapter } from "../../harness/src/adapter.ts";',
        "const X = z.object({ x: z.number() });",
        "const adapter: TargetAdapter = {",
        '  probes: () => Array.from({ length: 8 }, (_, i) => ({ id: `p-${String(i)}`, rules: ["T-01"], input: { x: i } })),',
        '  cloneEntry: "clone/server.ts",',
        "  run: async (probe) => {",
        "    const { x } = X.parse(probe.input);",
        "    await new Promise((r) => setTimeout(r, 150));",
        '    if (x === 5) throw new Error("target down for this probe");',
        "    return { v: x };",
        "  },",
        "};",
        "export default adapter;",
        "",
      ].join("\n"),
    );
    writeLock(t);
    const started = performance.now();
    await expect(record(t, { concurrency: 8 })).rejects.toThrow(
      /1 probe\(s\) failed to record:\n {2}p-5/,
    );
    const seconds = (performance.now() - started) / 1000;
    // Two runs of 150 ms per probe: about 0.3 s in parallel, 2.4 s one after the other.
    expect(seconds).toBeLessThan(1.5);
    for (const i of [0, 1, 2, 3, 4, 6, 7])
      expect(existsSync(fixturePath(t, `p-${String(i)}`))).toBe(true);
    expect(existsSync(fixturePath(t, "p-5"))).toBe(false);
    expect(checkLock(t)).toEqual([]);
  }, 30_000);
});
