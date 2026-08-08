import { describe, expect, it } from 'vitest';
import { parseGoogleCard } from '../src/providers/google-flights.js';
import { parseKayakCard } from '../src/providers/kayak.js';
import { parseSkyscannerCard } from '../src/providers/skyscanner.js';
import { parseAirlineCard } from '../src/providers/airline-sites.js';
import { WizzAirProvider } from '../src/providers/airline-sites.js';
import { createDefaultRegistry, createMockRegistry } from '../src/providers/index.js';
import type { SearchTask } from '../src/providers/provider.js';
import type { RawCard } from '../src/providers/parse-helpers.js';
import { createFlightRequest } from '../src/models/flight-request.js';

const task: SearchTask = {
  originIata: 'PRN',
  destinationIata: 'BER',
  departureDate: '2026-09-15',
  returnDate: '2026-09-20',
  passengers: 2,
  cabinClass: 'economy',
  currency: 'EUR',
};

const SEARCH_URL = 'https://example.com/search?from=PRN&to=BER';

function card(text: string, extras: Partial<RawCard> = {}): RawCard {
  return { text, ariaLabels: [], ...extras };
}

describe('parseGoogleCard', () => {
  it('parses a card from its visible text', () => {
    const result = parseGoogleCard(
      card('6:20 AM – 8:40 AM\nWizz Air\n2 hr 20 min\nPRN–BER\nNonstop\n€89\nround trip'),
      task,
      SEARCH_URL,
    )!;

    expect(result.airline).toBe('Wizz Air');
    expect(result.departureTime).toBe('06:20');
    expect(result.stops).toBe(0);
    expect(result.price).toBe(89);
    // Google quotes round-trip fares per traveller — the total must reflect the party size.
    expect(result.priceIsPerPerson).toBe(true);
    expect(result.totalPrice).toBe(178);
  });

  it('falls back to the aria-label when the visible text is unhelpful', () => {
    const result = parseGoogleCard(
      card('€89', {
        ariaLabels: [
          'From 89 euros round trip. Nonstop flight with Wizz Air. Leaves Pristina at 6:20 AM and arrives at Berlin Brandenburg Airport at 8:40 AM. Total duration 2 hr 20 min.',
        ],
      }),
      task,
      SEARCH_URL,
    )!;

    expect(result.departureTime).toBe('06:20');
    expect(result.arrivalTime).toBe('08:40');
    expect(result.airline).toBe('Wizz Air');
    expect(result.stops).toBe(0);
  });

  it('carries the request dates onto the result', () => {
    const result = parseGoogleCard(card('06:20 – 08:40\nWizz Air\nNonstop\n€89'), task, SEARCH_URL)!;
    expect(result.departureDate).toBe('2026-09-15');
    expect(result.returnDate).toBe('2026-09-20');
  });

  it('flags a search URL as such when the card has no offer link', () => {
    const result = parseGoogleCard(card('06:20 – 08:40\nWizz Air\nNonstop\n€89'), task, SEARCH_URL)!;
    expect(result.bookingUrl).toBe(SEARCH_URL);
    expect(result.bookingUrlIsSearch).toBe(true);
  });

  it('prefers a real offer link when one is present', () => {
    const result = parseGoogleCard(
      card('06:20 – 08:40\nWizz Air\nNonstop\n€89', { href: '/travel/clk?abc=1' }),
      task,
      SEARCH_URL,
    )!;
    expect(result.bookingUrl).toContain('/travel/clk');
    expect(result.bookingUrlIsSearch).toBe(false);
  });

  it('returns undefined rather than a half-built result', () => {
    expect(parseGoogleCard(card('Sponsored\nAd'), task, SEARCH_URL)).toBeUndefined();
    expect(parseGoogleCard(card('06:20 – 08:40\nWizz Air'), task, SEARCH_URL)).toBeUndefined(); // no price
  });
});

describe('parseKayakCard', () => {
  it('reads outbound and return legs separately', () => {
    const result = parseKayakCard(
      card('06:20 – 08:40\nWizz Air\n2h 20m\nnonstop\nPRN-BER\n\n19:05 – 21:25\nWizz Air\n2h 20m\n1 stop\nBER-PRN\n€178\nper person'),
      task,
      SEARCH_URL,
      'kayak',
    )!;

    expect(result.departureTime).toBe('06:20');
    expect(result.stops).toBe(0);
    expect(result.returnStops).toBe(1);
    expect(result.source).toBe('kayak');
  });

  it('respects an explicit per-person marker', () => {
    const result = parseKayakCard(card('06:20 – 08:40\nWizz Air\nnonstop\n€89 per person'), task, SEARCH_URL, 'kayak')!;
    expect(result.priceIsPerPerson).toBe(true);
    expect(result.totalPrice).toBe(178);
  });

  it('respects an explicit total marker', () => {
    const result = parseKayakCard(card('06:20 – 08:40\nWizz Air\nnonstop\n€178 total'), task, SEARCH_URL, 'kayak')!;
    expect(result.priceIsPerPerson).toBe(false);
    expect(result.totalPrice).toBe(178);
  });

  it('captures the deal link when the card has one', () => {
    const result = parseKayakCard(
      card('06:20 – 08:40\nWizz Air\nnonstop\n€89', { href: 'https://www.kayak.com/book/xyz' }),
      task,
      SEARCH_URL,
      'kayak',
    )!;
    expect(result.bookingUrl).toContain('/book/xyz');
    expect(result.bookingUrlIsSearch).toBe(false);
  });
});

