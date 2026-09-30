/**
 * UI probes for the Customer Portal plan-change flow. A walkthrough is data (actions and the text
 * each screen must show before it is captured), so the same steps drive the real portal and the
 * clone's. Each capture is the page's accessibility tree without link targets, plus the portal
 * API calls the step fired (method and path only).
 */
import { chromium, type Page } from "playwright";
import type Stripe from "stripe";
import { z } from "zod";
import type { Json } from "../../harness/src/json.ts";

export const Step = z.discriminatedUnion("do", [
  z.object({
    do: z.literal("click"),
    role: z.enum(["button", "link"]),
    name: z.string(),
    nth: z.number().optional(),
  }),
  z.object({ do: z.literal("hoverIconAfter"), text: z.string() }),
  z.object({ do: z.literal("capture"), as: z.string(), until: z.string() }),
]);
export type Step = z.infer<typeof Step>;

export const UiInput = z.object({
  kind: z.literal("ui"),
  start: z.number(),
  current: z.enum(["Basic", "Pro"]),
  coupon_percent: z.number().nullable(),
  // Slice 2. Absent in slice 1 fixtures, which were recorded with cancellation disabled.
  cancel_enabled: z.boolean().default(false),
  steps: z.array(Step),
});
export type UiInput = z.infer<typeof UiInput>;

export const PLANS = { Basic: 1000, Pro: 3000 } as const;

function normalise(aria: string): string[] {
  return aria
    .split("\n")
    .filter((l) => !/^\s*- \/url:/.test(l))
    .map((l) => l.replace(/\s+$/, ""));
}

async function act(page: Page, step: Step): Promise<void> {
  if (step.do === "click") {
    await page
      .getByRole(step.role, { name: step.name, exact: true })
      .nth(step.nth ?? 0)
      .click();
  } else if (step.do === "hoverIconAfter") {
    await page
      .getByText(step.text, { exact: true })
      .first()
      .locator("xpath=following::*[name()='svg'][1]")
      .hover();
    await page.getByRole("tooltip").first().waitFor({ timeout: 5000 });
  }
}

export async function runWalkthrough(
  stripe: Stripe,
  input: UiInput,
): Promise<Record<string, Json>> {
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: input.start });
  const prices: Record<string, string> = {};
  const products: { product: string; prices: string[] }[] = [];
  for (const name of ["Basic", "Pro"] as const) {
    const product = await stripe.products.create({ name });
    const price = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: PLANS[name],
      recurring: { interval: "month" },
    });
    prices[name] = price.id;
    products.push({ product: product.id, prices: [price.id] });
  }
  const customer = await stripe.customers.create({
    test_clock: clock.id,
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
    preferred_locales: ["en"],
  });
  const coupon =
    input.coupon_percent !== null
      ? await stripe.coupons.create({ duration: "forever", percent_off: input.coupon_percent })
      : null;
  await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: prices[input.current] ?? "" }],
    ...(coupon ? { discounts: [{ coupon: coupon.id }] } : {}),
  });
  const configuration = await stripe.billingPortal.configurations.create({
    features: {
      payment_method_update: { enabled: true },
      ...(input.cancel_enabled
        ? {
            subscription_cancel: {
              enabled: true,
              mode: "at_period_end" as const,
              // The API wants two options even with the reason prompt disabled.
              cancellation_reason: {
                enabled: false,
                options: ["other" as const, "unused" as const],
              },
            },
          }
        : {}),
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

  const browser = await chromium.launch();
  const out: Record<string, Json> = {};
  try {
    const page = await (await browser.newContext({ locale: "en-US", timezoneId: "UTC" })).newPage();
    const fired: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/v1/billing_portal/")) fired.push(`${r.method()} ${u.pathname}`);
    });
    await page.goto(session.url);
    for (const step of input.steps) {
      if (step.do === "capture") {
        await page.getByText(step.until, { exact: false }).first().waitFor({ timeout: 20000 });
        // The real portal keeps background connections open, so "network idle" may never come.
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
        out[step.as] = {
          screen: normalise(await page.locator("body").ariaSnapshot()),
          requests: fired.splice(0),
        };
      } else {
        await act(page, step);
      }
    }
  } finally {
    await browser.close();
  }
  return out;
}
