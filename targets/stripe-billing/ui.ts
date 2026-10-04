/**
 * UI probes for the Customer Portal. A walkthrough is data (actions and the text each screen must
 * show before it is captured), so the same steps drive the real portal and the clone's. A capture
 * is the page's accessibility tree without link targets, plus the portal API calls the step fired.
 * With `capture: "full"` it also holds each call's request body, the layout of the visible
 * elements and a masked luminance thumbnail, and the walkthrough ends with the account state it
 * left behind, read through the public API: what the clicks actually did.
 */
import { chromium, type Browser, type Page } from "playwright";
import type Stripe from "stripe";
import { z } from "zod";
import { JsonSchema, type Json } from "../../harness/src/json.ts";
import { invoiceView } from "./lifecycle.ts";

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

export const World = z.object({
  start: z.number(),
  current: z.enum(["Basic", "Pro"]),
  coupon_percent: z.number().nullable(),
  // Slice 2. Absent in slice 1 fixtures, which were recorded with cancellation disabled.
  cancel_enabled: z.boolean().default(false),
  quantity: z.number().default(1),
});
export type World = z.infer<typeof World>;

export const UiInput = World.extend({
  kind: z.literal("ui"),
  // "screen" is the original capture; fixtures recorded before "full" existed keep it.
  capture: z.enum(["screen", "full"]).default("screen"),
  steps: z.array(Step),
});
export type UiInput = z.infer<typeof UiInput>;

export const PLANS = { Basic: 1000, Pro: 3000 } as const;
export const VIEWPORT = { width: 1280, height: 800 };
const THUMB = { width: 64, height: 40 };

export interface Portal {
  url: string;
  subscription: string;
}

export async function setupWorld(stripe: Stripe, w: World): Promise<Portal> {
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: w.start });
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
    w.coupon_percent !== null
      ? await stripe.coupons.create({ duration: "forever", percent_off: w.coupon_percent })
      : null;
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [
      { price: prices[w.current] ?? "", ...(w.quantity !== 1 ? { quantity: w.quantity } : {}) },
    ],
    ...(coupon ? { discounts: [{ coupon: coupon.id }] } : {}),
  });
  const configuration = await stripe.billingPortal.configurations.create({
    features: {
      payment_method_update: { enabled: true },
      ...(w.cancel_enabled
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
        default_allowed_updates: w.quantity !== 1 ? ["price", "quantity"] : ["price"],
        proration_behavior: "create_prorations",
        products,
      },
    },
  });
  const session = await stripe.billingPortal.sessions.create({
    customer: customer.id,
    configuration: configuration.id,
  });
  return { url: session.url, subscription: subscription.id };
}

export function normalise(aria: string): string[] {
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

// Form bodies become sorted key/value objects so that parameter order never matters.
function parseBody(raw: string | null, type: string | undefined): Json {
  if (raw === null || raw === "") return null;
  if (type?.includes("json") === true) {
    try {
      return JsonSchema.parse(JSON.parse(raw));
    } catch {
      return raw;
    }
  }
  const params = new URLSearchParams(raw);
  return Object.fromEntries([...params.keys()].sort().map((k) => [k, params.getAll(k).join(",")]));
}

export interface Recorder {
  take(): Promise<Json[]>;
}

// Records the portal API calls a page fires: method and path, plus body and status when full.
export function watchPortalCalls(page: Page, full: boolean): Recorder {
  const pending: Promise<Json>[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/v1/billing_portal/")) return;
    const line = `${r.method()} ${u.pathname}`;
    if (!full) {
      pending.push(Promise.resolve(line));
      return;
    }
    const body = parseBody(r.postData(), r.headers()["content-type"]);
    pending.push(
      r
        .response()
        .then((res) => ({ call: line, body, status: res?.status() ?? null }))
        .catch(() => ({ call: line, body, status: null })),
    );
  });
  return { take: async () => Promise.all(pending.splice(0)) };
}

const LAYOUT_ROLES =
  "a,button,h1,h2,h3,h4,input,select,textarea,[role=button],[role=link],[role=tooltip]";

// Runs in an isolated JavaScript world: it shares the page's DOM but not its globals or prototypes,
// so page code (the clone serves its own) cannot patch getBoundingClientRect or innerText to fake
// what is measured. Plain JavaScript source, evaluated through the Chrome DevTools Protocol.
const MEASURE = `(selector) => {
  const candidates = [...document.querySelectorAll(selector)];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (parent && (n.textContent || "").trim() !== "" && !parent.closest(selector)) candidates.push(parent);
  }
  const ordered = [...new Set(candidates)].sort((x, y) =>
    x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  const out = [];
  for (const el of ordered) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const text = (el instanceof HTMLElement ? el.innerText : el.textContent || "").replace(/\\s+/g, " ").trim();
    const tag = el.getAttribute("role") || el.tagName.toLowerCase();
    out.push({ tag, text, box: [r.x, r.y, r.width, r.height].map(Math.round) });
  }
  return out;
}`;

const Boxes = z.array(z.object({ tag: z.string(), text: z.string(), box: z.array(z.number()) }));
const FrameTree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) });
const IsolatedWorld = z.object({ executionContextId: z.number() });
const Evaluated = z.object({ result: z.object({ value: z.unknown() }) });

