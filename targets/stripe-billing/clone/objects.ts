/** Stripe-shaped JSON for the clone's objects. Constants here are the recorded account's. */
import type { Json } from "../../../harness/src/json.ts";
import { amountDue, priceOf, totals } from "./billing.ts";
import {
  get,
  type Coupon,
  type Customer,
  type DiscountAmount,
  type Invoice,
  type InvoiceItem,
  type Line,
  type State,
  type SubItem,
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
    // A line without a subscription item comes from a one-off invoice item (ITM-02, INV-02); it
    // names the item's own subscription. A detached proration (LIF-09) is shown the same way.
    parent:
      l.subscription_item === null || l.detached === true
        ? {
            invoice_item_details: {
              invoice_item: l.invoice_item,
              proration: l.proration,
              proration_details: {
                credited_items: l.credited
                  ? { invoice: l.credited.invoice, invoice_line_items: [l.credited.line] }
                  : null,
              },
              subscription:
                l.invoice_item !== null
                  ? (get(state.invoice_items, l.invoice_item)?.subscription ?? null)
                  : null,
            },
            subscription_item_details: null,
            type: "invoice_item_details",
          }
        : {
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

// The recorded account's ID as it appears in hosted invoice URLs.
const ACCOUNT_ID = "acct_1UIrqUAcmeAcct00";

// Invoice number: the customer's prefix and the rank of the invoice among its finalized ones.
function invoiceNumber(state: State, inv: Invoice, prefix: string): string {
  const finalized = Object.values(state.invoices).filter(
    (i) => i.customer === inv.customer && i.finalized_at !== null,
  );
  const rank = finalized.findIndex((i) => i.id === inv.id) + 1;
  return `${prefix}-${String(rank).padStart(4, "0")}`;
}

export function invoiceJson(state: State, inv: Invoice, preview: boolean): Json {
  const { subtotal, total } = totals(inv.lines, inv.total_discount_amounts);
  // A finalized invoice gets a number, hosted URLs and an effective date (INV-02).
  const finalized = !preview && inv.finalized_at !== null;
  const token = `test_YWNj${inv.id.slice(inv.id.indexOf("_") + 1)}`;
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
    // A paid invoice counts as attempted even when nothing was charged (dev-v5-cancel-at-mid-prorate).
    attempted: inv.attempt_count > 0 || (!preview && inv.status === "paid"),
    auto_advance: inv.auto_advance,
    automatic_tax: {
      disabled_reason: null,
      enabled: false,
      liability: null,
      provider: null,
      status: null,
    },
    automatically_finalizes_at:
      !preview && inv.status === "draft" && inv.auto_advance ? inv.next_payment_attempt : null,
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
    effective_at: finalized ? inv.finalized_at : null,
    ending_balance: preview ? ending : inv.status === "draft" ? null : ending,
    footer: null,
    from_invoice: null,
    hosted_invoice_url: finalized
      ? `https://invoice.stripe.com/i/${ACCOUNT_ID}/${token}?s=ap`
      : null,
    invoice_pdf: finalized
      ? `https://pay.stripe.com/invoice/${ACCOUNT_ID}/${token}/pdf?s=ap`
      : null,
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
    number: finalized ? invoiceNumber(state, inv, customer?.invoice_prefix ?? "") : null,
    on_behalf_of: null,
    parent: inv.manual
      ? null
      : {
          quote_details: null,
          subscription_details: {
            metadata: {},
            subscription: inv.subscription,
            ...(inv.proration_date !== null
              ? { subscription_proration_date: inv.proration_date }
              : {}),
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
    rendering: inv.manual
      ? {
          amount_tax_display: null,
          pdf: { page_size: finalized ? "letter" : "auto" },
          template: null,
          template_version: null,
        }
      : null,
    shipping_cost: null,
    shipping_details: null,
    starting_balance: inv.starting_balance,
    statement_descriptor: null,
    status: inv.status,
    status_transitions: {
      finalized_at: finalized ? inv.finalized_at : null,
      marked_uncollectible_at: null,
      paid_at: finalized && inv.status === "paid" ? inv.paid_at : null,
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
    webhooks_delivered_at: preview ? null : inv.created,
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
    billing_scheme: "per_unit",
    created: p.created,
    currency: p.currency,
    custom_unit_amount: null,
    livemode: false,
    lookup_key: null,
    metadata: {},
    nickname: null,
    product: p.product,
    recurring: {
      interval: p.interval,
      interval_count: 1,
      meter: null,
      trial_period_days: null,
      usage_type: "licensed",
    },
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    type: "recurring",
    unit_amount: p.unit_amount,
    unit_amount_decimal: String(p.unit_amount),
  };
}

// The legacy `plan` view of a recurring price, still returned beside `price`.
export function planJson(state: State, id: string): Json {
  const p = priceOf(state, id);
  return {
    id: p.id,
    object: "plan",
    active: true,
    amount: p.unit_amount,
    amount_decimal: String(p.unit_amount),
    billing_scheme: "per_unit",
    created: p.created,
    currency: p.currency,
    interval: p.interval,
    interval_count: 1,
    livemode: false,
    metadata: {},
    meter: null,
    nickname: null,
    product: p.product,
    tiers_mode: null,
    transform_usage: null,
    trial_period_days: null,
    usage_type: "licensed",
  };
}

export function itemJson(state: State, sub: Subscription, it: SubItem): Json {
  return {
    id: it.id,
    object: "subscription_item",
    billing_thresholds: null,
    created: it.created,
    current_period_end: sub.period_end,
    current_period_start: sub.period_start,
    current_trial: null,
    discounts: [],
    metadata: {},
    plan: planJson(state, it.price),
    price: priceJson(state, it.price),
    quantity: it.quantity,
    subscription: sub.id,
    tax_rates: [],
  };
}

// The coupon object as `expand=discounts.source.coupon` shows it (DSC-09). A coupon counts one
// redemption per discount applied to a subscription; one passed to a preview is not redeemed.
export function fullCouponJson(state: State, c: Coupon): Json {
  return {
    id: c.id,
    object: "coupon",
    amount_off: c.amount_off,
    created: c.created,
    currency: c.amount_off !== null ? "usd" : null,
    duration: c.duration,
    duration_in_months: null,
    livemode: false,
    max_redemptions: null,
    metadata: {},
    name: null,
    percent_off: c.percent_off,
    redeem_by: null,
    times_redeemed: Object.values(state.discounts).filter(
      (d) => d.coupon === c.id && d.subscription !== null,
    ).length,
    valid: true,
  };
}

export function discountJson(state: State, id: string, expandCoupon = false): Json {
  const d = get(state.discounts, id);
  if (!d) return id;
  const coupon = expandCoupon ? get(state.coupons, d.coupon) : undefined;
  return {
    id: d.id,
    object: "discount",
    checkout_session: null,
    customer: d.customer,
    customer_account: null,
    end: null,
    invoice: null,
    invoice_item: null,
    promotion_code: null,
    source: { coupon: coupon ? fullCouponJson(state, coupon) : d.coupon, type: "coupon" },
    start: d.start,
    subscription: d.subscription,
    subscription_item: null,
  };
}

export function customerJson(state: State, c: Customer): Json {
  return {
    id: c.id,
    object: "customer",
    address: null,
    balance: c.balance,
    created: c.created,
    currency: c.currency,
    customer_account: null,
    default_source: null,
    delinquent: false,
    description: null,
    discount: null,
    email: null,
    invoice_prefix: c.invoice_prefix,
    invoice_settings: {
      custom_fields: null,
      default_payment_method: c.default_payment_method,
      footer: null,
      rendering_options: null,
    },
    livemode: false,
    metadata: {},
    name: null,
    phone: null,
    preferred_locales: [...c.preferred_locales],
    shipping: null,
    tax_exempt: "none",
    test_clock: c.clock,
  };
}

export function invoiceItemJson(state: State, ii: InvoiceItem): Json {
  const l = ii.line;
  const price = get(state.prices, l.price);
  const customer = get(state.customers, ii.customer);
  // A one-off invoice item (POST /v1/invoiceitems) has no proration details, and a parent only
  // when it was created for a subscription.
  if (ii.oneoff) {
    return {
      id: ii.id,
      object: "invoiceitem",
      amount: l.amount,
      currency: "usd",
      customer: ii.customer,
      customer_account: null,
      date: ii.date,
      description: l.description,
      discountable: l.discountable,
      discounts: [],
      frozen_fields: [],
      invoice: ii.invoice,
      invoicing_rules: [],
      livemode: false,
      metadata: {},
      parent:
        ii.subscription !== null
          ? {
              subscription_details: { subscription: ii.subscription },
              type: "subscription_details",
            }
          : null,
      period: { end: l.period.end, start: l.period.start },
      pricing: {
        price_details: { price: l.price, product: price?.product ?? null },
        type: "price_details",
        unit_amount_decimal: l.unit_amount_decimal,
      },
      proration: l.proration,
      quantity: l.quantity,
      quantity_decimal: String(l.quantity),
      tax_rates: [],
      test_clock: customer?.clock ?? null,
    };
  }
  const net = l.amount - l.discount_amounts.reduce((a, d) => a + d.amount, 0);
  return {
    id: ii.id,
    object: "invoiceitem",
    amount: l.amount,
    currency: "usd",
    customer: ii.customer,
    customer_account: null,
    date: ii.date,
    description: l.description,
    discountable: l.discountable,
    discounts: [],
    frozen_fields: ["pricing", "quantity", "discounts"],
    invoice: ii.invoice,
    invoicing_rules: [],
    livemode: false,
    metadata: {},
    net_amount: net,
    parent: {
      subscription_details: {
        subscription: ii.subscription,
        subscription_item: l.subscription_item,
      },
      type: "subscription_details",
    },
    period: { end: l.period.end, start: l.period.start },
    pricing: {
      price_details: { price: l.price, product: price?.product ?? null },
      type: "price_details",
      unit_amount_decimal: l.unit_amount_decimal,
    },
    proration: l.proration,
    proration_details: {
      credited_items: l.credited
        ? {
            invoice_line_item_details: {
              invoice: l.credited.invoice,
              invoice_line_items: [l.credited.line],
            },
            type: "invoice_line_items",
          }
        : null,
      discount_amounts: l.discount_amounts.map((d) => ({ amount: d.amount, discount: d.discount })),
    },
    quantity: l.quantity,
    quantity_decimal: String(l.quantity),
    tax_rates: [],
    test_clock: customer?.clock ?? null,
  };
}

export function subscriptionJson(
  state: State,
  sub: Subscription,
  expandInvoice: boolean,
  expandDiscounts = false,
  expandCoupons = false,
): Json {
  const latest = sub.latest_invoice ? get(state.invoices, sub.latest_invoice) : undefined;
  const customer = get(state.customers, sub.customer);
  const single = sub.items.length === 1 ? sub.items[0] : undefined;
  return {
    id: sub.id,
    object: "subscription",
    application: null,
    application_fee_percent: null,
    automatic_tax: { disabled_reason: null, enabled: false, liability: null },
    billing_cycle_anchor: sub.anchor,
    billing_cycle_anchor_config: null,
    // Only the flexible shape is recorded; the classic one is a guess (NOTES.md, pass 6).
    billing_mode:
      sub.billing_mode === "flexible"
        ? {
            flexible: { proration_discounts: "included" },
            type: "flexible",
            updated_at: sub.created,
          }
        : { flexible: null, type: "classic", updated_at: sub.created },
    billing_schedules: [],
    billing_thresholds: null,
    cancel_at: sub.cancel_at,
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: sub.canceled_at,
    cancellation_details: {
      comment: null,
      feedback: null,
      feedback_option: null,
      reason: sub.cancellation_reason,
    },
    collection_method: "charge_automatically",
    created: sub.created,
    currency: "usd",
    customer: sub.customer,
    customer_account: null,
    days_until_due: null,
    default_payment_method: null,
    default_source: null,
    default_tax_rates: [],
    description: null,
    discounts: sub.discounts.map((d) =>
      expandDiscounts || expandCoupons ? discountJson(state, d, expandCoupons) : d,
    ),
    ended_at: sub.ended_at,
    invoice_settings: {
      account_tax_ids: null,
      custom_fields: null,
      description: null,
      footer: null,
      issuer: { type: "self" },
    },
    items: {
      object: "list",
      data: sub.items.map((it) => itemJson(state, sub, it)),
      has_more: false,
      total_count: sub.items.length,
      url: `/v1/subscription_items?subscription=${sub.id}`,
    },
    latest_invoice:
      expandInvoice && latest ? invoiceJson(state, latest, false) : sub.latest_invoice,
    livemode: false,
    managed_payments: { enabled: false },
    metadata: { ...sub.metadata },
    next_pending_invoice_item_invoice: null,
    on_behalf_of: null,
    pause_collection: null,
    payment_settings: {
      payment_method_options: null,
      payment_method_types: null,
      save_default_payment_method: "off",
    },
    pending_invoice_item_interval: null,
    pending_setup_intent: null,
    pending_update: null,
    // A single-item subscription also shows its item as the legacy `plan` and `quantity`.
    plan: single ? planJson(state, single.price) : null,
    quantity: single ? single.quantity : null,
    schedule: null,
    start_date: sub.created,
    status: sub.status,
    test_clock: customer?.clock ?? null,
    transfer_data: null,
    trial_end: sub.trial_end,
    trial_settings: {
      end_behavior: { billing_cycle_anchor: "now", missing_payment_method: "create_invoice" },
    },
    trial_start: sub.trial_start,
  };
}
