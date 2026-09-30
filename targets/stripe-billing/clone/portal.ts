/**
 * Customer Portal: configurations and sessions (public API), the portal's own JSON endpoints under
 * `/v1/billing_portal/sessions/<bps>/...` that the page calls, and the page itself. The JSON
 * endpoints return display-ready strings; the page only lays them out.
 */
import { z } from "zod";
import type { CloneRequest } from "../../../harness/src/clone-kit.ts";
import type { Json } from "../../../harness/src/json.ts";
import { parse, type Handler } from "./api.ts";
import {
  ACCOUNT,
  ApiError,
  activeDiscounts,
  couponOf,
  customerNow,
  discountOn,
  draftFor,
  must,
  priceOf,
  prorationLines,
  totals,
  type Draft,
} from "./billing.ts";
import { longDate, monthDay, money, shortRange } from "./format.ts";
import { setCancelAtPeriodEnd } from "./life.ts";
import { portalHtml } from "./portal-page.ts";
import { mint, type PortalSession, type State, type Subscription } from "./state.ts";

const ConfigurationBody = z.object({
  features: z.object({
    payment_method_update: z.object({ enabled: z.enum(["true", "false"]) }).optional(),
    subscription_cancel: z.object({ enabled: z.enum(["true", "false"]) }).optional(),
    subscription_update: z
      .object({
        enabled: z.enum(["true", "false"]),
        default_allowed_updates: z.array(z.string()).optional(),
        proration_behavior: z.enum(["create_prorations", "none", "always_invoice"]).optional(),
        products: z
          .array(z.object({ product: z.string(), prices: z.array(z.string()) }))
          .optional(),
      })
      .optional(),
  }),
});
const SessionBody = z.object({
  customer: z.string(),
  configuration: z.string().optional(),
  return_url: z.string().optional(),
});
const UpdateBody = z.object({ price: z.string() });

function createConfiguration(s: State, body: Json): Json {
  const b = parse(ConfigurationBody, body);
  const update = b.features.subscription_update;
  const updates = update?.enabled === "true";
  if (updates && b.features.payment_method_update?.enabled !== "true") {
    throw new ApiError(
      400,
      "Cannot enable subscription updates while payment method update is disabled.",
    );
  }
  const products = update?.products ?? [];
  for (const p of products) {
    must(s.products[p.product], "product", p.product, "features[subscription_update][products]");
    const intervals = p.prices.map((id) => priceOf(s, id).interval);
    if (new Set(intervals).size !== intervals.length) {
      throw new ApiError(400, "For each product, its price must have unique billing intervals");
    }
  }
  const id = mint(s, "bpc");
  s.portal_configurations[id] = {
    id,
    products,
    proration_behavior: update?.proration_behavior ?? "none",
    cancel_enabled: b.features.subscription_cancel?.enabled === "true",
    created: 0,
  };
  return {
    id,
    object: "billing_portal.configuration",
    active: true,
    features: {
      payment_method_update: { enabled: b.features.payment_method_update?.enabled === "true" },
      subscription_update: {
        enabled: updates,
        default_allowed_updates: update?.default_allowed_updates ?? [],
        products: products.map((p) => ({ product: p.product, prices: p.prices })),
        proration_behavior: update?.proration_behavior ?? "none",
      },
    },
    is_default: false,
    livemode: false,
    metadata: {},
  };
}

function createSession(s: State, body: Json, origin: string): Json {
  const b = parse(SessionBody, body);
  const customer = must(s.customers[b.customer], "customer", b.customer, "customer");
  const configuration = b.configuration ?? Object.keys(s.portal_configurations)[0];
  if (configuration === undefined) {
    throw new ApiError(
      400,
      "No configuration provided and your default configuration has not been created.",
    );
  }
  must(s.portal_configurations[configuration], "configuration", configuration, "configuration");
  const id = mint(s, "bps");
  const token = `test_${id.slice(4)}`;
  const created = customerNow(s, customer.id);
  s.portal_sessions[id] = { id, customer: customer.id, configuration, token, created };
  return {
    id,
    object: "billing_portal.session",
    configuration,
    created,
    customer: customer.id,
    flow: null,
    livemode: false,
    locale: null,
    on_behalf_of: null,
    return_url: b.return_url ?? null,
    url: `${origin}/p/session/${token}`,
  };
}

const perInterval = (interval: string): string => `per ${interval}`;

