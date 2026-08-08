import { describe, expect, it } from 'vitest';
import { formatCheapest, formatCityRanking, formatDateOptions, formatSearchReport } from '../src/agent/result-formatter.js';
import { compareResults, cheapestByCity, cheapestByDates } from '../src/agent/price-comparator.js';
import { createFlightRequest, type FlightRequest } from '../src/models/flight-request.js';
import { normaliseResult, type FlightResult } from '../src/models/flight-result.js';
import type { SearchReport } from '../src/agent/flight-search-agent.js';

function result(overrides: Partial<FlightResult> & { price: number }, passengers = 1): FlightResult {
  return normaliseResult(
    {
      airline: 'Wizz Air',
      origin: { airport: 'PRN', city: 'Prishtinë' },
      destination: { airport: 'BER', city: 'Berlin' },
      departureDate: '2026-09-15',
      returnDate: '2026-09-20',
      departureTime: '06:20',
      arrivalTime: '08:40',
      duration: '2h 20min',
      stops: 0,
      currency: 'EUR',
      priceIsPerPerson: false,
      source: 'google_flights',
      bookingUrl: 'https://www.google.com/travel/clk?offer=1',
      ...overrides,
    },
    { passengers, source: overrides.source ?? 'google_flights' },
  );
}

const request: FlightRequest = createFlightRequest({ origin: 'PRN', destination: 'BER', dateMode: 'exact' });

function report(results: FlightResult[], overrides: Partial<SearchReport> = {}): SearchReport {
  const comparison = compareResults(results, { request: overrides.request ?? request });
  return {
    request: overrides.request ?? request,
    outcomes: [],
    comparison,
    byCity: cheapestByCity(comparison.ranked),
    byDate: cheapestByDates(comparison.ranked),
    verificationReports: [],
    notes: [],
    failures: [],
    startedAt: new Date().toISOString(),
    durationMs: 4200,
    countryWide: false,
    flexibleDates: false,
    ...overrides,
  };
}

describe('formatCheapest — the spec’s §6 block', () => {
  it('renders every required field for a round trip', () => {
    const comparison = compareResults([result({ price: 89, priceConfidence: 'verified' })], { request });
    const output = formatCheapest(comparison.cheapest!, request);

    expect(output).toContain('✈️ Fluturimi më i lirë');
    expect(output).toContain('Nga: Prishtinë (PRN)');
    expect(output).toContain('Për: Berlin (BER)');
    expect(output).toContain('Data e nisjes: 15 Shtator 2026');
    expect(output).toContain('Data e kthimit: 20 Shtator 2026');
    expect(output).toContain('💰 Çmimi: €89');
    expect(output).toContain('👤 Për: 1 person');
    expect(output).toContain('🛫 Kompania: Wizz Air');
    expect(output).toContain('🔄 Direkt');
    expect(output).toContain('⏱️ Kohëzgjatja: 2h 20min');
    expect(output).toContain('🔗 Rezervimi:');
    expect(output).toContain('https://www.google.com/travel/clk?offer=1');
  });

  it('says "One-way" instead of a return date', () => {
    const comparison = compareResults([result({ price: 89, returnDate: undefined })], { request });
    const output = formatCheapest(comparison.cheapest!, request);

    expect(output).toContain('Kthimi: One-way');
    expect(output).not.toContain('Data e kthimit');
  });

  it('shows the per-person price alongside the total for a group', () => {
    const groupRequest = { ...request, passengers: 3 };
    const comparison = compareResults([result({ price: 89, priceIsPerPerson: true }, 3)], { request: groupRequest });
    const output = formatCheapest(comparison.cheapest!, groupRequest);

    expect(output).toContain('💰 Çmimi: €267');
    expect(output).toContain('👤 Për: 3 persona');
    expect(output).toContain('€89/person');
  });

  it('labels the price by how much it can be trusted', () => {
    const verified = compareResults([result({ price: 89, priceConfidence: 'verified' })], { request });
    expect(formatCheapest(verified.cheapest!, request)).toContain('i verifikuar');

    const changed = compareResults([result({ price: 95, priceConfidence: 'changed', listedPrice: 89 })], { request });
    expect(formatCheapest(changed.cheapest!, request)).toContain('i listuar ishte 89');

    const listed = compareResults([result({ price: 89 })], { request });
    expect(formatCheapest(listed.cheapest!, request)).toContain('i paverifikuar');
  });

  it('marks a search URL as a fallback rather than presenting it as the offer', () => {
    const comparison = compareResults(
      [result({ price: 89, bookingUrl: 'https://www.google.com/travel/flights?q=x', bookingUrlIsSearch: true })],
      { request },
    );
    expect(formatCheapest(comparison.cheapest!, request)).toContain('link i ofertës nuk ishte i disponueshëm');
  });
});

