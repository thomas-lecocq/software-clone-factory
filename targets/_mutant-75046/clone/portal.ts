/**
 * The Customer Portal: the configuration and session API, the portal page, and the JSON
 * endpoints the page calls under /v1/billing_portal/sessions/<bps>/... (UI-01..14).
 */
import type { CloneRequest, CloneResponse } from "../../../harness/src/clone-kit.ts";
import type { Json } from "../../../harness/src/json.ts";
import { arr, fail, num, obj, ok, str } from "./api.ts";
import {
  allocate,
  draftFromPlan,
  isPlanError,
  planChange,
  priceOf,
  productName,
  specsOf,
  type DiscSpec,
  type ItemChange,
} from "./billing.ts";
import { ACCOUNT_NAME, CARD } from "./objects.ts";
import { portalPage } from "./page.ts";
import {
  get,
  mint,
  nowFor,
  type Line,
  type PortalSession,
  type State,
  type Subscription,
} from "./state.ts";

type Params = Record<string, Json>;

// Discounts that will apply to the next renewal (forever coupons; a spent once coupon is gone).
function renewalSpecs(state: State, sub: Subscription): DiscSpec[] {
  return specsOf(state, sub.discounts).filter((s) => !s.once);
}

function couponText(s: DiscSpec): string {
  if (s.percent_off !== null) return `${String(s.percent_off)}% off`;
  return `$${((s.amount_off ?? 0) / 100).toFixed(2)} off`;
}

// The recurring amount of a set of items after the renewal discounts.
function recurringNet(
  state: State,
  sub: Subscription,
  items: { price: string; quantity: number }[],
): number {
  const bases = items.map((it) => priceOf(state, it.price).unit_amount * it.quantity);
  const alloc = allocate(bases, renewalSpecs(state, sub));
  const off = alloc.reduce((a, row) => a + row.reduce((x, y) => x + y, 0), 0);
  return bases.reduce((a, b) => a + b, 0) - off;
}

function pendingLines(state: State, sub: Subscription): Line[] {
  return Object.values(state.invoice_items)
    .filter((ii) => ii.subscription === sub.id || ii.invoice === null)
    .map((ii) => ii.line);
}

// The next invoice of a subscription: pending prorations plus the renewal, discounted.
function upcoming(state: State, sub: Subscription): Json {
  const now = nowFor(state, sub.customer);
  const plan = planChange(state, sub, {
    changes: [],
    proration_date: null,
    behavior: "create_prorations",
    discounts: null,
    now,
  });
  if (isPlanError(plan)) return null;
  let n = 0;
  const draft = draftFromPlan(
    state,
    sub,
    plan,
    {
      line: () => `il_tmp_${String((n += 1))}`,
      item: () => `ii_tmp_${String((n += 1))}`,
    },
    sub.billing_mode,
  );
  const pending = pendingLines(state, sub);
  const lines = [...pending, ...draft.lines];
  const subtotal = lines.reduce((a, l) => a + l.amount, 0);
  const discounts = draft.total_discount_amounts.map((d) => {
    const spec = specsOf(state, [d.discount])[0];
    return { label: spec ? couponText(spec) : "", amount: d.amount };
  });
  const total = subtotal - discounts.reduce((a, d) => a + d.amount, 0);
  const label = (l: Line): string => {
    const name = productName(state, l.price);
    if (!l.proration) return name;
    return l.amount < 0 || l.description.startsWith("Unused")
      ? `Prorated credit from ${name}`
      : `Prorated charge for ${name}`;
  };
  return {
    prorations: pending.map((l) => ({
      label: label(l),
      amount: l.amount,
      start: sub.period_start,
      end: sub.period_end,
    })),
    renewal: draft.lines.map((l) => ({
      label: label(l),
      amount: l.amount,
      quantity: l.quantity,
      start: l.period.start,
      end: l.period.end,
    })),
    subtotal,
    discounts,
    has_discount: discounts.some((d) => d.amount !== 0),
    total,
    amount_due: Math.max(0, total),
  };
}

function subscriptionView(state: State, sub: Subscription): Json {
  return {
    id: sub.id,
    status: sub.status,
    period_start: sub.period_start,
    period_end: sub.period_end,
    cancel_at: sub.cancel_at,
    items: sub.items.map((it) => {
      const p = priceOf(state, it.price);
      return {
        id: it.id,
        price: it.price,
        product: p.product,
        name: productName(state, it.price),
        unit_amount: p.unit_amount,
        interval: p.interval,
        quantity: it.quantity,
      };
    }),
    net: recurringNet(state, sub, sub.items),
    pending: pendingLines(state, sub).length,
    upcoming: upcoming(state, sub),
  };
}

function sessionOf(state: State, id: string): PortalSession | undefined {
  return get(state.sessions, id);
}

function subsOf(state: State, customer: string): Subscription[] {
  return Object.values(state.subscriptions).filter(
    (s) => s.customer === customer && s.status !== "canceled",
  );
}

