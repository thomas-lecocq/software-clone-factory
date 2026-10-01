/**
 * The contract between the harness and a target. A target folder provides one adapter: its
 * designed probes, a way to run a probe against either side, and a way to start its clone.
 * Everything else (recording, locking, diffing, scoring, reporting) is generic.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Json } from "./json.ts";
import { targetDir } from "./fixtures.ts";

export interface Probe {
  id: string;
  rules: string[];
  input: Json;
}

export type Side = { kind: "target" } | { kind: "clone"; url: string };

export interface RunningClone {
  url: string;
  close(): Promise<void>;
}

export interface TargetAdapter {
  probes(): Probe[];
  // Returns named observations, e.g. { preview: <response body> }.
  run(probe: Probe, side: Side): Promise<Record<string, Json>>;
  // The clone's entry module, relative to the target folder, exporting
  // `startClone(port): Promise<RunningClone>`. The harness runs it in a separate process.
  cloneEntry: string;
  // What the recording depended on besides the probe (API and SDK versions), stored with each new
  // fixture so that a later change on the target's side can be told apart from a clone bug.
  recordedWith?(): Record<string, Json>;
}

function isAdapter(v: unknown): v is TargetAdapter {
  return (
    typeof v === "object" &&
    v !== null &&
    "probes" in v &&
    typeof v.probes === "function" &&
    "run" in v &&
    typeof v.run === "function" &&
    "cloneEntry" in v &&
    typeof v.cloneEntry === "string"
  );
}

export async function loadAdapter(target: string): Promise<TargetAdapter> {
  const mod: unknown = await import(pathToFileURL(join(targetDir(target), "adapter.ts")).href);
  const adapter = typeof mod === "object" && mod !== null && "default" in mod ? mod.default : null;
  if (!isAdapter(adapter))
    throw new Error(`targets/${target}/adapter.ts has no valid default export`);
  return adapter;
}
