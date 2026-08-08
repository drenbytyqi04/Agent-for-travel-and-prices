import type { Page } from 'playwright';
import { AgentError } from '../errors.js';
import { normaliseResult, type FlightResult } from '../models/flight-result.js';
import { airportRef } from '../utils/airports.js';
import { buildGoogleFlightsUrl, cleanUrl } from '../utils/url-builder.js';
import { scrollThrough, waitForStableCount } from '../browser/page-interaction.js';
import {
  detectPerPerson,
  detectTaxesIncluded,
  lines,
  parseAirline,
  parseCardPrice,
  parseDurationText,
  parseStops,
  parseTimeRange,
  to24h,
  type RawCard,
} from './parse-helpers.js';
import { BaseProvider, type ProviderCapabilities, type ProviderContext, type SearchTask, type VerificationOutcome } from './provider.js';

/**
 * Google Flights — the MVP source.
 *
 * Navigation is URL-driven (`?q=Flights from PRN to BER on …`) rather than form-driven: Google
 * resolves that query into a fully-specified search, and it survives the DOM churn that breaks
 * date-picker automation. `fillSearchForm` is kept as a fallback for the case where the URL lands
 * on an unparameterised page.
 */
export class GoogleFlightsProvider extends BaseProvider {
  readonly id = 'google_flights';
  readonly name = 'Google Flights';
  override readonly priority = 10;
  override readonly capabilities: ProviderCapabilities = {
    priceVerification: true,
    baggageInfo: true,
    directBookingLinks: true,
    roundTrip: true,
  };

  buildSearchUrl(task: SearchTask): string {
    return buildGoogleFlightsUrl({
      originIata: task.originIata,
      destinationIata: task.destinationIata,
      departureDate: task.departureDate,
      returnDate: task.returnDate,
      passengers: task.passengers,
      cabinClass: task.cabinClass,
      currency: task.currency,
      maxStops: task.maxStops,
    });
  }

  async search(task: SearchTask, context: ProviderContext): Promise<FlightResult[]> {
    const url = this.buildSearchUrl(task);
    return this.withPage(context, async (page) => {
      await context.chrome.goto(page, url, { settleMs: 2_500 });

      const listSelector = RESULT_LIST_SELECTORS.join(', ');
      const count = await waitForStableCount(page, listSelector, { minCount: 1, timeout: 30_000, stableForMs: 2_000 });

      if (count === 0) {
        // Either genuinely no flights, or the query did not resolve. Try the form once.
        const recovered = await this.fillSearchForm(page, task, context);
        if (!recovered) {
          await context.chrome.assertNotBlocked(page, this.id);
          throw new AgentError('no_flights_found', `Google Flights nuk ktheu rezultate për ${task.originIata}→${task.destinationIata}.`, {
            source: this.id,
          });
        }
        await waitForStableCount(page, listSelector, { minCount: 1, timeout: 25_000, stableForMs: 2_000 });
      }

      await scrollThrough(page, 3, 500);
      const cards = await extractCards(page, task.limit ?? 12);
      context.logger.debug(`google: ${cards.length} karta të lexuara`);

      const searchUrl = cleanUrl(page.url());
      const results = cards
        .map((card) => parseGoogleCard(card, task, searchUrl))
        .filter((result): result is FlightResult => result !== undefined);

      if (results.length === 0) {
        throw new AgentError('search_failed', 'Google Flights: rezultatet u shfaqën por nuk u lexuan dot.', {
          source: this.id,
        });
      }
      return results;
    });
  }

