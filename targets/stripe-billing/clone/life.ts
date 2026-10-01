/**
 * Time on a test clock: renewals at the period end, payment attempts an hour later, retries of a
 * failed payment, the end of a subscription set to cancel, and cancelling now (LIF-*).
 */
import { allocate, creditLine, priceOf, recurringDescription, specOf, specsOf } from "./billing.ts";
import {
  get,
  mint,
  nowFor,
  type Clock,
  type Invoice,
  type Line,
  type State,
  type Subscription,
} from "./state.ts";
import { periodAt } from "./time.ts";

const HOUR = 3600;
const DAY = 86400;
// Retries after a failed renewal payment, counted from the first attempt (LIF-06: three attempts
// within five days; the spacing in between is not pinned by the recordings).
const RETRIES = [3 * DAY, 5 * DAY];

function failing(state: State, customer: string): boolean {
  const c = get(state.customers, customer);
  const pm = c?.default_payment_method
    ? get(state.payment_methods, c.default_payment_method)
    : undefined;
  return pm?.fails === true;
}

export function invoiceTotal(inv: Invoice): number {
  const sub = inv.lines.reduce((a, l) => a + l.amount, 0);
  return sub - inv.total_discount_amounts.reduce((a, d) => a + d.amount, 0);
}

// Pending invoice items (prorations) of a subscription, moved onto an invoice.
export function takePending(state: State, sub: Subscription, invoice: string): Line[] {
  const out: Line[] = [];
  for (const ii of Object.values(state.invoice_items)) {
    if (ii.subscription !== sub.id || ii.invoice !== null) continue;
    ii.invoice = invoice;
    out.push({ ...ii.line, id: mint(state, "il") });
  }
  return out;
}

