/**
 * The public API endpoints the adapter calls: test clocks, products, prices, coupons, customers,
 * subscriptions, invoice previews and invoice retrieval. Request bodies arrive form-encoded and
 * are parsed with zod here, at the boundary.
 */
import { z } from "zod";
import type { Json } from "../../../harness/src/json.ts";
import {
  ApiError,
  activeDiscounts,
  couponOf,
  customerNow,
  draftFor,
  invoiceJson,
  intervalMonths,
  must,
  periodLine,
  previewJson,
  priceOf,
  type Behavior,
} from "./billing.ts";
import { addMonths } from "./format.ts";
import {
  addInvoice,
  advanceClock,
  cancelNow,
  collect,
  setCancelAtPeriodEnd,
  trialEnd,
} from "./life.ts";
import {
  mint,
  mintBare,
  type Discount,
  type Invoice,
  type State,
  type Subscription,
} from "./state.ts";

const num = z.coerce.number();
const int = z.coerce.number().int();

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const param = issue ? issue.path.map(String).join(".") : null;
  throw new ApiError(
    400,
    issue?.code === "invalid_type" && issue.input === undefined
      ? `Missing required param: ${param ?? ""}.`
      : `Invalid value for ${param ?? "request"}.`,
    param,
  );
}

const ClockBody = z.object({ frozen_time: int, name: z.string().optional() });
const ProductBody = z.object({ name: z.string() });
const PriceBody = z.object({
  product: z.string(),
  currency: z.string(),
  unit_amount: int,
  recurring: z.object({ interval: z.enum(["month", "year"]) }),
});
const CouponBody = z.object({
  duration: z.enum(["forever", "once"]),
  percent_off: num.optional(),
  amount_off: int.optional(),
  currency: z.string().optional(),
});
const CustomerBody = z.object({
  test_clock: z.string().optional(),
  payment_method: z.string().optional(),
  invoice_settings: z.object({ default_payment_method: z.string().optional() }).optional(),
  preferred_locales: z.array(z.string()).optional(),
});
const DiscountsParam = z.array(z.object({ coupon: z.string() })).optional();
const SubscriptionBody = z.object({
  customer: z.string(),
  items: z.array(z.object({ price: z.string(), quantity: int.optional() })).min(1),
  billing_mode: z.object({ type: z.enum(["flexible", "classic"]) }).optional(),
  discounts: DiscountsParam,
  trial_period_days: int.optional(),
});
const Flag = z.enum(["true", "false"]).transform((v) => v === "true");
const UpdateSubscriptionBody = z.object({ cancel_at_period_end: Flag.optional() });
const CancelBody = z.object({ prorate: Flag.optional(), invoice_now: Flag.optional() });
const AdvanceBody = z.object({ frozen_time: int });
const AttachBody = z.object({ customer: z.string() });
const UpdateCustomerBody = z.object({
  invoice_settings: z.object({ default_payment_method: z.string().optional() }).optional(),
});
const InvoiceListBody = z.object({ subscription: z.string().optional() });
const Expand = z.object({ expand: z.union([z.array(z.string()), z.string()]).optional() });
const PreviewBody = z.object({
  subscription: z.string(),
  subscription_details: z
    .object({
      items: z
        .array(z.object({ id: z.string(), price: z.string().optional(), quantity: int.optional() }))
        .optional(),
      proration_date: int.optional(),
      proration_behavior: z.enum(["create_prorations", "none", "always_invoice"]).optional(),
    })
    .optional(),
  discounts: DiscountsParam,
});

function clockJson(s: State, id: string): Json {
  const c = must(s.clocks[id], "test clock", id, "test_clock");
  return {
    id: c.id,
    object: "test_helpers.test_clock",
    created: c.frozen_time,
    deletes_after: c.frozen_time + 30 * 86400,
    frozen_time: c.frozen_time,
    livemode: false,
    name: null,
    status: "ready",
    status_details: {},
  };
}

function productJson(s: State, id: string): Json {
  const p = must(s.products[id], "product", id, "product");
  return {
    id: p.id,
    object: "product",
    active: true,
    created: p.created,
    livemode: false,
    name: p.name,
    metadata: {},
    type: "service",
  };
}

function priceJson(s: State, id: string): Json {
  const p = priceOf(s, id);
  return {
    id: p.id,
    object: "price",
    active: true,
    billing_scheme: "per_unit",
    created: p.created,
    currency: p.currency,
    livemode: false,
    metadata: {},
    product: p.product,
    recurring: { interval: p.interval, interval_count: 1, usage_type: "licensed" },
    type: "recurring",
    unit_amount: p.unit_amount,
    unit_amount_decimal: String(p.unit_amount),
  };
}

