/**
 * Billing arithmetic: prorations, discounts and the invoice objects built from them. The rules
 * and the fixtures that pin them are in NOTES.md; the rendering copies the shape of the target's
 * invoice objects field for field, because the verifier compares every field.
 */
import type { Json } from "../../../harness/src/json.ts";
import { addMonths, dayMonYear, money, percentLabel } from "./format.ts";
import {
  mint,
  type Coupon,
  type Discount,
  type DiscountAmount,
  type Interval,
  type InvoiceStatus,
  type LineData,
  type Price,
  type State,
  type Subscription,
} from "./state.ts";

export const ACCOUNT = { country: "FR", name: "environnement de test AcmeCo" } as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly param: string | null = null,
    readonly type = "invalid_request_error",
  ) {
    super(message);
  }
}

export function must<T>(value: T | undefined, what: string, id: string, param: string): T {
  if (value === undefined) throw new ApiError(404, `No such ${what}: '${id}'`, param);
  return value;
}

export const priceOf = (s: State, id: string): Price => must(s.prices[id], "price", id, "price");
export const couponOf = (s: State, id: string): Coupon =>
  must(s.coupons[id], "coupon", id, "coupon");
const productName = (s: State, price: Price): string => s.products[price.product]?.name ?? "";
const couponFor = (s: State, d: Discount): Coupon => couponOf(s, d.coupon);

/** The discount a coupon gives on a full-period amount. */
export function discountOn(coupon: Coupon, base: number): number {
  if (coupon.percent_off !== null) return Math.round((base * coupon.percent_off) / 100);
  return Math.min(coupon.amount_off ?? 0, Math.max(base, 0));
}

export function couponLabel(coupon: Coupon): string {
  return coupon.percent_off !== null
    ? percentLabel(coupon.percent_off)
    : money(coupon.amount_off ?? 0);
}

const withQty = (q: number, name: string): string => (q > 1 ? `${q} × ${name}` : name);

export function customerNow(s: State, customerId: string): number {
  const clock = s.customers[customerId]?.test_clock;
  const frozen = clock !== null && clock !== undefined ? s.clocks[clock]?.frozen_time : undefined;
  // Without a test clock the real product uses wall time; every probe runs on a clock.
  return frozen ?? Math.floor(Date.now() / 1000);
}

/** The full-period line of a price, as billed at a renewal or on the first invoice. */
export function periodLine(
  s: State,
  price: Price,
  quantity: number,
  start: number,
  end: number,
  discounts: Discount[],
): LineData {
  const amount = price.unit_amount * quantity;
  return {
    id: mint(s, "il_tmp"),
    amount,
    description: `${quantity} × ${productName(s, price)} (at ${money(price.unit_amount)} / ${price.interval})`,
    period_start: start,
    period_end: end,
    price: price.id,
    quantity,
    discountable: true,
    proration: false,
    credit: false,
    invoice_item: null,
    unit_amount_decimal: String(price.unit_amount),
    discount_amounts: discounts.map((d) => ({
      discount: d.id,
      amount: discountOn(couponFor(s, d), amount),
    })),
  };
}

/** Months in one billing interval. */
export const intervalMonths = (interval: Interval): number => (interval === "year" ? 12 : 1);

/** End of the period that starts at the subscription's current period start, for `interval`. */
export function periodEndFor(sub: Subscription, interval: Interval, periods = 1): number {
  return addMonths(sub.anchor, sub.cycle_months + periods * intervalMonths(interval));
}

interface Span {
  start: number;
  end: number;
  date: number;
}

const isPercent = (s: State, d: Discount): boolean => couponFor(s, d).percent_off !== null;

const offOf = (s: State, ds: Discount[], base: number): number =>
  ds.reduce((sum, d) => sum + discountOn(couponFor(s, d), base), 0);

/**
 * The prorated amount of a full-period `base` over `span.date -> span.end`, less the prorated
 * discounts (the mode-specific order is in NOTES.md, pass 6). The flexible charge uses
 * `1 - elapsed / P` in floating point, which is what makes 7.5 and 22.5 round down while 1501.5
 * rounds up (t-round-half-*, b-round-half; see NOTES.md, pass 3).
 */
