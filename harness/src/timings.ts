/**
 * What each automatic step cost: one JSON line per probe recorded, per verify run and per agent
 * run, in `targets/<t>/timings.jsonl`. Build cost and run cost are part of what a clone is worth.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { targetDir } from "./fixtures.ts";
import type { Json } from "./json.ts";

export function logTiming(target: string, step: string, entry: Record<string, Json>): void {
  const line = { at: new Date().toISOString(), step, ...entry };
  appendFileSync(join(targetDir(target), "timings.jsonl"), `${JSON.stringify(line)}\n`);
}

export const secondsSince = (start: number): number =>
  Math.round((performance.now() - start) / 100) / 10;