function couponJson(s: State, id: string): Json {
  const c = couponOf(s, id);
  return {
    id: c.id,
    object: "coupon",
    amount_off: c.amount_off,
    created: c.created,
    currency: c.currency,
    duration: c.duration,
    livemode: false,
    percent_off: c.percent_off,
    valid: true,
  };
}

function customerJson(s: State, id: string): Json {
  const c = must(s.customers[id], "customer", id, "customer");
  return {
    id: c.id,
    object: "customer",
    balance: 0,
    created: c.created,
    email: null,
    invoice_settings: { default_payment_method: c.default_payment_method },
    livemode: false,
    metadata: {},
    name: null,
    preferred_locales: c.preferred_locales,
    test_clock: c.test_clock,
  };
}

export function subscriptionJson(s: State, sub: Subscription, expand: string[] = []): Json {
  const price = sub.item.price;
  const latest = s.invoices[sub.latest_invoice];
  return {
    id: sub.id,
    object: "subscription",
    billing_cycle_anchor: sub.anchor,
    billing_mode: { type: sub.billing_mode },
    cancel_at: sub.cancel_at,
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: sub.canceled_at,
    created: sub.created,
    currency: "usd",
    customer: sub.customer,
    discounts: activeDiscounts(s, sub).map((d) => d.id),
    ended_at: sub.ended_at,
    items: {
      object: "list",
      data: [
        {
          id: sub.item.id,
          object: "subscription_item",
          current_period_end: sub.current_period_end,
          current_period_start: sub.current_period_start,
          discounts: [],
          price: priceJson(s, price),
          quantity: sub.item.quantity,
          subscription: sub.id,
        },
      ],
      has_more: false,
      total_count: 1,
      url: `/v1/subscription_items?subscription=${sub.id}`,
    },
    latest_invoice:
      expand.includes("latest_invoice") && latest
        ? storedInvoiceJson(s, latest)
        : sub.latest_invoice,
    livemode: false,
    metadata: {},
    status: sub.status,
    test_clock: s.customers[sub.customer]?.test_clock ?? null,
    trial_end: sub.trial_end,
  };
}

const PM_CARD = { brand: "visa", last4: "4242", exp_month: 9, exp_year: 2027 } as const;
// Test tokens the clone knows. The failing card attaches, then declines every charge.
const TEST_CARDS: Record<string, { last4: string; declines: boolean }> = {
  pm_card_visa: { last4: "4242", declines: false },
  pm_card_chargeCustomerFail: { last4: "0341", declines: true },
};

function attachCard(s: State, customer: string, token: string): string {
  const card = TEST_CARDS[token];
  if (card === undefined) {
    throw new ApiError(404, `No such PaymentMethod: '${token}'`, "payment_method");
  }
  const id = mint(s, "pm");
  s.payment_methods[id] = { id, customer, ...PM_CARD, ...card };
  return id;
}

function paymentMethodJson(s: State, id: string): Json {
  const p = must(s.payment_methods[id], "payment method", id, "payment_method");
  return {
    id: p.id,
    object: "payment_method",
    card: { brand: p.brand, exp_month: p.exp_month, exp_year: p.exp_year, last4: p.last4 },
    customer: p.customer,
    livemode: false,
    type: "card",
  };
}

function createSubscription(s: State, body: Json): Json {
  const b = parse(SubscriptionBody, body);
  const customer = must(s.customers[b.customer], "customer", b.customer, "customer");
  const first = b.items[0];
  if (!first) throw new ApiError(400, "Missing required param: items.", "items");
  const price = priceOf(s, first.price);
  const quantity = first.quantity ?? 1;
  const coupon = b.discounts?.[0]?.coupon;
  const discount: Discount | null =
    coupon !== undefined ? { id: mint(s, "di"), coupon: couponOf(s, coupon).id } : null;
  const start = customerNow(s, customer.id);
  const trial = b.trial_period_days !== undefined ? trialEnd(start, b.trial_period_days) : null;
  const sub: Subscription = {
    id: mint(s, "sub"),
    customer: customer.id,
    billing_mode: b.billing_mode?.type ?? "flexible",
    item: { id: mint(s, "si"), price: price.id, quantity },
    anchor: trial ?? start,
    cycle_months: 0,
    current_period_start: start,
    current_period_end: trial ?? addMonths(start, intervalMonths(price.interval)),
    status: trial !== null ? "trialing" : "active",
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    trial_end: trial,
    discount,
    period_discount: discount,
    latest_invoice: "",
    invoices: [],
    pending: [],
    created: start,
  };
  s.subscriptions[sub.id] = sub;
  const line = periodLine(
    s,
    price,
    quantity,
    start,
    sub.current_period_end,
    discount ? [discount] : [],
  );
  line.id = mint(s, "il");
  if (trial !== null) {
    line.amount = 0;
    line.description = `Free trial for ${String(quantity)} × ${s.products[price.product]?.name ?? ""}`;
    line.discount_amounts = [];
  }
  const invoice = addInvoice(s, sub, {
    lines: [line],
    discounts: discount ? [discount] : [],
    billing_reason: "subscription_create",
    created: start,
    period_start: start,
    period_end: start,
  });
  collect(s, invoice, start);
  return subscriptionJson(s, sub);
}