  /**
   * Opens the cheapest itinerary and reads the price Google shows on the booking panel — this is
   * the number that actually gets charged, and it routinely differs from the list price.
   */
  async verify(result: FlightResult, context: ProviderContext): Promise<VerificationOutcome> {
    return this.withPage(context, async (page) => {
      await context.chrome.goto(page, result.bookingUrl, { settleMs: 2_500 });

      const card = page.locator(RESULT_LIST_SELECTORS.join(', ')).first();
      if (!(await card.isVisible({ timeout: 8_000 }).catch(() => false))) {
        return { error: new AgentError('price_unverifiable', 'Karta e fluturimit nuk u hap dot.', { source: this.id }) };
      }

      await card.click({ timeout: 8_000 }).catch(() => undefined);
      await page.waitForTimeout(3_000);

      const panel = await page
        .locator('[role="dialog"], [jsname="Vsuq6"], c-wiz')
        .first()
        .innerText({ timeout: 8_000 })
        .catch(() => '');
      const text = panel || (await page.innerText('body').catch(() => ''));
      if (!text) {
        return { error: new AgentError('price_unverifiable', 'Paneli i rezervimit nuk u lexua dot.', { source: this.id }) };
      }

      const price = parseCardPrice(text, result.currency);
      const bookingUrl = await captureBookingLink(page);

      if (!price) {
        return {
          bookingUrl,
          error: new AgentError('price_unverifiable', 'Çmimi nuk u gjet në panelin e rezervimit.', { source: this.id }),
        };
      }

      return {
        price: price.amount,
        currency: price.currency,
        priceIsPerPerson: detectPerPerson(text) ?? result.priceIsPerPerson,
        taxesIncluded: detectTaxesIncluded(text),
        bookingUrl,
      };
    });
  }

  /**
   * Fallback path: drive the actual search form. Only used when the URL query failed to resolve,
   * because it is markedly slower and more brittle than the URL route.
   */
  private async fillSearchForm(page: Page, task: SearchTask, context: ProviderContext): Promise<boolean> {
    context.logger.debug('google: URL nuk u zgjidh, po provoj formularin');
    try {
      const origin = page.locator('input[aria-label*="Where from" i], input[placeholder*="Where from" i]').first();
      const destination = page.locator('input[aria-label*="Where to" i], input[placeholder*="Where to" i]').first();
      if (!(await origin.isVisible({ timeout: 5_000 }).catch(() => false))) return false;

      await origin.click();
      await origin.fill('');
      await origin.type(task.originIata, { delay: 90 });
      await page.waitForTimeout(900);
      await page.keyboard.press('Enter');

      await destination.click();
      await destination.fill('');
      await destination.type(task.destinationIata, { delay: 90 });
      await page.waitForTimeout(900);
      await page.keyboard.press('Enter');

      const departureInput = page.locator('input[aria-label*="Departure" i]').first();
      await departureInput.click({ timeout: 5_000 });
      await departureInput.fill(task.departureDate);
      await page.keyboard.press('Enter');

      if (task.returnDate) {
        const returnInput = page.locator('input[aria-label*="Return" i]').first();
        if (await returnInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await returnInput.click();
          await returnInput.fill(task.returnDate);
          await page.keyboard.press('Enter');
        }
      }

      await page.locator('button[aria-label*="Search" i], button:has-text("Search")').first().click({ timeout: 5_000 });
      await page.waitForTimeout(3_000);
      return true;
    } catch (error) {
      context.logger.debug(`google: formulari dështoi — ${(error as Error).message.split('\n')[0]}`);
      return false;
    }
  }
}

const RESULT_LIST_SELECTORS = ['ul.Rk10dc li.pIav2d', 'ul[class] li[class] div[role="button"][aria-label*="Leaves"]', 'li.pIav2d'];

/** Reads the results list into plain data. All DOM knowledge is confined to this function. */
async function extractCards(page: Page, limit: number): Promise<RawCard[]> {
  return page.evaluate(
    ({ selectors, limit: max }) => {
      const nodes: Element[] = [];
      for (const selector of selectors) {
        nodes.push(...Array.from(document.querySelectorAll(selector)));
        if (nodes.length > 0) break;
      }

      return nodes.slice(0, max).map((node) => {
        const ariaLabels = Array.from(node.querySelectorAll('[aria-label]'))
          .map((el) => el.getAttribute('aria-label') ?? '')
          .filter(Boolean);
        const own = node.getAttribute('aria-label');
        if (own) ariaLabels.unshift(own);

        const anchor = node.querySelector('a[href]');
        return {
          text: (node as HTMLElement).innerText ?? '',
          ariaLabels,
          href: anchor?.getAttribute('href') ?? undefined,
        };
      });
    },
    { selectors: RESULT_LIST_SELECTORS, limit },
  );
}