// Visible landmarks of the page with their boxes ([x, y, width, height]), in document order. Text
// blocks count when they hold their own text, so that a moved price or label shows up even if no
// control moved.
async function layout(page: Page): Promise<Json> {
  const cdp = await page.context().newCDPSession(page);
  let boxes: z.infer<typeof Boxes>;
  try {
    const { frameTree } = FrameTree.parse(await cdp.send("Page.getFrameTree"));
    const { executionContextId } = IsolatedWorld.parse(
      await cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "measure",
      }),
    );
    const evaluated = Evaluated.parse(
      await cdp.send("Runtime.evaluate", {
        expression: `(${MEASURE})(${JSON.stringify(LAYOUT_ROLES)})`,
        contextId: executionContextId,
        returnByValue: true,
      }),
    );
    boxes = Boxes.parse(evaluated.result.value);
  } finally {
    await cdp.detach();
  }
  // Keyed by element, not by index, so that one missing element does not shift all the others.
  const keyed: Record<string, Json> = {};
  const seen = new Map<string, number>();
  for (const b of boxes) {
    const base = `${b.tag} ${b.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    keyed[n === 0 ? base : `${base} #${n + 1}`] = b.box;
  }
  return keyed;
}

// A grey-level thumbnail of the viewport, iframes masked (third-party payment widgets). Decoding
// happens in a blank page of the same browser, so no image library is needed.
async function thumbnail(browser: Browser, page: Page): Promise<string> {
  const masks = await page.locator("iframe").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    }),
  );
  const png = (await page.screenshot({ animations: "disabled", caret: "hide" })).toString("base64");
  const scratch = await browser.newPage();
  try {
    return await scratch.evaluate(
      async ({ png, masks, thumb, viewport }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        ctx.drawImage(img, 0, 0, viewport.width, viewport.height);
        ctx.fillStyle = "#fff";
        for (const [x = 0, y = 0, w = 0, h = 0] of masks) ctx.fillRect(x, y, w, h);
        const small = document.createElement("canvas");
        small.width = thumb.width;
        small.height = thumb.height;
        const sctx = small.getContext("2d");
        if (!sctx) throw new Error("no 2d context");
        sctx.imageSmoothingQuality = "high";
        sctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
        const { data } = sctx.getImageData(0, 0, thumb.width, thumb.height);
        let bin = "";
        for (let i = 0; i < data.length; i += 4) {
          const lum =
            0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
          bin += String.fromCharCode(Math.round(lum));
        }
        return `${thumb.width}x${thumb.height}:${btoa(bin)}`;
      },
      { png, masks, thumb: THUMB, viewport: VIEWPORT },
    );
  } finally {
    await scratch.close();
  }
}

export async function settle(page: Page): Promise<void> {
  // The real portal keeps background connections open, so "network idle" may never come.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
}

export async function capture(
  browser: Browser,
  page: Page,
  calls: Recorder,
  full: boolean,
): Promise<Record<string, Json>> {
  const screen = normalise(await page.locator("body").ariaSnapshot());
  if (!full) return { screen, requests: await calls.take() };
  return {
    screen,
    requests: await calls.take(),
    layout: await layout(page),
    thumbnail: await thumbnail(browser, page),
  };
}

export async function accountState(stripe: Stripe, subscription: string): Promise<Json> {
  const sub = await stripe.subscriptions.retrieve(subscription, { expand: ["items.data.price"] });
  const invoices = await stripe.invoices.list({ subscription, limit: 10 });
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const pending = await stripe.invoiceItems.list({ customer, pending: true, limit: 20 });
  return {
    status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end,
    cancel_at: sub.cancel_at ?? null,
    discounts: sub.discounts.length,
    items: sub.items.data.map((i) => ({
      amount: i.price.unit_amount,
      interval: i.price.recurring?.interval ?? null,
      quantity: i.quantity ?? null,
      period_end: i.current_period_end,
    })),
    // Oldest first, so that a new invoice appends instead of shifting every index.
    invoices: invoices.data.toReversed().map((inv) => invoiceView(inv)),
    // Prorations wait here until the next invoice; amounts sorted, since list order is by time.
    pending_items: pending.data
      .map((i) => ({ amount: i.amount, description: i.description ?? null }))
      .sort(
        (a, b) => a.amount - b.amount || (a.description ?? "").localeCompare(b.description ?? ""),
      ),
  };
}

export async function launch(): Promise<Browser> {
  return chromium.launch();
}

export async function openPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });
  return context.newPage();
}

export async function runWalkthrough(
  stripe: Stripe,
  input: UiInput,
): Promise<Record<string, Json>> {
  const portal = await setupWorld(stripe, input);
  const full = input.capture === "full";
  const browser = await launch();
  const out: Record<string, Json> = {};
  try {
    const page = await openPage(browser);
    const calls = watchPortalCalls(page, full);
    await page.goto(portal.url);
    for (const step of input.steps) {
      if (step.do === "capture") {
        await page.getByText(step.until, { exact: false }).first().waitFor({ timeout: 20000 });
        await settle(page);
        out[step.as] = await capture(browser, page, calls, full);
      } else {
        await act(page, step);
      }
    }
  } finally {
    await browser.close();
  }
  if (full) out.account = await accountState(stripe, portal.subscription);
  return out;
}
