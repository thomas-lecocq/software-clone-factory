/**
 * The subscription lifecycle over test-clock time (slice 2): renewals, trial end, cancellation,
 * payment attempts and retries. Everything happens when a clock is advanced, in time order, so
 * the same script always gives the same invoices. The rules and the fixtures that pin them are in
 * NOTES.md, passes 4 and 5.
 */
import {
  activeDiscounts,
  creditLine,
  customerNow,
  intervalMonths,
  periodEndFor,
  periodLine,
  priceOf,
  totals,
} from "./billing.ts";
import {
  mint,
  type Discount,
  type Invoice,
  type LineData,
  type State,
  type Subscription,
} from "./state.ts";

/** Finalisation and the first payment attempt come one hour after an invoice is created. */
const FIRST_ATTEMPT_DELAY = 3600;
// A guess from one observation (l-payment-fails-retries: 3 attempts 5 days after the first).
const RETRY_EVERY = 2 * 86400;
const MAX_ATTEMPTS = 4;

interface NewInvoice {
  lines: LineData[];
  discounts: Discount[];
  billing_reason: Invoice["billing_reason"];
  created: number;
  period_start: number;
  period_end: number;
}

export function addInvoice(s: State, sub: Subscription, spec: NewInvoice): Invoice {
  const invoice: Invoice = {
    id: mint(s, "in"),
    customer: sub.customer,
    subscription: sub.id,
    lines: spec.lines,
    discounts: spec.discounts,
    status: "draft",
    billing_reason: spec.billing_reason,
    attempt_count: 0,
    next_attempt: spec.created + FIRST_ATTEMPT_DELAY,
    first_attempt: null,
    created: spec.created,
    period_start: spec.period_start,
    period_end: spec.period_end,
  };
  s.invoices[invoice.id] = invoice;
  sub.invoices.push(invoice.id);
  sub.latest_invoice = invoice.id;
  return invoice;
}

export function amountDue(inv: Invoice): number {
  return totals(inv.lines, inv.discounts).amount_due;
}

/** Finalise the invoice and try to collect it with the customer's default payment method. */
export function collect(s: State, inv: Invoice, at: number): void {
  const sub = s.subscriptions[inv.subscription];
  inv.next_attempt = null;
  if (amountDue(inv) === 0) {
    inv.status = "paid";
    return;
  }
  const customer = s.customers[inv.customer];
  const pm = customer?.default_payment_method ?? null;
  const declines = pm === null || s.payment_methods[pm]?.declines === true;
  inv.attempt_count += 1;
  inv.first_attempt ??= at;
  if (!declines) {
    inv.status = "paid";
    if (sub?.status === "past_due") sub.status = "active";
    return;
  }
  inv.status = "open";
  if (sub && sub.status !== "canceled") sub.status = "past_due";
  if (inv.attempt_count < MAX_ATTEMPTS) {
    inv.next_attempt = inv.first_attempt + inv.attempt_count * RETRY_EVERY;
  }
}

function renew(s: State, sub: Subscription): void {
  const at = sub.current_period_end;
  if (sub.cancel_at_period_end && sub.cancel_at !== null && sub.cancel_at <= at) {
    sub.status = "canceled";
    sub.ended_at = sub.cancel_at;
    return;
  }
  const price = priceOf(s, sub.item.price);
  const ended = { start: sub.current_period_start, end: at };
  if (sub.status === "trialing") {
    sub.status = "active";
    sub.anchor = at;
    sub.cycle_months = 0;
  } else {
    sub.cycle_months += intervalMonths(price.interval);
  }
  sub.current_period_start = at;
  sub.current_period_end = periodEndFor(sub, price.interval);
  const discounts = activeDiscounts(s, sub);
  sub.period_discount = discounts[0] ?? null;
  const line = periodLine(s, price, sub.item.quantity, at, sub.current_period_end, discounts);
  line.id = mint(s, "il");
  const lines = [...sub.pending, line];
  sub.pending = [];
  addInvoice(s, sub, {
    lines,
    discounts,
    billing_reason: "subscription_cycle",
    created: at,
    period_start: ended.start,
    period_end: ended.end,
  });
}

type Event = { at: number; run: () => void };

function nextEvent(s: State, clock: string, to: number): Event | null {
  let best: Event | null = null;
  const consider = (at: number, run: () => void): void => {
    if (at <= to && (best === null || at < best.at)) best = { at, run };
  };
  for (const sub of Object.values(s.subscriptions)) {
    if (s.customers[sub.customer]?.test_clock !== clock) continue;
    for (const id of sub.invoices) {
      const inv = s.invoices[id];
      const at = inv?.next_attempt ?? null;
      if (inv && at !== null) {
        consider(at, () => {
          collect(s, inv, at);
        });
      }
    }
    if (sub.status !== "canceled") {
      consider(sub.current_period_end, () => {
        renew(s, sub);
      });
    }
  }
  return best;
}

/** Move a test clock forward, running every renewal and payment attempt due on the way. */
export function advanceClock(s: State, clock: string, to: number): void {
  const c = s.clocks[clock];
  if (!c) return;
  for (;;) {
    const event: Event | null = nextEvent(s, clock, to);
    if (event === null) break;
    c.frozen_time = Math.max(c.frozen_time, event.at);
    event.run();
  }
  c.frozen_time = to;
}

export function setCancelAtPeriodEnd(s: State, sub: Subscription, cancel: boolean): void {
  sub.cancel_at_period_end = cancel;
  sub.cancel_at = cancel ? sub.current_period_end : null;
  sub.canceled_at = cancel ? customerNow(s, sub.customer) : null;
}

export function cancelNow(
  s: State,
  sub: Subscription,
  prorate: boolean,
  invoiceNow: boolean,
): void {
  const now = customerNow(s, sub.customer);
  if (prorate && now < sub.current_period_end) {
    const before = sub.period_discount ? [sub.period_discount] : [];
    const after = activeDiscounts(s, sub);
    const listed = sub.billing_mode === "classic" ? after : [...before, ...after];
    const line = creditLine(s, sub, now, listed);
    line.id = mint(s, "il");
    sub.pending.push(line);
  }
  if (invoiceNow && sub.pending.length > 0) {
    const lines = sub.pending;
    sub.pending = [];
    addInvoice(s, sub, {
      lines,
      discounts: activeDiscounts(s, sub),
      billing_reason: "subscription_cycle",
      created: now,
      period_start: sub.current_period_start,
      period_end: now,
    });
  }
  sub.status = "canceled";
  sub.canceled_at ??= now;
  sub.ended_at = now;
  sub.cancel_at = null;
  sub.cancel_at_period_end = false;
}

/** First period of a trial: `start -> start + days`, billed as a zero "Free trial" line. */
export function trialEnd(start: number, days: number): number {
  return start + days * 86400;
}
