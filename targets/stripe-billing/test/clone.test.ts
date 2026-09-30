import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningClone } from "../../../harness/src/adapter.ts";
import adapter from "../adapter.ts";

const probe = adapter.probes().find((p) => p.id === "d-pct20-sub");
if (!probe) throw new Error("probe d-pct20-sub missing");

describe("invariant 4: recording refuses a non-test key", () => {
  it("throws before any network call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-"));
    writeFileSync(join(dir, "stripe.env"), "STRIPE_SECRET_KEY=sk_live_notreal\n");
    const previous = process.env.STRIPE_ENV;
    process.env.STRIPE_ENV = join(dir, "stripe.env");
    try {
      await expect(adapter.run(probe, { kind: "target" })).rejects.toThrow(/not a test key/);
    } finally {
      if (previous === undefined) delete process.env.STRIPE_ENV;
      else process.env.STRIPE_ENV = previous;
    }
  });
});

describe("invariant 5: the clone is resettable and deterministic", () => {
  let clone: RunningClone;
  beforeAll(async () => {
    clone = await adapter.startClone(4611);
  });
  afterAll(async () => {
    await clone.close();
  });

  // A crash must fail the test: two identical exceptions are not determinism.
  const attempt = async (): Promise<string> => {
    const reset = await fetch(`${clone.url}/__reset`, { method: "POST" });
    expect(reset.ok).toBe(true);
    return JSON.stringify(await adapter.run(probe, { kind: "clone", url: clone.url }));
  };

  it("gives byte-identical output for the same probe after a reset", async () => {
    const first = await attempt();
    const second = await attempt();
    expect(second).toBe(first);
  });

  it("empties its state on reset", async () => {
    await attempt();
    await fetch(`${clone.url}/__reset`, { method: "POST" });
    const afterReset = await (await fetch(`${clone.url}/__state`)).text();
    const fresh = await adapter.startClone(4612);
    const seed = await (await fetch(`${fresh.url}/__state`)).text();
    await fresh.close();
    expect(afterReset).toBe(seed);
  });
});
