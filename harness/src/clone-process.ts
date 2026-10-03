/**
 * Starts a target's clone in a child process and hands back its URL. The verifier only ever talks
 * to the clone over HTTP: clone code is never imported into the process that scores it.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { RunningClone } from "./adapter.ts";
import { targetDir } from "./fixtures.ts";

function packageJsons(from: string, repo: string): string[] {
  const out: string[] = [];
  for (let d = from; d.startsWith(repo); d = dirname(d)) out.push(join(d, "package.json"));
  return out;
}

export function startCloneProcess(
  target: string,
  entry: string,
  port: number,
): Promise<RunningClone> {
  const runner = join(import.meta.dirname, "clone-runner.ts");
  const repo = join(import.meta.dirname, "..", "..");
  const entryPath = join(targetDir(target), entry);
  // Node's permission model: the clone may read its own folder, the harness and its dependencies,
  // and nothing else, so recorded fixtures (holdout included) are out of its reach by structure.
  const reads = [
    dirname(entryPath),
    join(repo, "harness", "src"),
    join(repo, "node_modules"),
    // Package-scope lookups walk up from each module: those files only, never their folders.
    ...packageJsons(dirname(entryPath), repo),
    join(repo, "harness", "package.json"),
  ];
  const child = spawn(
    process.execPath,
    [
      "--permission",
      ...reads.map((r) => `--allow-fs-read=${r}`),
      // The clone serves HTTP on its port; it gets no file writes, child processes or workers.
      "--allow-net",
      "--disable-warning=ExperimentalWarning",
      // Node runs TypeScript natively: no loader, so no reason to let it read the repository root.
      runner,
      entryPath,
      String(port),
    ],
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
