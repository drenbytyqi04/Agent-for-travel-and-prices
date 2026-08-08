import { describe, expect, it } from 'vitest';
import { cheapestByCity, cheapestByDates, compareResults } from '../src/agent/price-comparator.js';
import { createFlightRequest, type FlightRequest } from '../src/models/flight-request.js';
import { normaliseResult, type FlightResult } from '../src/models/flight-result.js';

function result(overrides: Partial<FlightResult> & { price: number }, passengers = 1): FlightResult {
  return normaliseResult(
    {
      airline: 'Wizz Air',
      origin: { airport: 'PRN', city: 'Prishtinë' },
      destination: { airport: 'BER', city: 'Berlin' },
      departureDate: '2026-09-15',
      departureTime: '06:20',
      arrivalTime: '08:40',
      duration: '2h 20min',
      stops: 0,
      currency: 'EUR',
      priceIsPerPerson: false,
      source: 'google_flights',
      bookingUrl: 'https://example.com/offer',
      ...overrides,
    },
    { passengers, source: overrides.source ?? 'google_flights' },
  );
}

const request: FlightRequest = createFlightRequest({ origin: 'PRN', destination: 'BER', dateMode: 'exact' });

describe('compareResults — ranking', () => {
  it('sorts by total price, never trusting the provider’s own order', () => {
    const comparison = compareResults(
      [result({ price: 149, airline: 'Lufthansa' }), result({ price: 89 }), result({ price: 120, airline: 'Austrian' })],
      { request },
    );

    expect(comparison.ranked.map((entry) => entry.comparablePrice)).toEqual([89, 120, 149]);
    expect(comparison.cheapest?.result.price).toBe(89);
  });

  it('breaks price ties on the shorter itinerary', () => {
    const comparison = compareResults(
      [
        result({ price: 89, airline: 'Slow Air', duration: '9h', durationMinutes: 540, stops: 1 }),
        result({ price: 89, airline: 'Fast Air', duration: '2h 20min', durationMinutes: 140 }),
      ],
      { request },
    );
    expect(comparison.cheapest?.result.airline).toBe('Fast Air');
  });

  it('multiplies a per-person fare by the party size', () => {
    const perPerson = result({ price: 89, priceIsPerPerson: true }, 3);
    expect(perPerson.totalPrice).toBe(267);

    const comparison = compareResults([perPerson], {
      request: { ...request, passengers: 3 },
    });
    expect(comparison.cheapest?.comparablePrice).toBe(267);
  });
});

describe('compareResults — deduplication', () => {
  it('collapses the same itinerary across sources, keeping the cheapest', () => {
    const comparison = compareResults(
      [
        result({ price: 95, source: 'kayak', bookingUrl: 'https://kayak/x' }),
        result({ price: 89, source: 'skyscanner', bookingUrl: 'https://sky/x' }),
        result({ price: 99, source: 'momondo', bookingUrl: 'https://momondo/x' }),
      ],
      { request },
    );

    expect(comparison.ranked).toHaveLength(1);
    expect(comparison.cheapest?.result.source).toBe('skyscanner');
    expect(comparison.cheapest?.alsoOn.map((entry) => entry.source)).toEqual(['kayak', 'momondo']);
  });

  it('keeps genuinely different itineraries apart', () => {
    const comparison = compareResults(
      [result({ price: 89 }), result({ price: 89, departureTime: '18:00', arrivalTime: '20:20' })],
      { request },
    );
    expect(comparison.ranked).toHaveLength(2);
  });

  it('treats airline-name variants as the same carrier', () => {
    const comparison = compareResults(
      [result({ price: 95, airline: 'Wizz Air', source: 'kayak' }), result({ price: 89, airline: 'WizzAir', source: 'skyscanner' })],
      { request },
    );
    expect(comparison.ranked).toHaveLength(1);
  });
});

describe('compareResults — filters', () => {
  it('drops itineraries with too many stops and says why', () => {
    const comparison = compareResults(
      [result({ price: 60, stops: 1 }), result({ price: 89, stops: 0 })],
      { request: { ...request, maxStops: 0 } },
    );

    expect(comparison.ranked).toHaveLength(1);
    expect(comparison.cheapest?.result.price).toBe(89);
    expect(comparison.filteredOut[0]?.reason).toContain('ndalesa');
  });

  it('also checks the return leg against the stop limit', () => {
    const comparison = compareResults([result({ price: 60, stops: 0, returnStops: 2, returnDate: '2026-09-20' })], {
      request: { ...request, maxStops: 0 },
    });
    expect(comparison.ranked).toHaveLength(0);
    expect(comparison.filteredOut[0]?.reason).toContain('kthim');
  });

  it('drops fares without checked baggage when the user asked for it', () => {
    const comparison = compareResults(
      [
        result({ price: 60, baggage: { checkedBagIncluded: false } }),
        result({ price: 89, baggage: { checkedBagIncluded: true } }),
      ],
      { request: { ...request, baggage: true } },
    );
    expect(comparison.cheapest?.result.price).toBe(89);
  });

  it('applies the departure-time window', () => {
    const comparison = compareResults(
      [result({ price: 60, departureTime: '22:00' }), result({ price: 89, departureTime: '08:00' })],
      { request: { ...request, timePreference: { earliest: '05:00', latest: '11:00' } } },
    );
    expect(comparison.cheapest?.result.departureTime).toBe('08:00');
    expect(comparison.filteredOut[0]?.reason).toContain('pas 11:00');
  });
});

describe('compareResults — currencies', () => {
  it('excludes results it cannot convert rather than comparing them wrongly', () => {
    const comparison = compareResults([result({ price: 89, currency: 'USD' }), result({ price: 99 })], { request });

    expect(comparison.incomparable).toHaveLength(1);
    expect(comparison.ranked).toHaveLength(1);
    expect(comparison.cheapest?.result.currency).toBe('EUR');
  });

  it('converts when a rate table is supplied', () => {
    const comparison = compareResults([result({ price: 110, currency: 'USD' }), result({ price: 120 })], {
      request,
      rates: { base: 'EUR', rates: { USD: 1.1 } },
    });

    expect(comparison.incomparable).toHaveLength(0);
    expect(comparison.cheapest?.comparablePrice).toBe(100);
    expect(comparison.cheapest?.converted).toBe(true);
  });
});

describe('groupings', () => {
  const ranked = compareResults(
    [
      result({ price: 71, destination: { airport: 'MUC', city: 'München' } }),
      result({ price: 49, destination: { airport: 'STR', city: 'Stuttgart' } }),
      result({ price: 62, destination: { airport: 'BER', city: 'Berlin' }, departureDate: '2026-09-16' }),
      result({ price: 80, destination: { airport: 'STR', city: 'Stuttgart' }, departureTime: '19:00' }),
    ],
    { request },
  ).ranked;

  it('gives the cheapest option per city, cheapest city first', () => {
    const cities = cheapestByCity(ranked);
    expect(cities.map((option) => option.airport)).toEqual(['STR', 'BER', 'MUC']);
    expect(cities[0]?.best.comparablePrice).toBe(49);
  });

  it('gives the cheapest option per date pair', () => {
    const dates = cheapestByDates(ranked);
    expect(dates[0]).toMatchObject({ departureDate: '2026-09-15' });
    expect(dates[0]?.best.comparablePrice).toBe(49);
    expect(dates.map((option) => option.departureDate)).toContain('2026-09-16');
  });
});
