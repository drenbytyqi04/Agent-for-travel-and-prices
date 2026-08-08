import { AgentError } from '../errors.js';
import { isRoundTrip, type FlightRequest } from '../models/flight-request.js';
import { airportsInCountry, resolveAirports, type Airport } from '../utils/airports.js';
import { expandDateWindow, type DatePair } from '../utils/dates.js';

/**
 * Turning one `FlightRequest` into the concrete (airport, date-pair) searches it implies.
 *
 * Kept free of any browser or provider import on purpose: the browser agent and the web deep-link
 * builder both need this expansion, and the web side runs in a serverless function where pulling
 * in Playwright would be both impossible and pointless.
 */

export interface ExpansionOptions {
  /** Max destination airports to produce when the user named a country. */
  maxDestinations?: number;
  /** Max date pairs to produce when dates are flexible. */
  maxDatePairs?: number;
  /** Default nights away when a round trip is implied without a length. */
  defaultNights?: number;
}

export interface Expansion {
  destinations: Airport[];
  datePairs: DatePair[];
  /** Assumptions worth showing the user. */
  notes: string[];
}

export function expandRequest(request: FlightRequest, options: ExpansionOptions = {}): Expansion {
  const notes: string[] = [];
  return {
    destinations: expandDestinations(request, notes, options),
    datePairs: expandDatePairs(request, notes, options),
    notes,
  };
}

/** Expands "Germany" into the airports to actually search (spec §7). */
export function expandDestinations(
  request: FlightRequest,
  notes: string[],
  options: ExpansionOptions = {},
): Airport[] {
  if (request.destination) {
    const matches = resolveAirports(request.destination);
    if (matches.length === 0) {
      throw new AgentError('invalid_airport', `Destinacioni "${request.destination}" nuk u njoh.`, {
        retryable: false,
      });
    }

    // A multi-airport city (London, Istanbul) is worth searching in full — the price gap is large.
    const sameCity = matches.filter((airport) => airport.city === matches[0]!.city);
    if (sameCity.length > 1) {
      notes.push(`${matches[0]!.city} ka ${sameCity.length} aeroporte — po i krahasoj të gjitha.`);
    }
    return sameCity.slice(0, options.maxDestinations ?? 4);
  }

  if (request.destinationCountry) {
    const airports = airportsInCountry(request.destinationCountry, options.maxDestinations ?? 6);
    if (airports.length === 0) {
      throw new AgentError('invalid_airport', `Nuk njoh aeroporte për shtetin "${request.destinationCountry}".`, {
        retryable: false,
      });
    }
    notes.push(
      `Po krahasoj ${airports.length} aeroporte: ${airports.map((a) => `${a.city} (${a.iata})`).join(', ')}.`,
    );
    return airports;
  }

  throw new AgentError('invalid_request', 'Destinacioni mungon.', { retryable: false });
}

/** Expands a flexible window into the date pairs to search (spec §8). */
export function expandDatePairs(
  request: FlightRequest,
  notes: string[],
  options: ExpansionOptions = {},
): DatePair[] {
  if (request.dateMode === 'exact' && request.departureDate) {
    return [{ departureDate: request.departureDate, returnDate: request.returnDate }];
  }

  if (request.dateWindow) {
    const nights = request.tripLengthNights ?? (isRoundTrip(request) ? options.defaultNights ?? 5 : 0);
    const pairs = expandDateWindow({
      start: request.dateWindow.start,
      end: request.dateWindow.end,
      tripLengthNights: nights,
      maxSamples: options.maxDatePairs ?? 5,
    });
    notes.push(
      `Data fleksibile: po provoj ${pairs.length} kombinime midis ${request.dateWindow.start} dhe ${request.dateWindow.end}.`,
    );
    return pairs;
  }

  if (request.departureDate) {
    return [{ departureDate: request.departureDate, returnDate: request.returnDate }];
  }

  throw new AgentError('invalid_date', 'Nuk ka datë ose periudhë për të kërkuar.', { retryable: false });
}