function renew(state: State, sub: Subscription): void {
  const start = sub.period_end;
  const interval = priceOf(state, sub.items[0]?.price ?? "").interval;
  const end = periodAt(sub.anchor, interval, start)[1];
  const id = mint(state, "in");
  const pending = takePending(state, sub, id);
  const lines: Line[] = sub.items.map((it) => {
    const p = priceOf(state, it.price);
    return {
      id: mint(state, "il"),
      amount: p.unit_amount * it.quantity,
      description: recurringDescription(state, it.price, it.quantity),
      period: { start, end },
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
  const active = sub.discounts.filter((d) => {
    const s = specOf(state, d);
    return s !== undefined && !(s.once && get(state.discounts, d)?.used === true);
  });
  const specs = specsOf(state, active);
  const alloc = allocate(
    lines.map((l) => l.amount),
    specs,
  );
  lines.forEach((l, i) => {
    l.discount_amounts = specs.map((s, k) => ({ discount: s.id, amount: alloc[k]?.[i] ?? 0 }));
  });
  for (const s of specs) {
    const d = get(state.discounts, s.id);
    if (d && s.once) d.used = true;
  }
  sub.items.forEach((it, i) => {
    const l = lines[i];
    if (l) it.billed = { invoice: id, line: l.id, amount: l.amount, discounts: l.discount_amounts };
  });
  const all = [...pending, ...lines];
  const inv: Invoice = {
    id,
    customer: sub.customer,
    subscription: sub.id,
    lines: all,
    discounts: specs.map((s) => s.id),
    total_discount_amounts: specs.map((s, k) => ({
      discount: s.id,
      amount: (alloc[k] ?? []).reduce((a, b) => a + b, 0),
    })),
    billing_reason: "subscription_cycle",
    status: "draft",
    created: start,
    period_start: sub.period_start,
    period_end: start,
    attempt_count: 0,
    amount_paid: 0,
    auto_advance: true,
    next_payment_attempt: start + HOUR,
    proration_date: null,
    retries: [],
  };
  state.invoices[id] = inv;
  sub.latest_invoice = id;
  sub.period_start = start;
  sub.period_end = end;
  if (sub.status === "trialing") sub.status = "active";
}

function attempt(state: State, inv: Invoice, at: number): void {
  const sub = inv.subscription ? get(state.subscriptions, inv.subscription) : undefined;
  const due = Math.max(0, invoiceTotal(inv));
  if (due === 0) {
    inv.status = "paid";
    inv.next_payment_attempt = null;
    return;
  }
  inv.attempt_count += 1;
  if (!failing(state, inv.customer)) {
    inv.status = "paid";
    inv.amount_paid = due;
    inv.next_payment_attempt = null;
    if (sub?.status === "past_due") sub.status = "active";
    return;
  }
  inv.status = "open";
  if (inv.attempt_count === 1) inv.retries = RETRIES.map((d) => at + d);
  const next = inv.retries.shift();
  inv.next_payment_attempt = next ?? null;
  if (sub && sub.status !== "canceled") sub.status = "past_due";
}

// Runs every event of the clock's customers up to `to`, in time order.
export function advanceClock(state: State, clock: Clock, to: number): void {
  const customers = new Set(
    Object.values(state.customers)
      .filter((c) => c.clock === clock.id)
      .map((c) => c.id),
  );
  for (let guard = 0; guard < 1000; guard += 1) {
    const events: { at: number; run: () => void }[] = [];
    const consider = (at: number, run: () => void): void => {
      if (at <= to) events.push({ at, run });
    };
    for (const sub of Object.values(state.subscriptions)) {
      if (!customers.has(sub.customer) || sub.status === "canceled") continue;
      const cancelAt = sub.cancel_at;
      if (cancelAt !== null && cancelAt <= sub.period_end) {
        consider(cancelAt, () => {
          sub.status = "canceled";
          sub.ended_at = cancelAt;
        });
        continue;
      }
      consider(sub.period_end, () => {
        if (sub.cancel_at_period_end) {
          sub.status = "canceled";
          sub.ended_at = sub.period_end;
        } else {
          renew(state, sub);
        }
      });
    }
    for (const inv of Object.values(state.invoices)) {
      if (!customers.has(inv.customer)) continue;
      if ((inv.status === "draft" && inv.auto_advance) || inv.status === "open") {
        const at = inv.next_payment_attempt;
        if (at !== null) {
          consider(at, () => {
            attempt(state, inv, at);
          });
        }
      }
    }
    // The earliest event first; ties keep discovery order (subscriptions before invoices).
    const chosen = events.reduce<{ at: number; run: () => void } | null>(
      (best, e) => (best === null || e.at < best.at ? e : best),
      null,
    );
    if (chosen === null) break;
    clock.frozen_time = Math.max(clock.frozen_time, chosen.at);
    chosen.run();
  }
  clock.frozen_time = to;
}

export function cancelNow(
  state: State,
  sub: Subscription,
  prorate: boolean,
  invoiceNow: boolean,
): void {
  const now = nowFor(state, sub.customer);
  if (prorate && now < sub.period_end) {
    const credits = sub.items.map((it) => creditLine(state, sub, it, now).line);
    if (invoiceNow) {
      const id = mint(state, "in");
      const pending = takePending(state, sub, id);
      const lines: Line[] = [
        ...pending,
        ...credits.map((l) => ({ ...l, id: mint(state, "il"), invoice_item: mint(state, "ii") })),
      ];
      state.invoices[id] = {
        id,
        customer: sub.customer,
        subscription: sub.id,
        lines,
        discounts: [],
        total_discount_amounts: [],
        billing_reason: "subscription_cycle",
        status: "draft",
        created: now,
        period_start: sub.period_start,
        period_end: now,
        attempt_count: 0,
        amount_paid: 0,
        auto_advance: false,
        next_payment_attempt: null,
        proration_date: null,
        retries: [],
      };
      sub.latest_invoice = id;
    } else {
      for (const l of credits) {
        const id = mint(state, "ii");
        state.invoice_items[id] = {
          id,
          customer: sub.customer,
          subscription: sub.id,
          line: { ...l, id: "", invoice_item: id },
          invoice: null,
        };
      }
    }
  }
  sub.status = "canceled";
  sub.ended_at = now;
  sub.canceled_at ??= now;
  sub.cancel_at_period_end = false;
  sub.cancel_at = null;
}