function customerSubscriptions(s: State, session: PortalSession): Subscription[] {
  return Object.values(s.subscriptions).filter((x) => x.customer === session.customer);
}

function upcomingFor(s: State, sub: Subscription): Draft {
  const price = priceOf(s, sub.item.price);
  return draftFor(s, sub, {
    target: { price, quantity: sub.item.quantity },
    behavior: "create_prorations",
    prorationDate: null,
    discounts: activeDiscounts(s, sub),
  });
}

function lineLabel(s: State, l: Draft["lines"][number]): string {
  const name = s.products[priceOf(s, l.price).product]?.name ?? "";
  if (!l.proration) return name;
  return l.credit ? `Prorated credit from ${name}` : `Prorated charge for ${name}`;
}

function invoiceSummary(s: State, draft: Draft): Json {
  const t = totals(draft.lines, draft.discounts);
  const groups: { range: string; lines: { label: string; amount: string }[] }[] = [];
  for (const l of draft.lines) {
    const range = shortRange(l.period_start, l.period_end);
    let group = groups.at(-1);
    if (group?.range !== range) {
      group = { range, lines: [] };
      groups.push(group);
    }
    group.lines.push({ label: lineLabel(s, l), amount: money(l.amount) });
  }
  const recurringOnly = draft.lines.every((l) => !l.proration);
  return {
    amount_due: money(t.amount_due),
    subtotal: money(t.subtotal),
    total: money(t.total),
    groups,
    discounts: t.total_discount_amounts.map((d) => {
      const discount = draft.discounts.find((x) => x.id === d.discount);
      const c = discount ? couponOf(s, discount.coupon) : null;
      const label =
        c?.percent_off !== null && c?.percent_off !== undefined
          ? `${c.percent_off}% off`
          : `${money(c?.amount_off ?? 0)} off`;
      return { label, amount: money(-d.amount) };
    }),
    show: !recurringOnly || draft.discounts.length > 0,
    open: draft.discounts.length > 0,
  };
}

function subscriptionSummary(s: State, session: PortalSession, sub: Subscription): Json {
  const config = s.portal_configurations[session.configuration];
  const price = priceOf(s, sub.item.price);
  const gross = price.unit_amount * sub.item.quantity;
  const off = activeDiscounts(s, sub).reduce(
    (sum, d) => sum + discountOn(couponOf(s, d.coupon), gross),
    0,
  );
  return {
    id: sub.id,
    plan: s.products[price.product]?.name ?? "",
    amount: money(gross - off),
    per: perInterval(price.interval),
    next_billing_date: longDate(sub.current_period_end),
    cancel_enabled: config?.cancel_enabled === true,
    cancels: sub.cancel_at_period_end && sub.cancel_at !== null ? monthDay(sub.cancel_at) : null,
    upcoming: invoiceSummary(s, upcomingFor(s, sub)),
  };
}

function plans(s: State, session: PortalSession, sub: Subscription): Json {
  const config = must(
    s.portal_configurations[session.configuration],
    "configuration",
    session.configuration,
    "configuration",
  );
  return {
    id: sub.id,
    current_price: sub.item.price,
    plans: config.products.flatMap((p) =>
      p.prices.map((id) => {
        const price = priceOf(s, id);
        return {
          price: id,
          name: s.products[p.product]?.name ?? "",
          amount: money(price.unit_amount),
          per: perInterval(price.interval),
          current: id === sub.item.price,
        };
      }),
    ),
  };
}

function updatePreview(s: State, sub: Subscription, priceId: string): Json {
  const price = priceOf(s, priceId);
  const discounts = activeDiscounts(s, sub);
  const change = {
    target: { price, quantity: sub.item.quantity },
    behavior: "create_prorations" as const,
    prorationDate: null,
    discounts,
  };
  const upcoming = draftFor(s, sub, change);
  const recurring = upcoming.lines.filter((l) => !l.proration);
  const rt = totals(recurring, discounts);
  return {
    latest_invoice: null,
    upcoming_invoice: invoiceSummary(s, upcoming),
    recurring_invoice: { total: money(rt.total), has_discount: rt.discount > 0 },
    generates_immediate_invoice: false,
    reset_billing_cycle_anchor: false,
    schedule_update_at_period_end: false,
    plan: s.products[price.product]?.name ?? "",
    starting: longDate(sub.current_period_end),
    interval: price.interval === "year" ? "yearly" : "monthly",
  };
}

