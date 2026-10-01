/**
 * JSON helpers shared by the recorder and the verifier: a stable flattening of any value into
 * `path -> leaf` pairs, and canonical renaming of generated IDs so that two systems that mint
 * different IDs can still be compared on the references between objects.
 */

import { z } from "zod";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);

export function flatten(
  value: Json,
  prefix = "",
  out = new Map<string, Json>(),
): Map<string, Json> {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix, []);
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) out.set(prefix, {});
    for (const k of keys) flatten(value[k] ?? null, prefix === "" ? k : `${prefix}.${k}`, out);
  } else {
    out.set(prefix, value);
  }
  return out;
}

// A path pattern uses `[*]` for any index, `*` for any single key segment, and a trailing `.**`
// for the whole subtree under a path.
export function pathMatches(pattern: string, path: string): boolean {
  const subtree = pattern.endsWith(".**");
  const re = (subtree ? pattern.slice(0, -3) : pattern)
    .split(/(\[\*\]|\*)/)
    .map((part) => {
      if (part === "[*]") return String.raw`\[\d+\]`;
      if (part === "*") return String.raw`[^.\[]+`;
      return part.replace(/[.[\]()^$+?{}|\\]/g, (c) => `\\${c}`);
    })
    .join("");
  return new RegExp(`^${re}${subtree ? String.raw`(?:[.[].*)?` : ""}$`).test(path);
}

const GENERATED_ID = /^([a-z]+(?:_[a-z]+)*)_([A-Za-z0-9]{8,})$/;

// Replaces every generated ID with `<prefix>#<n>`, n being the order of first appearance in a
// key-sorted traversal. Equal IDs stay equal, so references between objects are still checked.
export function canonicalIds(value: Json): Json {
  const seen = new Map<string, string>();
  const counters = new Map<string, number>();
  const rename = (s: string): string => {
    const m = GENERATED_ID.exec(s);
    if (!m?.[1]) return s;
    const known = seen.get(s);
    if (known) return known;
    const n = (counters.get(m[1]) ?? 0) + 1;
    counters.set(m[1], n);
    const name = `${m[1]}#${n}`;
    seen.set(s, name);
    return name;
  };
  const walk = (v: Json): Json => {
    if (typeof v === "string") {
      return v.replace(/[a-z]+(?:_[a-z]+)*_[A-Za-z0-9]{8,}/g, (id) => rename(id));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const o: Record<string, Json> = {};
      for (const k of Object.keys(v).sort()) o[k] = walk(v[k] ?? null);
      return o;
    }
    return v;
  };
  return walk(value);
}
