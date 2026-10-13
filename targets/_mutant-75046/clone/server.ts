/**
 * The clone: the Stripe Billing API slice the adapter drives, and the Customer Portal (its pages
 * and the JSON endpoints they call). State is in memory only and reset by `POST /__reset`.
 */
import type { RunningClone } from "../../../harness/src/adapter.ts";
import {
  parseNestedForm,
  startCloneServer,
  type CloneApp,
} from "../../../harness/src/clone-kit.ts";
import { handleApi } from "./api.ts";
import { handlePortal } from "./portal.ts";
import { seed, type State } from "./state.ts";

const app: CloneApp<State> = {
  seed,
  handle: (req, state) => {
    const params = { ...parseNestedForm(req.query), ...req.body };
    const portal = handlePortal(state, req, params);
    if (portal) return portal;
    const api = handleApi(state, req, params);
    if (api) return api;
    return {
      status: 404,
      body: {
        error: {
          type: "invalid_request_error",
          message: `Unrecognized request URL (${req.method}: ${req.path}).`,
        },
      },
    };
  },
};

export function startClone(port: number): Promise<RunningClone> {
  return startCloneServer(app, port);
}
