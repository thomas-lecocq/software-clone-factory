// Recon: walk the whole portal plan-change flow from the home page and dump what each step shows
// and which JSON requests it fires. Output under recon/out/walk (not committed).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { chromium, type Page } from "playwright";

const key = /STRIPE_SECRET_KEY=(\S+)/.exec(
  readFileSync(process.env.STRIPE_ENV ?? `${import.meta.dirname}/../../../.env`, "utf8"),
)?.[1];
if (!key?.startsWith("sk_test_")) throw new Error("refusing: not a test key");
const stripe = new Stripe(key);
const out = join(import.meta.dirname, "out", "walk");
mkdirSync(out, { recursive: true });

const clock = await stripe.testHelpers.testClocks.create({
  frozen_time: Math.floor(Date.now() / 1000),
});
const basic = await stripe.products.create({ name: "Basic" });
const pro = await stripe.products.create({ name: "Pro" });
const pb = await stripe.prices.create({
  product: basic.id,
  currency: "usd",
  unit_amount: 1000,
  recurring: { interval: "month" },
});
const pp = await stripe.prices.create({
  product: pro.id,
  currency: "usd",
  unit_amount: 3000,
  recurring: { interval: "month" },
});
const customer = await stripe.customers.create({
  test_clock: clock.id,
  payment_method: "pm_card_visa",
  invoice_settings: { default_payment_method: "pm_card_visa" },
  preferred_locales: ["en"],
});
await stripe.subscriptions.create({ customer: customer.id, items: [{ price: pb.id }] });
const config = await stripe.billingPortal.configurations.create({
  features: {
    payment_method_update: { enabled: true },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price"],
      proration_behavior: "create_prorations",
      products: [
        { product: basic.id, prices: [pb.id] },
        { product: pro.id, prices: [pp.id] },
      ],
    },
  },
});
const session = await stripe.billingPortal.sessions.create({
  customer: customer.id,
  configuration: config.id,
});

const browser = await chromium.launch();
const context = await browser.newContext({
  locale: "en-US",
  recordHar: { path: join(out, "walk.har"), content: "embed" },
});
const page = await context.newPage();
const requests: string[] = [];
page.on("request", (r) => {
  if (r.url().includes("billing.stripe.com/v1/"))
    requests.push(`${r.method()} ${r.url().split("?")[0] ?? ""}`);
});
let n = 0;
const snap = async (p: Page, name: string): Promise<void> => {
  n += 1;
  await p.waitForLoadState("networkidle");
  writeFileSync(join(out, `${n}-${name}.aria.yml`), await p.locator("body").ariaSnapshot());
  await p.screenshot({ path: join(out, `${n}-${name}.png`), fullPage: true });
  writeFileSync(join(out, `${n}-${name}.requests.txt`), requests.splice(0).join("\n"));
};

await page.goto(session.url);
await snap(page, "home");
await page
  .getByRole("link", { name: /update subscription/i })
  .or(page.getByRole("button", { name: /update subscription/i }))
  .first()
  .click();
await snap(page, "plans");
await page.getByRole("button", { name: "Select" }).first().click();
await snap(page, "plan-selected");
await page
  .getByRole("button", { name: /continue/i })
  .first()
  .click();
await page.getByText("Confirm your updates").waitFor();
await snap(page, "confirm");
await page
  .getByRole("button", { name: /confirm|subscribe|pay/i })
  .first()
  .click();
await page.waitForTimeout(3000);
await snap(page, "after-confirm");
await page
  .getByText("Current subscription")
  .waitFor({ timeout: 20000 })
  .catch(() => undefined);
await snap(page, "after-confirm-settled");
await context.close();
await browser.close();
console.log(`walked ${n} steps into ${out}`);