function prorated(
  s: State,
  mode: Subscription["billing_mode"],
  base: number,
  discounts: Discount[],
  span: Span,
  charge: boolean,
): number {
  const p = span.end - span.start;
  const r = span.end - span.date;
  const part = (x: number): number =>
    charge && mode === "flexible"
      ? Math.round(x * (1 - (span.date - span.start) / p))
      : Math.round((x * r) / p);
  if (mode === "classic") {
    // Classic credit prorates the discounted period amount (fresh2-002, t-disc-round-classic-36).
    if (!charge) return Math.max(part(base - offOf(s, discounts, base)), 0);
    // Classic charge prorates the gross amount, then takes an amount-off coupon prorated on its
    // own (fresh-016) and a percent coupon on the prorated line (fresh2-081).
    const gross = part(base);
    const off = discounts.reduce((sum, d) => {
      const c = couponFor(s, d);
      return sum + (isPercent(s, d) ? discountOn(c, gross) : part(discountOn(c, base)));
    }, 0);
    return Math.max(gross - off, 0);
  }
  return Math.max(
    part(base) - discounts.reduce((sum, d) => sum + part(discountOn(couponFor(s, d), base)), 0),
    0,
  );
}

const zeroAmounts = (ds: Discount[]): DiscountAmount[] => {
  const seen = new Set<string>();
  return ds
    .filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
    .map((d) => ({ discount: d.id, amount: 0 }));
};

const withLabel = (s: State, ds: Discount[]): string => {
  const first = ds[0];
  return first ? ` (with ${couponLabel(couponFor(s, first))} off)` : "";
};

export interface Target {
  price: Price;
  quantity: number;
}

/**
 * Credit for the unused time of the current item. `after` are the discounts listed on the line:
 * flexible mode also lists the credited period's own discount unless the caller replaced it.
 */
export function creditLine(
  s: State,
  sub: Subscription,
  date: number,
  listed: Discount[],
): LineData {
  const old = priceOf(s, sub.item.price);
  const q0 = sub.item.quantity;
  const before = sub.period_discount ? [sub.period_discount] : [];
  const span = { start: sub.current_period_start, end: sub.current_period_end, date };
  const credit = prorated(s, sub.billing_mode, old.unit_amount * q0, before, span, false);
  return {
    id: mint(s, "il_tmp"),
    amount: credit === 0 ? 0 : -credit,
    description: `Unused time on ${withQty(q0, productName(s, old))}${withLabel(s, before)} after ${dayMonYear(date)}`,
    period_start: date,
    period_end: span.end,
    price: old.id,
    quantity: q0,
    discountable: false,
    proration: true,
    credit: true,
    invoice_item: mint(s, "ii"),
    unit_amount_decimal: null,
    discount_amounts: zeroAmounts(listed),
  };
}

/** Credit for the unused time of the current item and charge for the rest of the new period. */
export function prorationLines(
  s: State,
  sub: Subscription,
  target: Target,
  prorationDate: number,
  after: Discount[],
  replaced = false,
): LineData[] {
  const q0 = sub.item.quantity;
  if (sub.item.price === target.price.id && q0 === target.quantity) return [];
  if (prorationDate >= sub.current_period_end) return [];
  const before = sub.period_discount ? [sub.period_discount] : [];
  // Flexible mode also lists the spent discount of the credited period; classic does not
  // (rand-039 against d-off500-once-sub). Discounts passed to the preview replace it
  // (b-off300-sub-pct15-preview).
  const listed = sub.billing_mode === "classic" || replaced ? after : [...before, ...after];
  const credit = creditLine(s, sub, prorationDate, listed);
  const newEnd = periodEndFor(sub, target.price.interval);
  const span = { start: sub.current_period_start, end: newEnd, date: prorationDate };
  const base = target.price.unit_amount * target.quantity;
  return [
    credit,
    {
      id: mint(s, "il_tmp"),
      amount: prorated(s, sub.billing_mode, base, after, span, true),
      description: `Remaining time on ${withQty(target.quantity, productName(s, target.price))}${withLabel(s, after)} after ${dayMonYear(prorationDate)}`,
      period_start: prorationDate,
      period_end: newEnd,
      price: target.price.id,
      quantity: target.quantity,
      discountable: false,
      proration: true,
      credit: false,
      invoice_item: mint(s, "ii"),
      unit_amount_decimal: null,
      discount_amounts: zeroAmounts(after),
    },
  ];
}