function applyUpdate(s: State, session: PortalSession, sub: Subscription, priceId: string): Json {
  const price = priceOf(s, priceId);
  const now = customerNow(s, sub.customer);
  const target = { price, quantity: sub.item.quantity };
  const lines = prorationLines(s, sub, target, now, activeDiscounts(s, sub));
  sub.pending.push(...lines);
  sub.item = { ...sub.item, price: price.id };
  return subscriptionSummary(s, session, sub);
}

function sessionOf(s: State, id: string): PortalSession {
  return must(s.portal_sessions[id], "billing portal session", id, "session");
}

function subscriptionOf(s: State, session: PortalSession, id: string): Subscription {
  const sub = customerSubscriptions(s, session).find((x) => x.id === id);
  return must(sub, "subscription", id, "subscription");
}

export function portalRoutes(req: CloneRequest): [string, RegExp, Handler][] {
  const host = req.headers.host;
  const origin = `http://${typeof host === "string" ? host : "127.0.0.1"}`;
  const m = /^\/v1\/billing_portal\/sessions\/(bps_[A-Za-z0-9]+)(?:\/(.*))?$/.exec(req.path);
  const rest = m?.[2] ?? "";
  const subPath = /^subscriptions\/([^/]+)(?:\/(cancel|reactivate|retention_coupon))?$/.exec(rest);
  const sub = subPath?.[1];
  const action = subPath?.[2];
  const routes: [string, RegExp, Handler][] = [
    ["POST", /^\/v1\/billing_portal\/configurations$/, (s, body) => createConfiguration(s, body)],
    ["POST", /^\/v1\/billing_portal\/sessions$/, (s, body) => createSession(s, body, origin)],
  ];
  if (!m) return routes;
  const at = (method: string, handler: (s: State, session: PortalSession) => Json): void => {
    routes.push([
      method,
      /^\/v1\/billing_portal\/sessions\/(bps_[A-Za-z0-9]+)/,
      (s, _b, id) => handler(s, sessionOf(s, id)),
    ]);
  };
  if (rest === "") {
    at("GET", (s, session) => ({
      id: session.id,
      customer: session.customer,
      configuration: session.configuration,
      account: { name: ACCOUNT.name },
    }));
  } else if (rest === "customer") {
    at("GET", (s, session) => ({ id: session.customer, name: null, email: null }));
  } else if (rest === "subscriptions") {
    at("GET", (s, session) => ({
      data: customerSubscriptions(s, session).map((x) => subscriptionSummary(s, session, x)),
    }));
  } else if (rest === "payment_methods") {
    at("GET", (s, session) => {
      const customer = s.customers[session.customer];
      return {
        data: Object.values(s.payment_methods)
          .filter((p) => p.customer === session.customer)
          .map((p) => ({
            id: p.id,
            label: `${p.brand === "visa" ? "Visa" : p.brand} •••• ${p.last4}`,
            expires: `${String(p.exp_month).padStart(2, "0")}/${p.exp_year}`,
            default: customer?.default_payment_method === p.id,
          })),
      };
    });
  } else if (rest === "update_preview") {
    at("GET", (s, session) => {
      const subId = req.query.get("subscription") ?? "";
      return updatePreview(s, subscriptionOf(s, session, subId), req.query.get("price") ?? "");
    });
  } else if (sub !== undefined && action === "retention_coupon") {
    at("GET", (s, session) => ({ subscription: subscriptionOf(s, session, sub).id, coupon: null }));
  } else if (sub !== undefined && action !== undefined) {
    at("POST", (s, session) => {
      const x = subscriptionOf(s, session, sub);
      setCancelAtPeriodEnd(s, x, action === "cancel");
      return subscriptionSummary(s, session, x);
    });
  } else if (sub !== undefined) {
    at("GET", (s, session) => plans(s, session, subscriptionOf(s, session, sub)));
    at("POST", (s, session) =>
      applyUpdate(s, session, subscriptionOf(s, session, sub), parse(UpdateBody, req.body).price),
    );
  }
  return routes;
}

export function portalPage(req: CloneRequest, s: State): string | null {
  const m = /^\/p\/session\/([A-Za-z0-9_]+)$/.exec(req.path);
  if (req.method !== "GET" || !m) return null;
  const session = Object.values(s.portal_sessions).find((x) => x.token === m[1]);
  if (!session) return null;
  return portalHtml(session.id, ACCOUNT.name);
}
