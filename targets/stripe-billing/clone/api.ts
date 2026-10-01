/** The public Stripe API surface the adapter drives (form-encoded v1 endpoints). */
import type { CloneRequest, CloneResponse } from "../../../harness/src/clone-kit.ts";
import type { Json } from "../../../harness/src/json.ts";
import {
  allocate,
  amountDue,
  deferSmall,
  draftFromPlan,
  isPlanError,
  planChange,
  priceOf,
  productName,
  recurringDescription,
  specsOf,
  type Behavior,
  type ItemChange,
} from "./billing.ts";
import { advanceClock, cancelNow } from "./life.ts";
import { couponJson, invoiceJson, priceJson, subscriptionJson } from "./objects.ts";
import {
  get,
  mint,
  nowFor,
  type Discount,
  type Invoice,
  type Line,
  type State,
  type Subscription,
} from "./state.ts";
import { addIntervals, type Interval } from "./time.ts";

type Params = Record<string, Json>;

export const ok = (body: Json): CloneResponse => ({ status: 200, body });
export const fail = (
  status: number,
  message: string,
  param: string | null = null,
): CloneResponse => ({
  status,
  body: { error: { type: "invalid_request_error", message, param } },
});
const missing = (what: string, id: string): CloneResponse =>
  fail(404, `No such ${what}: '${id}'`, "id");