describe('formatCityRanking — the spec’s §7 block', () => {
  it('renders a medal ranking and a recommendation', () => {
    const results = [
      result({ price: 49, destination: { airport: 'STR', city: 'Stuttgart' } }),
      result({ price: 62, destination: { airport: 'BER', city: 'Berlin' }, departureDate: '2026-09-16' }),
      result({ price: 71, destination: { airport: 'MUC', city: 'München' } }),
    ];
    const comparison = compareResults(results, { request });
    const output = formatCityRanking(cheapestByCity(comparison.ranked), request);

    expect(output).toContain('🥇 PRN → Stuttgart (STR)');
    expect(output).toContain('🥈 PRN → Berlin (BER)');
    expect(output).toContain('🥉 PRN → München (MUC)');
    expect(output).toContain('€49');
    expect(output).toContain('👉 Rekomandimi: Stuttgart (STR) me €49.');
  });
});

describe('formatDateOptions — the spec’s §8 block', () => {
  it('shows the cheapest dates plus alternatives', () => {
    const results = [
      result({ price: 89, departureDate: '2026-09-15', returnDate: '2026-09-20' }),
      result({ price: 94, departureDate: '2026-09-17', returnDate: '2026-09-22' }),
      result({ price: 102, departureDate: '2026-09-20', returnDate: '2026-09-25' }),
    ];
    const comparison = compareResults(results, { request });
    const output = formatDateOptions(cheapestByDates(comparison.ranked), request);

    expect(output).toContain('Data më e lirë:');
    expect(output).toContain('15 Shtator → 20 Shtator');
    expect(output).toContain('€89');
    expect(output).toContain('Alternativa:');
    expect(output).toContain('17 Shtator → 22 Shtator — €94');
    expect(output).toContain('20 Shtator → 25 Shtator — €102');
  });
});

describe('formatSearchReport', () => {
  it('adds the city ranking only for country-wide searches', () => {
    const results = [
      result({ price: 49, destination: { airport: 'STR', city: 'Stuttgart' } }),
      result({ price: 71, destination: { airport: 'MUC', city: 'München' } }),
    ];
    expect(formatSearchReport(report(results, { countryWide: true }))).toContain('Krahasimi sipas qyteteve');
    expect(formatSearchReport(report(results))).not.toContain('Krahasimi sipas qyteteve');
  });

  it('adds the date options only for flexible-date searches', () => {
    const results = [
      result({ price: 89, departureDate: '2026-09-15' }),
      result({ price: 94, departureDate: '2026-09-17' }),
    ];
    expect(formatSearchReport(report(results, { flexibleDates: true }))).toContain('Datat më të lira');
    expect(formatSearchReport(report(results))).not.toContain('Datat më të lira');
  });

  it('surfaces source failures but stays quiet about routine empty results', () => {
    const output = formatSearchReport(
      report([result({ price: 89 })], {
        failures: [
          { source: 'kayak', kind: 'captcha', userMessage: 'Kayak kërkoi CAPTCHA.' },
          { source: 'momondo', kind: 'no_flights_found', userMessage: 'Asnjë fluturim.' },
        ],
      }),
    );

    expect(output).toContain('Kayak kërkoi CAPTCHA');
    expect(output).not.toContain('Asnjë fluturim.');
  });

  it('states plainly when a price could not be verified', () => {
    const output = formatSearchReport(report([result({ price: 89, priceConfidence: 'unverified' })]));
    expect(output).toContain('Çmimi nuk mund të verifikohej në mënyrë të sigurt');
  });

  it('never invents a price when there are no results', () => {
    const output = formatSearchReport(report([]));
    expect(output).toContain('Nuk u gjet asnjë fluturim');
    expect(output).not.toMatch(/€\s*\d/);
  });

  it('explains which filter removed the results and offers to relax it', () => {
    const output = formatSearchReport(
      report([result({ price: 89, stops: 2 })], { request: { ...request, maxStops: 0 } }),
    );
    expect(output).toContain('u përjashtuan nga filtrat');
    expect(output).toContain('2 ndalesa');
    expect(output).toContain('lirosh filtrat');
  });

  it('includes the per-source audit trail on request', () => {
    const withDiagnostics = report([result({ price: 89 })], {
      outcomes: [{ source: 'google_flights', results: [result({ price: 89 })], durationMs: 1200 }],
    });
    expect(formatSearchReport(withDiagnostics, { includeDiagnostics: true })).toContain('🔍 Diagnostikë');
    expect(formatSearchReport(withDiagnostics)).not.toContain('🔍 Diagnostikë');
  });
});
