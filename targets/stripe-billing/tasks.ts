/**
 * Tasks for task validation (`harness/src/tasks.ts`): everyday billing operations an agent might be
 * trained on, each with a starting world, an instruction in plain words and a check of the outcome
 * read back through the API on the same side. The world is the slice's: a Basic ($10) and a Pro
 * ($30) monthly price, a customer with a card, a subscription, on a frozen test clock.
 */
import Stripe from "stripe";
import type { Side } from "../../harness/src/adapter.ts";
import type { TaskDefinition, TaskModule } from "../../harness/src/tasks.ts";
import { client, testKey } from "./adapter.ts";
import { STARTS } from "./probes.ts";

interface World {
  plan?: "Basic" | "Pro";
  cancelAtEnd?: boolean;
}

async function world(side: Side, w: World = {}): Promise<Record<string, string>> {
  const stripe = client(side);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: STARTS.oct });
  const prices: Record<string, string> = {};
  for (const [name, amount] of [
    ["Basic", 1000],
    ["Pro", 3000],
  ] as const) {
    const product = await stripe.products.create({ name });
    const price = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: amount,
      recurring: { interval: "month" },
    });
    prices[name] = price.id;
  }
  const customer = await stripe.customers.create({
    test_clock: clock.id,
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
    preferred_locales: ["en"],
  });
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: prices[w.plan ?? "Basic"] ?? "" }],
  });
  if (w.cancelAtEnd === true)
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
  return {
    customer: customer.id,
    subscription: sub.id,
    basic: prices.Basic ?? "",
    pro: prices.Pro ?? "",
  };
}

const cents = (answer: string | null): number | null => {
  const m = /-?\d+/.exec((answer ?? "").replace(/[,\s]/g, ""));
  return m === null ? null : Number(m[0]);
};

async function sub(side: Side, id: string): Promise<Stripe.Subscription> {
  return client(side).subscriptions.retrieve(id, { expand: ["discounts"] });
}

