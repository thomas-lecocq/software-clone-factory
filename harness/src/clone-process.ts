/**
 * Starts a target's clone in a child process and hands back its URL. The verifier only ever talks
 * to the clone over HTTP: clone code is never imported into the process that scores it.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { RunningClone } from "./adapter.ts";
import { targetDir } from "./fixtures.ts";

export function startCloneProcess(
  target: string,
  entry: string,
  port: number,
): Promise<RunningClone> {
  const runner = join(import.meta.dirname, "clone-runner.ts");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", runner, join(targetDir(target), entry), String(port)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => {
      resolve();
    }),
  );
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`clone of ${target} did not start within 60 s`));
    }, 60_000);
    let ready = false;
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!ready)
        reject(
          new Error(`clone of ${target} exited with code ${String(code)} before it was ready`),
        );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const url = /^ready (\S+)$/m.exec(out)?.[1];
      if (url === undefined) return;
      clearTimeout(timer);
      ready = true;
      resolve({
        url,
        close: async () => {
          child.kill("SIGTERM");
          await exited;
        },
      });
    });
  });
}
