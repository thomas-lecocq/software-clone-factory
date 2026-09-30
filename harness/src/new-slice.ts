/**
 * Scaffolds an empty target with the structure every target has, so that a new product starts
 * from the harness's conventions instead of from a copy of the last target. It writes nothing that
 * encodes knowledge of any product: the adapter throws until it is written, the ledger is empty.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { targetDir } from "./fixtures.ts";

const FILES: Record<string, string> = {
  "RECON.md": `# Recon: <target>

Owner: main session. Step 1 of the replicate-slice skill.

## What was done

## Observed

## Still open
`,
  "GAPS.md": `# Gaps: <target>

Owner: main session. Measured divergences, thin rules, what was never compared, blind spots by
design, evaluator integrity. The generated list is \`GAPS.generated.md\`.
`,
  "rules.json": `${JSON.stringify({ rules: [] }, null, 2)}\n`,
  "policy.json": `${JSON.stringify({ canonicalIds: true, fields: [] }, null, 2)}\n`,
  "probes.ts": `/**
 * The designed probe set for this target: per rule, a case that triggers it and a boundary case;
 * interacting rules combined; a seeded random batch with its distribution written down.
 */
import type { Probe } from "../../harness/src/adapter.ts";

export function probes(): Probe[] {
  return [];
}
`,
  "adapter.ts": `/**
 * Runs one probe against the target or the clone with the same code; only the endpoint changes.
 */
import type { Probe, Side, TargetAdapter } from "../../harness/src/adapter.ts";
import type { Json } from "../../harness/src/json.ts";
import { startClone } from "./clone/server.ts";
import { probes } from "./probes.ts";

function run(probe: Probe, side: Side): Promise<Record<string, Json>> {
  return Promise.reject(new Error(\`adapter not written yet (\${probe.id} on \${side.kind})\`));
}

const adapter: TargetAdapter = { probes, run, startClone };
export default adapter;
`,
  "clone/server.ts": `/**
 * The clone. Starts empty: the builder agent implements it against the dev fixtures. State is in
 * memory only and reset by \`POST /__reset\`.
 */
import type { RunningClone } from "../../../harness/src/adapter.ts";
import { startCloneServer, type CloneApp } from "../../../harness/src/clone-kit.ts";

type State = Record<string, never>;

const app: CloneApp<State> = {
  seed: () => ({}),
  handle: (req) => ({ status: 404, body: { error: \`no route \${req.method} \${req.path}\` } }),
};

export function startClone(port: number): Promise<RunningClone> {
  return startCloneServer(app, port);
}
`,
};

export function newSlice(target: string): string[] {
  const dir = targetDir(target);
  if (existsSync(dir)) throw new Error(`targets/${target} already exists`);
  const written: string[] = [];
  for (const [rel, content] of Object.entries(FILES)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content.replaceAll("<target>", target));
    written.push(`targets/${target}/${rel}`);
  }
  return written;
}