function sessionApi(
  state: State,
  session: PortalSession,
  method: string,
  rest: string[],
  p: Params,
): CloneResponse {
  const config = get(state.configs, session.configuration);
  const [a, b, c] = rest;
  if (method === "GET" && a === undefined) {
    return ok({
      id: session.id,
      object: "billing_portal.session",
      customer: session.customer,
      account_name: ACCOUNT_NAME,
      configuration: {
        id: session.configuration,
        cancel_enabled: config?.cancel_enabled ?? false,
        allowed_updates: config?.allowed_updates ?? [],
      },
    });
  }
  if (method === "GET" && a === "customer") {
    return ok({ id: session.customer, object: "customer", balance: 0 });
  }
  if (method === "GET" && a === "payment_methods") {
    const cus = get(state.customers, session.customer);
    return ok({
      object: "list",
      data: cus?.default_payment_method
        ? [{ id: cus.default_payment_method, ...CARD, default: true }]
        : [],
    });
  }
  if (method === "GET" && a === "subscriptions" && b === undefined) {
    return ok({
      object: "list",
      data: subsOf(state, session.customer).map((s) => subscriptionView(state, s)),
    });
  }
  if (method === "GET" && a === "update_preview") {
    const sub = subsOf(state, session.customer)[0];
    if (!sub) return fail(404, "No subscription");
    const changes: ItemChange[] = arr(p.items).map((raw) => {
      const it = obj(raw);
      return { id: str(it.id) ?? "", price: str(it.price), quantity: num(it.quantity) };
    });
    const items = sub.items.map((it) => {
      const ch = changes.find((x) => x.id === it.id);
      return { price: ch?.price ?? it.price, quantity: ch?.quantity ?? it.quantity };
    });
    return ok({
      object: "billing_portal.update_preview",
      recurring_amount: recurringNet(state, sub, items),
      has_discount: renewalSpecs(state, sub).length > 0,
      generates_immediate_invoice: false,
      next_billing_date: sub.period_end,
    });
  }
  if (a !== "subscriptions" || b === undefined) return fail(404, "Not found");
  const sub = get(state.subscriptions, b);
  if (!sub || sub.customer !== session.customer) return fail(404, "No such subscription");
  if (method === "GET" && c === undefined) {
    const plans = (config?.products ?? []).flatMap((prod) =>
      prod.prices.map((priceId) => {
        const pr = priceOf(state, priceId);
        return {
          product: prod.product,
          price: priceId,
          name: productName(state, priceId),
          unit_amount: pr.unit_amount,
          interval: pr.interval,
        };
      }),
    );
    return ok({ ...obj(subscriptionView(state, sub)), plans });
  }
  if (method === "GET" && c === "retention_coupon") return ok({ coupon: null });
  const now = nowFor(state, sub.customer);
  if (method === "POST" && c === "cancel") {
    sub.cancel_at = sub.period_end;
    sub.canceled_at = now;
    return ok(subscriptionView(state, sub));
  }
  if (method === "POST" && c === "reactivate") {
    sub.cancel_at = null;
    sub.canceled_at = null;
    sub.cancel_at_period_end = false;
    return ok(subscriptionView(state, sub));
  }
  if (method === "POST" && c === undefined) {
    const changes: ItemChange[] = arr(p.recurring_items).map((raw) => {
      const it = obj(raw);
      return { id: str(it.id) ?? "", price: str(it.price), quantity: num(it.quantity) };
    });
    const plan = planChange(state, sub, {
      changes,
      proration_date: null,
      behavior: "create_prorations",
      discounts: null,
      now,
    });
    if (isPlanError(plan)) return fail(400, plan.message, plan.param);
    for (const l of plan.prorations) {
      const id = mint(state, "ii");
      state.invoice_items[id] = {
        id,
        customer: sub.customer,
        subscription: sub.id,
        line: { ...l, id: "", invoice_item: id },
        invoice: null,
      };
    }
    sub.items.forEach((it) => {
      const next = plan.items.find((x) => x.id === it.id);
      if (next) {
        it.price = next.price;
        it.quantity = next.quantity;
      }
    });
    return ok(subscriptionView(state, sub));
  }
  return fail(404, "Not found");
}

export function handlePortal(state: State, req: CloneRequest, p: Params): CloneResponse | null {
  const parts = req.path.split("/").filter((s) => s !== "");
  if (
    parts[0] === "p" &&
    parts[1] === "session" &&
    parts[2] !== undefined &&
    req.method === "GET"
  ) {
    const id = parts[2].replace(/^test_/, "bps_");
    const session = sessionOf(state, id);
    if (!session) return { status: 404, body: "Not found", contentType: "text/plain" };
    return { status: 200, body: portalPage(session.id), contentType: "text/html; charset=utf-8" };
  }
  if (parts[0] !== "v1" || parts[1] !== "billing_portal") return null;
  const [, , kind, id, ...rest] = parts;
  if (kind === "configurations" && req.method === "POST" && id === undefined) {
    const features = obj(p.features);
    const cancel = obj(features.subscription_cancel);
    const update = obj(features.subscription_update);
    const cfgId = mint(state, "bpc");
    state.configs[cfgId] = {
      id: cfgId,
      cancel_enabled: cancel.enabled === "true",
      allowed_updates: arr(update.default_allowed_updates).map((x) => str(x) ?? ""),
      products: arr(update.products).map((raw) => {
        const pr = obj(raw);
        return { product: str(pr.product) ?? "", prices: arr(pr.prices).map((x) => str(x) ?? "") };
      }),
    };
    return ok({ id: cfgId, object: "billing_portal.configuration" });
  }
  if (kind === "sessions" && req.method === "POST" && id === undefined) {
    const customer = str(p.customer) ?? "";
    if (!get(state.customers, customer)) return fail(404, `No such customer: '${customer}'`);
    const sid = mint(state, "bps");
    state.sessions[sid] = {
      id: sid,
      customer,
      configuration: str(p.configuration) ?? "",
      created: nowFor(state, customer),
    };
    const host = typeof req.headers.host === "string" ? req.headers.host : "127.0.0.1";
    return ok({
      id: sid,
      object: "billing_portal.session",
      customer,
      url: `http://${host}/p/session/${sid.replace(/^bps_/, "test_")}`,
    });
  }
  if (kind === "sessions" && id !== undefined) {
    const session = sessionOf(state, id);
    if (!session) return fail(404, `No such session: '${id}'`);
    return sessionApi(state, session, req.method, rest, p);
  }
  return null;
}