function createPreview(s: State, body: Json): Json {
  const b = parse(PreviewBody, body);
  const sub = must(s.subscriptions[b.subscription], "subscription", b.subscription, "subscription");
  const details = b.subscription_details;
  const item = details?.items?.find((i) => i.id === sub.item.id);
  const price = priceOf(s, item?.price ?? sub.item.price);
  const changed = price.id !== sub.item.price;
  const discounts: Discount[] =
    b.discounts !== undefined
      ? b.discounts.map((d) => ({ id: mint(s, "di"), coupon: couponOf(s, d.coupon).id }))
      : activeDiscounts(s, sub);
  const behavior: Behavior = details?.proration_behavior ?? "create_prorations";
  const draft = draftFor(s, sub, {
    // A new price without a quantity starts again at quantity 1 (rand-004, rand-011).
    target: { price, quantity: item?.quantity ?? (changed ? 1 : sub.item.quantity) },
    behavior,
    prorationDate: details?.proration_date ?? null,
    discounts,
    replaced: b.discounts !== undefined,
  });
  return previewJson(s, sub, draft);
}

function storedInvoiceJson(s: State, inv: Invoice): Json {
  const sub = must(s.subscriptions[inv.subscription], "subscription", inv.subscription, "id");
  return invoiceJson(
    s,
    sub,
    {
      id: inv.id,
      status: inv.status,
      attempt_count: inv.attempt_count,
      billing_reason: inv.billing_reason,
      created: inv.created,
      period_start: inv.period_start,
      period_end: inv.period_end,
      next_payment_attempt: inv.next_attempt,
      auto_advance: inv.status !== "paid",
      proration_date: null,
    },
    inv.lines,
    inv.discounts,
  );
}

function retrieveInvoice(s: State, id: string): Json {
  return storedInvoiceJson(s, must(s.invoices[id], "invoice", id, "invoice"));
}

function listInvoices(s: State, body: Json): Json {
  const b = parse(InvoiceListBody, body);
  const data = Object.values(s.invoices)
    .filter((inv) => b.subscription === undefined || inv.subscription === b.subscription)
    .reverse()
    .map((inv) => storedInvoiceJson(s, inv));
  return { object: "list", data, has_more: false, url: "/v1/invoices" };
}

const subscriptionOf = (s: State, id: string): Subscription =>
  must(s.subscriptions[id], "subscription", id, "subscription");

function expandOf(body: Json): string[] {
  const e = parse(Expand, body).expand;
  return e === undefined ? [] : Array.isArray(e) ? e : [e];
}

export type Handler = (s: State, body: Json, id: string) => Json;