export function str(v: Json | undefined): string | null {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}
export function num(v: Json | undefined): number | null {
  const s = str(v);
  if (s === null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
export function obj(v: Json | undefined): Params {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
}
export function arr(v: Json | undefined): Json[] {
  if (Array.isArray(v)) return v;
  if (v !== null && typeof v === "object") return Object.values(v);
  return [];
}
const bool = (v: Json | undefined): boolean => v === true || v === "true";

function newDiscount(
  state: State,
  coupon: string,
  customer: string,
  sub: string | null,
  now: number,
): Discount {
  const d: Discount = {
    id: mint(state, "di"),
    coupon,
    customer,
    subscription: sub,
    start: now,
    used: false,
  };
  state.discounts[d.id] = d;
  return d;
}

// pm_card_* tokens resolve to a new payment method each time.
function paymentMethodFrom(state: State, token: string, customer: string | null): string {
  if (get(state.payment_methods, token)) return token;
  const id = mint(state, "pm");
  state.payment_methods[id] = { id, customer, fails: token.includes("Fail") };
  return id;
}

// ------------------------------------------------------------------ first invoice

export function billFirstInvoice(state: State, sub: Subscription, now: number): Invoice {
  const id = mint(state, "in");
  const trial = sub.status === "trialing";
  const specs = trial ? [] : specsOf(state, sub.discounts);
  const lines: Line[] = sub.items.map((it) => {
    const p = priceOf(state, it.price);
    return {
      id: mint(state, "il"),
      amount: trial ? 0 : p.unit_amount * it.quantity,
      description: trial
        ? `Free trial for ${it.quantity} × ${productName(state, it.price)}`
        : recurringDescription(state, it.price, it.quantity),
      period: { start: sub.period_start, end: sub.period_end },
      price: it.price,
      quantity: it.quantity,
      proration: false,
      discountable: true,
      discount_amounts: [],
      subscription_item: it.id,
      invoice_item: null,
      credited: null,
      unit_amount_decimal: String(p.unit_amount),
    };
  });
  const alloc = allocate(
    lines.map((l) => l.amount),
    specs,
  );
  lines.forEach((l, i) => {
    l.discount_amounts = specs.map((s, k) => ({ discount: s.id, amount: alloc[k]?.[i] ?? 0 }));
  });
  sub.items.forEach((it, i) => {
    const l = lines[i];
    if (l) it.billed = { invoice: id, line: l.id, amount: l.amount, discounts: l.discount_amounts };
  });
  for (const s of specs) {
    const d = get(state.discounts, s.id);
    if (d && s.once) d.used = true;
  }
  const tda = specs.map((s, k) => ({
    discount: s.id,
    amount: (alloc[k] ?? []).reduce((a, b) => a + b, 0),
  }));
  const inv: Invoice = {
    id,
    customer: sub.customer,
    subscription: sub.id,
    lines,
    discounts: specs.map((s) => s.id),
    total_discount_amounts: tda,
    billing_reason: "subscription_create",
    status: "paid",
    created: now,
    period_start: now,
    period_end: now,
    attempt_count: 0,
    amount_paid: 0,
    auto_advance: false,
    next_payment_attempt: null,
    proration_date: null,
    retries: [],
    starting_balance: 0,
    deferred: 0,
  };
  if (!deferSmall(state, inv)) {
    const due = amountDue(inv);
    inv.amount_paid = due;
    inv.attempt_count = due > 0 ? 1 : 0;
  }
  state.invoices[id] = inv;
  sub.latest_invoice = id;
  return inv;
}

// ------------------------------------------------------------------ handlers

function createSubscription(state: State, p: Params): CloneResponse {
  const customerId = str(p.customer) ?? "";
  const customer = get(state.customers, customerId);
  if (!customer) return missing("customer", customerId);
  const now = nowFor(state, customerId);
  const id = mint(state, "sub");
  const items = arr(p.items).map((raw) => {
    const it = obj(raw);
    return {
      id: mint(state, "si"),
      price: str(it.price) ?? "",
      quantity: num(it.quantity) ?? 1,
      created: now,
      billed: null,
    };
  });
  for (const it of items) if (!get(state.prices, it.price)) return missing("price", it.price);
  const first = items[0];
  const interval: Interval = first ? priceOf(state, first.price).interval : "month";
  const trialDays = num(p.trial_period_days);
  const trialEnd = trialDays !== null ? now + trialDays * 86400 : null;
  const mode = str(obj(p.billing_mode).type) === "classic" ? "classic" : "flexible";
  const sub: Subscription = {
    id,
    customer: customerId,
    items,
    billing_mode: mode,
    discounts: [],
    anchor: trialEnd ?? now,
    period_start: now,
    period_end: trialEnd ?? addIntervals(now, interval, 1),
    status: trialEnd !== null ? "trialing" : "active",
    created: now,
    latest_invoice: null,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    trial_start: trialEnd !== null ? now : null,
    trial_end: trialEnd,
  };
  for (const raw of arr(p.discounts)) {
    const coupon = str(obj(raw).coupon) ?? "";
    if (!get(state.coupons, coupon)) return missing("coupon", coupon);
    sub.discounts.push(newDiscount(state, coupon, customerId, id, now).id);
  }
  state.subscriptions[id] = sub;
  billFirstInvoice(state, sub, now);
  return ok(subscriptionJson(state, sub, false));
}

function previewInvoice(state: State, p: Params): CloneResponse {
  const subId = str(p.subscription) ?? "";
  const sub = get(state.subscriptions, subId);
  if (!sub) return missing("subscription", subId);
  const details = obj(p.subscription_details);
  const changes: ItemChange[] = arr(details.items).map((raw) => {
    const it = obj(raw);
    return { id: str(it.id) ?? "", price: str(it.price), quantity: num(it.quantity) };
  });
  const now = nowFor(state, sub.customer);
  const discounts =
    p.discounts !== undefined
      ? arr(p.discounts).map(
          (raw) => newDiscount(state, str(obj(raw).coupon) ?? "", sub.customer, null, now).id,
        )
      : null;
  const behavior = str(details.proration_behavior) as Behavior | null;
  const plan = planChange(state, sub, {
    changes,
    proration_date: num(details.proration_date),
    behavior,
    discounts,
    now,
  });
  if (isPlanError(plan)) return fail(400, plan.message, plan.param);
  const draft = draftFromPlan(
    state,
    sub,
    plan,
    { line: () => mint(state, "il_tmp"), item: () => mint(state, "ii") },
    sub.billing_mode,
  );
  const inv: Invoice = {
    id: mint(state, "upcoming_in"),
    customer: sub.customer,
    subscription: sub.id,
    lines: draft.lines,
    discounts: draft.discounts,
    total_discount_amounts: draft.total_discount_amounts,
    billing_reason: "upcoming",
    status: "draft",
    created: draft.created,
    period_start: draft.period_start,
    period_end: draft.period_end,
    attempt_count: 0,
    amount_paid: 0,
    auto_advance: !draft.immediate,
    next_payment_attempt: draft.immediate ? null : draft.created + 3600,
    proration_date: plan.proration_date,
    retries: [],
    starting_balance: get(state.customers, sub.customer)?.balance ?? 0,
    deferred: 0,
  };
  return ok(invoiceJson(state, inv, true));
}

function updateSubscription(state: State, sub: Subscription, p: Params): CloneResponse {
  const now = nowFor(state, sub.customer);
  if (p.cancel_at_period_end !== undefined) {
    const on = bool(p.cancel_at_period_end);
    sub.cancel_at_period_end = on;
    sub.cancel_at = on ? sub.period_end : null;
    sub.canceled_at = on ? now : null;
  }
  return ok(subscriptionJson(state, sub, false));
}

function listInvoices(state: State, q: Params): CloneResponse {
  const sub = str(q.subscription);
  const limit = num(q.limit) ?? 10;
  const all = Object.values(state.invoices)
    .filter((i) => sub === null || i.subscription === sub)
    .reverse()
    .slice(0, limit);
  return ok({
    object: "list",
    data: all.map((i) => invoiceJson(state, i, false)),
    has_more: false,
    url: "/v1/invoices",
  });
}

function listInvoiceItems(state: State, q: Params): CloneResponse {
  const customer = str(q.customer);
  const pending = bool(q.pending);
  const items = Object.values(state.invoice_items)
    .filter((i) => customer === null || i.customer === customer)
    .filter((i) => !pending || i.invoice === null)
    .reverse();
  return ok({
    object: "list",
    data: items.map((i) => ({
      id: i.id,
      object: "invoiceitem",
      amount: i.line.amount,
      customer: i.customer,
      description: i.line.description,
      invoice: i.invoice,
      period: { start: i.line.period.start, end: i.line.period.end },
      proration: i.line.proration,
      quantity: i.line.quantity,
    })),
    has_more: false,
    url: "/v1/invoiceitems",
  });
}

export function handleApi(state: State, req: CloneRequest, p: Params): CloneResponse | null {
  const parts = req.path.split("/").filter((s) => s !== "");
  if (parts[0] !== "v1") return null;
  const [, a, b, c, d] = parts;
  const m = req.method;

  if (a === "test_helpers" && b === "test_clocks") {
    if (m === "POST" && c === undefined) {
      const id = mint(state, "clock");
      const t = num(p.frozen_time) ?? 0;
      state.clocks[id] = { id, frozen_time: t, created: t };
      return ok(clockJson(state, id));
    }
    const clock = c !== undefined ? get(state.clocks, c) : undefined;
    if (!clock || c === undefined) return missing("test_clock", c ?? "");
    if (m === "GET") return ok(clockJson(state, c));
    if (m === "POST" && d === "advance") {
      advanceClock(state, clock, num(p.frozen_time) ?? clock.frozen_time);
      return ok(clockJson(state, c));
    }
  }
  if (a === "products" && m === "POST" && b === undefined) {
    const id = mint(state, "prod");
    state.products[id] = { id, name: str(p.name) ?? "" };
    return ok({ id, object: "product", name: str(p.name) ?? "", active: true });
  }
  if (a === "prices" && m === "POST" && b === undefined) {
    const id = mint(state, "price");
    const interval = str(obj(p.recurring).interval) === "year" ? "year" : "month";
    state.prices[id] = {
      id,
      product: str(p.product) ?? "",
      unit_amount: num(p.unit_amount) ?? 0,
      currency: str(p.currency) ?? "usd",
      interval,
    };
    return ok(priceJson(state, id));
  }
  if (a === "coupons" && m === "POST" && b === undefined) {
    const id = mint(state, "coupon");
    const coupon = {
      id,
      percent_off: num(p.percent_off),
      amount_off: num(p.amount_off),
      duration: str(p.duration) === "once" ? ("once" as const) : ("forever" as const),
    };
    state.coupons[id] = coupon;
    return ok(couponJson(coupon));
  }
  if (a === "customers") {
    if (m === "POST" && b === undefined) {
      const id = mint(state, "cus");
      const clock = str(p.test_clock);
      const now = clock ? (get(state.clocks, clock)?.frozen_time ?? 0) : 0;
      const pmToken = str(p.payment_method);
      const pm = pmToken ? paymentMethodFrom(state, pmToken, id) : null;
      state.customers[id] = { id, clock, default_payment_method: pm, created: now, balance: 0 };
      return ok({
        id,
        object: "customer",
        test_clock: clock,
        invoice_settings: { default_payment_method: pm },
      });
    }
    const cus = b !== undefined ? get(state.customers, b) : undefined;
    if (!cus || b === undefined) return missing("customer", b ?? "");
    if (m === "POST" && c === undefined) {
      const dpm = str(obj(p.invoice_settings).default_payment_method);
      if (dpm) cus.default_payment_method = paymentMethodFrom(state, dpm, cus.id);
    }
    return ok({
      id: cus.id,
      object: "customer",
      test_clock: cus.clock,
      invoice_settings: { default_payment_method: cus.default_payment_method },
    });
  }
  if (a === "payment_methods" && b !== undefined && c === "attach" && m === "POST") {
    const id = paymentMethodFrom(state, b, str(p.customer));
    return ok({ id, object: "payment_method", customer: str(p.customer), type: "card" });
  }
  if (a === "subscriptions") {
    if (m === "POST" && b === undefined) return createSubscription(state, p);
    const sub = b !== undefined ? get(state.subscriptions, b) : undefined;
    if (!sub || b === undefined) return missing("subscription", b ?? "");
    if (m === "GET") {
      const expand = arr(p.expand).map(str);
      return ok(subscriptionJson(state, sub, expand.includes("latest_invoice")));
    }
    if (m === "DELETE") {
      cancelNow(state, sub, bool(p.prorate), bool(p.invoice_now));
      return ok(subscriptionJson(state, sub, false));
    }
    if (m === "POST") return updateSubscription(state, sub, p);
  }
  if (a === "invoices") {
    if (m === "POST" && b === "create_preview") return previewInvoice(state, p);
    if (m === "GET" && b === undefined) return listInvoices(state, p);
    if (m === "GET" && b !== undefined) {
      const inv = get(state.invoices, b);
      return inv ? ok(invoiceJson(state, inv, false)) : missing("invoice", b);
    }
  }
  if (a === "invoiceitems" && m === "GET" && b === undefined) return listInvoiceItems(state, p);
  return null;
}

function clockJson(state: State, id: string): Json {
  const c = get(state.clocks, id);
  return {
    id,
    object: "test_helpers.test_clock",
    created: c?.created ?? 0,
    frozen_time: c?.frozen_time ?? 0,
    livemode: false,
    status: "ready",
  };
}
