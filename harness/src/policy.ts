/**
 * The per-field diff policy: how each output field of a target is compared with the clone.
 * Every rule that weakens the comparison carries a one-line justification, so the list of
 * weakened fields is itself a declared blind spot in the report. A `perceptual` field never
 * decides a verdict: its differences are reported apart, with a score.
 */
import { z } from "zod";
import { canonicalIds, flatten, pathMatches, type Json } from "./json.ts";

const Why = z.string().min(5);
const Field = z.discriminatedUnion("mode", [
  z.object({ path: z.string(), mode: z.literal("ignore"), why: Why }),
  z.object({ path: z.string(), mode: z.literal("type"), why: Why }),
  z.object({ path: z.string(), mode: z.literal("tolerance"), by: z.number().positive(), why: Why }),
  z.object({
    path: z.string(),
    mode: z.literal("perceptual"),
    // Share of thumbnail cells allowed to differ before the difference is reported.
    max_share: z.number().min(0).max(1),
    why: Why,
  }),
]);
export type PolicyField = z.infer<typeof Field>;

export const PolicySchema = z.object({
  canonicalIds: z.boolean().describe("rename generated IDs before comparing"),
  fields: z.array(Field),
});
export type Policy = z.infer<typeof PolicySchema>;

export interface FieldDiff {
  path: string;
  expected: Json | undefined;
  actual: Json | undefined;
  // Set on perceptual differences: reported, never counted against the case.
  report?: { share: number };
}

const typeOf = (v: Json | undefined): string =>
  v === undefined ? "absent" : v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

// A thumbnail is "<width>x<height>:<base64 luminance bytes>"; masked cells hold 255 on both sides.
const CELL_DELTA = 24;
export function thumbnailShare(e: Json | undefined, a: Json | undefined): number {
  if (typeof e !== "string" || typeof a !== "string") return 1;
  const [eSize, eData = ""] = e.split(":");
  const [aSize, aData = ""] = a.split(":");
  if (eSize !== aSize) return 1;
  const x = Buffer.from(eData, "base64");
  const y = Buffer.from(aData, "base64");
  if (x.length !== y.length || x.length === 0) return 1;
  let off = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs((x[i] ?? 0) - (y[i] ?? 0)) > CELL_DELTA) off++;
  return off / x.length;
}

function compare(field: PolicyField | undefined, path: string, ev?: Json, av?: Json): FieldDiff[] {
  const d = { path, expected: ev, actual: av };
  switch (field?.mode) {
    case "ignore":
      return [];
    case "type":
      return typeOf(ev) === typeOf(av) ? [] : [d];
    case "tolerance":
      return typeof ev === "number" && typeof av === "number" && Math.abs(ev - av) <= field.by
        ? []
        : [d];
    case "perceptual": {
      const share = thumbnailShare(ev, av);
      return share <= field.max_share ? [] : [{ ...d, report: { share } }];
    }
    case undefined:
      return JSON.stringify(ev) === JSON.stringify(av) ? [] : [d];
  }
}

export function diff(policy: Policy, expected: Json, actual: Json): FieldDiff[] {
  const prep = (v: Json): Map<string, Json> => flatten(policy.canonicalIds ? canonicalIds(v) : v);
  const e = prep(expected);
  const a = prep(actual);
  const out: FieldDiff[] = [];
  for (const path of new Set([...e.keys(), ...a.keys()])) {
    const field = policy.fields.find((f) => pathMatches(f.path, path));
    out.push(...compare(field, path, e.get(path), a.get(path)));
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

export const blocking = (diffs: FieldDiff[]): FieldDiff[] => diffs.filter((d) => !d.report);
