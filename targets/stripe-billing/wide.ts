/**
 * The widened slice-1 probe: the same mid-cycle change previewed with `create_preview`, on a
 * subscription of one to three items sharing a monthly or yearly interval, with up to two
 * coupons. The original single-item probe is the special case of one item and at most one coupon;
 * it keeps its own input shape so that its recorded fixtures stay valid.
 */
import type Stripe from "stripe";
import { z } from "zod";
import type { Json } from "../../harness/src/json.ts";

export const Coupon = z.object({
  percent_off: z.number().optional(),
  amount_off: z.number().optional(),
  duration: z.enum(["forever", "once"]),
});
export type Coupon = z.infer<typeof Coupon>;

const Interval = z.enum(["month", "year"]);

export const WideInput = z.object({
  kind: z.literal("wide"),
  start: z.number(),
  billing_mode: z.enum(["flexible", "classic"]),
  interval: Interval,
  items: z
    .array(z.object({ amount: z.number(), quantity: z.number() }))
    .min(1)
    .max(4),
  coupons: z.array(Coupon).max(2),
  change: z.object({
    item: z.number().int().min(0),
    amount: z.number().nullable(),
    // Only with a single item: a subscription's items share one interval.
    interval: Interval.nullable(),
    quantity: z.number().nullable(),
    offset: z.number(),
    proration_behavior: z.enum(["create_prorations", "none", "always_invoice"]).nullable(),
    discount: Coupon.nullable(),
  }),
});
export type WideInput = z.infer<typeof WideInput>;

export async function couponId(stripe: Stripe, c: Coupon): Promise<string> {
  const created = await stripe.coupons.create({
    duration: c.duration,
    ...(c.percent_off !== undefined ? { percent_off: c.percent_off } : {}),
    ...(c.amount_off !== undefined ? { amount_off: c.amount_off, currency: "usd" } : {}),
  });
  return created.id;
}

export async function runWide(
  stripe: Stripe,
  p: WideInput,
  toJson: (v: unknown) => Json,
  errorJson: (e: unknown) => Json,
): Promise<Record<string, Json>> {
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: p.start });
  const price = async (amount: number, interval: "month" | "year", name: string) => {
    const product = await stripe.products.create({ name });
    const created = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: amount,
      recurring: { interval },
    });
    return created.id;
  };
  const names = ["Plan A", "Plan B", "Plan C"];
  const prices: string[] = [];
  for (const [i, item] of p.items.entries())
    prices.push(await price(item.amount, p.interval, names[i] ?? "Plan"));
  const changed = p.items[p.change.item];
  if (!changed) throw new Error(`change.item ${String(p.change.item)} is out of range`);
  const newPrice =
    p.change.amount !== null || p.change.interval !== null
      ? await price(p.change.amount ?? changed.amount, p.change.interval ?? p.interval, "Plan New")
      : null;
  const customer = await stripe.customers.create({
    test_clock: clock.id,
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
    preferred_locales: ["en"],
  });
  const discounts: { coupon: string }[] = [];
  for (const c of p.coupons) discounts.push({ coupon: await couponId(stripe, c) });
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: p.items.map((item, i) => ({ price: prices[i] ?? "", quantity: item.quantity })),
    billing_mode: { type: p.billing_mode },
    ...(discounts.length > 0 ? { discounts } : {}),
  });
  const target = subscription.items.data.find((i) => i.price.id === prices[p.change.item]);
  if (!target) throw new Error("subscription created without the changed item");
  const discount = p.change.discount ? await couponId(stripe, p.change.discount) : null;

  let preview: Json;
  try {
    preview = toJson(
      await stripe.invoices.createPreview({
        subscription: subscription.id,
        subscription_details: {
          items: [
            {
              id: target.id,
              ...(newPrice !== null ? { price: newPrice } : {}),
              ...(p.change.quantity !== null ? { quantity: p.change.quantity } : {}),
            },
          ],
          proration_date: p.start + p.change.offset,
          ...(p.change.proration_behavior !== null
            ? { proration_behavior: p.change.proration_behavior }
            : {}),
        },
        ...(discount !== null ? { discounts: [{ coupon: discount }] } : {}),
      }),
    );
  } catch (e) {
    preview = errorJson(e);
  }
  const first =
    typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : null;
  const invoice = first !== null ? await stripe.invoices.retrieve(first) : null;
  return {
    preview,
    first_invoice: invoice
      ? {
          subtotal: invoice.subtotal,
          total: invoice.total,
          amount_due: invoice.amount_due,
          status: invoice.status,
        }
      : null,
  };
}