export interface Draft {
  lines: LineData[];
  discounts: Discount[];
  created: number;
  period_start: number;
  period_end: number;
  next_payment_attempt: number | null;
  auto_advance: boolean;
  proration_date: number;
}

export type Behavior = "create_prorations" | "none" | "always_invoice";

export interface Change {
  target: Target;
  behavior: Behavior;
  prorationDate: number | null;
  /** Discounts of the previewed invoice: the request's, or the subscription's. */
  discounts: Discount[];
  /** True when the request's discounts replace the subscription's. */
  replaced?: boolean;
}

/** The discounts still in force on a subscription: a `once` coupon is spent by the first invoice. */
export function activeDiscounts(s: State, sub: Subscription): Discount[] {
  const d = sub.discount;
  return d && couponFor(s, d).duration !== "once" ? [d] : [];
}

/**
 * Classic mode resets the billing cycle on an interval change (u-year-to-month-classic-60d): an
 * immediate invoice with the credit for the old period and a full new period from now.
 */
function intervalReset(
  s: State,
  sub: Subscription,
  change: Change,
  now: number,
  prd: number,
): Draft {
  const pending = sub.pending.map((l) => ({ ...l, id: mint(s, "il_tmp") }));
  const credit = prd < sub.current_period_end ? [creditLine(s, sub, prd, change.discounts)] : [];
  const { price, quantity } = change.target;
  const end = addMonths(now, intervalMonths(price.interval));
  const line = periodLine(s, price, quantity, now, end, []);
  line.discount_amounts = discountAmountsFor(s, change.discounts, [line]);
  return {
    discounts: change.discounts,
    proration_date: prd,
    lines: [...pending, ...credit, line],
    created: now,
    period_start: now,
    period_end: now,
    next_payment_attempt: null,
    auto_advance: false,
  };
}

/** The invoice a change produces: the next renewal, or an immediate invoice. */
export function draftFor(s: State, sub: Subscription, change: Change): Draft {
  const start = sub.current_period_start;
  const end = sub.current_period_end;
  if (change.prorationDate !== null) {
    if (change.behavior === "none") {
      throw new ApiError(
        400,
        "Cannot specify proration date if no proration is being done",
        "proration_date",
      );
    }
    if (change.prorationDate < start || change.prorationDate > end) {
      throw new ApiError(
        400,
        `Cannot specify proration date outside of current subscription period or current phase. The value should be between ${start} and ${end}.`,
        "proration_date",
      );
    }
  }
  const now = customerNow(s, sub.customer);
  const prd = change.prorationDate ?? now;
  const interval = change.target.price.interval;
  const oldInterval = priceOf(s, sub.item.price).interval;
  if (interval !== oldInterval && change.behavior !== "none") {
    if (sub.billing_mode === "classic") return intervalReset(s, sub, change, now, prd);
    const newEnd = periodEndFor(sub, interval);
    if (prd > newEnd) {
      throw new ApiError(
        400,
        `You cannot specify \`proration_date\` past the updated subscription period end when using flexible billing mode. The value should be less than ${newEnd}.`,
      );
    }
  }
  const prorations =
    change.behavior === "none"
      ? []
      : prorationLines(s, sub, change.target, prd, change.discounts, change.replaced === true);
  const pending = sub.pending.map((l) => ({ ...l, id: mint(s, "il_tmp") }));
  const base = { discounts: change.discounts, proration_date: prd };

  if (change.behavior === "always_invoice") {
    return {
      ...base,
      created: now,
      period_start: now,
      period_end: now,
      lines: [...pending, ...prorations],
      next_payment_attempt: null,
      auto_advance: false,
    };
  }
  // In flexible mode an interval change keeps the anchor (t-month-to-year-*, b-year-to-month):
  // the renewal moves to the end of the new interval counted from the current period start.
  const renewal = periodEndFor(sub, interval);
  const next = periodEndFor(sub, interval, 2);
  const line = periodLine(s, change.target.price, change.target.quantity, renewal, next, []);
  const lines = [...pending, ...prorations, line];
  line.discount_amounts = discountAmountsFor(s, change.discounts, [line]);
  return {
    ...base,
    lines,
    created: renewal,
    period_start: start,
    period_end: renewal,
    next_payment_attempt: renewal + 3600,
    auto_advance: true,
  };
}

