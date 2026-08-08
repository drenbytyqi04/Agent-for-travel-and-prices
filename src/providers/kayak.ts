import type { Page } from 'playwright';
import { AgentError } from '../errors.js';
import { normaliseResult, type FlightResult } from '../models/flight-result.js';
import { airportRef } from '../utils/airports.js';
import { buildKayakUrl, buildMomondoUrl, cleanUrl } from '../utils/url-builder.js';
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
 * Kayak and Momondo run the same engine and near-identical markup, so one implementation serves
 * both; only the URL shape and the branding differ. Both are aggressive about bot detection —
 * when they wall us, the base class records it and the agent moves on.
 */
abstract class KayakFamilyProvider extends BaseProvider {
  override readonly capabilities: ProviderCapabilities = {
    priceVerification: true,
    baggageInfo: true,
    directBookingLinks: true,
    roundTrip: true,
  };

  async search(task: SearchTask, context: ProviderContext): Promise<FlightResult[]> {
    const url = this.buildSearchUrl(task);
    return this.withPage(context, async (page) => {
      await context.chrome.goto(page, url, { settleMs: 4_000 });

      // Kayak polls providers for ~20s after the page loads; reading early means missing the
      // cheapest fare, which is exactly what we are here for.
      const selector = CARD_SELECTORS.join(', ');
      const count = await waitForStableCount(page, selector, { minCount: 1, timeout: 45_000, stableForMs: 4_000 });

      if (count === 0) {
        await context.chrome.assertNotBlocked(page, this.id);
        throw new AgentError('no_flights_found', `${this.name}: asnjë rezultat për ${task.originIata}→${task.destinationIata}.`, {
          source: this.id,
        });
      }

      await scrollThrough(page, 2, 500);
      const cards = await extractKayakCards(page, task.limit ?? 12);
      context.logger.debug(`${this.id}: ${cards.length} karta`);

      const searchUrl = cleanUrl(page.url());
      const results = cards
        .map((card) => parseKayakCard(card, task, searchUrl, this.id))
        .filter((result): result is FlightResult => result !== undefined);

      if (results.length === 0) {
        throw new AgentError('search_failed', `${this.name}: kartat u shfaqën por nuk u lexuan dot.`, { source: this.id });
      }
      return results;
    });
  }

  async verify(result: FlightResult, context: ProviderContext): Promise<VerificationOutcome> {
    return this.withPage(context, async (page) => {
      await context.chrome.goto(page, result.bookingUrl, { settleMs: 4_000 });

      const card = page.locator(CARD_SELECTORS.join(', ')).first();
      if (!(await card.isVisible({ timeout: 10_000 }).catch(() => false))) {
        return { error: new AgentError('price_unverifiable', `${this.name}: oferta nuk u hap dot.`, { source: this.id }) };
      }

      const text = await card.innerText({ timeout: 5_000 }).catch(() => '');
      const price = parseCardPrice(text, result.currency);
      const bookingUrl = await captureDealLink(page, card);

      if (!price) {
        return {
          bookingUrl,
          error: new AgentError('price_unverifiable', `${this.name}: çmimi nuk u lexua në faqen e ofertës.`, { source: this.id }),
        };
      }
      return {
        price: price.amount,
        currency: price.currency,
        priceIsPerPerson: detectPerPerson(text) ?? result.priceIsPerPerson,
        taxesIncluded: detectTaxesIncluded(text),
        baggage: parseBaggage(text, price.currency),
        bookingUrl,
      };
    });
  }
}

export class KayakProvider extends KayakFamilyProvider {
  readonly id = 'kayak';
  readonly name = 'Kayak';
  override readonly priority = 30;

  buildSearchUrl(task: SearchTask): string {
    return buildKayakUrl(toUrlParams(task));
  }
}

export class MomondoProvider extends KayakFamilyProvider {
  readonly id = 'momondo';
  readonly name = 'Momondo';
  override readonly priority = 40;

  buildSearchUrl(task: SearchTask): string {
    return buildMomondoUrl(toUrlParams(task));
  }
}

function toUrlParams(task: SearchTask) {
  return {
    originIata: task.originIata,
    destinationIata: task.destinationIata,
    departureDate: task.departureDate,
    returnDate: task.returnDate,
    passengers: task.passengers,
    cabinClass: task.cabinClass,
    currency: task.currency,
    maxStops: task.maxStops,
  };
}

const CARD_SELECTORS = [
  '[data-resultid]',
  'div[class*="resultWrapper"]',
  'div[class*="result-item"]',
  '[role="group"][data-testid*="result"]',
];

async function extractKayakCards(page: Page, limit: number): Promise<RawCard[]> {
  return page.evaluate(
    ({ selectors, limit: max }) => {
      const nodes: Element[] = [];
      for (const selector of selectors) {
        nodes.push(...Array.from(document.querySelectorAll(selector)));
        if (nodes.length > 0) break;
      }

      return nodes.slice(0, max).map((node) => {
        const anchor =
          node.querySelector('a[href*="/book/"]') ??
          node.querySelector('a[href*="/in?"]') ??
          node.querySelector('a[href]');
        return {
          text: (node as HTMLElement).innerText ?? '',
          ariaLabels: Array.from(node.querySelectorAll('[aria-label]'))
            .map((el) => el.getAttribute('aria-label') ?? '')
            .filter(Boolean),
          href: anchor?.getAttribute('href') ?? undefined,
          attributes: { resultId: node.getAttribute('data-resultid') ?? '' },
        };
      });
    },
    { selectors: CARD_SELECTORS, limit },
  );
}

async function captureDealLink(page: Page, card: import('playwright').Locator): Promise<string | undefined> {
  const href = await card
    .locator('a[href*="/book/"], a[href*="/in?"], a[href*="bookingProvider"]')
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
 * Parses one Kayak/Momondo card. Their cards list the outbound leg first and the return leg
 * second, so the *first* time range is the outbound one and the stop count nearest it applies.
 */
export function parseKayakCard(
  card: RawCard,
  task: SearchTask,
  searchUrl: string,
  source: string,
): FlightResult | undefined {
  const text = card.text;
  const combined = `${text}\n${card.ariaLabels.join('\n')}`;

  const times = parseTimeRange(text);
  const price = parseCardPrice(text, task.currency);
  if (!times || !price) return undefined;

  const legs = text.split(/\n(?=\d{1,2}[:.]\d{2})/);
  const outboundStops = parseStops(legs[0] ?? text) ?? parseStops(text) ?? 0;
  const returnStops = task.returnDate && legs[1] ? parseStops(legs[1]) : undefined;

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
      stops: outboundStops,
      returnStops,
      price: price.amount,
      currency: price.currency,
      // Kayak quotes per traveller by default and says so when it does not.
      priceIsPerPerson: detectPerPerson(combined) ?? true,
      taxesIncluded: detectTaxesIncluded(combined),
      baggage: parseBaggage(combined, price.currency),
      cabinClass: task.cabinClass,
      source,
      bookingUrl,
      bookingUrlIsSearch: bookingUrl === searchUrl,
    },
    { passengers: task.passengers, source },
  );
}

function absolute(href: string, base: string): string {
  try {
    return cleanUrl(new URL(href, base).toString());
  } catch {
    return base;
  }
}
