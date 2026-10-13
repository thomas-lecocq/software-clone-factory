/** Stripe-shaped JSON for the clone's objects. Constants here are the recorded account's. */
import type { Json } from "../../../harness/src/json.ts";
import { amountDue, priceOf, totals } from "./billing.ts";
import {
  get,
  type Coupon,
  type DiscountAmount,
  type Invoice,
  type Line,
  type State,
  type Subscription,
} from "./state.ts";

export const ACCOUNT_NAME = "environnement de test AcmeCo";
export const ACCOUNT_COUNTRY = "FR";
// pm_card_visa: the test card's expiry, as the portal recorded it.
export const CARD = { brand: "visa", last4: "4242", exp_month: 10, exp_year: 2027 };

export function lineJson(
  state: State,
  l: Line,
  invoice: string,
  subscription: string | null,
): Json {
  const price = get(state.prices, l.price);
  const pretax = (d: DiscountAmount): Json => ({
    amount: d.amount,
    discount: d.discount,
    type: "discount",
  });
  return {
    id: l.id,
    object: "line_item",
    amount: l.amount,
    currency: "usd",
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
          credited_items: l.credited
            ? { invoice: l.credited.invoice, invoice_line_items: [l.credited.line] }
            : null,
        },
        subscription,
        subscription_item: l.subscription_item,
      },
      type: "subscription_item_details",
    },
    period: { end: l.period.end, start: l.period.start },
    pretax_credit_amounts: l.discount_amounts.map(pretax),
    pricing: {
      price_details: { price: l.price, product: price?.product ?? null },
      type: "price_details",
      unit_amount_decimal: l.unit_amount_decimal,
    },
    quantity: l.quantity,
    quantity_decimal: String(l.quantity),
    subtotal: l.amount,
    taxes: [],
  };
}

export function invoiceJson(state: State, inv: Invoice, preview: boolean): Json {
  const { subtotal, total } = totals(inv.lines, inv.total_discount_amounts);
  const due = amountDue(inv);
  const ending = Math.min(0, total + inv.starting_balance);
  const paid = inv.status === "paid" ? inv.amount_paid : 0;
  const customer = get(state.customers, inv.customer);
  const tda = inv.total_discount_amounts;
  return {
    id: inv.id,
    object: "invoice",
    account_country: ACCOUNT_COUNTRY,
    account_name: ACCOUNT_NAME,
    account_tax_ids: null,
    amount_due: due,
    amount_overpaid: 0,
    amount_paid: paid,
    amount_remaining: inv.status === "paid" ? 0 : due - paid,
    amount_shipping: 0,
    application: null,
    attempt_count: inv.attempt_count,
    attempted: inv.attempt_count > 0,
    auto_advance: inv.auto_advance,
    automatic_tax: {
      disabled_reason: null,
      enabled: false,
      liability: null,
      provider: null,
      status: null,
    },
    automatically_finalizes_at: null,
    billing_reason: inv.billing_reason,
    collection_method: "charge_automatically",
    created: inv.created,
    currency: "usd",
    custom_fields: null,
    customer: inv.customer,
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
    discounts: [...inv.discounts],
    due_date: null,
    effective_at: null,
    ending_balance: preview ? ending : inv.status === "draft" ? null : ending,
    footer: null,
    from_invoice: null,
    hosted_invoice_url: null,
    invoice_pdf: null,
    issuer: { type: "self" },
    last_finalization_error: null,
    latest_revision: null,
    lines: {
      object: "list",
      data: inv.lines.map((l) => lineJson(state, l, inv.id, inv.subscription)),
      has_more: false,
      total_count: inv.lines.length,
      url: `/v1/invoices/${inv.id}/lines`,
    },
    livemode: false,
    metadata: {},
    next_payment_attempt: inv.next_payment_attempt,
    number: null,
    on_behalf_of: null,
    parent: {
      quote_details: null,
      subscription_details: {
        metadata: {},
        subscription: inv.subscription,
        ...(inv.proration_date !== null ? { subscription_proration_date: inv.proration_date } : {}),
      },
      type: "subscription_details",
    },
    payment_settings: {
      default_mandate: null,
      payment_method_options: null,
      payment_method_types: null,
    },
    period_end: inv.period_end,
    period_start: inv.period_start,
    post_payment_credit_notes_amount: 0,
    pre_payment_credit_notes_amount: 0,
    receipt_number: null,
    rendering: null,
    shipping_cost: null,
    shipping_details: null,
    starting_balance: inv.starting_balance,
    statement_descriptor: null,
    status: inv.status,
    status_transitions: {
      finalized_at: null,
      marked_uncollectible_at: null,
      paid_at: null,
      voided_at: null,
    },
    subtotal,
    subtotal_excluding_tax: subtotal,
    test_clock: customer?.clock ?? null,
    total,
    total_discount_amounts: tda.map((d) => ({ amount: d.amount, discount: d.discount })),
    total_excluding_tax: total,
    total_pretax_credit_amounts: tda.map((d) => ({
      amount: d.amount,
      discount: d.discount,
      type: "discount",
    })),
    total_taxes: [],
    webhooks_delivered_at: null,
  };
}

export function couponJson(c: Coupon): Json {
  return {
    id: c.id,
    object: "coupon",
    amount_off: c.amount_off,
    currency: c.amount_off !== null ? "usd" : null,
    duration: c.duration,
    percent_off: c.percent_off,
    valid: true,
  };
}

export function priceJson(state: State, id: string): Json {
  const p = priceOf(state, id);
  return {
    id: p.id,
    object: "price",
    active: true,
    currency: p.currency,
    product: p.product,
    recurring: { interval: p.interval, interval_count: 1, usage_type: "licensed" },
    type: "recurring",
    unit_amount: p.unit_amount,
    unit_amount_decimal: String(p.unit_amount),
  };
}

export function subscriptionJson(state: State, sub: Subscription, expandInvoice: boolean): Json {
  const latest = sub.latest_invoice ? get(state.invoices, sub.latest_invoice) : undefined;
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
    discounts: [...sub.discounts],
    ended_at: sub.ended_at,
    items: {
      object: "list",
      data: sub.items.map((it) => ({
        id: it.id,
        object: "subscription_item",
        created: it.created,
        current_period_end: sub.period_end,
        current_period_start: sub.period_start,
        price: priceJson(state, it.price),
        quantity: it.quantity,
        subscription: sub.id,
      })),
      has_more: false,
      total_count: sub.items.length,
      url: `/v1/subscription_items?subscription=${sub.id}`,
    },
    latest_invoice:
      expandInvoice && latest ? invoiceJson(state, latest, false) : sub.latest_invoice,
    livemode: false,
    start_date: sub.created,
    status: sub.status,
    trial_end: sub.trial_end,
    trial_start: sub.trial_start,
  };
}
