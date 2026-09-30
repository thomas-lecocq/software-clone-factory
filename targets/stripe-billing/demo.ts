/**
 * Starts the clone, seeds one customer on the Basic plan through the same SDK calls the probes
 * use, and prints a Customer Portal URL to open in a browser. The clone stays up until Ctrl-C;
 * `POST /__reset` empties it again.
 */
import Stripe from "stripe";
import { startClone } from "./clone/server.ts";

const port = Number(process.env.PORT ?? "4599");
const clone = await startClone(port);
const stripe = new Stripe("sk_test_clone", { host: "127.0.0.1", port, protocol: "http" });

const clock = await stripe.testHelpers.testClocks.create({ frozen_time: 1791158400 });
const prices: string[] = [];
const products: { product: string; prices: string[] }[] = [];
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
  prices.push(price.id);
  products.push({ product: product.id, prices: [price.id] });
}
const customer = await stripe.customers.create({
  test_clock: clock.id,
  payment_method: "pm_card_visa",
  invoice_settings: { default_payment_method: "pm_card_visa" },
  preferred_locales: ["en"],
});
await stripe.subscriptions.create({ customer: customer.id, items: [{ price: prices[0] ?? "" }] });
const configuration = await stripe.billingPortal.configurations.create({
  features: {
    payment_method_update: { enabled: true },
    subscription_cancel: {
      enabled: true,
      mode: "at_period_end",
      cancellation_reason: { enabled: false, options: ["other", "unused"] },
    },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price"],
      proration_behavior: "create_prorations",
      products,
    },
  },
});
const session = await stripe.billingPortal.sessions.create({
  customer: customer.id,
  configuration: configuration.id,
});
console.log(`clone on ${clone.url}\nopen the portal: ${session.url}\n(Ctrl-C to stop)`);