/**
 * Invoice-level discount amounts for the discountable lines: a percent applies to each line, an
 * amount is spread over the lines in proportion to their amounts (DSC-03, one line in every dev
 * fixture). Returns the amounts of `lines[0]` when called for one line.
 */
function discountAmountsFor(s: State, discounts: Discount[], lines: LineData[]): DiscountAmount[] {
  const line = lines[0];
  if (!line) return [];
  const total = lines.reduce((sum, l) => sum + Math.max(l.amount, 0), 0);
  return discounts.map((d) => {
    const c = couponFor(s, d);
    if (c.percent_off !== null) return { discount: d.id, amount: discountOn(c, line.amount) };
    const all = discountOn(c, total);
    const share = total === 0 ? 0 : Math.round((all * Math.max(line.amount, 0)) / total);
    return { discount: d.id, amount: share };
  });
}

export interface Totals {
  subtotal: number;
  discount: number;
  total: number;
  amount_due: number;
  ending_balance: number;
  total_discount_amounts: DiscountAmount[];
}

export function totals(lines: LineData[], discounts: Discount[]): Totals {
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const tda = discounts.map((d) => ({
    discount: d.id,
    amount: lines.reduce(
      (sum, l) =>
        sum +
        l.discount_amounts.filter((x) => x.discount === d.id).reduce((a, x) => a + x.amount, 0),
      0,
    ),
  }));
  const discount = tda.reduce((sum, x) => sum + x.amount, 0);
  const total = subtotal - discount;
  return {
    subtotal,
    discount,
    total,
    amount_due: Math.max(total, 0),
    ending_balance: Math.min(total, 0),
    total_discount_amounts: tda,
  };
}

function lineJson(s: State, sub: Subscription, invoice: string, l: LineData): Json {
  const price = priceOf(s, l.price);
  const paid = s.invoices[sub.latest_invoice];
  const credited = paid?.lines.find((x) => x.price === l.price) ?? paid?.lines[0];
  return {
    id: l.id,
    object: "line_item",
    amount: l.amount,
    currency: price.currency,
    description: l.description,
    discount_amounts: l.discount_amounts.map((d) => ({ amount: d.amount, discount: d.discount })),
    discountable: l.discountable,
    discounts: [],
    invoice,
    livemode: false,
    metadata: {},
    parent: {
      invoice_item_details: null,
      subscription_item_details: {
        invoice_item: l.invoice_item,
        proration: l.proration,
        proration_details: {
          credited_items:
            l.credit && paid && credited
              ? { invoice: paid.id, invoice_line_items: [credited.id] }
              : null,
        },
        subscription: sub.id,
        subscription_item: sub.item.id,
      },
      type: "subscription_item_details",
    },
    period: { end: l.period_end, start: l.period_start },
    pretax_credit_amounts: l.discount_amounts.map((d) => ({
      amount: d.amount,
      discount: d.discount,
      type: "discount",
    })),
    pricing: {
      price_details: { price: price.id, product: price.product },
      type: "price_details",
      unit_amount_decimal: l.unit_amount_decimal,
    },
    quantity: l.quantity,
    quantity_decimal: String(l.quantity),
    subtotal: l.amount,
    taxes: [],
  };
}

export interface InvoiceMeta {
  id: string;
  status: InvoiceStatus;
  attempt_count: number;
  billing_reason: string;
  created: number;
  period_start: number;
  period_end: number;
  next_payment_attempt: number | null;
  auto_advance: boolean;
  proration_date: number | null;
}

