/**
 * The designed probe set for slice 1: a subscription change previewed with `create_preview`.
 * Designed probes pin each rule with a case that triggers it and one that does not; a seeded
 * random batch samples the same input space for a statistical bound. Inputs only: outputs come
 * from the target.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Probe } from "../../harness/src/adapter.ts";
import { JsonSchema } from "../../harness/src/json.ts";
import type { Coupon, WideInput } from "./wide.ts";

export interface CouponSpec {
  percent_off?: number;
  amount_off?: number;
  duration: "forever" | "once";
}

export interface ProbeInput {
  [key: string]: unknown;
  start: number;
  billing_mode: "flexible" | "classic";
  plan: { amount: number; interval: "month" | "year" };
  quantity: number;
  coupon: CouponSpec | null;
  change: {
    plan: { amount: number; interval: "month" | "year" } | null;
    quantity: number | null;
    offset: number;
    proration_behavior: "create_prorations" | "none" | "always_invoice" | null;
    discount: CouponSpec | null;
  };
}

const DAY = 86400;
const utc = (y: number, m: number, d: number, h = 0, mi = 0, s = 0): number =>
  Date.UTC(y, m - 1, d, h, mi, s) / 1000;

export const STARTS = {
  oct: utc(2026, 10, 5),
  feb: utc(2027, 2, 3),
  odd: utc(2026, 12, 17, 12, 34, 56),
};

type Over = Partial<Omit<ProbeInput, "change">> & { change?: Partial<ProbeInput["change"]> };

const base = (over: Over): ProbeInput => ({
  start: STARTS.oct,
  billing_mode: "flexible",
  plan: { amount: 1000, interval: "month" },
  quantity: 1,
  coupon: null,
  ...over,
  change: {
    plan: { amount: 3000, interval: "month" },
    quantity: null,
    offset: 10 * DAY,
    proration_behavior: null,
    discount: null,
    ...over.change,
  },
});

// Length of the first period: same day of the next month (or year), clamped to the month's end.
function periodLength(start: number, interval: "month" | "year"): number {
  const d = new Date(start * 1000);
  const months = interval === "year" ? 12 : 1;
  const target = new Date(d);
  target.setUTCDate(1);
  target.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target.getTime() / 1000 - start;
}

export function rulesFor(p: ProbeInput): string[] {
  const r = new Set<string>();
  const behavior = p.change.proration_behavior ?? "create_prorations";
  const prorates = behavior !== "none";
  if (p.change.offset < 0 || p.change.offset > periodLength(p.start, p.plan.interval))
    return ["ERR-01"];
  // A change that changes nothing prorates nothing: tagging it PRO-01..04 hid where bugs were.
  const changes = p.change.plan !== null || p.change.quantity !== null;
  if (!prorates) r.add("PRO-06");
  else if (changes) ["PRO-01", "PRO-02", "PRO-03", "PRO-04"].forEach((x) => r.add(x));
  if (behavior === "always_invoice") r.add("PRO-07");
  else r.add("PRO-05");
  if (p.change.quantity !== null) r.add("PRO-08");
  if (p.change.plan !== null && p.change.quantity === null && p.quantity > 1) r.add("PRO-10");
  const oldTotal = p.plan.amount * p.quantity;
  const newTotal = (p.change.plan?.amount ?? p.plan.amount) * (p.change.quantity ?? p.quantity);
  if (newTotal < oldTotal) r.add("PRO-09");
  if (p.change.plan && p.change.plan.interval !== p.plan.interval) r.add("INT-01");
  const day = new Date(p.start * 1000).getUTCDate();
  if (p.start === STARTS.feb || day >= 29) r.add("PER-01");
  const coupons = [p.coupon, p.change.discount].filter((c): c is CouponSpec => c !== null);
  if (coupons.some((c) => c.percent_off !== undefined)) r.add("DSC-01");
  if (coupons.length > 0 && prorates) r.add(p.billing_mode === "flexible" ? "DSC-02" : "DSC-04");
  if (coupons.some((c) => c.amount_off !== undefined)) r.add("DSC-03");
  if (coupons.some((c) => c.duration === "once")) r.add("DSC-05");
  if (p.billing_mode === "classic") r.add("MOD-01");
  return [...r].sort();
}

const pct = (n: number): CouponSpec => ({ percent_off: n, duration: "forever" });
const off = (n: number, duration: CouponSpec["duration"] = "forever"): CouponSpec => ({
  amount_off: n,
  duration,
});

const designed: [string, ProbeInput][] = [
  // Proration arithmetic, hit and boundary cases.
  ["up-10d", base({})],
  ["up-0s", base({ change: { offset: 0 } })],
  ["up-1s", base({ change: { offset: 1 } })],
  ["up-last-minute", base({ change: { offset: 31 * DAY - 60 } })],
  ["up-half", base({ change: { offset: 15 * DAY + 12 * 3600 } })],
  [
    "odd-cents",
    base({
      plan: { amount: 999, interval: "month" },
      change: { plan: { amount: 1999, interval: "month" }, offset: 7 * DAY + 3 * 3600 },
    }),
  ],
  [
    "odd-start",
    base({
      start: STARTS.odd,
      plan: { amount: 2500, interval: "month" },
      change: { offset: 9 * DAY + 777 },
    }),
  ],
  ["feb-short-month", base({ start: STARTS.feb, change: { offset: 10 * DAY } })],
  ["same-price", base({ change: { plan: null, offset: 10 * DAY } })],
  // Quantity and downgrade.
  ["qty-up", base({ change: { plan: null, quantity: 3 } })],
  ["qty-down", base({ quantity: 3, change: { plan: null, quantity: 1 } })],
  ["qty-and-price", base({ quantity: 2, change: { quantity: 5 } })],
  [
    "downgrade",
    base({
      plan: { amount: 3000, interval: "month" },
      change: { plan: { amount: 500, interval: "month" } },
    }),
  ],
  [
    "downgrade-late",
    base({
      plan: { amount: 3000, interval: "month" },
      change: { plan: { amount: 1000, interval: "month" }, offset: 28 * DAY },
    }),
  ],
  // Proration behaviour.
  ["behavior-none", base({ change: { proration_behavior: "none" } })],
  ["behavior-always", base({ change: { proration_behavior: "always_invoice" } })],
  [
    "behavior-always-down",
    base({
      plan: { amount: 3000, interval: "month" },
      change: { plan: { amount: 1000, interval: "month" }, proration_behavior: "always_invoice" },
    }),
  ],
  ["behavior-create", base({ change: { proration_behavior: "create_prorations" } })],
  // Interval change.
  ["month-to-year", base({ change: { plan: { amount: 10000, interval: "year" } } })],
  // Discounts, flexible mode.
  ["pct20-sub", base({ coupon: pct(20) })],
  [
    "pct33-sub-rounding",
    base({
      coupon: pct(33),
      plan: { amount: 999, interval: "month" },
      change: { plan: { amount: 2999, interval: "month" } },
    }),
  ],
  ["pct15-preview", base({ change: { discount: pct(15) } })],
  ["pct20-sub-pct15-preview", base({ coupon: pct(20), change: { discount: pct(15) } })],
  ["off500-once-sub", base({ coupon: off(500, "once") })],
  ["off300-forever-sub", base({ coupon: off(300) })],
  ["off300-qty", base({ coupon: off(300), quantity: 2, change: { quantity: 3 } })],
  ["off5000-exceeds", base({ coupon: off(5000) })],
  [
    "pct20-downgrade",
    base({
      coupon: pct(20),
      plan: { amount: 3000, interval: "month" },
      change: { plan: { amount: 1000, interval: "month" } },
    }),
  ],
  ["pct20-none", base({ coupon: pct(20), change: { proration_behavior: "none" } })],
  ["pct20-always", base({ coupon: pct(20), change: { proration_behavior: "always_invoice" } })],
  // Classic billing mode, same sequences.
  ["classic-up-10d", base({ billing_mode: "classic" })],
  ["classic-pct20-sub", base({ billing_mode: "classic", coupon: pct(20) })],
  ["classic-off300-sub", base({ billing_mode: "classic", coupon: off(300) })],
  [
    "classic-downgrade",
    base({
      billing_mode: "classic",
      plan: { amount: 3000, interval: "month" },
      change: { plan: { amount: 500, interval: "month" } },
    }),
  ],
  ["classic-qty-up", base({ billing_mode: "classic", change: { plan: null, quantity: 3 } })],
  [
    "classic-always",
    base({ billing_mode: "classic", change: { proration_behavior: "always_invoice" } }),
  ],
  // Errors.
  ["err-proration-before-start", base({ change: { offset: -DAY } })],
  ["err-proration-far-future", base({ change: { offset: 800 * DAY } })],
];

// Iteration 2 (2026-09-23), recorded after the first holdout measurement. These probes were
// designed by the main session after it had read the three holdout failures, so they are not
// independent of the first holdout; the clean measure is the fresh-* batch below.
const OCT_PERIOD = 31 * DAY;
const targeted: [string, ProbeInput][] = [
  // Rounding exactly at .5: 1000 x 6696 / 2678400 = 2.5 and 3000 x 6696 / 2678400 = 7.5.
  ["t-round-half-2.5", base({ change: { offset: OCT_PERIOD - 6696 } })],
  // 1000 x 20088 / 2678400 = 7.5 and 3000 x 20088 / 2678400 = 22.5.
  ["t-round-half-7.5", base({ change: { offset: OCT_PERIOD - 20088 } })],
  [
    "t-round-half-classic",
    base({ billing_mode: "classic", change: { offset: OCT_PERIOD - 20088 } }),
  ],
  // Discounted proration rounding, classic and flexible, quantities above one.
  [
    "t-disc-round-classic-36",
    base({
      billing_mode: "classic",
      coupon: pct(36),
      quantity: 4,
      plan: { amount: 2099, interval: "month" },
      change: { plan: { amount: 1370, interval: "month" }, offset: 9 * DAY + 4321 },
    }),
  ],
  [
    "t-disc-round-flex-36",
    base({
      coupon: pct(36),
      quantity: 4,
      plan: { amount: 2099, interval: "month" },
      change: { plan: { amount: 1370, interval: "month" }, offset: 9 * DAY + 4321 },
    }),
  ],
  [
    "t-disc-round-classic-17",
    base({
      billing_mode: "classic",
      coupon: pct(17),
      quantity: 3,
      plan: { amount: 1234, interval: "month" },
      change: { plan: { amount: 4321, interval: "month" }, quantity: 3, offset: 13 * DAY + 999 },
    }),
  ],
  [
    "t-disc-round-flex-17",
    base({
      coupon: pct(17),
      quantity: 3,
      plan: { amount: 1234, interval: "month" },
      change: { plan: { amount: 4321, interval: "month" }, quantity: 3, offset: 13 * DAY + 999 },
    }),
  ],
  // Two coupons: one on the subscription, one passed to the preview.
  ["t-two-coupons-pct-pct", base({ coupon: pct(10), change: { discount: pct(25) } })],
  ["t-two-coupons-pct-off", base({ coupon: pct(20), change: { discount: off(400) } })],
  ["t-two-coupons-off-pct", base({ coupon: off(300), change: { discount: pct(15) } })],
  [
    "t-two-coupons-classic",
    base({ billing_mode: "classic", coupon: pct(20), change: { discount: pct(15) } }),
  ],
  // Interval changes.
  [
    "t-month-to-year-2d",
    base({ change: { plan: { amount: 10000, interval: "year" }, offset: 2 * DAY } }),
  ],
  [
    "t-month-to-year-25d",
    base({ change: { plan: { amount: 12000, interval: "year" }, offset: 25 * DAY } }),
  ],
  [
    "t-month-to-year-coupon",
    base({ coupon: pct(20), change: { plan: { amount: 10000, interval: "year" } } }),
  ],
  [
    "t-year-to-month",
    base({
      plan: { amount: 10000, interval: "year" },
      change: { plan: { amount: 1000, interval: "month" }, offset: 40 * DAY },
    }),
  ],
  // Quantity reset when only the price changes (PRO-10), with and without coupon.
  ["t-qty-reset", base({ quantity: 3, change: { offset: 5 * DAY } })],
  ["t-qty-reset-coupon", base({ quantity: 2, coupon: off(300), change: { offset: 5 * DAY } })],
];

// Proposed by the breaker agent (read-only, no holdout access), `probes.proposed.md`.
// Iteration 3 (2026-09-23): dev probes for the two behaviours the final measurement of iteration 2
// found wrong (amount-off coupons in classic mode; yearly-to-monthly changes). Designed after
// reading those holdout failures, so informed by them; the clean measure is fresh2-*.
const iteration3: [string, ProbeInput][] = [
  [
    "u-classic-off-once-q4",
    base({
      billing_mode: "classic",
      coupon: off(1879, "once"),
      quantity: 4,
      plan: { amount: 6020, interval: "month" },
      change: { plan: { amount: 7669, interval: "month" }, offset: 12 * DAY + 3333 },
    }),
  ],
  [
    "u-classic-off-once-q2",
    base({
      billing_mode: "classic",
      coupon: off(750, "once"),
      quantity: 2,
      plan: { amount: 2500, interval: "month" },
      change: { offset: 8 * DAY + 777 },
    }),
  ],
  [
    "u-classic-off-forever-q3",
    base({
      billing_mode: "classic",
      coupon: off(1234, "forever"),
      quantity: 3,
      plan: { amount: 4000, interval: "month" },
      change: { plan: { amount: 5500, interval: "month" }, offset: 17 * DAY },
    }),
  ],
  [
    "u-classic-off-forever-q1",
    base({
      billing_mode: "classic",
      coupon: off(999, "forever"),
      plan: { amount: 3333, interval: "month" },
      change: { plan: { amount: 1111, interval: "month" }, offset: 5 * DAY + 1 },
    }),
  ],
  [
    "u-flex-off-once-q4",
    base({
      coupon: off(1879, "once"),
      quantity: 4,
      plan: { amount: 6020, interval: "month" },
      change: { plan: { amount: 7669, interval: "month" }, offset: 12 * DAY + 3333 },
    }),
  ],
  [
    "u-flex-off-forever-q3",
    base({
      coupon: off(1234, "forever"),
      quantity: 3,
      plan: { amount: 4000, interval: "month" },
      change: { plan: { amount: 5500, interval: "month" }, offset: 17 * DAY },
    }),
  ],
  [
    "u-year-to-month-5d",
    base({
      plan: { amount: 10000, interval: "year" },
      change: { plan: { amount: 1000, interval: "month" }, offset: 5 * DAY },
    }),
  ],
  [
    "u-year-to-month-29d",
    base({
      plan: { amount: 10000, interval: "year" },
      change: { plan: { amount: 1000, interval: "month" }, offset: 29 * DAY },
    }),
  ],
  [
    "u-year-to-month-60d",
    base({
      plan: { amount: 10000, interval: "year" },
      change: { plan: { amount: 1000, interval: "month" }, offset: 60 * DAY },
    }),
  ],
  [
    "u-year-to-month-200d",
    base({
      plan: { amount: 12000, interval: "year" },
      change: { plan: { amount: 3000, interval: "month" }, offset: 200 * DAY },
    }),
  ],
  [
    "u-year-to-month-classic-60d",
    base({
      billing_mode: "classic",
      plan: { amount: 10000, interval: "year" },
      change: { plan: { amount: 1000, interval: "month" }, offset: 60 * DAY },
    }),
  ],
  [
    "u-year-to-year",
    base({
      plan: { amount: 10000, interval: "year" },
      change: { plan: { amount: 15000, interval: "year" }, offset: 90 * DAY },
    }),
  ],
];

const broken: [string, ProbeInput][] = [
  ["b-clamp-jan31", base({ start: utc(2027, 1, 31) })],
  [
    "b-round-half",
    base({
      plan: { amount: 1001, interval: "month" },
      change: { plan: { amount: 3003, interval: "month" }, offset: 15 * DAY + 12 * 3600 },
    }),
  ],
  [
    "b-pct15-round-half",
    base({
      coupon: pct(15),
      plan: { amount: 1030, interval: "month" },
      change: { plan: { amount: 3070, interval: "month" }, offset: 0 },
    }),
  ],
  ["b-off300-sub-pct15-preview", base({ coupon: off(300), change: { discount: pct(15) } })],
  [
    "b-classic-pct20-downgrade",
    base({
      billing_mode: "classic",
      coupon: pct(20),
      plan: { amount: 3000, interval: "month" },
      change: { plan: { amount: 1000, interval: "month" } },
    }),
  ],
  [
    "b-year-to-month",
    base({
      plan: { amount: 10000, interval: "year" },
      change: { plan: { amount: 3000, interval: "month" } },
    }),
  ],
  ["b-up-at-period-end", base({ change: { offset: 31 * DAY } })],
  ["b-up-past-period-end", base({ change: { offset: 31 * DAY + 1 } })],
  ["b-qty-zero", base({ change: { plan: null, quantity: 0 } })],
  ["b-err-none-before-start", base({ change: { offset: -DAY, proration_behavior: "none" } })],
  ["b-tz-late-evening", base({ change: { offset: 10 * DAY - 1800 } })],
  [
    "b-fmt-large-fracpct",
    base({ coupon: pct(12.25), change: { plan: { amount: 250000, interval: "month" } } }),
  ],
];

// mulberry32: small, seeded, deterministic.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The random batch's distribution, stated for the statistical bound in the report.
export const RANDOM_DISTRIBUTION =
  "start in {oct, feb, odd}; mode flexible 70% / classic 30%; old and new unit amount uniform in " +
  "[100, 9999] cents; quantity 1-4; new quantity unchanged 60%; offset uniform over the first " +
  "28 days; coupon none 50%, percent 1-60 25%, amount 50-2000 forever/once 25%; behaviour default";

function randomProbes(n: number, seed = 20260923, prefix = "rand"): [string, ProbeInput][] {
  const r = rng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (xs: readonly number[]): number => xs[Math.floor(r() * xs.length)] ?? 0;
  const out: [string, ProbeInput][] = [];
  for (let i = 1; i <= n; i += 1) {
    const u = r();
    const coupon: CouponSpec | null =
      u < 0.5
        ? null
        : u < 0.75
          ? pct(int(1, 60))
          : off(int(50, 2000), r() < 0.5 ? "forever" : "once");
    out.push([
      `${prefix}-${String(i).padStart(3, "0")}`,
      base({
        start: pick([STARTS.oct, STARTS.feb, STARTS.odd]),
        billing_mode: r() < 0.7 ? "flexible" : "classic",
        plan: { amount: int(100, 9999), interval: "month" },
        quantity: int(1, 4),
        coupon,
        change: {
          plan: { amount: int(100, 9999), interval: "month" },
          quantity: r() < 0.6 ? null : int(1, 4),
          offset: int(0, 28 * DAY),
        },
      }),
    ]);
  }
  return out;
}

// The widened distribution (same slice): one to three items on a monthly or yearly interval,
// quantities 1 to 10, zero to two coupons, a start anywhere in a year (month ends included) and a
// change anywhere in the first period, its two ends included. Stated for the bound in the report.
export const WIDE_DISTRIBUTION =
  "start uniform over 2026-10-15..2027-10-15, 15 % on a 28th-31st; mode flexible 70 % / classic " +
  "30 %; interval month 75 % / year 25 %; 1-3 items (50/30/20 %), unit amount uniform in " +
  "[100, 9999] cents per month or [1000, 99999] per year, quantity uniform 1-10; 0-2 coupons " +
  "(50/35/15 %), each percent-off uniform 1-60 or amount-off uniform [50, 2000] cents, forever or " +
  "once; one item changed: new amount 70 %, new interval 15 % (single item only), new quantity " +
  "40 %; offset uniform over [0, period length] with 10 % on {0, 1, end - 1, end}; behaviour " +
  "default 55 % / create, none, always 15 % each; a preview coupon 15 %.";

const WIDE_FROM = utc(2026, 10, 15);
const WIDE_TO = utc(2027, 10, 15);

export function wideProbes(n: number, seed: number, prefix: string): [string, WideInput][] {
  const r = rng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const coupon = (): Coupon =>
    r() < 0.5 ? pct(int(1, 60)) : off(int(50, 2000), r() < 0.5 ? "forever" : "once");
  const out: [string, WideInput][] = [];
  for (let i = 1; i <= n; i += 1) {
    let start = int(WIDE_FROM, WIDE_TO - 1);
    if (r() < 0.15) {
      const d = new Date(start * 1000);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(int(28, last));
      start = Math.floor(d.getTime() / 1000);
    }
    const interval = r() < 0.75 ? "month" : "year";
    const amount = (): number => (interval === "month" ? int(100, 9999) : int(1000, 99999));
    const u = r();
    const count = u < 0.5 ? 1 : u < 0.8 ? 2 : 3;
    const items = Array.from({ length: count }, () => ({ amount: amount(), quantity: int(1, 10) }));
    const c = r();
    const coupons = c < 0.5 ? [] : c < 0.85 ? [coupon()] : [coupon(), coupon()];
    const newInterval =
      count === 1 && r() < 0.15 ? (interval === "month" ? "year" : "month") : null;
    const newAmount =
      r() < 0.7 || newInterval !== null
        ? (newInterval ?? interval) === "month"
          ? int(100, 9999)
          : int(1000, 99999)
        : null;
    const len = periodLength(start, interval);
    const offset = r() < 0.1 ? ([0, 1, len - 1, len][int(0, 3)] ?? 0) : int(0, len);
    const b = r();
    out.push([
      `${prefix}-${String(i).padStart(3, "0")}`,
      {
        kind: "wide",
        start,
        billing_mode: r() < 0.7 ? "flexible" : "classic",
        interval,
        items,
        coupons,
        change: {
          item: int(0, count - 1),
          amount: newAmount,
          interval: newInterval,
          quantity: r() < 0.4 ? int(1, 10) : null,
          offset,
          proration_behavior:
            b < 0.55 ? null : b < 0.7 ? "create_prorations" : b < 0.85 ? "none" : "always_invoice",
          discount: r() < 0.15 ? coupon() : null,
        },
      },
    ]);
  }
  return out;
}

// The wide probe seen through the single-item rules, plus the two rules only it can trigger.
export function rulesForWide(p: WideInput): string[] {
  const item = p.items[p.change.item] ?? { amount: 0, quantity: 1 };
  const single: ProbeInput = {
    start: p.start,
    billing_mode: p.billing_mode,
    plan: { amount: item.amount, interval: p.interval },
    quantity: item.quantity,
    coupon: p.coupons[0] ?? null,
    change: {
      plan:
        p.change.amount !== null || p.change.interval !== null
          ? { amount: p.change.amount ?? item.amount, interval: p.change.interval ?? p.interval }
          : null,
      quantity: p.change.quantity,
      offset: p.change.offset,
      proration_behavior: p.change.proration_behavior,
      discount: p.change.discount,
    },
  };
  const r = new Set(rulesFor(single));
  if (r.has("ERR-01")) return ["ERR-01"];
  if (p.items.length > 1) r.add("ITM-01");
  const real = p.change.amount !== null || p.change.interval !== null || p.change.quantity !== null;
  const len = periodLength(p.start, p.interval);
  const discounted = p.coupons.length > 0 || p.change.discount !== null;
  const flexible = p.billing_mode === "flexible";
  if (flexible && p.change.proration_behavior === "always_invoice" && real) r.add("DSC-07");
  if (flexible && discounted && real && p.change.offset >= len - 1) r.add("DSC-08");
  if (p.change.interval !== null && p.change.offset === len) r.add("INT-02");
  let first = p.items.reduce((n, i) => n + i.amount * i.quantity, 0);
  for (const c of p.coupons)
    first =
      c.percent_off !== undefined ? first * (1 - c.percent_off / 100) : first - (c.amount_off ?? 0);
  if (Math.round(first) > 0 && Math.round(first) < 56) r.add("INV-01");
  if (p.items.length > 1 && p.coupons.some((c) => c.percent_off !== undefined)) r.add("DSC-01");
  if (p.coupons.length > 1) {
    r.add("DSC-06");
    if (p.coupons.some((c) => c.percent_off !== undefined)) r.add("DSC-01");
    if (p.coupons.some((c) => c.amount_off !== undefined)) r.add("DSC-03");
    if (p.coupons.some((c) => c.duration === "once")) r.add("DSC-05");
  }
  return [...r].sort();
}

// Distribution v2 for slice 1, after holdout batch 2 and breaker round 1: the same change,
// widened where the breaker found the clone failing, and drawing fewer easy cases (the `none`
// behaviour with a proration date always errors; a change that changes nothing proves little).
export const WIDE_DISTRIBUTION_V2 =
  "start uniform over 2026-11-01..2027-11-01, 20 % on a 28th-31st; mode flexible 70 % / classic " +
  "30 %; interval month 70 % / year 30 %; 1-4 items (40/30/20/10 %), unit amount log-uniform in " +
  "[50, 10,000,000] cents per month (x10 per year), quantity uniform 1-10; 0-2 coupons " +
  "(50/35/15 %), each percent-off uniform 1-100 with 10 % at exactly 100, or amount-off " +
  "log-uniform [1, 1,000,000] cents, forever or once; one item changed: new amount 70 %, new " +
  "interval 15 % (any item count), new quantity 40 % (uniform 0-20); a change that would change " +
  "nothing becomes a quantity change 80 % of the time; offset uniform over [0, period length] with " +
  "10 % on {0, 1, end - 1, end}; behaviour default 60 % / create 15 % / always 20 % / none 5 %; a " +
  "preview coupon 15 %.";

const V2_FROM = utc(2026, 11, 1);
const V2_TO = utc(2027, 11, 1);

export function wideProbesV2(n: number, seed: number, prefix: string): [string, WideInput][] {
  const r = rng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const logInt = (lo: number, hi: number): number =>
    Math.round(Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo))));
  const coupon = (): Coupon => {
    const duration = r() < 0.5 ? "forever" : "once";
    if (r() < 0.5) return { percent_off: r() < 0.1 ? 100 : int(1, 100), duration };
    return { amount_off: logInt(1, 1_000_000), duration };
  };
  const out: [string, WideInput][] = [];
  for (let i = 1; i <= n; i += 1) {
    let start = int(V2_FROM, V2_TO - 1);
    if (r() < 0.2) {
      const d = new Date(start * 1000);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(int(28, last));
      start = Math.floor(d.getTime() / 1000);
    }
    const interval = r() < 0.7 ? "month" : "year";
    const amount = (iv: "month" | "year"): number =>
      iv === "month" ? logInt(50, 10_000_000) : logInt(500, 100_000_000);
    const u = r();
    const count = u < 0.4 ? 1 : u < 0.7 ? 2 : u < 0.9 ? 3 : 4;
    const items = Array.from({ length: count }, () => ({
      amount: amount(interval),
      quantity: int(1, 10),
    }));
    const c = r();
    const coupons = c < 0.5 ? [] : c < 0.85 ? [coupon()] : [coupon(), coupon()];
    const item = int(0, count - 1);
    const newInterval = r() < 0.15 ? (interval === "month" ? "year" : "month") : null;
    const newAmount = r() < 0.7 || newInterval !== null ? amount(newInterval ?? interval) : null;
    let quantity = r() < 0.4 ? int(0, 20) : null;
    const current = items[item]?.quantity ?? 1;
    if (
      newAmount === null &&
      newInterval === null &&
      (quantity === null || quantity === current) &&
      r() < 0.8
    )
      quantity = current === 20 ? 19 : current + 1 + int(0, 19 - current);
    const len = periodLength(start, interval);
    const offset = r() < 0.1 ? ([0, 1, len - 1, len][int(0, 3)] ?? 0) : int(0, len);
    const b = r();
    out.push([
      `${prefix}-${String(i).padStart(3, "0")}`,
      {
        kind: "wide",
        start,
        billing_mode: r() < 0.7 ? "flexible" : "classic",
        interval,
        items,
        coupons,
        change: {
          item,
          amount: newAmount,
          interval: newInterval,
          quantity,
          offset,
          proration_behavior:
            b < 0.6 ? null : b < 0.75 ? "create_prorations" : b < 0.95 ? "always_invoice" : "none",
          discount: r() < 0.15 ? coupon() : null,
        },
      },
    ]);
  }
  return out;
}

// Targeted dev probes after holdout batch 1 was spent, one family per root cause found in it
// (analysis/batch1-failures.md): A percent coupons over several lines, B once coupons passed to
// the preview, C credit-line discounts in immediate flexible invoices, D credits that prorate a
// discount to 0, E interval changes at the period end, F first invoices under 50 cents.
type WideChange = WideInput["change"];
const w = (
  over: Partial<Omit<WideInput, "change">> & { change?: Partial<WideChange> },
): WideInput => ({
  kind: "wide",
  start: STARTS.oct,
  billing_mode: "flexible",
  interval: "month",
  items: [{ amount: 1000, quantity: 1 }],
  coupons: [],
  ...over,
  change: {
    item: 0,
    amount: 3000,
    interval: null,
    quantity: null,
    offset: 10 * DAY,
    proration_behavior: null,
    discount: null,
    ...over.change,
  },
});
const once = (n: number): Coupon => ({ amount_off: n, duration: "once" });
const pctOnce = (n: number): Coupon => ({ percent_off: n, duration: "once" });
const MONTH_LEN = periodLength(STARTS.oct, "month");
const YEAR_LEN = periodLength(STARTS.oct, "year");

function targetedWide(): [string, WideInput][] {
  const out: [string, WideInput][] = [];
  const add = (id: string, p: WideInput): void => {
    out.push([`dev-t2-${id}`, p]);
  };
  const noop = { amount: null, quantity: null };
  const sets: [string, WideInput["items"], number][] = [
    [
      "a1",
      [
        { amount: 7009, quantity: 1 },
        { amount: 1371, quantity: 9 },
        { amount: 9488, quantity: 6 },
      ],
      22,
    ],
    [
      "a2",
      [
        { amount: 1065, quantity: 4 },
        { amount: 4809, quantity: 3 },
        { amount: 4156, quantity: 7 },
      ],
      26,
    ],
    [
      "a3",
      [
        { amount: 3880, quantity: 3 },
        { amount: 1459, quantity: 3 },
        { amount: 2578, quantity: 4 },
      ],
      43,
    ],
  ];
  for (const [id, items, percent] of sets) {
    add(`${id}-noop`, w({ items, coupons: [pct(percent)], change: noop }));
    for (const item of [0, 1, 2])
      add(
        `${id}-change-${String(item)}`,
        w({ items, coupons: [pct(percent)], change: { item, amount: 2222 } }),
      );
  }
  for (const mode of ["flexible", "classic"] as const) {
    for (const behavior of [null, "create_prorations"] as const)
      add(
        `b-noop-${mode}-${behavior ?? "default"}`,
        w({
          billing_mode: mode,
          change: { ...noop, proration_behavior: behavior, discount: once(300) },
        }),
      );
    for (const [name, coupons] of [
      ["none", []],
      ["forever", [pct(20)]],
      ["once", [once(200)]],
    ] as const)
      add(
        `b-always-${mode}-${name}`,
        w({
          billing_mode: mode,
          coupons: [...coupons],
          change: { proration_behavior: "always_invoice", discount: once(300) },
        }),
      );
  }
  const subSets: [string, Coupon[]][] = [
    ["once", [once(200)]],
    ["once-forever", [once(200), pct(10)]],
    ["forever", [pct(10)]],
    ["forever-forever", [pct(10), off(150)]],
  ];
  for (const [name, coupons] of subSets)
    for (const [dname, discount] of [
      ["none", null],
      ["once", pctOnce(15)],
      ["forever", pct(15)],
    ] as const)
      add(
        `c-${name}-${dname}`,
        w({ coupons, change: { proration_behavior: "always_invoice", discount } }),
      );
  for (const mode of ["flexible", "classic"] as const)
    for (const [name, coupons] of [
      ["pct", [pct(20)]],
      ["off", [off(300)]],
      ["both", [pct(20), off(300)]],
    ] as const)
      for (const back of [1, 2])
        for (const behavior of [null, "always_invoice"] as const)
          add(
            `d-${mode}-${name}-end${String(back)}-${behavior ?? "default"}`,
            w({
              billing_mode: mode,
              coupons: [...coupons],
              change: { offset: MONTH_LEN - back, proration_behavior: behavior },
            }),
          );
  for (const mode of ["flexible", "classic"] as const)
    for (const coupons of [[], [pct(20)]])
      for (const back of [0, 1]) {
        const tag = `${mode}-${coupons.length > 0 ? "pct" : "none"}-end${String(back)}`;
        add(
          `e-m2y-${tag}`,
          w({
            billing_mode: mode,
            coupons,
            change: { amount: 10000, interval: "year", offset: MONTH_LEN - back },
          }),
        );
        add(
          `e-y2m-${tag}`,
          w({
            billing_mode: mode,
            interval: "year",
            items: [{ amount: 10000, quantity: 1 }],
            coupons,
            change: { amount: 1000, interval: "month", offset: YEAR_LEN - back },
          }),
        );
      }
  for (const left of [1, 25, 49, 50, 51, 52, 55, 56, 57, 58, 59, 60, 75, 99, 100, 150, 291])
    add(
      `f-left${String(left)}`,
      w({ items: [{ amount: 1621, quantity: 1 }], coupons: [once(1621 - left)] }),
    );
  return out;
}

// Probes proposed by a breaker round: inputs chosen to make the clone fail, outside the generators'
// distribution. Adversarial by construction, so they are dev (`dev-` prefix) and carry no claim.
const BreakerRound = z.object({
  probes: z.array(
    z.object({
      id: z.string().startsWith("dev-"),
      rules: z.array(z.string()).min(1),
      input: JsonSchema,
    }),
  ),
});
function breakerProbes(file: string): Probe[] {
  const path = join(import.meta.dirname, file);
  if (!existsSync(path)) return [];
  return BreakerRound.parse(JSON.parse(readFileSync(path, "utf8"))).probes;
}

// Dev probes from the analysis of spent batch 3 (analysis/hold-b3-failures.md): A, discounts on
// classic credit lines with several items; B, an item moved to quantity 0. Each design runs in
// classic and, as a control, in flexible.
function batch3Probes(): [string, WideInput][] {
  const out: [string, WideInput][] = [];
  const start = utc(2026, 11, 15);
  const len = periodLength(start, "month");
  const half = Math.floor(len / 2);
  const two = [
    { amount: 1000, quantity: 1 },
    { amount: 1000000, quantity: 1 },
  ];
  const designs: [string, Omit<WideInput, "kind" | "start" | "billing_mode" | "interval">][] = [
    [
      "a1-off-forever",
      {
        items: two,
        coupons: [off(500)],
        change: {
          item: 0,
          amount: null,
          interval: null,
          quantity: 2,
          offset: half,
          proration_behavior: null,
          discount: null,
        },
      },
    ],
    [
      "a2-off-once",
      {
        items: two,
        coupons: [off(500, "once")],
        change: {
          item: 0,
          amount: null,
          interval: null,
          quantity: 2,
          offset: half,
          proration_behavior: null,
          discount: null,
        },
      },
    ],
    [
      "a3-once-then-pct",
      {
        items: two,
        coupons: [off(1500, "once"), pct(50)],
        change: {
          item: 0,
          amount: null,
          interval: null,
          quantity: 2,
          offset: half,
          proration_behavior: null,
          discount: null,
        },
      },
    ],
    [
      "a4-pct-then-off",
      {
        items: two,
        coupons: [pct(50), off(400)],
        change: {
          item: 0,
          amount: null,
          interval: null,
          quantity: 2,
          offset: half,
          proration_behavior: null,
          discount: null,
        },
      },
    ],
    [
      "a5-three-start",
      {
        items: [
          { amount: 100, quantity: 1 },
          { amount: 500000, quantity: 1 },
          { amount: 500000, quantity: 1 },
        ],
        coupons: [off(3)],
        change: {
          item: 0,
          amount: null,
          interval: null,
          quantity: 2,
          offset: 1,
          proration_behavior: null,
          discount: null,
        },
      },
    ],
    [
      "a5-three-end",
      {
        items: [
          { amount: 100, quantity: 1 },
          { amount: 500000, quantity: 1 },
          { amount: 500000, quantity: 1 },
        ],
        coupons: [off(3)],
        change: {
          item: 0,
          amount: null,
          interval: null,
          quantity: 2,
          offset: len - 1,
          proration_behavior: null,
          discount: null,
        },
      },
    ],
    ...(["default", "create_prorations", "always_invoice"] as const).map(
      (b): [string, Omit<WideInput, "kind" | "start" | "billing_mode" | "interval">] => [
        `b6-price-qty0-${b}`,
        {
          items: [{ amount: 2000, quantity: 2 }],
          coupons: [],
          change: {
            item: 0,
            amount: 5000,
            interval: null,
            quantity: 0,
            offset: half,
            proration_behavior: b === "default" ? null : b,
            discount: null,
          },
        },
      ],
    ),
    [
      "b7-qty0",
      {
        items: [{ amount: 2000, quantity: 2 }],
        coupons: [],
        change: {
          item: 0,
          amount: null,
          interval: null,
          quantity: 0,
          offset: half,
          proration_behavior: null,
          discount: null,
        },
      },
    ],
    [
      "b8-two-items-qty0",
      {
        items: [
          { amount: 2000, quantity: 2 },
          { amount: 700, quantity: 1 },
        ],
        coupons: [],
        change: {
          item: 0,
          amount: null,
          interval: null,
          quantity: 0,
          offset: half,
          proration_behavior: null,
          discount: null,
        },
      },
    ],
    [
      "b9-qty0-pct",
      {
        items: [{ amount: 2000, quantity: 2 }],
        coupons: [pct(20)],
        change: {
          item: 0,
          amount: 5000,
          interval: null,
          quantity: 0,
          offset: half,
          proration_behavior: null,
          discount: null,
        },
      },
    ],
    [
      "b9-qty0-once-preview",
      {
        items: [{ amount: 2000, quantity: 2 }],
        coupons: [],
        change: {
          item: 0,
          amount: 5000,
          interval: null,
          quantity: 0,
          offset: half,
          proration_behavior: null,
          discount: off(300, "once"),
        },
      },
    ],
    [
      "b10-control-last-second",
      {
        items: [{ amount: 2000, quantity: 2 }],
        coupons: [],
        change: {
          item: 0,
          amount: null,
          interval: null,
          quantity: 1,
          offset: len - 1,
          proration_behavior: null,
          discount: null,
        },
      },
    ],
  ];
  for (const mode of ["classic", "flexible"] as const)
    for (const [id, d] of designs)
      out.push([
        `dev-b3-${mode}-${id}`,
        { kind: "wide", start, billing_mode: mode, interval: "month", ...d },
      ]);
  return out;
}

// Dedicated holdout batches, one per pre-registered plan (analysis-plan*.md). Their seeds live in a
// holdout-* file, which never enters a builder sandbox: there the batches simply do not exist.
// Batch IDs start with `hold-`, which `splitOf` sends to the holdout whatever their hash.
const HOLDOUT_SEED_FILE = join(import.meta.dirname, "holdout-seed.json");
const Batches = z.object({
  batches: z.array(
    z.object({
      prefix: z.string().startsWith("hold"),
      seed: z.number().int(),
      size: z.number().int(),
      // Which distribution the batch is drawn from; batches 1 and 2 predate the field.
      generator: z.enum(["v1", "v2"]).default("v1"),
      // Sequential testing: the batch is scored stage by stage (`<prefix>-s1-001`…), and scoring
      // stops once failures exceed what the plan tolerates. Batches 1 to 3 have one stage.
      stages: z.number().int().min(1).default(1),
    }),
  ),
});
function holdoutBatches(): [string, WideInput][] {
  if (!existsSync(HOLDOUT_SEED_FILE)) return [];
  const { batches } = Batches.parse(JSON.parse(readFileSync(HOLDOUT_SEED_FILE, "utf8")));
  return batches.flatMap((b) => {
    const drawn = (b.generator === "v2" ? wideProbesV2 : wideProbes)(b.size, b.seed, b.prefix);
    if (b.stages === 1) return drawn;
    // Stage k holds the k-th consecutive slice of the draw, numbered from 001 within the stage.
    return drawn.map(([, input], i): [string, WideInput] => {
      const stage = Math.floor((i * b.stages) / b.size) + 1;
      const first = Math.ceil(((stage - 1) * b.size) / b.stages);
      return [`${b.prefix}-s${String(stage)}-${String(i - first + 1).padStart(3, "0")}`, input];
    });
  });
}

// UI walkthroughs of the portal plan-change flow. Text in `until` is what the screen must show
// before it is captured, identical on both sides.
const home = (as: string, until = "Current subscription") =>
  ({ do: "capture", as, until }) as const;
const toPlans = [
  { do: "click", role: "link", name: "Update subscription" },
  { do: "capture", as: "plans", until: "Update your subscription" },
] as const;
const toConfirm = [
  { do: "click", role: "button", name: "Continue" },
  { do: "capture", as: "confirm", until: "Confirm your updates" },
] as const;
const ui: [string, string[], Record<string, unknown>][] = [
  [
    "ui-upgrade",
    ["UI-01", "UI-02", "UI-03", "UI-04", "UI-05"],
    {
      current: "Basic",
      coupon_percent: null,
      steps: [
        home("home"),
        ...toPlans,
        { do: "click", role: "button", name: "Select" },
        { do: "capture", as: "selected", until: "Subtotal" },
        ...toConfirm,
        { do: "hoverIconAfter", text: "$30.00" },
        { do: "capture", as: "tooltip", until: "One-time adjustments" },
        { do: "click", role: "button", name: "Subscribe and pay" },
        home("after", "Your next estimated payment"),
      ],
    },
  ],
  [
    "ui-downgrade",
    ["UI-01", "UI-03", "UI-04", "UI-05"],
    {
      current: "Pro",
      coupon_percent: null,
      steps: [
        home("home"),
        ...toPlans,
        { do: "click", role: "button", name: "Select" },
        ...toConfirm,
        { do: "click", role: "button", name: "Subscribe and pay" },
        home("after"),
      ],
    },
  ],
  [
    "ui-reselect-current",
    ["UI-02"],
    {
      current: "Basic",
      coupon_percent: null,
      steps: [
        ...toPlans,
        { do: "click", role: "button", name: "Select" },
        { do: "capture", as: "selected", until: "Subtotal" },
        { do: "click", role: "button", name: "Select" },
        { do: "capture", as: "reselected", until: "Subtotal" },
      ],
    },
  ],
  [
    "ui-go-back",
    ["UI-02", "UI-06"],
    {
      current: "Basic",
      coupon_percent: null,
      steps: [
        ...toPlans,
        { do: "click", role: "button", name: "Select" },
        ...toConfirm,
        { do: "click", role: "button", name: "Go back" },
        { do: "capture", as: "back", until: "Update your subscription" },
      ],
    },
  ],
  [
    "ui-coupon-upgrade",
    ["UI-03", "UI-05", "DSC-01"],
    {
      current: "Basic",
      coupon_percent: 20,
      steps: [
        home("home"),
        ...toPlans,
        { do: "click", role: "button", name: "Select" },
        ...toConfirm,
        { do: "click", role: "button", name: "Subscribe and pay" },
        home("after", "Your next estimated payment"),
      ],
    },
  ],
];

// Slice 2: lifecycle scripts and the portal's cancel / renew flow.
const snap = (as: string) => ({ do: "snapshot", as }) as const;
const MONTH = 31 * DAY;
const lifecycle: [string, string[], Record<string, unknown>][] = [
  [
    "l-renews",
    ["LIF-01"],
    {
      amount: 1000,
      trial_days: null,
      steps: [snap("start"), { do: "advance", seconds: MONTH + 3600 }, snap("renewed")],
    },
  ],
  [
    "l-cancel-at-end",
    ["LIF-02", "LIF-03"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        { do: "cancel_at_period_end" },
        snap("scheduled"),
        { do: "advance", seconds: MONTH + 3600 },
        snap("ended"),
      ],
    },
  ],
  [
    "l-cancel-then-reactivate",
    ["LIF-02", "LIF-04"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        { do: "cancel_at_period_end" },
        { do: "advance", seconds: 10 * DAY },
        { do: "reactivate" },
        snap("reactivated"),
        { do: "advance", seconds: 22 * DAY },
        snap("renewed"),
      ],
    },
  ],
  [
    "l-cancel-now-prorate",
    ["LIF-05"],
    {
      amount: 3000,
      trial_days: null,
      steps: [
        { do: "advance", seconds: 10 * DAY },
        { do: "cancel_now", prorate: true, invoice_now: true },
        snap("canceled"),
      ],
    },
  ],
  [
    "l-cancel-now-plain",
    ["LIF-05"],
    {
      amount: 3000,
      trial_days: null,
      steps: [
        { do: "advance", seconds: 10 * DAY },
        { do: "cancel_now", prorate: false, invoice_now: false },
        snap("canceled"),
      ],
    },
  ],
  [
    "l-cancel-now-prorate-no-invoice",
    ["LIF-05"],
    {
      amount: 3000,
      trial_days: null,
      steps: [
        { do: "advance", seconds: 10 * DAY },
        { do: "cancel_now", prorate: true, invoice_now: false },
        snap("canceled"),
      ],
    },
  ],
  [
    "l-payment-fails",
    ["LIF-06"],
    {
      amount: 1000,
      trial_days: null,
      steps: [{ do: "failing_card" }, { do: "advance", seconds: MONTH + 3600 }, snap("failed")],
    },
  ],
  [
    "l-payment-fails-retries",
    ["LIF-06"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        { do: "failing_card" },
        { do: "advance", seconds: MONTH + 3600 },
        { do: "advance", seconds: 5 * DAY },
        snap("retried"),
      ],
    },
  ],
  [
    "l-trial",
    ["LIF-07"],
    {
      amount: 1000,
      trial_days: 7,
      steps: [snap("trialing"), { do: "advance", seconds: 7 * DAY + 3600 }, snap("converted")],
    },
  ],
  [
    "l-trial-cancel",
    ["LIF-07", "LIF-03"],
    {
      amount: 1000,
      trial_days: 7,
      steps: [
        { do: "cancel_at_period_end" },
        snap("scheduled"),
        { do: "advance", seconds: 7 * DAY + 3600 },
        snap("ended"),
      ],
    },
  ],
  [
    "l-cancel-at-end-then-now",
    ["LIF-02", "LIF-05"],
    {
      amount: 2000,
      trial_days: null,
      steps: [
        { do: "cancel_at_period_end" },
        { do: "advance", seconds: 5 * DAY },
        { do: "cancel_now", prorate: true, invoice_now: true },
        snap("canceled"),
      ],
    },
  ],
  [
    "l-renews-twice",
    ["LIF-01"],
    {
      amount: 999,
      trial_days: null,
      steps: [
        { do: "advance", seconds: MONTH + 3600 },
        { do: "advance", seconds: 30 * DAY },
        snap("twice"),
      ],
    },
  ],
];
const cancelUi: [string, string[], Record<string, unknown>][] = [
  [
    "ui-cancel",
    ["UI-07", "UI-08", "UI-09"],
    {
      current: "Basic",
      coupon_percent: null,
      cancel_enabled: true,
      steps: [
        { do: "capture", as: "home", until: "Cancel subscription" },
        { do: "click", role: "link", name: "Cancel subscription" },
        { do: "capture", as: "review", until: "Review your changes" },
        { do: "click", role: "button", name: "Cancel subscription" },
        { do: "capture", as: "after", until: "Your service will end on" },
      ],
    },
  ],
  [
    "ui-cancel-renew",
    ["UI-09", "UI-10"],
    {
      current: "Pro",
      coupon_percent: null,
      cancel_enabled: true,
      steps: [
        { do: "click", role: "link", name: "Cancel subscription" },
        { do: "capture", as: "review", until: "Review your changes" },
        { do: "click", role: "button", name: "Cancel subscription" },
        { do: "capture", as: "canceled", until: "Your service will end on" },
        { do: "click", role: "link", name: "Don't cancel subscription" },
        { do: "capture", as: "renew", until: "Renew your subscription" },
        { do: "click", role: "button", name: "Renew subscription" },
        { do: "capture", as: "after", until: "Cancel subscription" },
      ],
    },
  ],
  [
    "ui-cancel-go-back",
    ["UI-08"],
    {
      current: "Basic",
      coupon_percent: null,
      cancel_enabled: true,
      steps: [
        { do: "click", role: "link", name: "Cancel subscription" },
        { do: "capture", as: "review", until: "Review your changes" },
        { do: "click", role: "button", name: "Go back" },
        { do: "capture", as: "back", until: "Cancel subscription" },
      ],
    },
  ],
];

// Full-capture walkthroughs (layout, thumbnail, call bodies, final account state) and state-graph
// explorations. Rules UI-12 to UI-14 apply to every full capture.
const FULL = ["UI-12", "UI-13", "UI-14"];
const subscribe = [
  { do: "click", role: "button", name: "Subscribe and pay" },
  home("after", "Your next estimated payment"),
] as const;
const changePlan = [
  ...toPlans,
  { do: "click", role: "button", name: "Select" },
  ...toConfirm,
] as const;
const cancelFlow = [
  { do: "click", role: "link", name: "Cancel subscription" },
  { do: "capture", as: "review", until: "Review your changes" },
  { do: "click", role: "button", name: "Cancel subscription" },
  { do: "capture", as: "canceled", until: "Your service will end on" },
] as const;
const full: [string, string[], Record<string, unknown>][] = [
  [
    "uf-upgrade",
    ["UI-01", "UI-03", "UI-04", "UI-05"],
    {
      start: STARTS.oct,
      current: "Basic",
      coupon_percent: null,
      steps: [home("home"), ...changePlan, ...subscribe],
    },
  ],
  [
    "uf-downgrade-feb",
    ["UI-01", "UI-03", "UI-04", "UI-05"],
    {
      start: STARTS.feb,
      current: "Pro",
      coupon_percent: null,
      steps: [home("home"), ...changePlan, ...subscribe.slice(0, 1), home("after")],
    },
  ],
  [
    "uf-coupon50-odd",
    ["UI-03", "UI-05", "DSC-01"],
    {
      start: STARTS.odd,
      current: "Basic",
      coupon_percent: 50,
      steps: [home("home"), ...changePlan, ...subscribe],
    },
  ],
  [
    "uf-coupon-downgrade",
    ["UI-03", "UI-05", "DSC-01"],
    {
      start: STARTS.oct,
      current: "Pro",
      coupon_percent: 20,
      steps: [...changePlan, ...subscribe.slice(0, 1), home("after")],
    },
  ],
  [
    "uf-back-and-forth",
    ["UI-02", "UI-06"],
    {
      start: STARTS.feb,
      current: "Basic",
      coupon_percent: null,
      steps: [
        ...changePlan,
        { do: "click", role: "button", name: "Go back" },
        { do: "capture", as: "back", until: "Update your subscription" },
        // "Go back" clears the selection, so the plan is selected again.
        { do: "click", role: "button", name: "Select" },
        ...toConfirm,
        ...subscribe,
      ],
    },
  ],
  [
    "uf-upgrade-cancel-on",
    ["UI-01", "UI-05", "UI-07"],
    {
      start: STARTS.odd,
      current: "Basic",
      coupon_percent: null,
      cancel_enabled: true,
      steps: [home("home", "Cancel subscription"), ...changePlan, ...subscribe],
    },
  ],
  [
    "uf-cancel",
    ["UI-07", "UI-08", "UI-09"],
    {
      start: STARTS.oct,
      current: "Basic",
      coupon_percent: null,
      cancel_enabled: true,
      steps: [home("home", "Cancel subscription"), ...cancelFlow],
    },
  ],
  [
    "uf-cancel-feb-coupon",
    ["UI-08", "UI-09"],
    {
      start: STARTS.feb,
      current: "Pro",
      coupon_percent: 20,
      cancel_enabled: true,
      steps: [...cancelFlow],
    },
  ],
  [
    "uf-cancel-renew",
    ["UI-09", "UI-10"],
    {
      start: STARTS.odd,
      current: "Pro",
      coupon_percent: null,
      cancel_enabled: true,
      steps: [
        ...cancelFlow,
        { do: "click", role: "link", name: "Don't cancel subscription" },
        { do: "capture", as: "renew", until: "Renew your subscription" },
        { do: "click", role: "button", name: "Renew subscription" },
        { do: "capture", as: "after", until: "Cancel subscription" },
      ],
    },
  ],
  [
    "uf-cancel-go-back",
    ["UI-08"],
    {
      start: STARTS.feb,
      current: "Basic",
      coupon_percent: 50,
      cancel_enabled: true,
      steps: [
        { do: "click", role: "link", name: "Cancel subscription" },
        { do: "capture", as: "review", until: "Review your changes" },
        { do: "click", role: "button", name: "Go back" },
        { do: "capture", as: "back", until: "Cancel subscription" },
      ],
    },
  ],
];
const explorations: [string, Record<string, unknown>][] = [
  ["x-basic", { start: STARTS.oct, current: "Basic", coupon_percent: null, cancel_enabled: true }],
  ["x-pro-coupon", { start: STARTS.feb, current: "Pro", coupon_percent: 20, cancel_enabled: true }],
  ["x-no-cancel", { start: STARTS.odd, current: "Basic", coupon_percent: null }],
  [
    "x-quantity",
    {
      start: STARTS.oct,
      current: "Basic",
      coupon_percent: null,
      cancel_enabled: true,
      quantity: 3,
    },
  ],
];

// Probes for behaviour mutation testing showed no fixture pins (GAPS.md): once coupons over the
// lifecycle, the delay before each payment retry, and the error for a missing object. Designed
// after seeing the gaps, so they are dev.
const DAY_S = 86400;
const lifecycleV2: [string, string[], Record<string, unknown>][] = [
  [
    "dev-v2-once-coupon-renews",
    ["DSC-05", "LIF-01"],
    {
      amount: 1000,
      trial_days: null,
      coupon: { amount_off: 300, duration: "once" },
      steps: [
        { do: "advance", seconds: 31 * DAY_S + 3600 },
        { do: "snapshot", as: "first_renewal" },
        { do: "advance", seconds: 30 * DAY_S },
        { do: "snapshot", as: "second_renewal" },
      ],
    },
  ],
  [
    "dev-v2-forever-pct-renews",
    ["DSC-01", "LIF-01"],
    {
      amount: 1999,
      trial_days: null,
      coupon: { percent_off: 20, duration: "forever" },
      steps: [
        { do: "advance", seconds: 31 * DAY_S + 3600 },
        { do: "snapshot", as: "first_renewal" },
      ],
    },
  ],
  [
    "dev-v2-once-coupon-cancel-now",
    ["DSC-05", "LIF-05"],
    {
      amount: 3000,
      trial_days: null,
      coupon: { percent_off: 50, duration: "once" },
      steps: [
        { do: "advance", seconds: 10 * DAY_S },
        { do: "cancel_now", prorate: true, invoice_now: true },
        { do: "snapshot", as: "canceled" },
      ],
    },
  ],
  [
    "dev-v2-once-coupon-trial",
    ["DSC-05", "LIF-07"],
    {
      amount: 1000,
      trial_days: 7,
      coupon: { amount_off: 400, duration: "once" },
      steps: [
        { do: "advance", seconds: 8 * DAY_S },
        { do: "snapshot", as: "after_trial" },
        { do: "advance", seconds: 31 * DAY_S },
        { do: "snapshot", as: "renewal" },
      ],
    },
  ],
  [
    "dev-v2-retry-days",
    ["LIF-06"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        { do: "failing_card" },
        { do: "advance", seconds: 31 * DAY_S + 3600 },
        { do: "snapshot", as: "failed" },
        { do: "advance", seconds: 2 * DAY_S },
        { do: "snapshot", as: "day2" },
        { do: "advance", seconds: DAY_S + 3600 },
        { do: "snapshot", as: "day3" },
        { do: "advance", seconds: DAY_S },
        { do: "snapshot", as: "day4" },
      ],
    },
  ],
  [
    "dev-v2-missing-object",
    ["ERR-02"],
    { amount: 1000, trial_days: null, steps: [{ do: "retrieve_missing", as: "missing" }] },
  ],
];

// Probes from task validation: the calls an agent made when asked to change a price, add a coupon
// or cancel (tasks/), most of which no fixture exercised. Each replays such calls whole, then
// snapshots the subscription. Designed after seeing the agent fail on the clone, so they are dev.
const M = 31 * 86400 + 3600;
const sub = (as: string) => ({ do: "snapshot", as }) as const;
const raw = (
  as: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string> = {},
) => ({ do: "raw", as, method, path, params }) as const;
const agentTraces: [string, string[], Record<string, unknown>][] = [
  [
    "dev-ag-upgrade-items",
    ["PRO-01", "PRO-05"],
    {
      amount: 1000,
      second_amount: 3000,
      trial_days: null,
      steps: [
        raw("read", "GET", "/v1/subscriptions/{subscription}"),
        raw("update", "POST", "/v1/subscriptions/{subscription}", {
          "items[0][id]": "{item}",
          "items[0][price]": "{price2}",
          proration_behavior: "create_prorations",
        }),
        raw("preview", "POST", "/v1/invoices/create_preview", { subscription: "{subscription}" }),
        raw("upcoming", "GET", "/v1/invoices/upcoming", { subscription: "{subscription}" }),
        sub("after"),
      ],
    },
  ],
  [
    "dev-ag-upgrade-subscription-item",
    ["PRO-01", "PRO-05"],
    {
      amount: 1000,
      second_amount: 3000,
      trial_days: null,
      steps: [
        raw("update", "POST", "/v1/subscription_items/{item}", {
          price: "{price2}",
          proration_behavior: "create_prorations",
        }),
        raw("items", "GET", "/v1/subscription_items", { subscription: "{subscription}" }),
        raw("pending", "GET", "/v1/invoiceitems", { customer: "{customer}", pending: "true" }),
        sub("after"),
      ],
    },
  ],
  [
    "dev-ag-downgrade-no-proration",
    ["PRO-06"],
    {
      amount: 3000,
      second_amount: 1000,
      trial_days: null,
      steps: [
        raw("update", "POST", "/v1/subscriptions/{subscription}", {
          "items[0][id]": "{item}",
          "items[0][price]": "{price2}",
          proration_behavior: "none",
        }),
        raw("pending", "GET", "/v1/invoiceitems", { customer: "{customer}", pending: "true" }),
        sub("after"),
      ],
    },
  ],
  [
    "dev-ag-coupon-discounts",
    ["DSC-01"],
    {
      amount: 1000,
      spare_coupon: { percent_off: 20, duration: "forever" },
      trial_days: null,
      steps: [
        raw("apply", "POST", "/v1/subscriptions/{subscription}", {
          "discounts[0][coupon]": "{coupon}",
        }),
        raw("read", "GET", "/v1/subscriptions/{subscription}", { "expand[]": "discounts" }),
        { do: "advance", seconds: M },
        sub("renewal"),
      ],
    },
  ],
  [
    "dev-ag-coupon-legacy-param",
    ["DSC-01"],
    {
      amount: 1000,
      spare_coupon: { percent_off: 20, duration: "forever" },
      trial_days: null,
      steps: [
        raw("apply", "POST", "/v1/subscriptions/{subscription}", { coupon: "{coupon}" }),
        sub("after"),
      ],
    },
  ],
  [
    "dev-ag-reads",
    ["ERR-02"],
    {
      amount: 1000,
      second_amount: 3000,
      trial_days: null,
      steps: [
        raw("price", "GET", "/v1/prices/{price2}"),
        raw("customer", "GET", "/v1/customers/{customer}"),
        raw("subscriptions", "GET", "/v1/subscriptions", { customer: "{customer}" }),
      ],
    },
  ],
  [
    "dev-ag-cancel-now-delete",
    ["LIF-05"],
    {
      amount: 3000,
      trial_days: null,
      steps: [
        { do: "advance", seconds: 10 * 86400 },
        raw("cancel", "DELETE", "/v1/subscriptions/{subscription}", {
          invoice_now: "true",
          prorate: "true",
        }),
        sub("after"),
      ],
    },
  ],
  [
    "dev-v3-past-due-recovers",
    ["LIF-06"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        { do: "failing_card" },
        { do: "advance", seconds: M },
        sub("past_due"),
        { do: "good_card" },
        { do: "advance", seconds: 2 * 86400 },
        sub("after_retry"),
      ],
    },
  ],
  [
    "dev-v3-two-subscriptions",
    ["ITM-01"],
    {
      amount: 1000,
      second_amount: 3000,
      trial_days: null,
      steps: [
        raw("second", "POST", "/v1/subscriptions", {
          customer: "{customer}",
          "items[0][price]": "{price2}",
        }),
        raw("list", "GET", "/v1/subscriptions", { customer: "{customer}" }),
        raw("update", "POST", "/v1/subscriptions/{subscription}", {
          "items[0][id]": "{item}",
          "items[0][price]": "{price2}",
        }),
        raw("pending", "GET", "/v1/invoiceitems", { customer: "{customer}", pending: "true" }),
        sub("first"),
      ],
    },
  ],
];

// v4: behaviour no fixture pinned, found by task validation on clone v3 (a discount's coupon read
// expanded) and by mutation testing (GAPS.md): invoice items across two customers, a draft invoice
// with auto_advance off, cancel_at exactly at the period end. Designed after seeing the gaps, so
// they are dev.
const expandReads = [
  raw("expanded", "GET", "/v1/subscriptions/{subscription}", {
    "expand[]": "discounts.source.coupon",
  }),
  raw("discounts", "GET", "/v1/subscriptions/{subscription}", { "expand[]": "discounts" }),
  raw("plain", "GET", "/v1/subscriptions/{subscription}"),
];
const draftSteps = (autoAdvance: string) => [
  raw("item", "POST", "/v1/invoiceitems", {
    customer: "{customer}",
    amount: "500",
    currency: "usd",
  }),
  raw("draft", "POST", "/v1/invoices", {
    customer: "{customer}",
    auto_advance: autoAdvance,
    pending_invoice_items_behavior: "include",
  }),
  { do: "advance", seconds: 2 * 86400 } as const,
  raw("read", "GET", "/v1/invoices/{draft.id}"),
  raw("list", "GET", "/v1/invoices", { customer: "{customer}" }),
  sub("after"),
];
const v4Lifecycle: [string, string[], Record<string, unknown>][] = [
  [
    "dev-v4-expand-apply-percent",
    ["DSC-09"],
    {
      amount: 1000,
      trial_days: null,
      spare_coupon: { percent_off: 20, duration: "forever" },
      steps: [
        raw("apply", "POST", "/v1/subscriptions/{subscription}", {
          "discounts[0][coupon]": "{coupon}",
        }),
        ...expandReads,
      ],
    },
  ],
  [
    "dev-v4-expand-apply-amount-once",
    ["DSC-09", "DSC-05"],
    {
      amount: 1000,
      trial_days: null,
      spare_coupon: { amount_off: 300, duration: "once" },
      steps: [
        raw("apply", "POST", "/v1/subscriptions/{subscription}", {
          "discounts[0][coupon]": "{coupon}",
        }),
        ...expandReads,
      ],
    },
  ],
  [
    "dev-v4-expand-at-creation",
    ["DSC-09"],
    {
      amount: 2500,
      trial_days: null,
      coupon: { percent_off: 50, duration: "forever" },
      steps: [
        ...expandReads,
        raw("update_expanded", "POST", "/v1/subscriptions/{subscription}", {
          "metadata[k]": "v",
          "expand[0]": "discounts.source.coupon",
        }),
      ],
    },
  ],
  ["dev-v4-expand-no-discount", ["DSC-09"], { amount: 1000, trial_days: null, steps: expandReads }],
  [
    "dev-v4-items-two-customers",
    ["ITM-02"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        raw("other", "POST", "/v1/customers", { "preferred_locales[0]": "en" }),
        raw("other_item", "POST", "/v1/invoiceitems", {
          customer: "{other.id}",
          amount: "700",
          currency: "usd",
        }),
        raw("mine", "POST", "/v1/invoiceitems", {
          customer: "{customer}",
          amount: "300",
          currency: "usd",
        }),
        raw("list_mine", "GET", "/v1/invoiceitems", { customer: "{customer}" }),
        raw("list_other", "GET", "/v1/invoiceitems", { customer: "{other.id}" }),
        raw("pending_mine", "GET", "/v1/invoiceitems", {
          customer: "{customer}",
          pending: "true",
        }),
        raw("read_mine", "GET", "/v1/invoiceitems/{mine.id}"),
        raw("read_missing", "GET", "/v1/invoiceitems/ii_Missing0000000000"),
      ],
    },
  ],
  [
    "dev-v4-draft-auto-advance-off",
    ["INV-02"],
    { amount: 1000, trial_days: null, steps: draftSteps("false") },
  ],
  [
    "dev-v4-draft-auto-advance-on",
    ["INV-02"],
    { amount: 1000, trial_days: null, steps: draftSteps("true") },
  ],
  [
    "dev-v4-cancel-at-period-end-exact",
    ["LIF-08", "LIF-03"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        raw("set", "POST", "/v1/subscriptions/{subscription}", { cancel_at: "{period_end}" }),
        sub("set"),
        { do: "advance", seconds: M },
        sub("after"),
      ],
    },
  ],
  [
    "dev-v4-cancel-at-period-end-exact-no-proration",
    ["LIF-08"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        { do: "advance", seconds: 10 * 86400 },
        raw("set", "POST", "/v1/subscriptions/{subscription}", {
          cancel_at: "{period_end}",
          proration_behavior: "none",
        }),
        sub("set"),
        { do: "advance", seconds: M },
        sub("after"),
      ],
    },
  ],
  [
    "dev-v4-cancel-at-then-reactivate",
    ["LIF-08", "LIF-04"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        raw("set", "POST", "/v1/subscriptions/{subscription}", { cancel_at: "{period_end}" }),
        raw("unset", "POST", "/v1/subscriptions/{subscription}", { cancel_at: "" }),
        sub("unset"),
        { do: "advance", seconds: M },
        sub("after"),
      ],
    },
  ],
];

// v4: a flexible interval change whose proration date falls on, just before and just after the
// shortened period end (mutation survivor billing.ts:331).
function v4Wide(): [string, WideInput][] {
  const start = STARTS.oct;
  const end = periodLength(start, "month");
  const out: [string, WideInput][] = [];
  for (const [name, offset] of [
    ["at", end],
    ["before", end - 1],
    ["after", end + 1],
  ] as const) {
    for (const behaviour of ["create_prorations", "always_invoice"] as const) {
      out.push([
        `dev-v4-interval-end-${name}-${behaviour === "always_invoice" ? "invoice" : "prorate"}`,
        {
          kind: "wide",
          start,
          billing_mode: "flexible",
          interval: "year",
          items: [{ amount: 12000, quantity: 1 }],
          coupons: [],
          change: {
            item: 0,
            amount: null,
            interval: "month",
            quantity: null,
            offset,
            proration_behavior: behaviour,
            discount: null,
          },
        },
      ]);
    }
  }
  return out;
}

// v5: the area batches 4 and 5 still fail in (one of several items changed under two coupons,
// DSC-07), drawn from WIDE_DISTRIBUTION_V2 and kept only inside that area; and behaviour no
// fixture pinned on clone v4, from mutation testing and the v4 builder's own choices (GAPS.md).
// Designed after seeing those gaps, so they are dev.
function v5Wide(): [string, WideInput][] {
  const area = wideProbesV2(3000, 20261015, "x")
    .map(([, p]) => p)
    .filter((p) => p.items.length >= 2 && p.coupons.length === 2)
    .slice(0, 150)
    .map((p, i): [string, WideInput] => [`dev-v5-dsc-${String(i + 1).padStart(3, "0")}`, p]);
  const percents = [10.29, 11.37, 33.33].map((percent, i): [string, WideInput] => [
    `dev-v5-percent-${String(i + 1)}`,
    {
      kind: "wide",
      start: STARTS.oct,
      billing_mode: "flexible",
      interval: "month",
      items: [{ amount: 10_000_000, quantity: 10 }],
      coupons: [{ percent_off: percent, duration: "forever" }],
      change: {
        item: 0,
        amount: 9_000_000,
        interval: null,
        quantity: null,
        offset: 10 * 86400,
        proration_behavior: "always_invoice",
        discount: null,
      },
    },
  ]);
  return [...area, ...percents, ...b4Analysis()];
}

// The six designs of the batch 4 analysis (analysis/hold-b4-failures.md, section 4): a two-item
// flexible world where one carried discount's share prorates to 0 and is dropped.
function b4Analysis(): [string, WideInput][] {
  const world = (
    coupons: Coupon[],
    offset: number,
    over: Partial<WideInput["change"]> = {},
  ): WideInput => ({
    kind: "wide",
    start: STARTS.oct,
    billing_mode: "flexible",
    interval: "month",
    items: [
      { amount: 1_000_000, quantity: 1 },
      { amount: 100, quantity: 1 },
    ],
    coupons,
    change: {
      item: 1,
      amount: 300,
      interval: null,
      quantity: null,
      offset,
      proration_behavior: "always_invoice",
      discount: null,
      ...over,
    },
  });
  const off: Coupon = { amount_off: 500, duration: "forever" };
  const half: Coupon = { percent_off: 50, duration: "forever" };
  return [
    ["dev-v5-b4-1-dropped", world([off, half], 2_008_800)],
    ["dev-v5-b4-2-reversed", world([half, off], 2_008_800)],
    ["dev-v5-b4-3-both-survive", world([off, half], 669_600)],
    ["dev-v5-b4-4-survivor-spent", world([off, { ...half, duration: "once" }], 2_008_800)],
    [
      "dev-v5-b4-5-preview-coupon",
      world([off, half], 2_008_800, { discount: { percent_off: 10, duration: "forever" } }),
    ],
    ["dev-v5-b4-6-default", world([off, half], 2_008_800, { proration_behavior: null })],
    [
      "dev-v5-b4-6-prorations",
      world([off, half], 2_008_800, { proration_behavior: "create_prorations" }),
    ],
  ];
}

const MID = STARTS.oct + 15 * 86400;
const v5Lifecycle: [string, string[], Record<string, unknown>][] = [
  [
    "dev-v5-invoiceitem-update",
    ["ITM-02"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        raw("mine", "POST", "/v1/invoiceitems", {
          customer: "{customer}",
          amount: "300",
          currency: "usd",
        }),
        raw("update", "POST", "/v1/invoiceitems/{mine.id}", {
          amount: "900",
          description: "Setup fee",
        }),
        raw("read", "GET", "/v1/invoiceitems/{mine.id}"),
        raw("delete", "DELETE", "/v1/invoiceitems/{mine.id}"),
        raw("list", "GET", "/v1/invoiceitems", { customer: "{customer}" }),
      ],
    },
  ],
  [
    "dev-v5-cancel-now-no-prorate-invoice",
    ["LIF-05"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        { do: "advance", seconds: 10 * 86400 },
        { do: "cancel_now", prorate: false, invoice_now: true },
        sub("canceled"),
        raw("pending", "GET", "/v1/invoiceitems", { customer: "{customer}", pending: "true" }),
      ],
    },
  ],
  [
    "dev-v5-pending-item-renewal",
    ["INV-03", "LIF-01"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        { do: "advance", seconds: 10 * 86400 },
        raw("item", "POST", "/v1/invoiceitems", {
          customer: "{customer}",
          amount: "400",
          currency: "usd",
          description: "One-off",
        }),
        { do: "advance", seconds: M },
        sub("renewed"),
        raw("invoices", "GET", "/v1/invoices", { customer: "{customer}" }),
      ],
    },
  ],
  [
    "dev-v5-pending-item-subscription-renewal",
    ["INV-03", "LIF-01"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        raw("item", "POST", "/v1/invoiceitems", {
          customer: "{customer}",
          subscription: "{subscription}",
          amount: "400",
          currency: "usd",
        }),
        { do: "advance", seconds: M },
        sub("renewed"),
        raw("invoices", "GET", "/v1/invoices", { customer: "{customer}" }),
      ],
    },
  ],
  ...(["create_prorations", "none"] as const).map(
    (behaviour): [string, string[], Record<string, unknown>] => [
      `dev-v5-cancel-at-mid-${behaviour === "none" ? "none" : "prorate"}`,
      ["LIF-09"],
      {
        amount: 1000,
        trial_days: null,
        steps: [
          raw("set", "POST", "/v1/subscriptions/{subscription}", {
            cancel_at: String(MID),
            proration_behavior: behaviour,
          }),
          sub("set"),
          { do: "advance", seconds: 16 * 86400 },
          sub("ended"),
          raw("pending", "GET", "/v1/invoiceitems", { customer: "{customer}", pending: "true" }),
          raw("invoices", "GET", "/v1/invoices", { customer: "{customer}" }),
        ],
      },
    ],
  ),
  [
    "dev-v5-manual-invoice-mid-period",
    ["INV-02"],
    {
      amount: 1000,
      trial_days: null,
      steps: [
        { do: "advance", seconds: 10 * 86400 },
        raw("item", "POST", "/v1/invoiceitems", {
          customer: "{customer}",
          amount: "500",
          currency: "usd",
        }),
        raw("draft", "POST", "/v1/invoices", {
          customer: "{customer}",
          pending_invoice_items_behavior: "include",
        }),
        { do: "advance", seconds: 2 * 86400 },
        raw("read", "GET", "/v1/invoices/{draft.id}"),
      ],
    },
  ],
];

export function probes(): Probe[] {
  const logic = [
    ...designed.map(([id, p]) => [`d-${id}`, p] as const),
    ...randomProbes(40),
    ...targeted,
    ...broken,
    ...randomProbes(40, 424242, "fresh"),
    ...iteration3,
    ...randomProbes(150, 90210, "fresh2"),
  ].map(([id, p]) => ({
    id,
    rules: rulesFor(p),
    input: JsonSchema.parse(JSON.parse(JSON.stringify(p))),
  }));
  const walkthroughs = ui.map(([id, rules, rest]) => ({
    id,
    rules,
    input: JsonSchema.parse({ kind: "ui", start: STARTS.oct, ...rest }),
  }));
  const slice2 = [
    ...lifecycle.map(([id, rules, rest]) => ({
      id,
      rules,
      input: JsonSchema.parse({ kind: "lifecycle", start: STARTS.oct, ...rest }),
    })),
    ...agentTraces.map(([id, rules, rest]) => ({
      id,
      rules,
      input: JsonSchema.parse({ kind: "lifecycle", start: STARTS.oct, ...rest }),
    })),
    ...lifecycleV2.map(([id, rules, rest]) => ({
      id,
      rules,
      input: JsonSchema.parse({ kind: "lifecycle", start: STARTS.oct, ...rest }),
    })),
    ...v5Lifecycle.map(([id, rules, rest]) => ({
      id,
      rules,
      input: JsonSchema.parse({ kind: "lifecycle", start: STARTS.oct, ...rest }),
    })),
    ...v4Lifecycle.map(([id, rules, rest]) => ({
      id,
      rules,
      input: JsonSchema.parse({ kind: "lifecycle", start: STARTS.oct, ...rest }),
    })),
    ...cancelUi.map(([id, rules, rest]) => ({
      id,
      rules,
      input: JsonSchema.parse({ kind: "ui", start: STARTS.oct, ...rest }),
    })),
  ];
  const uiFull = [
    ...full.map(([id, rules, rest]) => ({
      id,
      rules: [...rules, ...FULL],
      input: JsonSchema.parse({ kind: "ui", capture: "full", ...rest }),
    })),
    ...explorations.map(([id, rest]) => ({
      id,
      rules: ["UI-11"],
      input: JsonSchema.parse({ kind: "explore", depth: 3, max_states: 30, ...rest }),
    })),
  ];
  // wide2: more dev cases of the same distribution, added after holdout batch 1 was spent.
  const wide = [
    ...wideProbes(150, 20261001, "wide"),
    ...wideProbes(300, 20261002, "wide2"),
    ...targetedWide(),
    ...wideProbesV2(300, 20261013, "wide3"),
    ...batch3Probes(),
    ...v4Wide(),
    ...v5Wide(),
    ...holdoutBatches(),
  ].map(([id, p]) => ({
    id,
    rules: rulesForWide(p),
    input: JsonSchema.parse(p),
  }));
  return [
    ...logic,
    ...walkthroughs,
    ...slice2,
    ...uiFull,
    ...wide,
    ...breakerProbes("breaker-round1.json"),
  ];
}
