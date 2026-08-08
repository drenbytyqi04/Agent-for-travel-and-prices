import type { FlightRequest } from '../models/flight-request.js';
import { itineraryKey, pricePerPerson, type FlightResult } from '../models/flight-result.js';
import { canConvert, convert, type RateTable } from '../utils/currency.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('compare');

/**
 * Turns the raw pile of results from every provider × airport × date into a ranked comparison.
 *
 * The spec's warning in §4 drives the design: never assume the first result is the cheapest.
 * Nothing here trusts a provider's own ordering — everything is re-sorted on total price for the
 * whole party, after normalising currencies and merging duplicate itineraries.
 */

export interface ComparisonOptions {
  request: FlightRequest;
  /** Optional FX table; without it, results in other currencies are kept but not cross-compared. */
  rates?: RateTable;
}

export interface RankedResult {
  result: FlightResult;
  /** Total price for the party, in the request's currency. */
  comparablePrice: number;
  /** True when `comparablePrice` came from an FX conversion rather than the source's own currency. */
  converted: boolean;
  /** Other sources offering the same itinerary, cheapest first. */
  alsoOn: Array<{ source: string; price: number; currency: string; bookingUrl: string }>;
}

export interface Comparison {
  /** Everything that passed the filters, cheapest first. */
  ranked: RankedResult[];
  /** Results dropped by a hard filter, with the reason — surfaced so the user knows why. */
  filteredOut: Array<{ result: FlightResult; reason: string }>;
  /** Results that could not be price-compared because their currency was unconvertible. */
  incomparable: FlightResult[];
  cheapest?: RankedResult;
}

export function compareResults(results: FlightResult[], options: ComparisonOptions): Comparison {
  const { request } = options;
  const target = request.currency.toUpperCase();

  const filteredOut: Array<{ result: FlightResult; reason: string }> = [];
  const incomparable: FlightResult[] = [];
  const kept: FlightResult[] = [];

  for (const result of results) {
    const reason = filterReason(result, request);
    if (reason) {
      filteredOut.push({ result, reason });
      continue;
    }
    if (result.currency.toUpperCase() !== target && !canConvert(result.currency, target, options.rates)) {
      incomparable.push(result);
      continue;
    }
    kept.push(result);
  }

  const merged = mergeDuplicates(kept, target, options.rates);
  merged.sort((a, b) => a.comparablePrice - b.comparablePrice || durationOf(a) - durationOf(b));

  log.debug(`krahasim: ${results.length} rezultate → ${merged.length} unike, ${filteredOut.length} të filtruara`);

  return {
    ranked: merged,
    filteredOut,
    incomparable,
    cheapest: merged[0],
  };
}

/** Why a result cannot satisfy the request, or undefined when it can. */
function filterReason(result: FlightResult, request: FlightRequest): string | undefined {
  if (request.maxStops !== undefined) {
    if (result.stops > request.maxStops) return `${result.stops} ndalesa (kërkohej max ${request.maxStops})`;
    if (result.returnStops !== undefined && result.returnStops > request.maxStops) {
      return `${result.returnStops} ndalesa në kthim (kërkohej max ${request.maxStops})`;
    }
  }

  if (request.baggage === true && result.baggage?.checkedBagIncluded === false) {
    return 'pa bagazh të regjistruar';
  }

  const preference = request.timePreference;
  if (preference?.earliest && minutesOf(result.departureTime) < minutesOf(preference.earliest)) {
    return `niset ${result.departureTime}, para ${preference.earliest}`;
  }
  if (preference?.latest && minutesOf(result.departureTime) > minutesOf(preference.latest)) {
    return `niset ${result.departureTime}, pas ${preference.latest}`;
  }

  return undefined;
}

/**
 * Collapses the same itinerary seen on several sources into one row, keeping the cheapest as the
 * primary and the rest as `alsoOn`. Without this, a flight listed on four aggregators would fill
 * the whole top of the ranking.
 */
function mergeDuplicates(results: FlightResult[], target: string, rates?: RateTable): RankedResult[] {
  const groups = new Map<string, FlightResult[]>();
  for (const result of results) {
    const key = itineraryKey(result);
    const existing = groups.get(key);
    if (existing) existing.push(result);
    else groups.set(key, [result]);
  }

  const ranked: RankedResult[] = [];
  for (const group of groups.values()) {
    const priced = group
      .map((result) => ({ result, comparablePrice: toTarget(result, target, rates) }))
      .sort((a, b) => a.comparablePrice - b.comparablePrice);

    const best = priced[0]!;
    ranked.push({
      result: best.result,
      comparablePrice: best.comparablePrice,
      converted: best.result.currency.toUpperCase() !== target,
      alsoOn: priced.slice(1).map((entry) => ({
        source: entry.result.source,
        price: entry.result.totalPrice,
        currency: entry.result.currency,
        bookingUrl: entry.result.bookingUrl,
      })),
    });
  }
  return ranked;
}

function toTarget(result: FlightResult, target: string, rates?: RateTable): number {
  if (result.currency.toUpperCase() === target) return result.totalPrice;
  return convert(result.totalPrice, result.currency, target, rates);
}

function durationOf(entry: RankedResult): number {
  return entry.result.durationMinutes ?? Number.MAX_SAFE_INTEGER;
}

function minutesOf(time: string): number {
  const match = time.match(/^(\d{1,2}):(\d{2})/);
  if (!match?.[1] || !match[2]) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

// ── Groupings used by the "country-wide" and "flexible dates" answers ──────────────────────────

export interface CityOption {
  /** Destination IATA. */
  airport: string;
  city: string;
  best: RankedResult;
}

/** Cheapest option per destination city (spec §7). */
export function cheapestByCity(ranked: RankedResult[]): CityOption[] {
  const best = new Map<string, RankedResult>();
  for (const entry of ranked) {
    const key = entry.result.destination.airport;
    const current = best.get(key);
    if (!current || entry.comparablePrice < current.comparablePrice) best.set(key, entry);
  }

  return [...best.entries()]
    .map(([airport, entry]) => ({ airport, city: entry.result.destination.city, best: entry }))
    .sort((a, b) => a.best.comparablePrice - b.best.comparablePrice);
}

export interface DateOption {
  departureDate: string;
  returnDate?: string;
  best: RankedResult;
}

/** Cheapest option per departure/return date pair (spec §8). */
export function cheapestByDates(ranked: RankedResult[]): DateOption[] {
  const best = new Map<string, RankedResult>();
  for (const entry of ranked) {
    const key = `${entry.result.departureDate}|${entry.result.returnDate ?? 'ow'}`;
    const current = best.get(key);
    if (!current || entry.comparablePrice < current.comparablePrice) best.set(key, entry);
  }

  return [...best.values()]
    .map((entry) => ({
      departureDate: entry.result.departureDate,
      returnDate: entry.result.returnDate,
      best: entry,
    }))
    .sort((a, b) => a.best.comparablePrice - b.best.comparablePrice);
}

/** Per-person price in the comparison currency, for display. */
export function perPersonPrice(entry: RankedResult, passengers: number): number {
  return Math.round((entry.comparablePrice / Math.max(1, passengers)) * 100) / 100;
}

export { pricePerPerson };