/** Grabs the outbound booking link from an expanded Google Flights card, if one is exposed. */
async function captureBookingLink(page: Page): Promise<string | undefined> {
  const href = await page
    .locator('a[href*="/travel/clk"], a[aria-label*="Continue" i], a[href^="http"]:has-text("Continue")')
    .first()
    .getAttribute('href', { timeout: 3_000 })
    .catch(() => null);
  if (!href) return undefined;
  try {
    return cleanUrl(new URL(href, page.url()).toString());
  } catch {
    return undefined;
  }
}

/**
 * Turns one raw card into a `FlightResult`. Exported for tests, which feed it captured card text
 * so parsing regressions surface without a browser.
 */
export function parseGoogleCard(card: RawCard, task: SearchTask, searchUrl: string): FlightResult | undefined {
  // The aria-labels are a richer, more stable description than the visible text; join both.
  const aria = card.ariaLabels.join('\n');
  const combined = `${aria}\n${card.text}`;

  const times = parseTimeRange(card.text) ?? parseTimeRange(aria) ?? parseAriaTimes(aria);
  const price = parseCardPrice(card.text, task.currency) ?? parseCardPrice(aria, task.currency);
  if (!times || !price) return undefined;

  const stops = parseStops(combined) ?? 0;
  const airline = parseAirline(lines(card.text)) ?? parseAriaAirline(aria) ?? 'E panjohur';
  const duration = parseDurationText(card.text) ?? parseDurationText(aria) ?? 'n/a';

  // Google shows round-trip fares as the total for the itinerary but per traveller.
  const perPerson = detectPerPerson(combined) ?? true;

  const bookingUrl = card.href ? absoluteOrSearch(card.href, searchUrl) : searchUrl;

  return normaliseResult(
    {
      airline,
      origin: airportRef(task.originIata),
      destination: airportRef(task.destinationIata),
      departureDate: task.departureDate,
      returnDate: task.returnDate,
      departureTime: times.departureTime,
      arrivalTime: times.arrivalTime,
      duration,
      stops,
      price: price.amount,
      currency: price.currency,
      priceIsPerPerson: perPerson,
      taxesIncluded: detectTaxesIncluded(combined),
      cabinClass: task.cabinClass,
      source: 'google_flights',
      bookingUrl,
      bookingUrlIsSearch: bookingUrl === searchUrl,
    },
    { passengers: task.passengers, source: 'google_flights' },
  );
}

/** Google's card aria-label form: "Leaves … at 6:20 AM … and arrives … at 8:40 AM". */
function parseAriaTimes(aria: string): { departureTime: string; arrivalTime: string } | undefined {
  const departure = aria.match(/leaves[^.]*?at\s+(\d{1,2}[:.]\d{2}\s*(?:[AP]M)?)/i);
  const arrival = aria.match(/arrives[^.]*?at\s+(\d{1,2}[:.]\d{2}\s*(?:[AP]M)?)/i);
  if (!departure?.[1] || !arrival?.[1]) return undefined;

  const departureTime = to24h(departure[1]);
  const arrivalTime = to24h(arrival[1]);
  if (!departureTime || !arrivalTime) return undefined;
  return { departureTime, arrivalTime };
}

function parseAriaAirline(aria: string): string | undefined {
  // The carrier is followed by a full stop and the next sentence ("… with Wizz Air. Leaves …"),
  // so the character class must exclude the period — otherwise the match swallows the sentence.
  const match = aria.match(/(?:flight with|operated by)\s+([A-Za-zÀ-ÿ0-9 '&-]{2,40})/i);
  return match?.[1]?.trim() || undefined;
}

function absoluteOrSearch(href: string, searchUrl: string): string {
  try {
    return cleanUrl(new URL(href, searchUrl).toString());
  } catch {
    return searchUrl;
  }
}
