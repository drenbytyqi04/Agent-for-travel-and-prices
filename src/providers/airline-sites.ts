import type { Page } from 'playwright';
import { AgentError } from '../errors.js';
import type { FlightRequest } from '../models/flight-request.js';
import { normaliseResult, type FlightResult } from '../models/flight-result.js';
import { airportRef, resolveAirports } from '../utils/airports.js';
import { buildWizzAirUrl, cleanUrl } from '../utils/url-builder.js';
import { waitForStableCount } from '../browser/page-interaction.js';
import {
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
import { BaseProvider, type ProviderCapabilities, type ProviderContext, type SearchTask } from './provider.js';

/**
 * Airline-owned sites.
 *
 * These matter because low-cost carriers frequently undercut their own listings on aggregators,
 * and their price is by definition the bookable one. The cost is coverage: each airline only
 * flies its own routes, so `supports()` and `servesRoute()` keep the agent from spending a browser
 * session on a route the carrier does not operate.
 */
export abstract class AirlineSiteProvider extends BaseProvider {
  override readonly capabilities: ProviderCapabilities = {
    priceVerification: false, // the listed price *is* the airline's price
    baggageInfo: true,
    directBookingLinks: true,
    roundTrip: true,
  };

  /** Airline brand name as it should appear in results. */
  abstract readonly airline: string;
  /** Routes the carrier operates, as `ORIGIN→DEST` pairs (both directions implied). */
  protected abstract routes(): ReadonlySet<string>;

  servesRoute(originIata: string, destinationIata: string): boolean {
    const routes = this.routes();
    return routes.has(`${originIata}-${destinationIata}`) || routes.has(`${destinationIata}-${originIata}`);
  }

  supports(request: FlightRequest): boolean {
    const origins = resolveAirports(request.origin);
    if (origins.length === 0) return false;

    // With only a country named, the agent will fan out; accept if any origin/destination pair
    // in the catalog is on our network. The per-task check below does the precise filtering.
    if (!request.destination) return origins.some((origin) => this.hasAnyRouteFrom(origin.iata));

    const destinations = resolveAirports(request.destination);
    return origins.some((origin) => destinations.some((dest) => this.servesRoute(origin.iata, dest.iata)));
  }

  private hasAnyRouteFrom(iata: string): boolean {
    for (const route of this.routes()) {
      const [from, to] = route.split('-');
      if (from === iata || to === iata) return true;
    }
    return false;
  }
}

/**
 * Wizz Air — the dominant low-cost carrier out of Prishtina and usually the cheapest option to
 * Germany, so it is worth querying directly rather than trusting an aggregator's cached fare.
 */
export class WizzAirProvider extends AirlineSiteProvider {
  readonly id = 'wizzair';
  readonly name = 'Wizz Air (faqja zyrtare)';
  readonly airline = 'Wizz Air';
  override readonly priority = 60;

  /** PRN network to German and nearby airports. Kept explicit so a dropped route is a one-line fix. */
  protected routes(): ReadonlySet<string> {
    return WIZZ_PRN_ROUTES;
  }

  buildSearchUrl(task: SearchTask): string {
    return buildWizzAirUrl({
      originIata: task.originIata,
      destinationIata: task.destinationIata,
      departureDate: task.departureDate,
      returnDate: task.returnDate,
      passengers: task.passengers,
      cabinClass: task.cabinClass,
      currency: task.currency,
    });
  }

  async search(task: SearchTask, context: ProviderContext): Promise<FlightResult[]> {
    if (!this.servesRoute(task.originIata, task.destinationIata)) {
      throw new AgentError('no_flights_found', `Wizz Air nuk fluturon ${task.originIata}→${task.destinationIata}.`, {
        source: this.id,
        retryable: false,
      });
    }

    const url = this.buildSearchUrl(task);
    return this.withPage(context, async (page) => {
      await context.chrome.goto(page, url, { settleMs: 5_000 });

      const selector = FARE_SELECTORS.join(', ');
      const count = await waitForStableCount(page, selector, { minCount: 1, timeout: 40_000, stableForMs: 3_000 });
      if (count === 0) {
        await context.chrome.assertNotBlocked(page, this.id);
        throw new AgentError('no_flights_found', `Wizz Air: asnjë fluturim më ${task.departureDate}.`, { source: this.id });
      }

      const cards = await extractAirlineCards(page, FARE_SELECTORS, task.limit ?? 8);
      const results = cards
        .map((card) => parseAirlineCard(card, task, cleanUrl(page.url()), this.id, this.airline))
        .filter((result): result is FlightResult => result !== undefined);

      if (results.length === 0) {
        throw new AgentError('search_failed', 'Wizz Air: çmimet nuk u lexuan dot nga faqja.', { source: this.id });
      }
      return results;
    });
  }
}

/** Route pairs Wizz Air operates from Prishtina (subset relevant to this agent). */
const WIZZ_PRN_ROUTES: ReadonlySet<string> = new Set([
  'PRN-DTM', 'PRN-FMM', 'PRN-HAM', 'PRN-BER', 'PRN-FKB', 'PRN-HAJ', 'PRN-NUE',
  'PRN-BRE', 'PRN-CGN', 'PRN-FRA', 'PRN-STR', 'PRN-DUS', 'PRN-LEJ', 'PRN-FMO',
  'PRN-BSL', 'PRN-GVA', 'PRN-VIE', 'PRN-BGY', 'PRN-MXP', 'PRN-CRL', 'PRN-EIN',
  'PRN-LTN', 'PRN-BVA', 'PRN-BUD', 'PRN-CPH', 'PRN-ARN', 'PRN-OSL',
]);

const FARE_SELECTORS = [
  '[class*="flight-select__flight"]',
  '[class*="fare-selector"]',
  '[data-test*="flight-select"]',
  '[class*="flight-list__item"]',
];

async function extractAirlineCards(page: Page, selectors: string[], limit: number): Promise<RawCard[]> {
  return page.evaluate(
    ({ selectors: candidates, limit: max }) => {
      const nodes: Element[] = [];
      for (const selector of candidates) {
        nodes.push(...Array.from(document.querySelectorAll(selector)));
        if (nodes.length > 0) break;
      }
      return nodes.slice(0, max).map((node) => ({
        text: (node as HTMLElement).innerText ?? '',
        ariaLabels: Array.from(node.querySelectorAll('[aria-label]'))
          .map((el) => el.getAttribute('aria-label') ?? '')
          .filter(Boolean),
        href: undefined,
      }));
    },
    { selectors, limit },
  );
}

/**
 * Parses an airline-site fare row. The airline is known from the provider, so unlike aggregator
 * cards we do not have to guess it — only fall back to text parsing for codeshares.
 */
export function parseAirlineCard(
  card: RawCard,
  task: SearchTask,
  searchUrl: string,
  source: string,
  airline: string,
): FlightResult | undefined {
  const text = card.text;
  const combined = `${text}\n${card.ariaLabels.join('\n')}`;

  const times = parseTimeRange(text);
  const price = parseCardPrice(text, task.currency);
  if (!times || !price) return undefined;

  return normaliseResult(
    {
      // The provider knows whose site this is, so the brand is authoritative here — unlike an
      // aggregator card, where the carrier has to be guessed from the text.
      airline,
      origin: airportRef(task.originIata),
      destination: airportRef(task.destinationIata),
      departureDate: task.departureDate,
      returnDate: task.returnDate,
      departureTime: times.departureTime,
      arrivalTime: times.arrivalTime,
      duration: parseDurationText(text) ?? 'n/a',
      stops: parseStops(combined) ?? 0,
      price: price.amount,
      currency: price.currency,
      // Airline sites price the whole booking for the party being searched.
      priceIsPerPerson: false,
      taxesIncluded: detectTaxesIncluded(combined) ?? true,
      baggage: parseBaggage(combined, price.currency),
      cabinClass: task.cabinClass,
      source,
      bookingUrl: searchUrl,
      // The deep link *is* the booking flow for this fare, so it is not merely a search page.
      bookingUrlIsSearch: false,
      priceConfidence: 'verified',
      notes: ['Çmim direkt nga faqja e kompanisë ajrore.'],
    },
    { passengers: task.passengers, source },
  );
}
