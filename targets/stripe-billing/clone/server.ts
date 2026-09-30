/**
 * Clone of the Stripe Billing slice: the public API the adapter drives, and the Customer Portal
 * (its own JSON endpoints and its screens). State is in memory only and reset by `POST /__reset`.
 */
import type { RunningClone } from "../../../harness/src/adapter.ts";
import {
  parseNestedForm,
  startCloneServer,
  type CloneApp,
  type CloneRequest,
  type CloneResponse,
} from "../../../harness/src/clone-kit.ts";
import { apiRoutes } from "./api.ts";
import { ApiError } from "./billing.ts";
import { portalPage, portalRoutes } from "./portal.ts";
import { seed, type State } from "./state.ts";

function route(req: CloneRequest, state: State): CloneResponse {
  const page = portalPage(req, state);
  if (page !== null) return { status: 200, body: page, contentType: "text/html; charset=utf-8" };
  // The SDK sends GET and DELETE parameters in the query string.
  const body =
    req.method === "GET" || req.method === "DELETE"
      ? { ...parseNestedForm(req.query), ...req.body }
      : req.body;
  for (const [method, pattern, handler] of [...apiRoutes, ...portalRoutes(req)]) {
    const m = pattern.exec(req.path);
    if (method === req.method && m) {
      return { status: 200, body: handler(state, body, decodeURIComponent(m[1] ?? "")) };
    }
  }
  throw new ApiError(404, `Unrecognized request URL (${req.method}: ${req.path}).`);
}

const app: CloneApp<State> = {
  seed,
  handle: (req, state) => {
    try {
      return route(req, state);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      return {
        status: e.status,
        body: {
          error: {
            type: e.type,
            message: e.message,
            ...(e.param !== null ? { param: e.param } : {}),
          },
        },
      };
    }
  },
};

export function startClone(port: number): Promise<RunningClone> {
  return startCloneServer(app, port);
}