export function invoiceJson(
  s: State,
  sub: Subscription,
  meta: InvoiceMeta,
  lines: LineData[],
  discounts: Discount[],
): Json {
  const t = totals(lines, discounts);
  const customer = s.customers[sub.customer];
  const paid = meta.status === "paid";
  const finalized = meta.status !== "draft";
  return {
    id: meta.id,
    object: "invoice",
    account_country: ACCOUNT.country,
    account_name: ACCOUNT.name,
    account_tax_ids: null,
    amount_due: t.amount_due,
    amount_overpaid: 0,
    amount_paid: paid ? t.amount_due : 0,
    amount_remaining: paid ? 0 : t.amount_due,
    amount_shipping: 0,
    application: null,
    attempt_count: meta.attempt_count,
    attempted: meta.attempt_count > 0,
    auto_advance: meta.auto_advance,
    automatic_tax: {
      disabled_reason: null,
      enabled: false,
      liability: null,
      provider: null,
      status: null,
    },
    automatically_finalizes_at: null,
    billing_reason: meta.billing_reason,
    collection_method: "charge_automatically",
    created: meta.created,
    currency: "usd",
    custom_fields: null,
    customer: sub.customer,
    customer_account: null,
    customer_address: null,
    customer_email: null,
    customer_name: null,
    customer_phone: null,
    customer_shipping: null,
    customer_tax_exempt: "none",
    customer_tax_ids: [],
    default_payment_method: null,
    default_source: null,
    default_tax_rates: [],
    description: null,
    discounts: discounts.map((d) => d.id),
    due_date: null,
    effective_at: finalized ? meta.created : null,
    ending_balance: finalized ? 0 : t.ending_balance,
    footer: null,
    from_invoice: null,
    hosted_invoice_url: null,
    invoice_pdf: null,
    issuer: { type: "self" },
    last_finalization_error: null,
    latest_revision: null,
    lines: {
      object: "list",
      data: lines.map((l) => lineJson(s, sub, meta.id, l)),
      has_more: false,
      total_count: lines.length,
      url: `/v1/invoices/${meta.id}/lines`,
    },
    livemode: false,
    metadata: {},
    next_payment_attempt: meta.next_payment_attempt,
    number: null,
    on_behalf_of: null,
    parent: {
      quote_details: null,
      subscription_details: {
        metadata: {},
        subscription: sub.id,
        ...(meta.proration_date !== null
          ? { subscription_proration_date: meta.proration_date }
          : {}),
      },
      type: "subscription_details",
    },
    payment_settings: {
      default_mandate: null,
      payment_method_options: null,
      payment_method_types: null,
    },
    period_end: meta.period_end,
    period_start: meta.period_start,
    post_payment_credit_notes_amount: 0,
    pre_payment_credit_notes_amount: 0,
    receipt_number: null,
    rendering: null,
    shipping_cost: null,
    shipping_details: null,
    starting_balance: 0,
    statement_descriptor: null,
    status: meta.status,
    status_transitions: {
      finalized_at: finalized ? meta.created : null,
      marked_uncollectible_at: null,
      paid_at: paid ? meta.created : null,
      voided_at: null,
    },
    subtotal: t.subtotal,
    subtotal_excluding_tax: t.subtotal,
    test_clock: customer?.test_clock ?? null,
    total: t.total,
    total_discount_amounts: t.total_discount_amounts.map((d) => ({
      amount: d.amount,
      discount: d.discount,
    })),
    total_excluding_tax: t.total,
    total_pretax_credit_amounts: t.total_discount_amounts.map((d) => ({
      amount: d.amount,
      discount: d.discount,
      type: "discount",
    })),
    total_taxes: [],
    webhooks_delivered_at: null,
  };
}

export function previewJson(s: State, sub: Subscription, draft: Draft): Json {
  return invoiceJson(
    s,
    sub,
    {
      id: mint(s, "upcoming_in"),
      status: "draft",
      attempt_count: 0,
      billing_reason: "upcoming",
      created: draft.created,
      period_start: draft.period_start,
      period_end: draft.period_end,
      next_payment_attempt: draft.next_payment_attempt,
      auto_advance: draft.auto_advance,
      proration_date: draft.proration_date,
    },
    draft.lines,
    draft.discounts,
  );
}
