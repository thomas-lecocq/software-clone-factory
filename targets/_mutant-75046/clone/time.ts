/** Calendar helpers: billing periods anchored on a day of month, and the date formats Stripe prints. */

export type Interval = "month" | "year";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = [
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

// `anchor` plus `n` intervals: same day of month (clamped to the month's end) and time of day.
export function addIntervals(anchor: number, interval: Interval, n: number): number {
  const d = new Date(anchor * 1000);
  const months = interval === "year" ? 12 * n : n;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), last);
  return Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}

// The period of an anchored cycle that contains `t` (start inclusive, end exclusive).
export function periodAt(anchor: number, interval: Interval, t: number): [number, number] {
  let k = 0;
  while (addIntervals(anchor, interval, k + 1) <= t) k += 1;
  return [addIntervals(anchor, interval, k), addIntervals(anchor, interval, k + 1)];
}

const pad = (n: number): string => String(n).padStart(2, "0");

// "15 Oct 2026", as in proration line descriptions.
export function shortDate(t: number): string {
  const d = new Date(t * 1000);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()}`;
}

// "October 21, 2026", as in the portal.
export function longDate(t: number): string {
  const d = new Date(t * 1000);
  return `${LONG_MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// "Oct 21", as in the portal's badges.
export function monthDay(t: number): string {
  const d = new Date(t * 1000);
  return `${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}`;
}

// "$2,500.00"
export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${whole}.${pad(abs % 100)}`;
}
