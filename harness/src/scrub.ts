/**
 * Removes secrets and personal data from recorded observations before they reach the repo.
 * Literal replacements (account names and the like) come from a file outside the repository, so
 * the mapping itself is never committed.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Json } from "./json.ts";

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b[sprk]k_(test|live)_[A-Za-z0-9]+/g, "key_REDACTED"],
  [/secret=[^&"\s]+/g, "secret=REDACTED"],
  [/[\w.+-]+@[\w-]+\.[a-z.]{2,}/gi, "user@example.com"],
];

const LiteralMap = z.record(z.string(), z.string());

export function loadLiterals(file: string | undefined): Record<string, string> {
  if (file === undefined || !existsSync(file)) return {};
  return LiteralMap.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function scrub(value: Json, literals: Record<string, string>): Json {
  if (typeof value === "string") {
    let s = value;
    for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
    for (const [from, to] of Object.entries(literals)) s = s.split(from).join(to);
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, literals));
  if (value !== null && typeof value === "object") {
    const o: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) o[k] = scrub(v, literals);
    return o;
  }
  return value;
}

// Used by the pre-commit test on committed fixtures.
export function findSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const [re] of SECRET_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (!["key_REDACTED", "secret=REDACTED", "user@example.com"].includes(m[0])) hits.push(m[0]);
    }
  }
  if (/authorization|set-cookie/i.test(text)) hits.push("auth header");
  return hits;
}