export const apiRoutes: [string, RegExp, Handler][] = [
  [
    "POST",
    /^\/v1\/test_helpers\/test_clocks$/,
    (s, body) => {
      const b = parse(ClockBody, body);
      const id = mint(s, "clock");
      s.clocks[id] = { id, frozen_time: b.frozen_time };
      return clockJson(s, id);
    },
  ],
  ["GET", /^\/v1\/test_helpers\/test_clocks\/([^/]+)$/, (s, _b, id) => clockJson(s, id)],
  [
    "POST",
    /^\/v1\/test_helpers\/test_clocks\/([^/]+)\/advance$/,
    (s, body, id) => {
      must(s.clocks[id], "test clock", id, "test_clock");
      advanceClock(s, id, parse(AdvanceBody, body).frozen_time);
      return clockJson(s, id);
    },
  ],
  [
    "POST",
    /^\/v1\/products$/,
    (s, body) => {
      const b = parse(ProductBody, body);
      const id = mint(s, "prod");
      s.products[id] = { id, name: b.name, created: 0 };
      return productJson(s, id);
    },
  ],
  ["GET", /^\/v1\/products\/([^/]+)$/, (s, _b, id) => productJson(s, id)],
  [
    "POST",
    /^\/v1\/prices$/,
    (s, body) => {
      const b = parse(PriceBody, body);
      must(s.products[b.product], "product", b.product, "product");
      const id = mint(s, "price");
      s.prices[id] = {
        id,
        product: b.product,
        unit_amount: b.unit_amount,
        currency: b.currency,
        interval: b.recurring.interval,
        created: 0,
      };
      return priceJson(s, id);
    },
  ],
  ["GET", /^\/v1\/prices\/([^/]+)$/, (s, _b, id) => priceJson(s, id)],
  [
    "POST",
    /^\/v1\/coupons$/,
    (s, body) => {
      const b = parse(CouponBody, body);
      if (b.percent_off === undefined && b.amount_off === undefined) {
        throw new ApiError(400, "Missing required param: percent_off.", "percent_off");
      }
      const id = mintBare(s);
      s.coupons[id] = {
        id,
        percent_off: b.percent_off ?? null,
        amount_off: b.amount_off ?? null,
        currency: b.currency ?? null,
        duration: b.duration,
        created: 0,
      };
      return couponJson(s, id);
    },
  ],
  ["GET", /^\/v1\/coupons\/([^/]+)$/, (s, _b, id) => couponJson(s, id)],
  [
    "POST",
    /^\/v1\/customers$/,
    (s, body) => {
      const b = parse(CustomerBody, body);
      if (b.test_clock !== undefined)
        must(s.clocks[b.test_clock], "test clock", b.test_clock, "test_clock");
      const id = mint(s, "cus");
      const created = b.test_clock !== undefined ? (s.clocks[b.test_clock]?.frozen_time ?? 0) : 0;
      const pm = b.payment_method !== undefined ? attachCard(s, id, b.payment_method) : null;
      const wantsDefault = b.invoice_settings?.default_payment_method !== undefined;
      s.customers[id] = {
        id,
        test_clock: b.test_clock ?? null,
        default_payment_method: wantsDefault ? pm : null,
        preferred_locales: b.preferred_locales ?? [],
        created,
      };
      return customerJson(s, id);
    },
  ],
  ["GET", /^\/v1\/customers\/([^/]+)$/, (s, _b, id) => customerJson(s, id)],
  [
    "POST",
    /^\/v1\/customers\/([^/]+)$/,
    (s, body, id) => {
      const c = must(s.customers[id], "customer", id, "customer");
      const pm = parse(UpdateCustomerBody, body).invoice_settings?.default_payment_method;
      if (pm !== undefined) {
        must(s.payment_methods[pm], "payment method", pm, "default_payment_method");
        c.default_payment_method = pm;
      }
      return customerJson(s, id);
    },
  ],
  [
    "POST",
    /^\/v1\/payment_methods\/([^/]+)\/attach$/,
    (s, body, token) => {
      const customer = parse(AttachBody, body).customer;
      must(s.customers[customer], "customer", customer, "customer");
      return paymentMethodJson(s, attachCard(s, customer, token));
    },
  ],
  ["POST", /^\/v1\/subscriptions$/, (s, body) => createSubscription(s, body)],
  [
    "GET",
    /^\/v1\/subscriptions\/([^/]+)$/,
    (s, body, id) => subscriptionJson(s, subscriptionOf(s, id), expandOf(body)),
  ],
  [
    "POST",
    /^\/v1\/subscriptions\/([^/]+)$/,
    (s, body, id) => {
      const sub = subscriptionOf(s, id);
      const b = parse(UpdateSubscriptionBody, body);
      if (b.cancel_at_period_end !== undefined)
        setCancelAtPeriodEnd(s, sub, b.cancel_at_period_end);
      return subscriptionJson(s, sub);
    },
  ],
  [
    "DELETE",
    /^\/v1\/subscriptions\/([^/]+)$/,
    (s, body, id) => {
      const sub = subscriptionOf(s, id);
      const b = parse(CancelBody, body);
      cancelNow(s, sub, b.prorate ?? false, b.invoice_now ?? false);
      return subscriptionJson(s, sub);
    },
  ],
  ["POST", /^\/v1\/invoices\/create_preview$/, (s, body) => createPreview(s, body)],
  ["GET", /^\/v1\/invoices$/, (s, body) => listInvoices(s, body)],
  ["GET", /^\/v1\/invoices\/([^/]+)$/, (s, _b, id) => retrieveInvoice(s, id)],
];
