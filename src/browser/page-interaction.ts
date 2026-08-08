import type { Locator, Page } from 'playwright';
import { createLogger } from '../utils/logger.js';

const log = createLogger('page');

/**
 * Defensive wrappers around Playwright.
 *
 * Every flight site changes its DOM without notice, so nothing here throws on a missing element:
 * helpers take a *list* of candidate selectors, try each, and report whether anything worked.
 * Providers decide what a miss means.
 */

export interface TryOptions {
  timeout?: number;
  /** Log the failure at warn instead of debug. */
  loud?: boolean;
}

/** First selector that resolves to a visible element, or undefined. */
export async function firstVisible(
  page: Page,
  selectors: string[],
  options: TryOptions = {},
): Promise<Locator | undefined> {
  const timeout = options.timeout ?? 4_000;
  const deadline = Date.now() + timeout;

  for (const selector of selectors) {
    // The budget is for the whole list, not per selector: with a per-selector floor, a 16-entry
    // list like the consent selectors would spend 6s on a page that has no consent wall at all.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: Math.min(remaining, 1_500) });
      return locator;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function clickFirst(page: Page, selectors: string[], options: TryOptions = {}): Promise<boolean> {
  const target = await firstVisible(page, selectors, options);
  if (!target) {
    log[options.loud ? 'warn' : 'debug'](`no clickable match: ${selectors[0]}`);
    return false;
  }
  try {
    await target.click({ timeout: options.timeout ?? 5_000 });
    return true;
  } catch (error) {
    log.debug(`click failed: ${(error as Error).message.split('\n')[0]}`);
    return false;
  }
}

/**
 * Types into an autocomplete field the way a person does, then picks the first suggestion.
 * Flight sites almost universally ignore a value set programmatically, so the keystrokes matter.
 */
export async function fillAutocomplete(
  page: Page,
  inputSelectors: string[],
  value: string,
  suggestionSelectors: string[],
  options: TryOptions = {},
): Promise<boolean> {
  const input = await firstVisible(page, inputSelectors, options);
  if (!input) return false;

  try {
    await input.click({ timeout: 5_000 });
    await input.fill('');
    await input.type(value, { delay: 80 });
    await page.waitForTimeout(700);

    const suggestion = await firstVisible(page, suggestionSelectors, { timeout: 5_000 });
    if (suggestion) {
      await suggestion.click({ timeout: 5_000 });
      return true;
    }
    // No suggestion list appeared — Enter commits the typed value on most sites.
    await input.press('Enter');
    return true;
  } catch (error) {
    log.debug(`autocomplete "${value}" failed: ${(error as Error).message.split('\n')[0]}`);
    return false;
  }
}

/** Cookie/consent walls, in the languages these sites serve to a European visitor. */
const CONSENT_SELECTORS = [
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("I agree")',
  'button:has-text("Agree")',
  'button:has-text("Alle akzeptieren")',
  'button:has-text("Alles accepteren")',
  'button:has-text("Pranoj")',
  'button:has-text("Got it")',
  'button:has-text("Continue")',
  'button[aria-label*="Accept" i]',
  'button[aria-label*="agree" i]',
  '[id*="onetrust-accept" i]',
  '#onetrust-accept-btn-handler',
  '[data-testid="cookie-banner-accept"]',
  '[class*="cookie" i] button:has-text("OK")',
  'form[action*="consent"] button',
];

/** Dismisses a consent dialog if one is up. Safe to call unconditionally. */
export async function dismissConsent(page: Page): Promise<boolean> {
  // Google serves consent from an iframe on some editions.
  for (const frame of page.frames()) {
    for (const selector of ['button:has-text("Accept all")', '#L2AGLb', 'form[action*="consent"] button']) {
      try {
        const locator = frame.locator(selector).first();
        if (await locator.isVisible({ timeout: 300 })) {
          await locator.click({ timeout: 3_000 });
          log.debug('consent dismissed (frame)');
          await page.waitForTimeout(500);
          return true;
        }
      } catch {
        continue;
      }
    }
  }

  const clicked = await clickFirst(page, CONSENT_SELECTORS, { timeout: 1_500 });
  if (clicked) {
    log.debug('consent dismissed');
    await page.waitForTimeout(500);
  }
  return clicked;
}

/** Closes newsletter/app-install modals that cover the results list. */
export async function dismissModals(page: Page): Promise<void> {
  await clickFirst(
    page,
    [
      'button[aria-label*="close" i]',
      'button[aria-label*="dismiss" i]',
      '[role="dialog"] button:has-text("No thanks")',
      '[role="dialog"] button:has-text("Not now")',
      '[data-testid*="close" i]',
    ],
    { timeout: 1_000 },
  );
}

/**
 * Waits for a results list to stop growing — flight sites stream results in, and reading too
 * early gives a price that is not the cheapest.
 */
export async function waitForStableCount(
  page: Page,
  selector: string,
  options: { minCount?: number; timeout?: number; stableForMs?: number } = {},
): Promise<number> {
  const minCount = options.minCount ?? 1;
  const timeout = options.timeout ?? 30_000;
  const stableFor = options.stableForMs ?? 2_500;

  const deadline = Date.now() + timeout;
  let lastCount = -1;
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    } else if (count >= minCount && Date.now() - stableSince >= stableFor) {
      return count;
    }
    await page.waitForTimeout(500);
  }
  return Math.max(0, lastCount);
}

/** Scrolls the results list so lazily-rendered cards mount before we read them. */
export async function scrollThrough(page: Page, steps = 4, delayMs = 600): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, 1600).catch(() => undefined);
    await page.waitForTimeout(delayMs);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
}

export async function textOf(locator: Locator | undefined): Promise<string> {
  if (!locator) return '';
  try {
    return ((await locator.textContent({ timeout: 2_000 })) ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/** First non-empty text among candidate selectors, searched within `scope`. */
export async function textFrom(scope: Locator, selectors: string[]): Promise<string> {
  for (const selector of selectors) {
    const text = await textOf(scope.locator(selector).first());
    if (text) return text;
  }
  return '';
}

export async function attrFrom(scope: Locator, selectors: string[], attribute: string): Promise<string | undefined> {
  for (const selector of selectors) {
    try {
      const value = await scope.locator(selector).first().getAttribute(attribute, { timeout: 1_500 });
      if (value) return value;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Saves a screenshot for debugging; never throws. */
export async function debugShot(page: Page, name: string): Promise<string | undefined> {
  if (process.env.FLIGHT_AGENT_SCREENSHOTS !== '1') return undefined;
  const path = `screenshots/${name.replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}.png`;
  try {
    await page.screenshot({ path, fullPage: false });
    log.debug(`screenshot → ${path}`);
    return path;
  } catch {
    return undefined;
  }
}
