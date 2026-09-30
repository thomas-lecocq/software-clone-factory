// Recon: open the Customer Portal update-confirm flow headless and record what it shows
// (aria snapshot per step, HAR of every request the page makes, a screenshot for a human glance).
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { chromium } from "playwright";
import { z } from "zod";

const envFile = process.env.STRIPE_ENV ?? `${import.meta.dirname}/../../../.env`;
const key = /STRIPE_SECRET_KEY=(\S+)/.exec(readFileSync(envFile, "utf8"))?.[1];
if (!key?.startsWith("sk_test_")) throw new Error("refusing: not a test key");
const stripe = new Stripe(key);

const out = join(import.meta.dirname, "out");
const Ids = z.object({ id: z.string() });
const readId = (f: string): string => Ids.parse(JSON.parse(readFileSync(join(out, f), "utf8"))).id;
const Sub = z.object({
  id: z.string(),
  items: z.object({ data: z.array(z.object({ id: z.string() })) }),
});
const sub = Sub.parse(JSON.parse(readFileSync(join(out, "subscription.json"), "utf8")));
const item = sub.items.data[0];
if (!item) throw new Error("subscription has no item");

const session = await stripe.billingPortal.sessions.create({
  customer: readId("customer.json"),
  configuration: readId("portal_config.json"),
  flow_data: {
    type: "subscription_update_confirm",
    subscription_update_confirm: {
      subscription: sub.id,
      items: [{ id: item.id, price: readId("price_pro.json") }],
    },
  },
});

const dir = join(out, "portal");
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  recordHar: { path: join(dir, "portal.har"), content: "embed" },
  locale: "en-US",
});
const page = await context.newPage();
await page.goto(session.url, { waitUntil: "networkidle" });
writeFileSync(join(dir, "confirm.aria.yml"), await page.locator("body").ariaSnapshot());
await page.screenshot({ path: join(dir, "confirm.png"), fullPage: true });
await context.close();
await browser.close();
console.log(`recorded in ${dir}`);
