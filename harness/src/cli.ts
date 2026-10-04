/**
 * One entry point for the harness: `record`, `verify` and `serve`, each taking a target name.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startCloneProcess } from "./clone-process.ts";
import { loadAdapter } from "./adapter.ts";
import { checkLock, writeLock, type Split } from "./fixtures.ts";
import { explain } from "./explain.ts";
import { newSlice } from "./new-slice.ts";
import { record } from "./record.ts";
import { verify } from "./verify.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    split: { type: "string", default: "dev" },
    only: { type: "string" },
    rerecord: { type: "string" },
    reason: { type: "string" },
    port: { type: "string", default: "4599" },
  },
});
const [command, target] = positionals;
if (command === undefined || target === undefined) {
  console.error("usage: cli <record|verify|serve> <target> [--split dev|holdout|all] [--only a,b]");
  process.exit(64);
}
const port = Number(values.port);

if (command === "record") {
  if (values.rerecord !== undefined && (values.reason ?? "").length < 10) {
    console.error(
      "--rerecord needs --reason: evidence that the target changed or the recording was wrong",
    );
    process.exit(64);
  }
  await record(target, {
    ...(values.only !== undefined ? { only: values.only.split(",") } : {}),
    ...(values.rerecord !== undefined
      ? { rerecord: { id: values.rerecord, reason: values.reason ?? "" } }
      : {}),
    literalsFile:
      process.env.SCRUB_LITERALS ?? join(import.meta.dirname, "..", "..", ".scrub.json"),
  });
} else if (command === "verify") {
  const splits: Split[] =
    values.split === "all"
      ? ["dev", "holdout"]
      : values.split === "holdout"
        ? ["holdout"]
        : ["dev"];
  process.exit(await verify(target, splits, port));
} else if (command === "new-slice") {
  for (const f of newSlice(target)) console.log(`created ${f}`);
} else if (command === "relock") {
  // Rewrites the lock after a deliberate change to the evaluator code or policy. Never used to
  // absorb a changed fixture: that is a re-record, with its own evidence.
  if ((values.reason ?? "").length < 10) {
    console.error("relock needs --reason: which evaluator file changed and why");
    process.exit(64);
  }
  const problems = checkLock(target).filter(
    (p) =>
      (p.includes("/") && !p.startsWith("dev/") && !p.startsWith("holdout/")) ||
      p.startsWith("policy") ||
      p.startsWith("lock has"),
  );
  const fixtureProblems = checkLock(target).filter(
    (p) => p.startsWith("dev/") || p.startsWith("holdout/"),
  );
  if (fixtureProblems.length > 0) {
    console.error(
      `refusing: fixtures changed, which relock cannot absorb:\n  ${fixtureProblems.join("\n  ")}`,
    );
    process.exit(2);
  }
  writeLock(target);
  console.log(`relocked ${target}: ${values.reason ?? ""}\n  ${problems.join("\n  ")}`);
} else if (command === "explain") {
  const splits: Split[] =
    values.split === "holdout"
      ? ["holdout"]
      : values.split === "all"
        ? ["dev", "holdout"]
        : ["dev"];
  await explain(target, splits, port);
} else if (command === "serve") {
  const clone = await startCloneProcess(target, (await loadAdapter(target)).cloneEntry, port);
  console.log(`clone of ${target} listening on ${clone.url}`);
} else {
  console.error(`unknown command ${command}`);
  process.exit(64);
}
