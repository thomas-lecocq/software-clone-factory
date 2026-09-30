/**
 * Calendar arithmetic and the display formats the product uses in invoice line descriptions and
 * on the portal screens. All dates are rendered in UTC.
 */
import type { Interval } from "./state.ts";

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Same day and time of day, `months` calendar months later; the day is clamped to the month. */
export function addMonths(ts: number, months: number): number {
  const d = new Date(ts * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), last);
  return Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}

export function addInterval(ts: number, interval: Interval): number {
  return addMonths(ts, interval === "year" ? 12 : 1);
}

const parts = (ts: number): { y: number; m: number; d: number } => {
  const x = new Date(ts * 1000);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate() };
};

/** "05 Oct 2026", as in "Unused time on Basic after 05 Oct 2026". */
export function dayMonYear(ts: number): string {
  const { y, m, d } = parts(ts);
  return `${String(d).padStart(2, "0")} ${MONTHS_SHORT[m] ?? ""} ${y}`;
}

/** "November 5, 2026". */
export function longDate(ts: number): string {
  const { y, m, d } = parts(ts);
  return `${MONTHS_LONG[m] ?? ""} ${d}, ${y}`;
}

/** "Nov 5", as in the "Cancels Nov 5" badge. */
export function monthDay(ts: number): string {
  const { m, d } = parts(ts);
  return `${MONTHS_SHORT[m] ?? ""} ${d}`;
}

/** "Nov 5-Dec 5, 2026", or "Dec 5, 2026-Jan 5, 2027" across a year boundary. */
export function shortRange(start: number, end: number): string {
  const a = parts(start);
  const b = parts(end);
  const s = `${MONTHS_SHORT[a.m] ?? ""} ${a.d}`;
  const e = `${MONTHS_SHORT[b.m] ?? ""} ${b.d}, ${b.y}`;
  return a.y === b.y ? `${s}-${e}` : `${s}, ${a.y}-${e}`;
}

/** "$1,234.56", "-$8.00". */
export function money(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}$${whole}.${frac}`;
}

/** "20.0%" in line descriptions. */
export function percentLabel(p: number): string {
  return Number.isInteger(p) ? `${p.toFixed(1)}%` : `${p}%`;
}
