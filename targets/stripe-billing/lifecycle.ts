/**
 * Slice 2: the subscription lifecycle over time. A lifecycle probe is a script of actions on one
 * subscription living on a test clock (cancel at period end, reactivate, cancel now, advance the
 * clock, swap in a failing card), with a snapshot of the subscription and its latest invoice after
 * the steps that matter. Snapshots are a projection: fields outside it are not compared.
 */
import type Stripe from "stripe";
import { z } from "zod";
import type { Json } from "../../harness/src/json.ts";

export const LifeStep = z.discriminatedUnion("do", [
  z.object({ do: z.literal("cancel_at_period_end") }),
  z.object({ do: z.literal("reactivate") }),
  z.object({ do: z.literal("cancel_now"), prorate: z.boolean(), invoice_now: z.boolean() }),
  z.object({ do: z.literal("advance"), seconds: z.number() }),
  z.object({ do: z.literal("failing_card") }),
  z.object({ do: z.literal("snapshot"), as: z.string() }),
]);
export type LifeStep = z.infer<typeof LifeStep>;

export const LifeInput = z.object({
  kind: z.literal("lifecycle"),
  start: z.number(),
  amount: z.number(),
  trial_days: z.number().nullable(),
  steps: z.array(LifeStep),
});
export type LifeInput = z.infer<typeof LifeInput>;

export function invoiceView(inv: Stripe.Invoice | null): Json {
  if (!inv) return null;
  return {
    status: inv.status ?? null,
    billing_reason: inv.billing_reason ?? null,
    subtotal: inv.subtotal,
    total: inv.total,
    amount_due: inv.amount_due,
    amount_paid: inv.amount_paid,
    amount_remaining: inv.amount_remaining,
    attempt_count: inv.attempt_count,
    period_start: inv.period_start,
    period_end: inv.period_end,
    lines: inv.lines.data.map((l) => ({ amount: l.amount, description: l.description ?? null })),
  };
}

async function waitReady(stripe: Stripe, clock: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const c = await stripe.testHelpers.testClocks.retrieve(clock);
    if (c.status === "ready") return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`test clock ${clock} did not become ready`);
}

export async function runLifecycle(
  stripe: Stripe,
  input: LifeInput,
): Promise<Record<string, Json>> {
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: input.start });
  const product = await stripe.products.create({ name: "Basic" });
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: input.amount,
    recurring: { interval: "month" },
  });
  const customer = await stripe.customers.create({
    test_clock: clock.id,
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
    preferred_locales: ["en"],
  });
  const created = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
    ...(input.trial_days !== null ? { trial_period_days: input.trial_days } : {}),
  });
  let now = input.start;
  const out: Record<string, Json> = {};
  for (const step of input.steps) {
    if (step.do === "cancel_at_period_end" || step.do === "reactivate") {
      await stripe.subscriptions.update(created.id, {
        cancel_at_period_end: step.do === "cancel_at_period_end",
      });
    } else if (step.do === "cancel_now") {
      await stripe.subscriptions.cancel(created.id, {
        prorate: step.prorate,
        invoice_now: step.invoice_now,
      });
    } else if (step.do === "advance") {
      now += step.seconds;
      await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: now });
      await waitReady(stripe, clock.id);
    } else if (step.do === "failing_card") {
      const pm = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", {
        customer: customer.id,
      });
      await stripe.customers.update(customer.id, {
        invoice_settings: { default_payment_method: pm.id },
      });
    } else {
      const sub = await stripe.subscriptions.retrieve(created.id, { expand: ["latest_invoice"] });
      const item = sub.items.data[0];
      const latest = typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
      const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 10 });
      out[step.as] = {
        status: sub.status,
        cancel_at_period_end: sub.cancel_at_period_end,
        cancel_at: sub.cancel_at ?? null,
        canceled_at: sub.canceled_at ?? null,
        ended_at: sub.ended_at ?? null,
        trial_end: sub.trial_end ?? null,
        period_start: item?.current_period_start ?? null,
        period_end: item?.current_period_end ?? null,
        latest_invoice: invoiceView(latest),
        invoice_count: invoices.data.length,
      };
    }
  }
  return out;
}