describe('parseSkyscannerCard', () => {
  it('assumes per-person, taxes-included pricing unless told otherwise', () => {
    const result = parseSkyscannerCard(card('06:20 – 08:40\nWizz Air\nDirect\n2h 20m\n€89'), task, SEARCH_URL)!;

    expect(result.priceIsPerPerson).toBe(true);
    expect(result.taxesIncluded).toBe(true);
    expect(result.totalPrice).toBe(178);
    expect(result.source).toBe('skyscanner');
  });

  it('lets the card override the assumption', () => {
    const result = parseSkyscannerCard(
      card('06:20 – 08:40\nWizz Air\nDirect\n€178 total\nplus taxes'),
      task,
      SEARCH_URL,
    )!;
    expect(result.priceIsPerPerson).toBe(false);
    expect(result.taxesIncluded).toBe(false);
  });
});

describe('parseAirlineCard', () => {
  it('treats an airline-site price as the whole booking and already verified', () => {
    const result = parseAirlineCard(
      card('06:20 – 08:40\n2h 20min\nDirekt\n€178'),
      task,
      'https://wizzair.com/en-gb/booking/select-flight/PRN/BER/2026-09-15/2026-09-20/2/0/0/null',
      'wizzair',
      'Wizz Air',
    )!;

    expect(result.airline).toBe('Wizz Air');
    expect(result.priceIsPerPerson).toBe(false);
    expect(result.totalPrice).toBe(178);
    expect(result.priceConfidence).toBe('verified');
    expect(result.bookingUrlIsSearch).toBe(false);
    expect(result.notes?.[0]).toContain('kompanisë ajrore');
  });
});

describe('WizzAirProvider route coverage', () => {
  const provider = new WizzAirProvider();

  it('recognises routes it operates, in either direction', () => {
    expect(provider.servesRoute('PRN', 'BER')).toBe(true);
    expect(provider.servesRoute('BER', 'PRN')).toBe(true);
    expect(provider.servesRoute('PRN', 'DTM')).toBe(true);
  });

  it('rejects routes it does not fly', () => {
    expect(provider.servesRoute('PRN', 'JFK')).toBe(false);
    expect(provider.servesRoute('TIA', 'BER')).toBe(false);
  });

  it('opts out of requests it cannot serve', () => {
    expect(provider.supports(createFlightRequest({ origin: 'PRN', destination: 'Berlin' }))).toBe(true);
    expect(provider.supports(createFlightRequest({ origin: 'PRN', destination: 'New York' }))).toBe(false);
    // Country-wide searches are accepted; the per-task check filters the specific routes.
    expect(provider.supports(createFlightRequest({ origin: 'PRN', destinationCountry: 'DE' }))).toBe(true);
  });
});

describe('provider registry', () => {
  it('orders live providers by priority, Google Flights first', () => {
    expect(createDefaultRegistry().ids()).toEqual(['google_flights', 'skyscanner', 'kayak', 'momondo', 'wizzair']);
  });

  it('filters by only and exclude', () => {
    const registry = createDefaultRegistry();
    const request = createFlightRequest({ origin: 'PRN', destination: 'Berlin' });

    expect(registry.select(request, { only: ['kayak', 'momondo'] }).map((p) => p.id)).toEqual(['kayak', 'momondo']);
    expect(registry.select(request, { exclude: ['google_flights'] }).map((p) => p.id)).not.toContain('google_flights');
  });

  it('drops providers that declare they cannot serve the request', () => {
    const registry = createDefaultRegistry();
    const ids = registry.select(createFlightRequest({ origin: 'PRN', destination: 'New York' })).map((p) => p.id);
    expect(ids).not.toContain('wizzair');
  });

  it('exposes every provider’s capabilities and a non-homepage search URL', () => {
    for (const provider of createDefaultRegistry().all()) {
      expect(provider.capabilities).toBeDefined();
      const url = provider.buildSearchUrl(task);
      expect(url).toMatch(/^https:\/\//);
      expect(new URL(url).pathname.length).toBeGreaterThan(1);
    }
  });

  it('keeps the mock registry separate from the live one', () => {
    expect(createMockRegistry().ids()).toEqual(['mock']);
  });
});
