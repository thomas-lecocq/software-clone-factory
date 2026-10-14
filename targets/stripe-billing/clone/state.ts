/** In-memory account state of the clone. JSON-serialisable, rebuilt from scratch by `seed()`. */
import type { Interval } from "./time.ts";

export type BillingMode = "flexible" | "classic";

export interface Clock {
  id: string;
  frozen_time: number;
  created: number;
}

export interface Product {
  id: string;
  name: string;
}

export interface Price {
  id: string;
  product: string;
  unit_amount: number;
  currency: string;
  interval: Interval;
  // Prices live outside test clocks; the clone uses the latest clock time (recorded as noise).
  created: number;
}

export interface Coupon {
  id: string;
  percent_off: number | null;
  amount_off: number | null;
  duration: "forever" | "once";
  // Coupons live outside test clocks; the latest clock time (recorded as noise).
  created: number;
}

export interface PaymentMethod {
  id: string;
  customer: string | null;
  fails: boolean;
}

export interface Customer {
  id: string;
  clock: string | null;
  default_payment_method: string | null;
  created: number;
  // What the customer owes (positive) or is owed (negative), carried to the next invoice.
  balance: number;
  // Set by the first subscription.
  currency: string | null;
  invoice_prefix: string;
  preferred_locales: string[];
}

export interface Discount {
  id: string;
  coupon: string;
  customer: string;
  subscription: string | null;
  start: number;
  // A once coupon is spent by the first invoice it discounts.
  used: boolean;
}

// What the invoice that billed the current period charged for one item.
export interface Billed {
  invoice: string;
  line: string;
  amount: number;
  discounts: { discount: string; amount: number }[];
}

export interface SubItem {
  id: string;
  price: string;
  quantity: number;
  created: number;
  billed: Billed | null;
}

export interface Subscription {
  id: string;
  customer: string;
  items: SubItem[];
  billing_mode: BillingMode;
  discounts: string[];
  anchor: number;
  period_start: number;
  period_end: number;
  status: "active" | "trialing" | "past_due" | "canceled";
  created: number;
  latest_invoice: string | null;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  trial_start: number | null;
  trial_end: number | null;
  // cancellation_details.reason: "cancellation_requested" once a cancellation is asked for.
  cancellation_reason: string | null;
  metadata: Record<string, string>;
}

export interface DiscountAmount {
  discount: string;
  amount: number;
}

export interface Line {
  id: string;
  amount: number;
  // null on a line of an invoice item created without a description.
  description: string | null;
  period: { start: number; end: number };
  price: string;
  quantity: number;
  proration: boolean;
  discountable: boolean;
  discount_amounts: DiscountAmount[];
  subscription_item: string | null;
  invoice_item: string | null;
  credited: { invoice: string; line: string } | null;
  unit_amount_decimal: string | null;
}

export interface Invoice {
  id: string;
  customer: string;
  subscription: string | null;
  lines: Line[];
  discounts: string[];
  total_discount_amounts: DiscountAmount[];
  billing_reason: string;
  status: "draft" | "open" | "paid";
  created: number;
  period_start: number;
  period_end: number;
  attempt_count: number;
  amount_paid: number;
  auto_advance: boolean;
  next_payment_attempt: number | null;
  proration_date: number | null;
  // Seconds of the next retry, while a failed invoice is still open.
  retries: number[];
  // The customer balance the invoice starts from (added to what is due).
  starting_balance: number;
  // An amount due below the minimum charge, moved to the customer balance instead (INV-01).
  deferred: number;
  // When the invoice left draft and when it was paid (status_transitions, effective_at).
  finalized_at: number | null;
  paid_at: number | null;
  // Created by POST /v1/invoices (billing_reason manual): no subscription parent, a rendering.
  manual: boolean;
}

export interface InvoiceItem {
  id: string;
  customer: string;
  // null for an invoice item created by POST /v1/invoiceitems (ITM-02).
  subscription: string | null;
  line: Line;
  invoice: string | null;
  // When the invoice item was created (clock time).
  date: number;
}

export interface PortalConfig {
  id: string;
  cancel_enabled: boolean;
  allowed_updates: string[];
  products: { product: string; prices: string[] }[];
}

export interface PortalSession {
  id: string;
  customer: string;
  configuration: string;
  created: number;
}

export interface State {
  n: number;
  clocks: Record<string, Clock>;
  products: Record<string, Product>;
  prices: Record<string, Price>;
  coupons: Record<string, Coupon>;
  customers: Record<string, Customer>;
  payment_methods: Record<string, PaymentMethod>;
  discounts: Record<string, Discount>;
  subscriptions: Record<string, Subscription>;
  invoices: Record<string, Invoice>;
  invoice_items: Record<string, InvoiceItem>;
  configs: Record<string, PortalConfig>;
  sessions: Record<string, PortalSession>;
}

export function seed(): State {
  return {
    n: 0,
    clocks: {},
    products: {},
    prices: {},
    coupons: {},
    customers: {},
    payment_methods: {},
    discounts: {},
    subscriptions: {},
    invoices: {},
    invoice_items: {},
    configs: {},
    sessions: {},
  };
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Deterministic IDs: the same calls after a reset mint the same IDs.
export function mint(state: State, prefix: string): string {
  state.n += 1;
  const n = state.n;
  let x = n * 7919 + 104729;
  let s = "";
  while (s.length < 14) {
    s = (ALPHABET[x % 62] ?? "0") + s;
    x = Math.floor(x / 62) + n * 31;
  }
  // Stripe IDs start with an upper-case letter or digit after the prefix; keep one fixed shape.
  return `${prefix}_1${s}`;
}

export function get<T>(table: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(table, id) ? table[id] : undefined;
}

// The clock time a customer lives on (its test clock), or the subscription's creation time.
export function nowFor(state: State, customer: string): number {
  const c = get(state.customers, customer);
  const clock = c?.clock ? get(state.clocks, c.clock) : undefined;
  return clock ? clock.frozen_time : Math.floor(Date.now() / 1000);
}
