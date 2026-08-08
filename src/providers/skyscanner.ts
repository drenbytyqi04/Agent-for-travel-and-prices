import type { Locator, Page } from 'playwright';
import { AgentError } from '../errors.js';
import { normaliseResult, type FlightResult } from '../models/flight-result.js';
import { airportRef } from '../utils/airports.js';
import { buildSkyscannerUrl, cleanUrl } from '../utils/url-builder.js';
import { scrollThrough, waitForStableCount } from '../browser/page-interaction.js';
import {
  detectPerPerson,
  detectTaxesIncluded,
  lines,
  parseAirline,
  parseBaggage,
  parseCardPrice,
  parseDurationText,
  parseStops,
  parseTimeRange,
  type RawCard,
} from './parse-helpers.js';
import { BaseProvider, type ProviderCapabilities, type ProviderContext, type SearchTask, type VerificationOutcome } from './provider.js';

/**
 * Skyscanner. Quotes per-traveller prices including taxes by default, and exposes a "Select"
 * link per itinerary that redirects to the actual seller — the closest thing to a direct booking
 * URL among the aggregators.
 */
export class SkyscannerProvider extends BaseProvider {
  readonly id = 'skyscanner';
  readonly name = 'Skyscanner';
  override readonly priority = 20;
  override readonly capabilities: ProviderCapabilities = {
    priceVerification: true,
    baggageInfo: false,
    directBookingLinks: true,
    roundTrip: true,
  };

  buildSearchUrl(task: SearchTask): string {
    return buildSkyscannerUrl({
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
      await context.chrome.goto(page, url, { settleMs: 4_000 });

      const selector = CARD_SELECTORS.join(', ');
      const count = await waitForStableCount(page, selector, { minCount: 1, timeout: 45_000, stableForMs: 3_500 });

      if (count === 0) {
        await context.chrome.assertNotBlocked(page, this.id);
        throw new AgentError('no_flights_found', `Skyscanner: asnjë rezultat për ${task.originIata}→${task.destinationIata}.`, {
          source: this.id,
        });
      }

      await scrollThrough(page, 2, 500);
      const cards = await extractSkyscannerCards(page, task.limit ?? 12);
      context.logger.debug(`skyscanner: ${cards.length} karta`);

      const searchUrl = cleanUrl(page.url());
      const results = cards
        .map((card) => parseSkyscannerCard(card, task, searchUrl))
        .filter((result): result is FlightResult => result !== undefined);

      if (results.length === 0) {
        throw new AgentError('search_failed', 'Skyscanner: kartat u shfaqën por nuk u lexuan dot.', { source: this.id });
      }
      return results;
    });
  }

  async verify(result: FlightResult, context: ProviderContext): Promise<VerificationOutcome> {
    return this.withPage(context, async (page) => {
      await context.chrome.goto(page, result.bookingUrl, { settleMs: 4_000 });

      const card = page.locator(CARD_SELECTORS.join(', ')).first();
      if (!(await card.isVisible({ timeout: 10_000 }).catch(() => false))) {
        return { error: new AgentError('price_unverifiable', 'Skyscanner: oferta nuk u hap dot.', { source: this.id }) };
      }

      const text = await card.innerText({ timeout: 5_000 }).catch(() => '');
      const price = parseCardPrice(text, result.currency);
      const bookingUrl = await captureSelectLink(page, card);

      if (!price) {
        return {
          bookingUrl,
          error: new AgentError('price_unverifiable', 'Skyscanner: çmimi nuk u lexua dot.', { source: this.id }),
        };
      }
      return {
        price: price.amount,
        currency: price.currency,
        // Skyscanner quotes per traveller including taxes unless it says otherwise.
        priceIsPerPerson: detectPerPerson(text) ?? true,
        taxesIncluded: detectTaxesIncluded(text) ?? true,
        baggage: parseBaggage(text, price.currency),
        bookingUrl,
      };
    });
  }
}

const CARD_SELECTORS = [
  '[data-testid="flight-card"]',
  '[class*="FlightsResults_dayViewItem"]',
  '[class*="ItineraryCard"]',
  'div[data-testid*="itinerary"]',
];

async function extractSkyscannerCards(page: Page, limit: number): Promise<RawCard[]> {
  return page.evaluate(
    ({ selectors, limit: max }) => {
      const nodes: Element[] = [];
      for (const selector of selectors) {
        nodes.push(...Array.from(document.querySelectorAll(selector)));
        if (nodes.length > 0) break;
      }

      return nodes.slice(0, max).map((node) => ({
        text: (node as HTMLElement).innerText ?? '',
        ariaLabels: Array.from(node.querySelectorAll('[aria-label]'))
          .map((el) => el.getAttribute('aria-label') ?? '')
          .filter(Boolean),
        href: node.querySelector('a[href]')?.getAttribute('href') ?? undefined,
      }));
    },
    { selectors: CARD_SELECTORS, limit },
  );
}

async function captureSelectLink(page: Page, card: Locator): Promise<string | undefined> {
  const href = await card
    .locator('a[href*="/transport_deeplink/"], a[href*="/deeplink"], a[href]')
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

export function parseSkyscannerCard(card: RawCard, task: SearchTask, searchUrl: string): FlightResult | undefined {
  const text = card.text;
  const combined = `${text}\n${card.ariaLabels.join('\n')}`;

  const times = parseTimeRange(text);
  const price = parseCardPrice(text, task.currency);
  if (!times || !price) return undefined;

  const legs = text.split(/\n(?=\d{1,2}[:.]\d{2})/);
  const bookingUrl = card.href ? absolute(card.href, searchUrl) : searchUrl;

  return normaliseResult(
    {
      airline: parseAirline(lines(text)) ?? 'E panjohur',
      origin: airportRef(task.originIata),
      destination: airportRef(task.destinationIata),
      departureDate: task.departureDate,
      returnDate: task.returnDate,
      departureTime: times.departureTime,
      arrivalTime: times.arrivalTime,
      duration: parseDurationText(text) ?? 'n/a',
      stops: parseStops(legs[0] ?? text) ?? parseStops(text) ?? 0,
      returnStops: task.returnDate && legs[1] ? parseStops(legs[1]) : undefined,
      price: price.amount,
      currency: price.currency,
      priceIsPerPerson: detectPerPerson(combined) ?? true,
      taxesIncluded: detectTaxesIncluded(combined) ?? true,
      baggage: parseBaggage(combined, price.currency),
      cabinClass: task.cabinClass,
      source: 'skyscanner',
      bookingUrl,
      bookingUrlIsSearch: bookingUrl === searchUrl,
    },
    { passengers: task.passengers, source: 'skyscanner' },
  );
}

function absolute(href: string, base: string): string {
  try {
    return cleanUrl(new URL(href, base).toString());
  } catch {
    return base;
  }
}
