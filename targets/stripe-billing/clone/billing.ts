/**
 * The billing engine: discount allocation, proration arithmetic, and the plan of a subscription
 * change (which lines it bills, now or at the next renewal). Pure functions over the state; the
 * API layer turns their output into Stripe objects.
 */
import {
  get,
  type Billed,
  type Coupon,
  type DiscountAmount,
  type Invoice,
  type Line,
  type State,
  type SubItem,
  type Subscription,
} from "./state.ts";
import { addIntervals, money, periodAt, shortDate, type Interval } from "./time.ts";

// ---------------------------------------------------------------- rounding

// round(num / den) half away from zero, on exact integers (den > 0).
export function roundRatio(num: number, den: number): number {
  const sign = num < 0 ? -1 : 1;
  const a = Math.abs(num);
  return sign * Math.floor((2 * a + den) / (2 * den));
}

// Percent with up to four decimals, as an exact integer fraction of 1 000 000.
const PPM = 1_000_000;
const ppm = (percent: number): number => Math.round(percent * 10_000);

// ---------------------------------------------------------------- discounts

export interface DiscSpec {
  id: string;
  percent_off: number | null;
  amount_off: number | null;
  once: boolean;
}

export function specOf(state: State, discountId: string): DiscSpec | undefined {
  const d = get(state.discounts, discountId);
  const c = d ? get(state.coupons, d.coupon) : undefined;
  if (!d || !c) return undefined;
  return {
    id: d.id,
    percent_off: c.percent_off,
    amount_off: c.amount_off,
    once: c.duration === "once",
  };
}

export function specsOf(state: State, ids: string[]): DiscSpec[] {
  return ids.map((id) => specOf(state, id)).filter((s): s is DiscSpec => s !== undefined);
}

// Discounts apply one after another; each is spread over the discountable lines in proportion to
// what is left of them, with the rounding remainder on the last line. Result: [discount][line].
export function allocate(bases: number[], discounts: DiscSpec[]): number[][] {
  const left = bases.map((b) => Math.max(0, b));
  return discounts.map((d) => {
    const sum = left.reduce((a, b) => a + b, 0);
    const out = left.map(() => 0);
    if (sum <= 0) return out;
    // A percent-off takes round(pct x sum) and spreads it like an amount-off (DSC-01).
    const total =
      d.percent_off !== null
        ? roundRatio(sum * ppm(d.percent_off), PPM)
        : Math.min(d.amount_off ?? 0, sum);
    left.forEach((b, i) => {
      out[i] = Math.floor((total * b) / sum);
    });
    // The rounding remainder goes one cent per line, from the last line backwards.
    let rest = total - out.reduce((a, b) => a + b, 0);
    const open = left.map((b, i) => (b > 0 ? i : -1)).filter((i) => i >= 0);
    for (
      let k = open.length - 1;
      rest > 0 && open.length > 0;
      k = k === 0 ? open.length - 1 : k - 1
    ) {
      const i = open[k] ?? 0;
      out[i] = (out[i] ?? 0) + 1;
      rest -= 1;
    }
    left.forEach((b, i) => {
      left[i] = b - (out[i] ?? 0);
    });
    return out;
  });
}

export function couponLabel(c: Pick<Coupon, "percent_off" | "amount_off">): string {
  if (c.percent_off !== null) {
    const p = c.percent_off;
    return `${Number.isInteger(p * 10) ? p.toFixed(1) : String(p)}% off`;
  }
  return `${money(c.amount_off ?? 0)} off`;
}

function withDiscounts(specs: DiscSpec[]): string {
  if (specs.length === 0) return "";
  if (specs.length > 1) return " (with discounts)";
  const [s] = specs;
  return s ? ` (with ${couponLabel(s)})` : "";
}

// ---------------------------------------------------------------- lines

export function priceOf(state: State, id: string) {
  const p = get(state.prices, id);
  if (!p) throw new Error(`unknown price ${id}`);
  return p;
}

export function productName(state: State, priceId: string): string {
  const p = priceOf(state, priceId);
  return get(state.products, p.product)?.name ?? "";
}

export function recurringDescription(state: State, priceId: string, quantity: number): string {
  const p = priceOf(state, priceId);
  return `${quantity} × ${productName(state, priceId)} (at ${money(p.unit_amount)} / ${p.interval})`;
}

const qtyPrefix = (q: number): string => (q > 1 ? `${q} × ` : "");

export function intervalOf(state: State, sub: Subscription): Interval {
  const first = sub.items[0];
  return first ? priceOf(state, first.price).interval : "month";
}

// ---------------------------------------------------------------- change plan

export interface ItemChange {
  id: string;
  price: string | null;
  quantity: number | null;
}

