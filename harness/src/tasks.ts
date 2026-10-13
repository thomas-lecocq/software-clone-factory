/**
 * Task validation without training: does an agent behave the same in the clone as in the
 * original? Each task is given, in plain words, to an agent in the agent container, once against
 * the clone and once against the target's test mode. The agent reaches either through a local
 * proxy that adds the credentials (so the agent never holds them) and logs every request, which
 * gives the same action trace on both sides. The target module defines the tasks: how to set up
 * a world, what to ask, and how to check the outcome through its own API.
 * Usage: npx tsx harness/src/tasks.ts <target> [--reps 2] [--model claude-sonnet-5-5] [--only id,id]
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { Side } from "./adapter.ts";
import { loadAdapter } from "./adapter.ts";
import { startCloneProcess } from "./clone-process.ts";
import { targetDir } from "./fixtures.ts";
import { canonicalIds, type Json } from "./json.ts";

export interface TaskDefinition {
  id: string;
  // Builds the starting state on one side and returns the facts the instruction names (IDs).
  setup(side: Side): Promise<Record<string, string>>;
  instruction(facts: Record<string, string>): string;
  check(
    side: Side,
    facts: Record<string, string>,
    answer: string | null,
  ): Promise<{ success: boolean; detail: Json }>;
}

export interface TaskModule {
  tasks: TaskDefinition[];
  // What every task's prompt starts with: how to reach the API, and the expected answer format.
  preamble: string;
  // Where the proxy forwards to on each side, and the headers it adds (credentials included).
  upstream(side: Side): { url: string; headers: Record<string, string> };
}

interface Proxy {
  url: string;
  log: string[];
  close(): Promise<void>;
}

// Listens on the loopback only: the container reaches it through host.docker.internal, nothing
// else on the network can, and the credentials it adds never leave this process.
function startProxy(
  upstream: { url: string; headers: Record<string, string> },
  port: number,
): Promise<Proxy> {
  const log: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const url = new URL(req.url ?? "/", "http://proxy");
      log.push(`${req.method ?? "GET"} ${url.pathname}`);
      const headers: Record<string, string> = { ...upstream.headers };
      const type = req.headers["content-type"];
      if (typeof type === "string") headers["content-type"] = type;
      fetch(`${upstream.url}${url.pathname}${url.search}`, {
        method: req.method ?? "GET",
        headers,
        ...(body !== "" && req.method !== "GET" ? { body } : {}),
      })
        .then(async (r) => {
          res.writeHead(r.status, {
            "content-type": r.headers.get("content-type") ?? "application/json",
          });
          res.end(await r.text());
        })
        .catch((e: unknown) => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: String(e) } }));
        });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://host.docker.internal:${String(port)}`,
        log,
        close: () =>
          new Promise((r) =>
            server.close(() => {
              r();
            }),
          ),
      });
    });
  });
}

const Totals = z.object({
  result: z.string(),
  duration_ms: z.number(),
  total_cost_usd: z.number(),
  num_turns: z.number(),
});

// Asynchronous on purpose: the proxy lives in this process, and a blocking spawn would freeze the
// event loop so that the agent's requests could never be answered.
function runAgent(
  repo: string,
  model: string,
  api: string,
  prompt: string,
): Promise<z.infer<typeof Totals> | null> {
  const child = spawn(
    "docker",
    [
      ...[
        "run",
        "--rm",
        "--env-file",
        join(repo, ".agent.env"),
        "-e",
        `API_BASE=${api}`,
        "-w",
        "/tmp",
      ],
      "software-clone-factory-agent",
      ...[
        "claude",
        "-p",
        prompt,
        "--model",
        model,
        "--allowedTools",
        "Bash",
        "--output-format",
        "json",
      ],
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString()));
  const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
  return new Promise((resolve) => {
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = Totals.safeParse(JSON.parse(out || "null"));
        resolve(parsed.success ? parsed.data : null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      reps: { type: "string", default: "2" },
      model: { type: "string", default: "claude-sonnet-5-5" },
      only: { type: "string" },
    },
  });
  const target = positionals[0];
  if (target === undefined)
    throw new Error("usage: tasks.ts <target> [--reps n] [--model m] [--only ids]");
  const repo = join(import.meta.dirname, "..", "..");
  const mod: unknown = await import(pathToFileURL(join(targetDir(target), "tasks.ts")).href);
  const TaskModuleShape = z.object({
    default: z.object({
      tasks: z.array(z.unknown()),
      preamble: z.string(),
      upstream: z.function(),
    }),
  });
  if (!TaskModuleShape.safeParse(mod).success)
    throw new Error(`targets/${target}/tasks.ts exports no task module`);
  const tm = (mod as { default: TaskModule }).default; // shape checked just above
  const only = values.only?.split(",");
  const tasks = tm.tasks.filter((t) => only === undefined || only.includes(t.id));
  const adapter = await loadAdapter(target);
  const clone = await startCloneProcess(target, adapter.cloneEntry, 4660);
  const results: Record<string, Json>[] = [];
  let port = 4670;
  try {
    for (const task of tasks) {
      for (let rep = 1; rep <= Number(values.reps); rep += 1) {
        for (const side of [{ kind: "clone", url: clone.url }, { kind: "target" }] as Side[]) {
          if (side.kind === "clone") await fetch(`${clone.url}/__reset`, { method: "POST" });
          const facts = await task.setup(side);
          port += 1;
          const proxy = await startProxy(tm.upstream(side), port);
          const started = performance.now();
          const out = await runAgent(
            repo,
            values.model,
            proxy.url,
            `${tm.preamble}\n${task.instruction(facts)}`,
          );
          await proxy.close();
          const answer =
            out === null ? null : (/ANSWER:\s*(.+)\s*$/m.exec(out.result)?.[1]?.trim() ?? null);
          const check = await task.check(side, facts, answer);
          const trace = proxy.log.map((l) => {
            const c = canonicalIds(l);
            return typeof c === "string" ? c : l;
          });
          results.push({
            task: task.id,
            rep,
            side: side.kind,
            success: check.success,
            answer,
            detail: check.detail,
            trace,
            agent_ok: out !== null,
            seconds: Math.round((performance.now() - started) / 1000),
            cost_usd: out?.total_cost_usd ?? null,
            turns: out?.num_turns ?? null,
          });
          console.log(
            `${task.id} rep ${String(rep)} ${side.kind.padEnd(6)} ${check.success ? "success" : "FAILED "} ${String(trace.length)} calls`,
          );
        }
      }
    }
  } finally {
    await clone.close();
  }
  const pairs = tasks.flatMap((t) =>
    Array.from({ length: Number(values.reps) }, (_, i) => {
      const of = (side: string) =>
        results.find((r) => r.task === t.id && r.rep === i + 1 && r.side === side);
      const c = of("clone");
      const g = of("target");
      return {
        task: t.id,
        rep: i + 1,
        same_outcome: c?.success === g?.success,
        same_trace: JSON.stringify(c?.trace) === JSON.stringify(g?.trace),
        clone: c?.success,
        target: g?.success,
      };
    }),
  );
  const summary = {
    at: new Date().toISOString(),
    target,
    model: values.model,
    reps: Number(values.reps),
    pairs: pairs.length,
    same_outcome: pairs.filter((p) => p.same_outcome).length,
    same_trace: pairs.filter((p) => p.same_trace).length,
    success_clone: pairs.filter((p) => p.clone === true).length,
    success_target: pairs.filter((p) => p.target === true).length,
    cost_usd: results.reduce((n, r) => n + (typeof r.cost_usd === "number" ? r.cost_usd : 0), 0),
    pairs_detail: pairs,
    runs: results,
  };
  const dir = join(targetDir(target), "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `results-${summary.at.replace(/[:.]/g, "-")}.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(
    `same outcome on ${String(summary.same_outcome)} of ${String(pairs.length)} pairs; same calls on ${String(summary.same_trace)}; success clone ${String(summary.success_clone)}, target ${String(summary.success_target)}; $${summary.cost_usd.toFixed(2)}`,
  );
}

await main();
