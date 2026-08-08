import type { CabinClass } from '../models/flight-request.js';

/**
 * Deep-link builders for every supported source.
 *
 * These serve two purposes: they are how providers navigate (URL-first is far more reliable than
 * driving a date picker), and they are the fallback `bookingUrl` when an offer link cannot be
 * captured — spec §9 requires a URL that reproduces the exact search, never a bare homepage.
 */

export interface SearchUrlParams {
  originIata: string;
  destinationIata: string;
  /** ISO YYYY-MM-DD. */
  departureDate: string;
  /** ISO YYYY-MM-DD. Omit for one-way. */
  returnDate?: string;
  passengers: number;
  cabinClass: CabinClass;
  currency?: string;
  /** 0 = nonstop only. */
  maxStops?: number;
  locale?: string;
}

const CABIN_GOOGLE: Record<CabinClass, string> = {
  economy: 'economy',
  premium_economy: 'premium economy',
  business: 'business',
  first: 'first',
};

const CABIN_KAYAK: Record<CabinClass, string> = {
  economy: 'economy',
  premium_economy: 'premium',
  business: 'business',
  first: 'first',
};

const CABIN_SKYSCANNER: Record<CabinClass, string> = {
  economy: 'economy',
  premium_economy: 'premiumeconomy',
  business: 'business',
  first: 'first',
};

/**
 * Google Flights is driven through its natural-language `q` parameter. The alternative is the
 * `tfs` protobuf blob, which is undocumented and breaks silently when Google reorders fields;
 * the `q` form is stable and Google resolves it into a fully-specified search.
 */
export function buildGoogleFlightsUrl(params: SearchUrlParams): string {
  const parts = [
    'Flights',
    `from ${params.originIata}`,
    `to ${params.destinationIata}`,
    `on ${params.departureDate}`,
  ];
  if (params.returnDate) parts.push(`through ${params.returnDate}`);
  else parts.push('one way');
  if (params.passengers > 1) parts.push(`${params.passengers} adults`);
  if (params.cabinClass !== 'economy') parts.push(CABIN_GOOGLE[params.cabinClass]);
  if (params.maxStops === 0) parts.push('nonstop');

  const url = new URL('https://www.google.com/travel/flights');
  url.searchParams.set('q', parts.join(' '));
  url.searchParams.set('curr', params.currency ?? 'EUR');
  url.searchParams.set('hl', params.locale ?? 'en');
  url.searchParams.set('gl', 'DE');
  return url.toString();
}

/** Kayak path form: /flights/PRN-BER/2026-09-15/2026-09-20/1adults/economy */
export function buildKayakUrl(params: SearchUrlParams): string {
  const segments = [
    'flights',
    `${params.originIata}-${params.destinationIata}`,
    params.departureDate,
  ];
  if (params.returnDate) segments.push(params.returnDate);
  segments.push(`${params.passengers}adults`);
  if (params.cabinClass !== 'economy') segments.push(CABIN_KAYAK[params.cabinClass]);

  const url = new URL(`https://www.kayak.com/${segments.join('/')}`);
  url.searchParams.set('sort', 'price_a');
  if (params.currency) url.searchParams.set('currency', params.currency);
  if (params.maxStops === 0) url.searchParams.set('fs', 'stops=0');
  else if (params.maxStops === 1) url.searchParams.set('fs', 'stops=-2');
  return url.toString();
}

/** Momondo runs the same engine as Kayak but with a `/flight-search/` prefix. */
export function buildMomondoUrl(params: SearchUrlParams): string {
  const segments = ['flight-search', `${params.originIata}-${params.destinationIata}`, params.departureDate];
  if (params.returnDate) segments.push(params.returnDate);
  segments.push(`${params.passengers}adults`);
  if (params.cabinClass !== 'economy') segments.push(CABIN_KAYAK[params.cabinClass]);

  const url = new URL(`https://www.momondo.com/${segments.join('/')}`);
  url.searchParams.set('sort', 'price_a');
  if (params.maxStops === 0) url.searchParams.set('fs', 'stops=0');
  return url.toString();
}

/** Skyscanner uses lowercase IATA and YYMMDD dates. */
export function buildSkyscannerUrl(params: SearchUrlParams): string {
  const segments = [
    'transport',
    'flights',
    params.originIata.toLowerCase(),
    params.destinationIata.toLowerCase(),
    toYymmdd(params.departureDate),
  ];
  if (params.returnDate) segments.push(toYymmdd(params.returnDate));

  const url = new URL(`https://www.skyscanner.net/${segments.join('/')}/`);
  url.searchParams.set('adults', String(params.passengers));
  url.searchParams.set('adultsv2', String(params.passengers));
  url.searchParams.set('cabinclass', CABIN_SKYSCANNER[params.cabinClass]);
  url.searchParams.set('rtn', params.returnDate ? '1' : '0');
  url.searchParams.set('preferdirects', params.maxStops === 0 ? 'true' : 'false');
  if (params.currency) url.searchParams.set('currency', params.currency);
  url.searchParams.set('locale', 'en-GB');
  url.searchParams.set('market', 'DE');
  return url.toString();
}

/** Wizz Air deep link: /booking/select-flight/PRN/BER/2026-09-15/2026-09-20/1/0/0/null */
export function buildWizzAirUrl(params: SearchUrlParams): string {
  const segments = [
    'en-gb',
    'booking',
    'select-flight',
    params.originIata,
    params.destinationIata,
    params.departureDate,
    params.returnDate ?? 'null',
    String(params.passengers),
    '0',
    '0',
    'null',
  ];
  return `https://wizzair.com/${segments.join('/')}`;
}

export function toYymmdd(iso: string): string {
  return iso.slice(2).replace(/-/g, '');
}

/** Absolutises a possibly-relative href captured from a page. Returns undefined on garbage. */
export function absoluteUrl(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

/** True when the URL is a bare homepage — spec §9 forbids returning these as booking links. */
export function isHomepageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.pathname === '/' || parsed.pathname === '') && !parsed.search;
  } catch {
    return true;
  }
}

/** Strips tracking noise so identical offers from one source compare equal. */
export function cleanUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|_ga|msclkid)/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
