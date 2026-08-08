import { InvalidRequestError } from '../errors.js';
import { isIsoDate, compareIso, todayIso } from '../utils/dates.js';

export type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';

/** How the traveller expressed their dates. Drives how many searches the agent fans out to. */
export type DateMode =
  | 'exact' // departureDate (and optionally returnDate) are fixed
  | 'flexible_range' // search anywhere inside [windowStart, windowEnd]
  | 'flexible_month' // search inside a named month
  | 'unspecified'; // nothing given — the agent must ask

export interface DateWindow {
  /** Inclusive ISO date (YYYY-MM-DD). */
  start: string;
  /** Inclusive ISO date (YYYY-MM-DD). */
  end: string;
}

/**
 * The structured search the planner produces from natural language.
 * Mirrors the schema in the spec, with a few fields added for flexible-date handling.
 */
export interface FlightRequest {
  /** IATA code or free text the airport resolver understands (e.g. "PRN", "Prishtina"). */
  origin: string;
  /** Specific destination city/airport. Mutually optional with `destinationCountry`. */
  destination?: string;
  /** ISO-3166 alpha-2 country code (e.g. "DE") when the user said only "Germany". */
  destinationCountry?: string;

  /** ISO YYYY-MM-DD. */
  departureDate?: string;
  /** ISO YYYY-MM-DD. Absent means one-way. */
  returnDate?: string;

  flexibleDates?: boolean;
  dateMode: DateMode;
  /** Window to explore when `flexibleDates` is true. */
  dateWindow?: DateWindow;
  /** Trip length in nights when the user said "for 4 days" without fixed dates. */
  tripLengthNights?: number;

  passengers: number;
  cabinClass: CabinClass;

  maxStops?: number;
  /** True when checked baggage must be included in the fare. */
  baggage?: boolean;

  /** Preferred departure time-of-day window, local time, 24h ("06:00"–"12:00"). */
  timePreference?: { earliest?: string; latest?: string };

  /** Currency the user wants prices in. */
  currency: string;
  /** Free-text of the original request, kept for logging and LLM fallbacks. */
  rawQuery?: string;
}

export const DEFAULT_CURRENCY = 'EUR';

export function createFlightRequest(partial: Partial<FlightRequest> & { origin: string }): FlightRequest {
  return {
    passengers: 1,
    cabinClass: 'economy',
    dateMode: 'unspecified',
    currency: DEFAULT_CURRENCY,
    ...partial,
  };
}

export function isRoundTrip(request: FlightRequest): boolean {
  return Boolean(request.returnDate) || (request.tripLengthNights ?? 0) > 0;
}

/** Fields the agent cannot proceed without. Used to ask the user a single targeted question. */
export type MissingField = 'origin' | 'destination' | 'dates';

export function missingFields(request: FlightRequest): MissingField[] {
  const missing: MissingField[] = [];
  if (!request.origin?.trim()) missing.push('origin');
  if (!request.destination?.trim() && !request.destinationCountry?.trim()) missing.push('destination');
  if (request.dateMode === 'unspecified' && !request.departureDate) missing.push('dates');
  return missing;
}

export const MISSING_FIELD_QUESTIONS: Record<MissingField, string> = {
  origin: 'Nga cili qytet/aeroport dëshiron të niseni?',
  destination: 'Për ku dëshironi të fluturoni? (qytet ose shtet)',
  dates: 'Për cilën datë ose periudhë? (p.sh. "15 shtator", "gjatë shtatorit", "muajin tjetër")',
};

/**
 * Validates internal consistency. Throws `InvalidRequestError` for anything the user must fix;
 * returns the (unchanged) request otherwise so it can be used inline.
 */
export function validateFlightRequest(request: FlightRequest, today = todayIso()): FlightRequest {
  if (!request.origin?.trim()) {
    throw new InvalidRequestError('Origjina mungon.');
  }
  if (!Number.isInteger(request.passengers) || request.passengers < 1 || request.passengers > 9) {
    throw new InvalidRequestError(`Numri i udhëtarëve duhet të jetë 1–9, u dha: ${request.passengers}.`);
  }
  if (request.maxStops !== undefined && (request.maxStops < 0 || !Number.isInteger(request.maxStops))) {
    throw new InvalidRequestError(`maxStops duhet të jetë numër i plotë >= 0, u dha: ${request.maxStops}.`);
  }

  for (const [label, value] of [
    ['departureDate', request.departureDate],
    ['returnDate', request.returnDate],
  ] as const) {
    if (value !== undefined && !isIsoDate(value)) {
      throw new InvalidRequestError(`${label} duhet të jetë ISO YYYY-MM-DD, u dha: "${value}".`);
    }
  }

  if (request.departureDate && compareIso(request.departureDate, today) < 0) {
    throw new InvalidRequestError(`Data e nisjes (${request.departureDate}) është në të kaluarën.`);
  }
  if (request.returnDate && request.departureDate && compareIso(request.returnDate, request.departureDate) < 0) {
    throw new InvalidRequestError(
      `Data e kthimit (${request.returnDate}) është para datës së nisjes (${request.departureDate}).`,
    );
  }
  if (request.dateWindow) {
    const { start, end } = request.dateWindow;
    if (!isIsoDate(start) || !isIsoDate(end)) {
      throw new InvalidRequestError(`Dritarja e datave është e pavlefshme: ${start}..${end}.`);
    }
    if (compareIso(end, start) < 0) {
      throw new InvalidRequestError(`Dritarja e datave mbaron para se të fillojë: ${start}..${end}.`);
    }
  }
  if (request.tripLengthNights !== undefined && request.tripLengthNights < 0) {
    throw new InvalidRequestError(`Kohëzgjatja e udhëtimit nuk mund të jetë negative.`);
  }

  return request;
}

/** Compact one-line summary used in logs and in the "searching…" line of the CLI. */
export function describeRequest(request: FlightRequest): string {
  const dest = request.destination ?? request.destinationCountry ?? '?';
  const dates =
    request.dateMode === 'exact'
      ? `${request.departureDate}${request.returnDate ? ` → ${request.returnDate}` : ' (one-way)'}`
      : request.dateWindow
        ? `fleksibël ${request.dateWindow.start}..${request.dateWindow.end}` +
          (request.tripLengthNights ? ` / ${request.tripLengthNights} netë` : '')
        : 'data të papërcaktuara';

  const bits = [
    `${request.origin} → ${dest}`,
    dates,
    `${request.passengers} pax`,
    request.cabinClass,
  ];
  if (request.maxStops === 0) bits.push('vetëm direkt');
  if (request.baggage) bits.push('me bagazh');
  return bits.join(' | ');
}