const tasks: TaskDefinition[] = [
  {
    id: "upgrade-and-quote",
    setup: (side) => world(side),
    instruction: (f) =>
      `Subscription ${f.subscription} is on the Basic price ${f.basic ?? ""}. Move it to the Pro price ${f.pro ?? ""}, with prorations. Then tell me the total of the customer's next invoice, in cents.`,
    check: async (side, f, answer) => {
      const s = await sub(side, f.subscription ?? "");
      const preview = await client(side).invoices.createPreview({ subscription: s.id });
      const onPro = s.items.data[0]?.price.id === f.pro;
      return {
        success: onPro && cents(answer) === preview.total,
        detail: { onPro, expected: preview.total, answer },
      };
    },
  },
  {
    id: "apply-coupon",
    setup: (side) => world(side),
    instruction: (f) => `Give subscription ${f.subscription} a 20 % discount that lasts forever.`,
    check: async (side, f) => {
      // A discount's coupon is an ID unless expanded: read it from the discount object itself.
      const s = await client(side).subscriptions.retrieve(f.subscription ?? "", {
        expand: ["discounts.source.coupon"],
      });
      const d = s.discounts[0];
      const raw = typeof d === "object" ? d.source.coupon : null;
      const c = typeof raw === "object" && raw !== null ? raw : null;
      const ok = s.discounts.length === 1 && c?.percent_off === 20 && c.duration === "forever";
      return {
        success: ok,
        detail: { discounts: s.discounts.length, percent: c?.percent_off ?? null },
      };
    },
  },
  {
    id: "cancel-at-period-end",
    setup: (side) => world(side),
    instruction: (f) =>
      `Subscription ${f.subscription} should stop at the end of its current period, not now.`,
    check: async (side, f) => {
      const s = await sub(side, f.subscription ?? "");
      const ok = s.status === "active" && (s.cancel_at_period_end || s.cancel_at !== null);
      return {
        success: ok,
        detail: {
          status: s.status,
          cancel_at_period_end: s.cancel_at_period_end,
          cancel_at: s.cancel_at,
        },
      };
    },
  },
  {
    id: "quote-quantity-change",
    setup: (side) => world(side),
    instruction: (f) =>
      `Without changing anything, tell me how much the customer would be charged right away, in cents, if subscription ${f.subscription} went to quantity 3 with proration_behavior always_invoice.`,
    check: async (side, f, answer) => {
      const s = await sub(side, f.subscription ?? "");
      const item = s.items.data[0];
      const preview = await client(side).invoices.createPreview({
        subscription: s.id,
        subscription_details: {
          items: [{ id: item?.id ?? "", quantity: 3 }],
          proration_behavior: "always_invoice",
        },
      });
      const unchanged = item?.quantity === 1 && item.price.id === f.basic;
      return {
        success: unchanged && cents(answer) === preview.amount_due,
        detail: { unchanged, expected: preview.amount_due, answer },
      };
    },
  },
  {
    id: "undo-cancellation",
    setup: (side) => world(side, { cancelAtEnd: true }),
    instruction: (f) =>
      `Subscription ${f.subscription} is set to stop at the end of the period. Make it renew normally instead.`,
    check: async (side, f) => {
      const s = await sub(side, f.subscription ?? "");
      const ok = s.status === "active" && !s.cancel_at_period_end && s.cancel_at === null;
      return {
        success: ok,
        detail: { cancel_at_period_end: s.cancel_at_period_end, cancel_at: s.cancel_at },
      };
    },
  },
  {
    id: "cancel-now-with-credit",
    setup: (side) => world(side),
    instruction: (f) =>
      `Cancel subscription ${f.subscription} immediately, crediting the unused time on a final invoice.`,
    check: async (side, f) => {
      const s = await sub(side, f.subscription ?? "");
      return { success: s.status === "canceled", detail: { status: s.status } };
    },
  },
  {
    id: "downgrade-without-proration",
    setup: (side) => world(side, { plan: "Pro" }),
    instruction: (f) =>
      `Subscription ${f.subscription} is on the Pro price ${f.pro ?? ""}. Move it to the Basic price ${f.basic ?? ""} without any proration.`,
    check: async (side, f) => {
      const s = await sub(side, f.subscription ?? "");
      const items = await client(side).invoiceItems.list({
        customer: f.customer ?? "",
        pending: true,
      });
      const onBasic = s.items.data[0]?.price.id === f.basic;
      return {
        success: onBasic && items.data.length === 0,
        detail: { onBasic, pending_items: items.data.length },
      };
    },
  },
  {
    id: "period-end",
    setup: (side) => world(side),
    instruction: (f) =>
      `When does the current period of subscription ${f.subscription} end? Answer as a Unix timestamp in seconds.`,
    check: async (side, f, answer) => {
      const s = await sub(side, f.subscription ?? "");
      const end = s.items.data[0]?.current_period_end ?? null;
      return { success: end !== null && cents(answer) === end, detail: { expected: end, answer } };
    },
  },
];

const preamble = [
  "You operate a billing system through its HTTP API, which works like the Stripe API. It is at",
  "$API_BASE (an environment variable) and already authenticated: send requests with curl,",
  "form-encoded (for example `curl -s $API_BASE/v1/customers/cus_123`). Do the task, then end your",
  "reply with one line `ANSWER: <value>`: the number asked for, or `done` when no number is asked.",
  "",
  "Task:",
].join("\n");

const module: TaskModule = {
  tasks,
  preamble,
  upstream: (side): { url: string; headers: Record<string, string> } => {
    if (side.kind === "clone")
      return { url: side.url, headers: { authorization: "Bearer sk_test_clone" } };
    return {
      url: "https://api.stripe.com",
      headers: { authorization: `Bearer ${testKey()}`, "stripe-version": Stripe.API_VERSION },
    };
  },
};
export default module;
