/**
 * Building blocks every clone needs to be a resettable, deterministic training environment:
 * an HTTP server with `/__reset` and `/__state`, deterministic ID minting, and a parser for the
 * nested form encoding (`a[b][0]=x`) that many web APIs accept.
 */
import { createServer, type IncomingMessage } from "node:http";
import { JsonSchema, type Json } from "./json.ts";
import type { RunningClone } from "./adapter.ts";

export interface CloneRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, Json>;
  headers: Record<string, string | string[] | undefined>;
}

export interface CloneResponse {
  status: number;
  body: Json | string;
  contentType?: string;
}

export interface CloneApp<S> {
  seed(): S;
  handle(req: CloneRequest, state: S): CloneResponse | Promise<CloneResponse>;
}

type Node = Record<string, Json>;

// `items[0][price]=p&items[0][quantity]=2` -> { items: [{ price: "p", quantity: "2" }] }
export function parseNestedForm(params: URLSearchParams): Node {
  const root: Node = {};
  for (const [rawKey, value] of params) {
    const keys = rawKey.split(/\[|\]\[|\]/).filter((k) => k !== "");
    let cur: Json = root;
    keys.forEach((k, i) => {
      const last = i === keys.length - 1;
      const nextIsIndex = /^\d+$/.test(keys[i + 1] ?? "");
      if (Array.isArray(cur)) {
        const idx = Number(k);
        if (last) cur[idx] = value;
        else cur = cur[idx] ??= nextIsIndex ? [] : {};
      } else if (cur !== null && typeof cur === "object") {
        if (last) cur[k] = value;
        else cur = cur[k] ??= nextIsIndex ? [] : {};
      }
    });
  }
  return root;
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Deterministic IDs: same sequence of calls after a reset gives the same IDs.
export function idMinter(): (prefix: string) => string {
  let n = 0;
  return (prefix) => {
    n += 1;
    let x = n * 7919 + 104729;
    let s = "";
    while (s.length < 14) {
      s = (ALPHABET[x % 62] ?? "0") + s;
      x = Math.floor(x / 62) + n * 31;
    }
    return `${prefix}_${s}`;
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString("utf8");
}

export function startCloneServer<S>(app: CloneApp<S>, port: number): Promise<RunningClone> {
  let state = app.seed();
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://clone");
      const raw = await readBody(req);
      const isJson = (req.headers["content-type"] ?? "").includes("json");
      const parsed: unknown = isJson && raw !== "" ? JSON.parse(raw) : null;
      const body: Node =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? Object.fromEntries(Object.entries(parsed))
          : parseNestedForm(new URLSearchParams(raw));
      let out: CloneResponse;
      if (url.pathname === "/__reset" && req.method === "POST") {
        state = app.seed();
        out = { status: 200, body: { reset: true } };
      } else if (url.pathname === "/__state" && req.method === "GET") {
        out = { status: 200, body: JsonSchema.parse(JSON.parse(JSON.stringify(state))) };
      } else {
        const request = {
          method: req.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          body,
          headers: req.headers,
        };
        out = await app.handle(request, state);
      }
      const text = typeof out.body === "string" ? out.body : JSON.stringify(out.body);
      res.writeHead(out.status, { "content-type": out.contentType ?? "application/json" });
      res.end(text);
    })().catch((e: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e) } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
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
