/**
 * Slice 2: the subscription lifecycle over time. A lifecycle probe is a script of actions on one
 * subscription living on a test clock (cancel at period end, reactivate, cancel now, advance the
 * clock, swap in a failing card), with a snapshot of the subscription and its latest invoice after
 * the steps that matter. Snapshots are a projection: fields outside it are not compared.
 */
import Stripe from "stripe";
import { z } from "zod";
import { JsonSchema, type Json } from "../../harness/src/json.ts";
import { Coupon, couponId } from "./wide.ts";

export const LifeStep = z.discriminatedUnion("do", [
  z.object({ do: z.literal("cancel_at_period_end") }),
  z.object({ do: z.literal("reactivate") }),
  z.object({ do: z.literal("cancel_now"), prorate: z.boolean(), invoice_now: z.boolean() }),
  z.object({ do: z.literal("advance"), seconds: z.number() }),
  z.object({ do: z.literal("failing_card") }),
  // Swaps the failing card for a working one, to see a past_due subscription recover.
  z.object({ do: z.literal("good_card") }),
  z.object({ do: z.literal("snapshot"), as: z.string() }),
  // Reads a subscription that does not exist, to pin the error a missing object returns.
  z.object({ do: z.literal("retrieve_missing"), as: z.string() }),
  // Any API call, recorded whole: replays the calls an agent made in task validation. Path and
  // parameter values may name {subscription}, {customer}, {item}, {price}, {price2}, {coupon}.
  z.object({
    do: z.literal("raw"),
    as: z.string(),
    method: z.enum(["GET", "POST", "DELETE"]),
    path: z.string(),
    params: z.record(z.string(), z.string()).default({}),
  }),
]);
export type LifeStep = z.infer<typeof LifeStep>;

export const LifeInput = z.object({
  kind: z.literal("lifecycle"),
  start: z.number(),
  amount: z.number(),
  trial_days: z.number().nullable(),
  // A coupon on the subscription from its creation; absent in fixtures recorded before it existed.
  coupon: Coupon.nullable().default(null),
  // A second monthly price ("Pro") to move to, for raw calls; absent in older fixtures.
  second_amount: z.number().nullable().default(null),
  // A coupon created but not applied, for raw calls to apply ({coupon}); absent in older fixtures.
  spare_coupon: Coupon.nullable().default(null),
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
  let price2: string | null = null;
  if (input.second_amount !== null) {
    const pro = await stripe.products.create({ name: "Pro" });
    price2 = (
      await stripe.prices.create({
        product: pro.id,
        currency: "usd",
        unit_amount: input.second_amount,
        recurring: { interval: "month" },
      })
    ).id;
  }
  const spare = input.spare_coupon !== null ? await couponId(stripe, input.spare_coupon) : null;
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
    ...(input.coupon !== null
      ? { discounts: [{ coupon: await couponId(stripe, input.coupon) }] }
      : {}),
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
    } else if (step.do === "good_card") {
      const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
      await stripe.customers.update(customer.id, {
        invoice_settings: { default_payment_method: pm.id },
      });
    } else if (step.do === "failing_card") {
      const pm = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", {
        customer: customer.id,
      });
      await stripe.customers.update(customer.id, {
        invoice_settings: { default_payment_method: pm.id },
      });
    } else if (step.do === "raw") {
      const fill = (v: string): string =>
        v
          .replaceAll("{subscription}", created.id)
          .replaceAll("{customer}", customer.id)
          .replaceAll("{item}", created.items.data[0]?.id ?? "")
          .replaceAll("{price}", price.id)
          .replaceAll("{price2}", price2 ?? "")
          .replaceAll("{coupon}", spare ?? "");
      const params = Object.fromEntries(Object.entries(step.params).map(([k, v]) => [k, fill(v)]));
      try {
        // The SDK takes parameters on POST only; GET and DELETE carry them in the query string.
        const query = new URLSearchParams(params).toString();
        const body: unknown =
          step.method === "POST"
            ? await stripe.rawRequest("POST", fill(step.path), params)
            : await stripe.rawRequest(step.method, `${fill(step.path)}${query ? `?${query}` : ""}`);
        out[step.as] = { ok: true, body: JsonSchema.parse(JSON.parse(JSON.stringify(body))) };
      } catch (e) {
        if (!(e instanceof Stripe.errors.StripeError)) throw e;
        out[step.as] = {
          ok: false,
          error: { type: e.type, code: e.code ?? null, param: e.param ?? null, message: e.message },
        };
      }
    } else if (step.do === "retrieve_missing") {
      try {
        await stripe.subscriptions.retrieve("sub_Missing0000000000");
        out[step.as] = { error: null };
      } catch (e) {
        if (!(e instanceof Stripe.errors.StripeError)) throw e;
        out[step.as] = {
          error: { type: e.type, code: e.code ?? null, param: e.param ?? null, message: e.message },
        };
      }
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
