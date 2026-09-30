/**
 * The rule ledger: the slice's specification as a list of rules with provenance. Status is not
 * part of the file; it is computed from a verdict, so no agent can mark a rule as passing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { targetDir } from "./fixtures.ts";

export const RuleSchema = z
  .object({
    id: z.string().regex(/^[A-Z]+-\d{2}$/),
    statement: z.string(),
    area: z.enum(["logic", "ui"]),
    provenance: z.object({
      kind: z.enum(["observed", "documented", "inferred", "mined"]),
      ref: z.string(),
    }),
  })
  .strict();
export type Rule = z.infer<typeof RuleSchema>;

export const LedgerSchema = z.object({ rules: z.array(RuleSchema) }).strict();

export function loadLedger(target: string): Rule[] {
  const raw: unknown = JSON.parse(readFileSync(join(targetDir(target), "rules.json"), "utf8"));
  return LedgerSchema.parse(raw).rules;
}

export type RuleStatus = "verified" | "failing" | "unverified";

export interface RuleResult {
  rule: Rule;
  status: RuleStatus;
  pass: number;
  total: number;
}

export function ruleStatuses(
  rules: Rule[],
  cases: { rules: string[]; pass: boolean }[],
): RuleResult[] {
  return rules.map((rule) => {
    const mine = cases.filter((c) => c.rules.includes(rule.id));
    const pass = mine.filter((c) => c.pass).length;
    const status: RuleStatus =
      mine.length === 0 ? "unverified" : pass === mine.length ? "verified" : "failing";
    return { rule, status, pass, total: mine.length };
  });
}