export type Behavior = "create_prorations" | "none" | "always_invoice";

export interface PlannedItem {
  id: string;
  price: string;
  quantity: number;
}

export interface Plan {
  // Proration lines, without IDs.
  prorations: Omit<Line, "id" | "invoice_item">[];
  // The discounts each proration line actually carries (for its discount list).
  own: DiscSpec[][];
  // Per proration line: how many discounts a credit line carried (null for a charge).
  carried: (number | null)[];
  items: PlannedItem[];
  // Items whose price or quantity changes.
  changed: string[];
  // Discounts of the new state (a once coupon passed to the preview included).
  discounts: string[];
  // Whether the discounts were passed with the change rather than kept from the subscription.
  passed: boolean;
  immediate: boolean;
  // A classic interval change restarts the cycle at the clock time.
  reset: boolean;
  period_start: number;
  period_end: number;
  anchor: number;
  interval: Interval;
  proration_date: number;
  now: number;
}

export interface PlanError {
  message: string;
  param: string | null;
}

export interface PlanInput {
  changes: ItemChange[];
  proration_date: number | null;
  behavior: Behavior | null;
  // Discount IDs replacing the subscription's, or null to keep them.
  discounts: string[] | null;
  now: number;
}

function creditDiscounts(
  state: State,
  billed: Billed | null,
): { spec: DiscSpec; amount: number }[] {
  if (!billed) return [];
  return billed.discounts
    .filter((d) => d.amount !== 0)
    .map((d) => ({ spec: specOf(state, d.discount), amount: d.amount }))
    .filter((x): x is { spec: DiscSpec; amount: number } => x.spec !== undefined);
}

// Credit for the unused time of an item, from `prd` to the period end, carrying the discounts the
// item got on the invoice that billed the period (PRO-01, DSC-04).
export function creditLine(
  state: State,
  sub: Subscription,
  it: SubItem,
  prd: number,
): { line: Omit<Line, "id" | "invoice_item">; own: DiscSpec[]; carried: number } {
  const oldPrice = priceOf(state, it.price);
  const P = sub.period_end - sub.period_start;
  const r = sub.period_end - prd;
  const b = oldPrice.unit_amount * it.quantity;
  const carried = creditDiscounts(state, it.billed);
  let credit: number;
  // Flexible: a carried discount whose prorated amount rounds to 0 is not applied (DSC-08);
  // classic prorates the net amount in one step and keeps every label.
  let applied = carried.map((c) => c.spec);
  if (sub.billing_mode === "classic") {
    // Classic: the coupons apply to the credited item on its own (an amount-off coupon in full,
    // not its share of a multi-item invoice), then the net amount is prorated.
    const D = allocate(
      [b],
      carried.map((c) => c.spec),
    ).reduce((a, x) => a + (x[0] ?? 0), 0);
    credit = -roundRatio((b - D) * r, P);
  } else {
    const prorated = carried.map((c) => roundRatio(c.amount * r, P));
    credit = -(roundRatio(b * r, P) - prorated.reduce((a, x) => a + x, 0));
    applied = carried.filter((_, k) => (prorated[k] ?? 0) !== 0).map((c) => c.spec);
  }
  return {
    line: {
      amount: credit,
      description: `Unused time on ${qtyPrefix(it.quantity)}${productName(state, it.price)}${withDiscounts(applied)} after ${shortDate(prd)}`,
      period: { start: prd, end: sub.period_end },
      price: it.price,
      quantity: it.quantity,
      proration: true,
      discountable: false,
      discount_amounts: [],
      subscription_item: it.id,
      credited: it.billed ? { invoice: it.billed.invoice, line: it.billed.line } : null,
      unit_amount_decimal: null,
    },
    own: applied,
    // Discounts on the billed line, those it got nothing from included (DSC-07).
    carried: it.billed?.discounts.length ?? 0,
  };
}

