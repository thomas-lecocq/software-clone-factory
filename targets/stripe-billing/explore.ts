/**
 * State-graph exploration of the Customer Portal: walkthroughs only check the paths someone
 * thought of, so this probe clicks every visible, enabled button and same-site link, breadth
 * first, up to a depth, and records the graph of screens it reaches. Each path is replayed in a
 * fresh billing world, since a click can change the account. The graph is canonical (states
 * numbered in discovery order, actions in page order), so the same code on the clone must
 * reach the same screens through the same clicks.
 */
import type { Browser, Page } from "playwright";
import type Stripe from "stripe";
import { z } from "zod";
import type { Json } from "../../harness/src/json.ts";
import { launch, normalise, openPage, settle, setupWorld, World } from "./ui.ts";

export const ExploreInput = World.extend({
  kind: z.literal("explore"),
  depth: z.number().int().min(1).max(4),
  max_states: z.number().int().min(1).max(40),
});
export type ExploreInput = z.infer<typeof ExploreInput>;

interface Action {
  role: "button" | "link";
  name: string;
  nth: number;
}

const label = (a: Action): string => `${a.role} "${a.name}"${a.nth > 0 ? ` #${a.nth}` : ""}`;

// Waits until the accessibility tree has not changed for a second: screens animate in, and
// buttons show a transient label ("Canceling…") while their request runs.
async function stableScreen(page: Page): Promise<string[]> {
  await settle(page);
  let last = "";
  let same = 0;
  for (let i = 0; i < 40 && same < 2; i += 1) {
    await page.waitForTimeout(500);
    const now = await page.locator("body").ariaSnapshot();
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return normalise(last);
}

async function actions(page: Page): Promise<Action[]> {
  const origin = new URL(page.url()).origin;
  const out: Action[] = [];
  const seen = new Map<string, number>();
  for (const role of ["link", "button"] as const) {
    for (const el of await page.getByRole(role).all()) {
      const aria = await el.ariaSnapshot().catch(() => "");
      const name = /^- \w+ "((?:[^"\\]|\\.)*)"/.exec(aria)?.[1];
      if (name === undefined) continue;
      const key = `${role}\u0000${name}`;
      const nth = seen.get(key) ?? 0;
      seen.set(key, nth + 1);
      if (!(await el.isVisible()) || !(await el.isEnabled())) continue;
      const href = await el.getAttribute("href");
      if (href !== null && !href.startsWith("#") && new URL(href, page.url()).origin !== origin)
        continue;
      out.push({ role, name: name.replace(/\\(.)/g, "$1"), nth });
    }
  }
  return out;
}

async function replay(
  browser: Browser,
  stripe: Stripe,
  world: World,
  path: Action[],
): Promise<{ screen: string[]; next: Action[] }> {
  const portal = await setupWorld(stripe, world);
  const page = await openPage(browser);
  try {
    await page.goto(portal.url);
    await page.getByRole("link").first().waitFor({ timeout: 20000 });
    for (const a of path) {
      await page.getByRole(a.role, { name: a.name, exact: true }).nth(a.nth).click();
      await stableScreen(page);
    }
    return { screen: await stableScreen(page), next: await actions(page) };
  } finally {
    await page.context().close();
  }
}

export async function runExplore(
  stripe: Stripe,
  input: ExploreInput,
): Promise<Record<string, Json>> {
  const browser = await launch();
  const states = new Map<string, number>();
  const screens: string[][] = [];
  const edges: { from: number; action: string; to: number }[] = [];
  const queue: { path: Action[]; from: number | null }[] = [{ path: [], from: null }];
  let truncated = false;
  try {
    for (let node = queue.shift(); node; node = queue.shift()) {
      const { screen, next } = await replay(browser, stripe, input, node.path);
      const sig = screen.join("\n");
      const known = states.get(sig);
      const id = known ?? screens.length;
      const last = node.path.at(-1);
      if (node.from !== null && last) edges.push({ from: node.from, action: label(last), to: id });
      if (known !== undefined) continue;
      if (screens.length >= input.max_states) {
        truncated = true;
        break;
      }
      states.set(sig, id);
      screens.push(screen);
      if (node.path.length >= input.depth) continue;
      for (const a of next) queue.push({ path: [...node.path, a], from: id });
    }
  } finally {
    await browser.close();
  }
  return { graph: { states: screens, edges, truncated } };
}
