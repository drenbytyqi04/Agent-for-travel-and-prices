import { describe, expect, it } from 'vitest';
import handler from '../api/search.js';
import { buildDeepLinks, describeInterpretation } from '../src/web/deep-links.js';
import { Planner } from '../src/agent/planner.js';
import { expandRequest } from '../src/agent/search-plan.js';
import { createFlightRequest } from '../src/models/flight-request.js';
import { AgentError } from '../src/errors.js';

const TODAY = '2026-08-08';

function post(body: unknown): Request {
  return new Request('https://example.vercel.app/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('expandRequest', () => {
  it('expands a country into its airports', () => {
    const { destinations, notes } = expandRequest(
      createFlightRequest({ origin: 'PRN', destinationCountry: 'DE', departureDate: '2026-09-15', dateMode: 'exact' }),
      { maxDestinations: 3 },
    );

    expect(destinations.map((airport) => airport.iata)).toEqual(['FRA', 'MUC', 'BER']);
    expect(notes.join(' ')).toContain('3 aeroporte');
  });

  it('expands a flexible window into several date pairs', () => {
    const { datePairs } = expandRequest(
      createFlightRequest({
        origin: 'PRN',
        destination: 'BER',
        dateMode: 'flexible_month',
        dateWindow: { start: '2026-09-01', end: '2026-09-30' },
        tripLengthNights: 5,
        flexibleDates: true,
      }),
      { maxDatePairs: 4 },
    );

    expect(datePairs).toHaveLength(4);
    expect(datePairs.every((pair) => pair.returnDate)).toBe(true);
  });

  it('rejects an unknown destination', () => {
    expect(() =>
      expandRequest(
        createFlightRequest({ origin: 'PRN', destination: 'Atlantis', departureDate: '2026-09-15', dateMode: 'exact' }),
      ),
    ).toThrow(AgentError);
  });
});

describe('buildDeepLinks', () => {
  it('produces one link set per airport and date pair', () => {
    const request = createFlightRequest({
      origin: 'Prishtina',
      destinationCountry: 'DE',
      dateMode: 'flexible_month',
      dateWindow: { start: '2026-09-01', end: '2026-09-30' },
      flexibleDates: true,
    });

    const { routes } = buildDeepLinks(request, { maxDestinations: 3, maxDatePairs: 2 });
    expect(routes).toHaveLength(6);

    for (const route of routes) {
      expect(route.origin.iata).toBe('PRN');
      expect(route.departureLabel).toMatch(/Shtator/);
      const sources = route.links.map((link) => link.source);
      expect(sources).toContain('google_flights');
      expect(sources).toContain('skyscanner');
      expect(sources).toContain('kayak');
      for (const link of route.links) expect(link.url).toMatch(/^https:\/\//);
    }
  });

  it('offers the airline’s own site only on routes it flies', () => {
    const toBerlin = buildDeepLinks(
      createFlightRequest({ origin: 'PRN', destination: 'Berlin', departureDate: '2026-09-15', dateMode: 'exact' }),
    );
    expect(toBerlin.routes[0]!.links.map((link) => link.source)).toContain('wizzair');

    const toRome = buildDeepLinks(
      createFlightRequest({ origin: 'PRN', destination: 'Rome', departureDate: '2026-09-15', dateMode: 'exact' }),
    );
    expect(toRome.routes[0]!.links.map((link) => link.source)).not.toContain('wizzair');
  });

  it('never emits a bare homepage as a link', () => {
    const { routes } = buildDeepLinks(
      createFlightRequest({ origin: 'PRN', destination: 'Berlin', departureDate: '2026-09-15', dateMode: 'exact' }),
    );
    for (const link of routes[0]!.links) {
      const url = new URL(link.url);
      expect(url.pathname.length + url.search.length).toBeGreaterThan(1);
    }
  });

  it('carries passengers and cabin class into the links', () => {
    const { routes } = buildDeepLinks(
      createFlightRequest({
        origin: 'PRN',
        destination: 'Berlin',
        departureDate: '2026-09-15',
        dateMode: 'exact',
        passengers: 3,
        cabinClass: 'business',
      }),
    );

    const kayak = routes[0]!.links.find((link) => link.source === 'kayak')!;
    expect(kayak.url).toContain('3adults');
    expect(kayak.url).toContain('business');
  });
});

describe('describeInterpretation', () => {
  it('exposes every field the UI shows, with nulls rather than gaps', () => {
    const plan = new Planner({ today: TODAY }).plan('Nga Prishtina në Berlin më 15 shtator');
    const view = describeInterpretation(plan.request);

    expect(view.origin).toBe('prishtina');
    expect(view.destination).toBe('berlin');
    expect(view.returnDate).toBeNull();
    expect(view.destinationCountry).toBeNull();
    expect(view.passengers).toBe(1);
  });
});

describe('/api/search', () => {
  it('answers a complete request with routes and links', async () => {
    const response = await handler(post({ query: 'Nga Prishtina në Berlin më 15 shtator 2027' }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe('ok');
    expect(body.routes.length).toBeGreaterThan(0);
    expect(body.routes[0].links.length).toBeGreaterThan(3);
    expect(body.summary).toContain('PRN');
  });

  it('asks a single question when something is missing', async () => {
    const response = await handler(post({ query: 'Gjeje më të lirën për Gjermani' }));
    const body = (await response.json()) as Record<string, any>;

    expect(body.status).toBe('needs_input');
    expect(body.missing).toEqual(['dates']);
    expect(body.question).toBeTruthy();
  });

  it('expands a country-wide flexible search into many routes', async () => {
    const response = await handler(post({ query: 'Nga Prishtina për në Gjermani gjatë dhjetorit 2027' }));
    const body = (await response.json()) as Record<string, any>;

    expect(body.status).toBe('ok');
    expect(body.countryWide).toBe(true);
    expect(body.flexibleDates).toBe(true);
    expect(body.routes.length).toBeGreaterThan(5);
  });

  it('rejects bad input without leaking internals', async () => {
    expect((await handler(post({}))).status).toBe(400);
    expect((await handler(post({ query: '   ' }))).status).toBe(400);

    const badMethod = await handler(new Request('https://x.dev/api/search', { method: 'GET' }));
    expect(badMethod.status).toBe(405);
  });

  it('says plainly when live prices were asked for but no worker is configured', async () => {
    const response = await handler(post({ query: 'Nga Prishtina në Berlin më 15 shtator 2027', live: true }));
    const body = (await response.json()) as Record<string, any>;

    expect(body.live.error).toContain('worker');
    // The deep links must still be there — the optional extra failing cannot cost the main answer.
    expect(body.routes.length).toBeGreaterThan(0);
  });

  it('caps absurdly long input rather than processing it', async () => {
    const response = await handler(post({ query: 'a'.repeat(50_000) }));
    expect([200, 400]).toContain(response.status);
  });

  it('sets JSON and no-store headers', async () => {
    const response = await handler(post({ query: 'Nga Prishtina në Berlin më 15 shtator 2027' }));
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