export function planChange(state: State, sub: Subscription, input: PlanInput): Plan | PlanError {
  const behavior = input.behavior ?? "create_prorations";
  if (behavior === "none" && input.proration_date !== null) {
    return {
      message: "Cannot specify proration date if no proration is being done",
      param: "proration_date",
    };
  }
  const prd = input.proration_date ?? input.now;
  if (prd < sub.period_start || prd > sub.period_end) {
    return {
      message: `Cannot specify proration date outside of current subscription period or current phase. The value should be between ${sub.period_start} and ${sub.period_end}.`,
      param: "proration_date",
    };
  }
  const oldInterval = intervalOf(state, sub);
  const items: PlannedItem[] = sub.items.map((it) => {
    const ch = input.changes.find((c) => c.id === it.id);
    if (!ch) return { id: it.id, price: it.price, quantity: it.quantity };
    const priceChanged = ch.price !== null && ch.price !== it.price;
    return {
      id: it.id,
      price: ch.price ?? it.price,
      quantity: ch.quantity ?? (priceChanged ? 1 : it.quantity),
    };
  });
  const firstPlanned = items[0];
  const newInterval = firstPlanned ? priceOf(state, firstPlanned.price).interval : oldInterval;
  const discounts =
    input.discounts ?? sub.discounts.filter((id) => get(state.discounts, id)?.used !== true);
  const chargeSpecs = specsOf(state, discounts);

  let periodStart = sub.period_start;
  let periodEnd = sub.period_end;
  let anchor = sub.anchor;
  let reset = false;
  const intervalChange = newInterval !== oldInterval;
  if (intervalChange) {
    if (sub.billing_mode === "classic") {
      reset = true;
      periodStart = input.now;
      anchor = input.now;
      periodEnd = addIntervals(input.now, newInterval, 1);
    } else {
      periodEnd = addIntervals(sub.period_start, newInterval, 1);
      if (periodEnd < sub.period_end && prd >= periodEnd) {
        return {
          message: `You cannot specify \`proration_date\` past the updated subscription period end when using flexible billing mode. The value should be less than ${periodEnd}.`,
          param: null,
        };
      }
    }
  }

  const prorations: Plan["prorations"] = [];
  const own: DiscSpec[][] = [];
  const carried: (number | null)[] = [];
  const changed = sub.items
    .filter((it, i) => {
      const next = items[i];
      return next !== undefined && (next.price !== it.price || next.quantity !== it.quantity);
    })
    .map((it) => it.id);
  if (behavior !== "none") {
    sub.items.forEach((it: SubItem, i) => {
      const next = items[i];
      if (!next || !changed.includes(it.id)) return;
      // A credit with no remaining time is omitted (INT-02).
      if (prd < sub.period_end) {
        const credit = creditLine(state, sub, it, prd);
        prorations.push(credit.line);
        own.push(credit.own);
        carried.push(credit.carried);
      }
      if (reset) return;
      // Charge for the remaining time on the new item, over the new period.
      const newPrice = priceOf(state, next.price);
      const n = newPrice.unit_amount * next.quantity;
      const P2 = periodEnd - periodStart;
      const r2 = periodEnd - prd;
      const e2 = prd - periodStart;
      if (r2 <= 0) return;
      const D2 = allocate([n], chargeSpecs).map((x) => x[0] ?? 0);
      const base =
        sub.billing_mode === "classic" ? roundRatio(n * r2, P2) : Math.round(n * (1 - e2 / P2));
      // Flexible discounts the full-period amount, then prorates the discount (DSC-02); classic
      // prorates first and takes a percent-off on the prorated amount (DSC-04).
      let left = base;
      const prorated = chargeSpecs.map((s, k) => {
        const d =
          sub.billing_mode === "classic" && s.percent_off !== null
            ? roundRatio(Math.max(0, left) * ppm(s.percent_off), PPM)
            : roundRatio((D2[k] ?? 0) * r2, P2);
        left -= d;
        return d;
      });
      const applied = chargeSpecs.filter((_, k) => (prorated[k] ?? 0) !== 0);
      const charge = left;
      prorations.push({
        amount: charge,
        description: `Remaining time on ${qtyPrefix(next.quantity)}${productName(state, next.price)}${withDiscounts(applied)} after ${shortDate(prd)}`,
        period: { start: prd, end: periodEnd },
        price: next.price,
        quantity: next.quantity,
        proration: true,
        discountable: false,
        discount_amounts: [],
        subscription_item: it.id,
        credited: null,
        unit_amount_decimal: null,
      });
      own.push(applied);
      carried.push(null);
    });
  }
  const immediate = reset || (behavior === "always_invoice" && prorations.length > 0);
  return {
    prorations,
    own,
    carried,
    items,
    changed,
    discounts,
    passed: input.discounts !== null,
    immediate,
    reset,
    period_start: periodStart,
    period_end: periodEnd,
    anchor,
    interval: newInterval,
    proration_date: prd,
    now: input.now,
  };
}

export function isPlanError(p: Plan | PlanError): p is PlanError {
  return "message" in p;
}

// ---------------------------------------------------------------- invoice assembly

export interface Draft {
  lines: Line[];
  discounts: string[];
  total_discount_amounts: DiscountAmount[];
  created: number;
  period_start: number;
  period_end: number;
  immediate: boolean;
}

