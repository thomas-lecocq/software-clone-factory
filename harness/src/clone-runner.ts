/**
 * Runs a clone in its own process, so that clone code can never reach the verifier's memory (a
 * clone that patched `JSON.stringify` in-process could fake its own score). Started by
 * `startCloneProcess`; prints one `ready <url>` line, then serves until terminated.
 * Usage: node --import tsx harness/src/clone-runner.ts <entry module> <port>
 */
import { pathToFileURL } from "node:url";

// Type guards, not casts: the module is loaded at run time and checked before it is called.
const isStart = (f: unknown): f is (port: number) => Promise<unknown> => typeof f === "function";

const [entry, port] = process.argv.slice(2);
if (entry === undefined || port === undefined)
  throw new Error("usage: clone-runner <entry> <port>");
const mod: unknown = await import(pathToFileURL(entry).href);
if (typeof mod !== "object" || mod === null || !("startClone" in mod)) {
  throw new Error(`${entry} exports no startClone`);
}
const { startClone } = mod;
if (!isStart(startClone)) throw new Error(`${entry}: no startClone function`);
const clone: unknown = await startClone(Number(port));
if (typeof clone !== "object" || clone === null || !("url" in clone) || !("close" in clone)) {
  throw new Error("startClone did not return { url, close }");
}
const { url, close } = clone;
if (typeof url !== "string" || typeof close !== "function") throw new Error("bad clone handle");
process.stdout.write(`ready ${url}\n`);
// State lives in memory only, so there is nothing to flush: exit at once rather than wait for
// keep-alive connections to drain.
process.on("SIGTERM", () => process.exit(0));
