/**
 * The recorder: the only code path that writes fixtures. It runs each designed probe twice on the
 * real target, keeps the paths that differed as declared noise, scrubs the observation and
 * rewrites the lock. Existing fixtures are never overwritten without an explicit re-record reason.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAdapter } from "./adapter.ts";
import { checkLock, fixturePath, sha256, targetDir, writeFixture, writeLock } from "./fixtures.ts";
import { diff, PolicySchema } from "./policy.ts";
import { loadLiterals, scrub } from "./scrub.ts";
import { logTiming, secondsSince } from "./timings.ts";

export interface RecordOptions {
  only?: string[];
  rerecord?: { id: string; reason: string };
  literalsFile?: string;
}

export async function record(target: string, opts: RecordOptions): Promise<void> {
  // The lock is rewritten after recording, so it must be intact before: otherwise a changed policy,
  // harness file or hand-written fixture would be absorbed without a reason. One recording at a time.
  const problems = checkLock(target);
  if (problems.length > 0) {
    throw new Error(
      `refusing to record: the evaluator differs from the lock (relock deliberately first):\n  ${problems.join("\n  ")}`,
    );
  }
  const adapter = await loadAdapter(target);
  const policy = PolicySchema.parse(
    JSON.parse(readFileSync(join(targetDir(target), "policy.json"), "utf8")),
  );
  const literals = loadLiterals(opts.literalsFile);
  let probes = adapter.probes();
  if (opts.only) probes = probes.filter((p) => opts.only?.includes(p.id));
  if (opts.rerecord) probes = probes.filter((p) => p.id === opts.rerecord?.id);

  let written = 0;
  for (const probe of probes) {
    const path = fixturePath(target, probe.id);
    const before = existsSync(path) ? sha256(readFileSync(path, "utf8")) : null;
    if (before !== null && opts.rerecord?.id !== probe.id) continue;
    const started = performance.now();
    const first = await adapter.run(probe, { kind: "target" });
    const second = await adapter.run(probe, { kind: "target" });
    const noise = diff(policy, first, second).map((d) => d.path);
    writeFixture(target, {
      id: probe.id,
      rules: probe.rules,
      input: probe.input,
      observed: Object.fromEntries(Object.entries(first).map(([k, v]) => [k, scrub(v, literals)])),
      noise,
      recorded_at: new Date().toISOString(),
      ...(adapter.recordedWith ? { recorded_with: adapter.recordedWith() } : {}),
    });
    written += 1;
    logTiming(target, "record", { id: probe.id, runs: 2, seconds: secondsSince(started) });
    const after = sha256(readFileSync(path, "utf8"));
    const tag = noise.length > 0 ? ` (noise: ${noise.length} paths)` : "";
    console.log(`recorded ${probe.id}${tag}`);
    if (before !== null && opts.rerecord) {
      console.log(
        `re-record ${probe.id}: ${opts.rerecord.reason}\n  old ${before}\n  new ${after}`,
      );
    }
  }
  writeLock(target);
  console.log(`${written} fixture(s) written, lock updated`);
}
