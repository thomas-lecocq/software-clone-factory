/**
 * Stripe Billing adapter. One probe = a fresh billing world on its own test clock (product,
 * prices, coupons, customer, subscription), then one `create_preview` of the probed change. The
 * same code runs against Stripe test mode and against the clone: only the SDK's host changes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { z } from "zod";
import type { Probe, Side, TargetAdapter } from "../../harness/src/adapter.ts";
import { JsonSchema, type Json } from "../../harness/src/json.ts";
import { probes } from "./probes.ts";
import { LifeInput, runLifecycle } from "./lifecycle.ts";
import { ExploreInput, runExplore } from "./explore.ts";
import { runWalkthrough, UiInput } from "./ui.ts";
import { runWide, WideInput } from "./wide.ts";

const Coupon = z.object({
  percent_off: z.number().optional(),
  amount_off: z.number().optional(),
  duration: z.enum(["forever", "once"]),
});
const Plan = z.object({ amount: z.number(), interval: z.enum(["month", "year"]) });
const Input = z.object({
  start: z.number(),
  billing_mode: z.enum(["flexible", "classic"]),
  plan: Plan,
  quantity: z.number(),
  coupon: Coupon.nullable(),
  change: z.object({
    plan: Plan.nullable(),
    quantity: z.number().nullable(),
    offset: z.number(),
    proration_behavior: z.enum(["create_prorations", "none", "always_invoice"]).nullable(),
    discount: Coupon.nullable(),
  }),
});

// The key comes from STRIPE_SECRET_KEY, else from the file named by STRIPE_ENV, else from .env at
// the repository root (git-ignored).
function testKey(): string {
  const file = process.env.STRIPE_ENV ?? join(import.meta.dirname, "..", "..", ".env");
  const fromFile = existsSync(file)
    ? /STRIPE_SECRET_KEY=(\S+)/.exec(readFileSync(file, "utf8"))?.[1]
    : undefined;
  const key = process.env.STRIPE_SECRET_KEY ?? fromFile;
  // Invariant 4: never record outside test mode.
  if (key?.startsWith("sk_test_") !== true) {
    throw new Error("refusing: STRIPE_SECRET_KEY is missing or not a test key (see .env.example)");
  }
  return key;
}

function client(side: Side): Stripe {
  if (side.kind === "target") return new Stripe(testKey(), { maxNetworkRetries: 2 });
  const url = new URL(side.url);
  return new Stripe("sk_test_clone", {
    host: url.hostname,
    port: Number(url.port),
    protocol: "http",
  });
}

const toJson = (v: unknown): Json => JsonSchema.parse(JSON.parse(JSON.stringify(v)));

function errorJson(e: unknown): Json {
  if (e instanceof Stripe.errors.StripeError) {
    return {
      error: { type: e.type, code: e.code ?? null, param: e.param ?? null, message: e.message },
    };
  }
  throw e;
}

async function couponId(stripe: Stripe, c: z.infer<typeof Coupon>): Promise<string> {
  const created = await stripe.coupons.create({
    duration: c.duration,
    ...(c.percent_off !== undefined ? { percent_off: c.percent_off } : {}),
    ...(c.amount_off !== undefined ? { amount_off: c.amount_off, currency: "usd" } : {}),
  });
  return created.id;
}

async function run(probe: Probe, side: Side): Promise<Record<string, Json>> {
  const ui = UiInput.safeParse(probe.input);
  if (ui.success) return runWalkthrough(client(side), ui.data);
  const explore = ExploreInput.safeParse(probe.input);
  if (explore.success) return runExplore(client(side), explore.data);
  const wide = WideInput.safeParse(probe.input);
  if (wide.success) return runWide(client(side), wide.data, toJson, errorJson);
  const life = LifeInput.safeParse(probe.input);
  if (life.success) return runLifecycle(client(side), life.data);
  const p = Input.parse(probe.input);
  const stripe = client(side);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: p.start });
  const price = async (plan: z.infer<typeof Plan>, name: string): Promise<string> => {
    const product = await stripe.products.create({ name });
    const created = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: plan.amount,
      recurring: { interval: plan.interval },
    });
    return created.id;
  };
  const oldPrice = await price(p.plan, "Basic");
  const newPrice = p.change.plan ? await price(p.change.plan, "Pro") : null;
  const customer = await stripe.customers.create({
    test_clock: clock.id,
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
    preferred_locales: ["en"],
  });
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: oldPrice, quantity: p.quantity }],
    billing_mode: { type: p.billing_mode },
    ...(p.coupon ? { discounts: [{ coupon: await couponId(stripe, p.coupon) }] } : {}),
  });
  const item = subscription.items.data[0];
  if (!item) throw new Error("subscription created without an item");
  const discount = p.change.discount ? await couponId(stripe, p.change.discount) : null;

  let preview: Json;
  try {
    preview = toJson(
      await stripe.invoices.createPreview({
        subscription: subscription.id,
        subscription_details: {
          items: [
            {
              id: item.id,
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

const recordedWith = (): Record<string, Json> => ({
  stripe_api_version: Stripe.API_VERSION,
  stripe_node: Stripe.PACKAGE_VERSION,
});

const adapter: TargetAdapter = { probes, run, cloneEntry: "clone/server.ts", recordedWith };
export default adapter;
