/**
 * Prints the field diffs of failing cases to the terminal only, for the main session's gap analysis.
 * Like verify it refuses a tampered evaluator, and a run that reads the holdout is logged as a look
 * in verify/runs.jsonl: explaining a holdout failure spends that holdout just as scoring it does.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startCloneProcess } from "./clone-process.ts";
import { loadAdapter } from "./adapter.ts";
import { batchOf } from "./fidelity.ts";
import { checkLock, loadFixtures, sha256, targetDir, type Split } from "./fixtures.ts";
import { diff, PolicySchema } from "./policy.ts";
import { committedLockProblems } from "./verify.ts";

export async function explain(target: string, splits: Split[], port: number): Promise<void> {
  const problems = [...checkLock(target), ...committedLockProblems(target)];
  if (problems.length > 0) {
    throw new Error(
      `evaluator integrity check failed, refusing to explain:\n  ${problems.join("\n  ")}`,
    );
  }
  const fixtures = loadFixtures(target, splits);
  const held = fixtures.filter((f) => f.split === "holdout");
  if (held.length > 0) {
    const out = join(targetDir(target), "verify");
    mkdirSync(out, { recursive: true });
    const sets = [
      ...new Set(held.map((f) => (f.id.startsWith("hold-") ? batchOf(f.id) : "hash"))),
    ].sort();
    const line = {
      at: new Date().toISOString(),
      by: "explain",
      splits,
      holdout: { pass: null, total: held.length },
      lock: sha256(readFileSync(join(targetDir(target), "fixtures.lock"), "utf8")).slice(0, 12),
      sets,
    };
    appendFileSync(join(out, "runs.jsonl"), `${JSON.stringify(line)}\n`);
  }
  const policy = PolicySchema.parse(
    JSON.parse(readFileSync(join(targetDir(target), "policy.json"), "utf8")),
  );
  const adapter = await loadAdapter(target);
  const clone = await startCloneProcess(target, adapter.cloneEntry, port);
  try {
    for (const f of fixtures) {
      await fetch(`${clone.url}/__reset`, { method: "POST" });
      const actual = await adapter.run(f, { kind: "clone", url: clone.url });
      const fieldsIgnored = f.noise.map((path) => ({
        path,
        mode: "ignore" as const,
        why: "noise",
      }));
      const d = diff(
        { ...policy, fields: [...policy.fields, ...fieldsIgnored] },
        f.observed,
        actual,
      );
      if (d.length === 0) continue;
      console.log(`== ${f.id} (${f.split}; ${f.rules.join(", ")}): ${d.length} field(s)`);
      console.log(`   input ${JSON.stringify(f.input)}`);
      for (const x of d.slice(0, 12)) {
        console.log(`   ${x.path}: ${JSON.stringify(x.expected)} => ${JSON.stringify(x.actual)}`);
      }
    }
  } finally {
    await clone.close();
  }
}
