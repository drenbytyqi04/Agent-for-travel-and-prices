import { describe, expect, it } from 'vitest';
import {
  buildGoogleFlightsUrl,
  buildKayakUrl,
  buildMomondoUrl,
  buildSkyscannerUrl,
  buildWizzAirUrl,
  cleanUrl,
  isHomepageUrl,
  toYymmdd,
} from '../src/utils/url-builder.js';
import type { SearchUrlParams } from '../src/utils/url-builder.js';

const roundTrip: SearchUrlParams = {
  originIata: 'PRN',
  destinationIata: 'BER',
  departureDate: '2026-09-15',
  returnDate: '2026-09-20',
  passengers: 1,
  cabinClass: 'economy',
  currency: 'EUR',
};

const oneWay: SearchUrlParams = { ...roundTrip, returnDate: undefined };

describe('buildGoogleFlightsUrl', () => {
  it('encodes the whole search in the q parameter', () => {
    const url = new URL(buildGoogleFlightsUrl(roundTrip));
    expect(url.host).toBe('www.google.com');
    expect(url.pathname).toBe('/travel/flights');

    const q = url.searchParams.get('q')!;
    expect(q).toContain('from PRN');
    expect(q).toContain('to BER');
    expect(q).toContain('on 2026-09-15');
    expect(q).toContain('through 2026-09-20');
    expect(url.searchParams.get('curr')).toBe('EUR');
  });

  it('marks one-way trips explicitly', () => {
    const q = new URL(buildGoogleFlightsUrl(oneWay)).searchParams.get('q')!;
    expect(q).toContain('one way');
    expect(q).not.toContain('through');
  });

  it('carries passengers, cabin class and the nonstop filter', () => {
    const q = new URL(
      buildGoogleFlightsUrl({ ...roundTrip, passengers: 3, cabinClass: 'business', maxStops: 0 }),
    ).searchParams.get('q')!;

    expect(q).toContain('3 adults');
    expect(q).toContain('business');
    expect(q).toContain('nonstop');
  });
});

describe('buildKayakUrl', () => {
  it('uses the path form with both dates', () => {
    const url = buildKayakUrl(roundTrip);
    expect(url).toContain('/flights/PRN-BER/2026-09-15/2026-09-20/1adults');
    expect(url).toContain('sort=price_a');
  });

  it('omits the return date for one-way', () => {
    expect(buildKayakUrl(oneWay)).toContain('/flights/PRN-BER/2026-09-15/1adults');
  });

  it('appends cabin class only when it is not economy', () => {
    expect(buildKayakUrl(roundTrip)).not.toContain('/economy');
    expect(buildKayakUrl({ ...roundTrip, cabinClass: 'business' })).toContain('/business');
  });

  it('adds the nonstop filter', () => {
    expect(buildKayakUrl({ ...roundTrip, maxStops: 0 })).toContain('fs=stops%3D0');
  });
});

describe('buildMomondoUrl', () => {
  it('uses the flight-search path prefix', () => {
    expect(buildMomondoUrl(roundTrip)).toContain('momondo.com/flight-search/PRN-BER/2026-09-15/2026-09-20');
  });
});

describe('buildSkyscannerUrl', () => {
  it('lowercases IATA codes and uses YYMMDD dates', () => {
    const url = buildSkyscannerUrl(roundTrip);
    expect(url).toContain('/transport/flights/prn/ber/260915/260920/');
  });

  it('sets the round-trip flag and passenger count', () => {
    const url = new URL(buildSkyscannerUrl(roundTrip));
    expect(url.searchParams.get('rtn')).toBe('1');
    expect(url.searchParams.get('adults')).toBe('1');
    expect(new URL(buildSkyscannerUrl(oneWay)).searchParams.get('rtn')).toBe('0');
  });

  it('maps cabin class to Skyscanner’s spelling', () => {
    const url = new URL(buildSkyscannerUrl({ ...roundTrip, cabinClass: 'premium_economy' }));
    expect(url.searchParams.get('cabinclass')).toBe('premiumeconomy');
  });

  it('sets preferdirects for nonstop searches', () => {
    expect(new URL(buildSkyscannerUrl({ ...roundTrip, maxStops: 0 })).searchParams.get('preferdirects')).toBe('true');
  });
});

describe('buildWizzAirUrl', () => {
  it('builds the select-flight deep link', () => {
    expect(buildWizzAirUrl(roundTrip)).toBe(
      'https://wizzair.com/en-gb/booking/select-flight/PRN/BER/2026-09-15/2026-09-20/1/0/0/null',
    );
  });

  it('uses the null placeholder for one-way', () => {
    expect(buildWizzAirUrl(oneWay)).toContain('/2026-09-15/null/1/0/0/null');
  });
});

describe('url helpers', () => {
  it('converts ISO dates to YYMMDD', () => {
    expect(toYymmdd('2026-09-15')).toBe('260915');
  });

  it('identifies bare homepages, which are never valid booking links', () => {
    expect(isHomepageUrl('https://wizzair.com/')).toBe(true);
    expect(isHomepageUrl('https://wizzair.com')).toBe(true);
    expect(isHomepageUrl('https://wizzair.com/en-gb/booking/select-flight/PRN/BER')).toBe(false);
    expect(isHomepageUrl('https://google.com/?q=x')).toBe(false);
    expect(isHomepageUrl('not a url')).toBe(true);
  });

  it('strips tracking parameters but keeps search parameters', () => {
    const cleaned = cleanUrl('https://example.com/x?utm_source=a&gclid=b&q=berlin');
    expect(cleaned).toContain('q=berlin');
    expect(cleaned).not.toContain('utm_source');
    expect(cleaned).not.toContain('gclid');
  });

  it('leaves unparseable input untouched', () => {
    expect(cleanUrl('::::')).toBe('::::');
  });
});