// The invoice a plan produces: now (immediate) or at the next renewal (prorations plus the next
// full period of every item).
export function draftFromPlan(
  state: State,
  sub: Subscription,
  plan: Plan,
  ids: { line: () => string; item: () => string },
  mode: Subscription["billing_mode"],
): Draft {
  // A once coupon passed with the change (DSC-05) is on the invoice when the change prorates
  // nothing (it then discounts the renewal) or when the invoice is immediate; with prorations
  // at the next renewal it discounts only the remaining-time charge. A once coupon kept from the
  // subscription never discounts a later invoice.
  const passedOnceShows = plan.immediate || plan.prorations.length === 0;
  const top = plan.discounts.filter((id) => {
    const s = specOf(state, id);
    if (!s) return false;
    return !s.once || (plan.passed && passedOnceShows);
  });
  const topSpecs = specsOf(state, top);
  const lines: Line[] = plan.prorations.map((p) => ({
    ...p,
    id: ids.line(),
    invoice_item: ids.item(),
  }));
  const recurring: Line[] = [];
  if (plan.reset) {
    for (const it of plan.items) {
      if (!plan.changed.includes(it.id)) continue;
      recurring.push(recurringLine(state, it, plan.period_start, plan.period_end, ids.line()));
    }
  } else if (!plan.immediate) {
    const next = periodAt(plan.anchor, plan.interval, plan.period_end)[1];
    for (const it of plan.items) {
      recurring.push(recurringLine(state, it, plan.period_end, next, ids.line()));
    }
  }
  const alloc = allocate(
    recurring.map((l) => l.amount),
    topSpecs,
  );
  recurring.forEach((l, i) => {
    l.discount_amounts = topSpecs.map((s, k) => ({ discount: s.id, amount: alloc[k]?.[i] ?? 0 }));
  });
  lines.forEach((l, i) => {
    const mine = (plan.own[i] ?? []).map((s) => s.id);
    const carried = plan.carried[i] ?? null;
    // Observed only (no documented rule): which discounts a proration line lists, at 0.
    let list: string[];
    if (mode === "classic") list = top;
    else if (plan.immediate) {
      if (carried === null) list = mine;
      // DSC-07, as the dev cases pin it: see NOTES.md, pass 4.
      else if (top.length === 0) list = [];
      else if (carried === 0) list = top;
      else if (mine.length === 0) list = [];
      else if (carried === 1) list = mine;
      else list = top;
    } else if (top.length > 0) list = top.slice(0, 1);
    else list = mine;
    l.discount_amounts = list.map((discount) => ({ discount, amount: 0 }));
  });
  const all = [...lines, ...recurring];
  const tda = top.map((discount) => ({
    discount,
    amount: all.reduce(
      (a, l) =>
        a +
        l.discount_amounts.filter((d) => d.discount === discount).reduce((x, d) => x + d.amount, 0),
      0,
    ),
  }));
  const immediate = plan.immediate;
  return {
    lines: all,
    discounts: top,
    total_discount_amounts: tda,
    created: immediate ? plan.now : plan.period_end,
    period_start: immediate ? plan.now : sub.period_start,
    period_end: immediate ? plan.now : plan.period_end,
    immediate,
  };
}

export function recurringLine(
  state: State,
  it: PlannedItem,
  start: number,
  end: number,
  id: string,
): Line {
  const p = priceOf(state, it.price);
  return {
    id,
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
}

// The smallest amount the account charges (INV-01). The dev cases pin it above 51 cents and at
// most 291; 59 cents is 0.50 EUR (the French account's minimum) converted, an assumption.
export const MIN_CHARGE = 59;

// What an invoice asks for: its total plus the starting balance, less an amount deferred to the
// customer balance because it was below the minimum charge.
export function amountDue(inv: {
  lines: Line[];
  total_discount_amounts: DiscountAmount[];
  starting_balance: number;
  deferred: number;
}): number {
  const { total } = totals(inv.lines, inv.total_discount_amounts);
  return Math.max(0, total + inv.starting_balance) - inv.deferred;
}

// Charges below the minimum are not attempted: the amount goes to the customer balance.
export function deferSmall(state: State, inv: Invoice): boolean {
  const due = amountDue(inv);
  if (due <= 0 || due >= MIN_CHARGE) return false;
  inv.deferred += due;
  const c = get(state.customers, inv.customer);
  if (c) c.balance += due;
  inv.status = "paid";
  inv.next_payment_attempt = null;
  return true;
}

export function totals(lines: Line[], tda: DiscountAmount[]) {
  const subtotal = lines.reduce((a, l) => a + l.amount, 0);
  const discount = tda.reduce((a, d) => a + d.amount, 0);
  return { subtotal, total: subtotal - discount };
}
