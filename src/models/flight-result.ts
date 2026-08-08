import type { CabinClass } from './flight-request.js';

export interface AirportRef {
  /** IATA code, uppercase. */
  airport: string;
  city: string;
  country?: string;
}

/** How much trust we can put in the price attached to a result. */
export type PriceConfidence =
  /** Price read from a search-results card only. */
  | 'listed'
  /** Offer page was opened and the price matched the listing. */
  | 'verified'
  /** Offer page was opened and the price differed — `price` holds the verified value. */
  | 'changed'
  /** Offer page could not be opened or read. Never present this as a final price. */
  | 'unverified';

export interface BaggageInfo {
  /** Free text as shown by the source, e.g. "1 personal item". */
  description?: string;
  cabinBagIncluded?: boolean;
  checkedBagIncluded?: boolean;
  /** Extra cost of adding a checked bag, when the source states it. */
  checkedBagFee?: number;
}

/** Standardised result shape produced by every provider (spec §13). */
export interface FlightResult {
  airline: string;
  flightNumber?: string;

  origin: AirportRef;
  destination: AirportRef;

  /** ISO YYYY-MM-DD. */
  departureDate: string;
  /** ISO YYYY-MM-DD. Absent for one-way. */
  returnDate?: string;

  /** Local 24h "HH:MM". */
  departureTime: string;
  /** Local 24h "HH:MM". May carry a "+1" day marker, e.g. "07:15+1". */
  arrivalTime: string;

  /** Human readable, e.g. "2h 20min". */
  duration: string;
  /** Total duration in minutes, for sorting. */
  durationMinutes?: number;
  /** Stops on the outbound leg. */
  stops: number;
  /** Stops on the return leg, when round-trip. */
  returnStops?: number;

  /** Total price for the whole booking as displayed. See `priceIsPerPerson`. */
  price: number;
  currency: string;
  /** True when `price` is per traveller rather than for the whole party. */
  priceIsPerPerson: boolean;
  /** Price for the whole party, derived. Always populated by `normaliseResult`. */
  totalPrice: number;
  /** Whether the source states taxes and fees are included. `undefined` = not stated. */
  taxesIncluded?: boolean;

  baggage?: BaggageInfo;
  cabinClass?: CabinClass;

  source: string;
  bookingUrl: string;
  /** Set when `bookingUrl` is a search URL rather than a direct offer link. */
  bookingUrlIsSearch?: boolean;

  priceConfidence: PriceConfidence;
  /** Price shown in search results before verification, when it differed. */
  listedPrice?: number;
  /** ISO 8601 timestamp of when the price was last read. */
  verifiedAt: string;

  /** Free-form provider notes (e.g. "self-transfer", "hidden city"). */
  notes?: string[];
}

/** What a provider returns for one search task, including failures. */
export interface SearchOutcome {
  source: string;
  results: FlightResult[];
  /** Present when the provider failed or was blocked. */
  error?: { kind: string; message: string; userMessage: string };
  /** URL that reproduces this search, kept even on failure so the user can continue manually. */
  searchUrl?: string;
  durationMs: number;
}

export interface NormaliseOptions {
  passengers: number;
  source: string;
}

/**
 * Fills in the derived fields (`totalPrice`, `durationMinutes`, `verifiedAt`) and clamps values
 * into their documented ranges, so downstream comparison never has to special-case a provider.
 */
export function normaliseResult(
  partial: Omit<FlightResult, 'totalPrice' | 'verifiedAt' | 'priceConfidence'> &
    Partial<Pick<FlightResult, 'totalPrice' | 'verifiedAt' | 'priceConfidence'>>,
  options: NormaliseOptions,
): FlightResult {
  const priceIsPerPerson = partial.priceIsPerPerson;
  const totalPrice =
    partial.totalPrice ?? (priceIsPerPerson ? round2(partial.price * options.passengers) : partial.price);

  return {
    ...partial,
    source: partial.source || options.source,
    totalPrice,
    durationMinutes: partial.durationMinutes ?? parseDurationMinutes(partial.duration),
    priceConfidence: partial.priceConfidence ?? 'listed',
    verifiedAt: partial.verifiedAt ?? new Date().toISOString(),
    origin: { ...partial.origin, airport: partial.origin.airport.toUpperCase() },
    destination: { ...partial.destination, airport: partial.destination.airport.toUpperCase() },
  };
}

/** Price per traveller, for display. */
export function pricePerPerson(result: FlightResult, passengers: number): number {
  return round2(result.totalPrice / Math.max(1, passengers));
}

/**
 * Stable identity of an itinerary across sources, so the same flight offered by Kayak and
 * Skyscanner collapses into one row. Deliberately excludes price and source.
 */
export function itineraryKey(result: FlightResult): string {
  return [
    result.origin.airport,
    result.destination.airport,
    result.departureDate,
    result.returnDate ?? 'ow',
    result.departureTime,
    result.arrivalTime,
    normaliseAirline(result.airline),
    result.stops,
  ].join('|');
}

/**
 * Reduces a carrier name to a comparable stem so the same airline written differently by two
 * sources collapses into one row. Punctuation and spacing go first — otherwise "Wizz Air" and
 * "WizzAir" strip differently, since only one of them has a word boundary before "Air".
 * Longer suffixes are listed first so "Airlines" is not eaten as "Air" + "lines".
 */
export function normaliseAirline(airline: string): string {
  return airline
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/airlines|airline|airways|air/g, '');
}

/** "2h 20min", "2 hr 20 min", "1d 3h" → minutes. Returns undefined when unparseable. */
export function parseDurationMinutes(duration: string | undefined): number | undefined {
  if (!duration) return undefined;
  const text = duration.toLowerCase();

  let minutes = 0;
  let matched = false;

  const days = text.match(/(\d+)\s*(?:d|dit[ëe]|day)/);
  if (days?.[1]) {
    minutes += Number(days[1]) * 1440;
    matched = true;
  }
  const hours = text.match(/(\d+)\s*(?:h|hr|hrs|hour|hours|or[ëe])/);
  if (hours?.[1]) {
    minutes += Number(hours[1]) * 60;
    matched = true;
  }
  const mins = text.match(/(\d+)\s*(?:m|min|mins|minute|minutes|minuta)/);
  if (mins?.[1]) {
    minutes += Number(mins[1]);
    matched = true;
  }

  if (!matched) {
    // "2:20" style
    const clock = text.match(/^(\d{1,2}):(\d{2})$/);
    if (clock?.[1] && clock[2]) return Number(clock[1]) * 60 + Number(clock[2]);
    return undefined;
  }
  return minutes;
}

export function formatDuration(minutes: number | undefined): string {
  if (minutes === undefined || !Number.isFinite(minutes)) return 'n/a';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
