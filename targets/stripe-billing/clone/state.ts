/**
 * In-memory state of the clone. Everything is plain data (records, arrays, numbers) so that
 * `/__state` can serialise it and `POST /__reset` can rebuild it from `seed()`.
 */

export type Interval = "month" | "year";

export interface Clock {
  id: string;
  frozen_time: number;
}

export interface Product {
  id: string;
  name: string;
  created: number;
}

export interface Price {
  id: string;
  product: string;
  unit_amount: number;
  currency: string;
  interval: Interval;
  created: number;
}

export interface Coupon {
  id: string;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: "forever" | "once";
  created: number;
}

export interface Customer {
  id: string;
  test_clock: string | null;
  default_payment_method: string | null;
  preferred_locales: string[];
  created: number;
}

export interface PaymentMethod {
  id: string;
  customer: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  /** Test card that attaches but declines every charge (`pm_card_chargeCustomerFail`). */
  declines: boolean;
}

export interface Discount {
  id: string;
  coupon: string;
}

export interface DiscountAmount {
  discount: string;
  amount: number;
}

/** One invoice line, before it is rendered as a Stripe `line_item`. */
export interface LineData {
  id: string;
  amount: number;
  description: string;
  period_start: number;
  period_end: number;
  price: string;
  quantity: number;
  discountable: boolean;
  proration: boolean;
  /** Credit for unused time: points back at the invoice line it credits. */
  credit: boolean;
  invoice_item: string | null;
  unit_amount_decimal: string | null;
  discount_amounts: DiscountAmount[];
}

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

export interface Subscription {
  id: string;
  customer: string;
  billing_mode: "flexible" | "classic";
  item: { id: string; price: string; quantity: number };
  /** Billing cycle anchor: periods are anchor + n months, clamped, never chained. */
  anchor: number;
  /** Months from the anchor to the current period start. */
  cycle_months: number;
  current_period_start: number;
  current_period_end: number;
  status: SubscriptionStatus;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  trial_end: number | null;
  /** Discount in force now (null once a `once` coupon has been spent). */
  discount: Discount | null;
  /** Discount that applied to the current, already paid, period. */
  period_discount: Discount | null;
  latest_invoice: string;
  /** Every invoice of the subscription, oldest first. */
  invoices: string[];
  /** Proration items created by updates, billed with the next renewal. */
  pending: LineData[];
  created: number;
}

export type InvoiceStatus = "draft" | "open" | "paid";

export interface Invoice {
  id: string;
  customer: string;
  subscription: string;
  lines: LineData[];
  discounts: Discount[];
  status: InvoiceStatus;
  billing_reason: "subscription_create" | "subscription_cycle";
  attempt_count: number;
  /** Time of the next payment attempt while the invoice is draft or open. */
  next_attempt: number | null;
  /** Time of the first attempt: retries are scheduled from it. */
  first_attempt: number | null;
  created: number;
  period_start: number;
  period_end: number;
}

export interface PortalConfiguration {
  id: string;
  products: { product: string; prices: string[] }[];
  proration_behavior: "create_prorations" | "none" | "always_invoice";
  cancel_enabled: boolean;
  created: number;
}

export interface PortalSession {
  id: string;
  customer: string;
  configuration: string;
  token: string;
  created: number;
}

export interface State {
  seq: number;
  clocks: Record<string, Clock>;
  products: Record<string, Product>;
  prices: Record<string, Price>;
  coupons: Record<string, Coupon>;
  customers: Record<string, Customer>;
  payment_methods: Record<string, PaymentMethod>;
  subscriptions: Record<string, Subscription>;
  invoices: Record<string, Invoice>;
  portal_configurations: Record<string, PortalConfiguration>;
  portal_sessions: Record<string, PortalSession>;
}

export function seed(): State {
  return {
    seq: 0,
    clocks: {},
    products: {},
    prices: {},
    coupons: {},
    customers: {},
    payment_methods: {},
    subscriptions: {},
    invoices: {},
    portal_configurations: {},
    portal_sessions: {},
  };
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(n: number): string {
  let x = n;
  let s = "";
  do {
    s = (ALPHABET[x % 62] ?? "0") + s;
    x = Math.floor(x / 62);
  } while (x > 0);
  return s;
}

// Deterministic IDs drawn from the state's own counter, so a reset restarts the sequence. The
// suffix is an injective function of the counter, long enough to read as a generated ID.
export function mint(state: State, prefix: string): string {
  state.seq += 1;
  return `${prefix}_1U${base62(state.seq * 7919 + 104729).padStart(12, "0")}`;
}

/** Coupon IDs in the real product have no prefix. */
export function mintBare(state: State): string {
  state.seq += 1;
  return `C${base62(state.seq * 7919 + 104729).padStart(7, "0")}`;
}
