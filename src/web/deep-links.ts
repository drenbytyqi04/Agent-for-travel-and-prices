import { expandRequest, type ExpansionOptions } from '../agent/search-plan.js';
import type { FlightRequest } from '../models/flight-request.js';
import { resolveAirport, type Airport } from '../utils/airports.js';
import {
  buildGoogleFlightsUrl,
  buildKayakUrl,
  buildMomondoUrl,
  buildSkyscannerUrl,
  buildWizzAirUrl,
  type SearchUrlParams,
} from '../utils/url-builder.js';
import { servesRoute, WIZZ_PRN_ROUTES } from '../utils/airline-routes.js';
import { formatDateSq } from '../utils/dates.js';

/**
 * Deep links for every (airport, date-pair) the request expands to.
 *
 * This is the half of the agent that needs no browser: it understands the request, works out
 * which airports and dates are worth checking, and hands back URLs that reproduce each search
 * exactly. It powers the hosted web app, where running a real browser is not possible — and it is
 * the same URL construction the browser agent navigates to, so the two never drift apart.
 */

export interface DeepLink {
  source: string;
  name: string;
  url: string;
}

export interface RouteOption {
  origin: { iata: string; city: string };
  destination: { iata: string; city: string; country: string };
  departureDate: string;
  departureLabel: string;
  returnDate?: string;
  returnLabel?: string;
  links: DeepLink[];
}

export interface DeepLinkResult {
  routes: RouteOption[];
  notes: string[];
  /** Human-readable read-back of the request, using resolved airport and date names. */
  summary: string;
}

export function buildDeepLinks(request: FlightRequest, options: ExpansionOptions = {}): DeepLinkResult {
  const origin = resolveAirport(request.origin);
  const { destinations, datePairs, notes } = expandRequest(request, options);

  const routes: RouteOption[] = [];
  for (const destination of destinations) {
    if (destination.iata === origin.iata) continue;

    for (const pair of datePairs) {
      const params: SearchUrlParams = {
        originIata: origin.iata,
        destinationIata: destination.iata,
        departureDate: pair.departureDate,
        returnDate: pair.returnDate,
        passengers: request.passengers,
        cabinClass: request.cabinClass,
        currency: request.currency,
        maxStops: request.maxStops,
      };

      routes.push({
        origin: { iata: origin.iata, city: origin.city },
        destination: { iata: destination.iata, city: destination.city, country: destination.countryName },
        departureDate: pair.departureDate,
        departureLabel: formatDateSq(pair.departureDate),
        returnDate: pair.returnDate,
        returnLabel: pair.returnDate ? formatDateSq(pair.returnDate) : undefined,
        links: linksFor(params, origin, destination),
      });
    }
  }

  return { routes, notes, summary: summariseRequest(request, destinations) };
}

function linksFor(params: SearchUrlParams, origin: Airport, destination: Airport): DeepLink[] {
  const links: DeepLink[] = [
    { source: 'google_flights', name: 'Google Flights', url: buildGoogleFlightsUrl(params) },
    { source: 'skyscanner', name: 'Skyscanner', url: buildSkyscannerUrl(params) },
    { source: 'kayak', name: 'Kayak', url: buildKayakUrl(params) },
    { source: 'momondo', name: 'Momondo', url: buildMomondoUrl(params) },
  ];

  // Only offer the airline's own site for a route it actually flies — a dead link helps nobody.
  if (servesRoute(WIZZ_PRN_ROUTES, origin.iata, destination.iata)) {
    links.push({ source: 'wizzair', name: 'Wizz Air', url: buildWizzAirUrl(params) });
  }
  return links;
}

const CABIN_LABELS: Record<string, string> = {
  economy: 'economy',
  premium_economy: 'premium economy',
  business: 'business',
  first: 'klasa e parë',
};

/**
 * One-sentence read-back of the request in the user's own terms.
 *
 * Distinct from `describeRequest`, which is a compact log line: this resolves airports to their
 * real names and dates to Albanian, so the reader can immediately spot a misreading.
 */
export function summariseRequest(request: FlightRequest, destinations: Airport[]): string {
  const origin = resolveAirport(request.origin);
  const where =
    destinations.length === 1
      ? `${destinations[0]!.city} (${destinations[0]!.iata})`
      : `${destinations.length} aeroporte në ${destinations[0]?.countryName ?? 'destinacion'}`;

  const parts = [`${origin.city} (${origin.iata}) → ${where}`];

  if (request.dateMode === 'exact' && request.departureDate) {
    parts.push(
      request.returnDate
        ? `${formatDateSq(request.departureDate)} → ${formatDateSq(request.returnDate)}`
        : `${formatDateSq(request.departureDate)}, one-way`,
    );
  } else if (request.dateWindow) {
    const nights = request.tripLengthNights ? `, ${request.tripLengthNights} netë` : '';
    parts.push(`data fleksibile ${formatDateSq(request.dateWindow.start)} – ${formatDateSq(request.dateWindow.end)}${nights}`);
  }

  parts.push(request.passengers === 1 ? '1 udhëtar' : `${request.passengers} udhëtarë`);
  parts.push(CABIN_LABELS[request.cabinClass] ?? request.cabinClass);
  if (request.maxStops === 0) parts.push('vetëm direkt');
  if (request.baggage === true) parts.push('me bagazh');
  if (request.baggage === false) parts.push('pa bagazh');

  return parts.join(' · ');
}

/** Compact, JSON-friendly view of how the request was understood, for the web UI. */
export function describeInterpretation(request: FlightRequest): Record<string, unknown> {
  return {
    origin: request.origin,
    destination: request.destination ?? null,
    destinationCountry: request.destinationCountry ?? null,
    departureDate: request.departureDate ?? null,
    returnDate: request.returnDate ?? null,
    dateMode: request.dateMode,
    dateWindow: request.dateWindow ?? null,
    tripLengthNights: request.tripLengthNights ?? null,
    passengers: request.passengers,
    cabinClass: request.cabinClass,
    maxStops: request.maxStops ?? null,
    baggage: request.baggage ?? null,
    currency: request.currency,
  };
}
