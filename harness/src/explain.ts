/**
 * Prints the field diffs of failing cases, holdout included, to the terminal only. For the main
 * session's gap analysis: nothing is written to disk, so the builder never sees holdout details.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAdapter } from "./adapter.ts";
import { loadFixtures, targetDir, type Split } from "./fixtures.ts";
import { diff, PolicySchema } from "./policy.ts";

export async function explain(target: string, splits: Split[], port: number): Promise<void> {
  const policy = PolicySchema.parse(
    JSON.parse(readFileSync(join(targetDir(target), "policy.json"), "utf8")),
  );
  const adapter = await loadAdapter(target);
  const clone = await adapter.startClone(port);
  try {
    for (const f of loadFixtures(target, splits)) {
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
