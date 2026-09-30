/**
 * The per-field diff policy: how each output field of a target is compared with the clone.
 * Every rule that weakens the comparison carries a one-line justification, so the list of
 * ignored fields is itself a declared blind spot in the report.
 */
import { z } from "zod";
import { canonicalIds, flatten, pathMatches, type Json } from "./json.ts";

export const PolicySchema = z.object({
  canonicalIds: z.boolean().describe("rename generated IDs before comparing"),
  fields: z.array(
    z.object({
      path: z.string(),
      mode: z.enum(["ignore", "type"]),
      why: z.string().min(5),
    }),
  ),
});
export type Policy = z.infer<typeof PolicySchema>;

export interface FieldDiff {
  path: string;
  expected: Json | undefined;
  actual: Json | undefined;
}

const typeOf = (v: Json | undefined): string =>
  v === undefined ? "absent" : v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

export function diff(policy: Policy, expected: Json, actual: Json): FieldDiff[] {
  const prep = (v: Json): Map<string, Json> => flatten(policy.canonicalIds ? canonicalIds(v) : v);
  const e = prep(expected);
  const a = prep(actual);
  const modeOf = (path: string): "exact" | "ignore" | "type" =>
    policy.fields.find((f) => pathMatches(f.path, path))?.mode ?? "exact";
  const out: FieldDiff[] = [];
  for (const path of new Set([...e.keys(), ...a.keys()])) {
    const mode = modeOf(path);
    if (mode === "ignore") continue;
    const ev = e.get(path);
    const av = a.get(path);
    const same =
      mode === "type" ? typeOf(ev) === typeOf(av) : JSON.stringify(ev) === JSON.stringify(av);
    if (!same) out.push({ path, expected: ev, actual: av });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}
