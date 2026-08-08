import { describe, expect, it } from 'vitest';
import handler from '../api/search.js';
import { handleSearch } from '../src/web/handle-search.js';
import { buildDeepLinks, describeInterpretation } from '../src/web/deep-links.js';
import { Planner } from '../src/agent/planner.js';
import { expandRequest } from '../src/agent/search-plan.js';
import { createFlightRequest } from '../src/models/flight-request.js';
import { AgentError } from '../src/errors.js';

const TODAY = '2026-08-08';

/**
 * Minimal stand-ins for Vercel's `(req, res)` pair.
 *
 * `req.url` is a path only — never an absolute URL — which is exactly the detail that crashed the
 * first deployed version, so the fakes reproduce it faithfully rather than handing over a `Request`.
 */
function fakeReq(options: { method?: string; url?: string; body?: unknown } = {}): any {
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/api/search',
    headers: { 'content-type': 'application/json' },
    body: options.body,
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(JSON.stringify(options.body));
    },
  };
}

function fakeRes(): any {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    payload: '',
    setHeader(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
    },
    end(body?: string) {
      this.payload = body ?? '';
    },
    json() {
      return JSON.parse(this.payload);
    },
  };
}

async function callGet(query: string, extra = ''): Promise<any> {
  const res = fakeRes();
  await handler(fakeReq({ url: `/api/search?q=${encodeURIComponent(query)}${extra}` }), res);
  return res;
}

async function callPost(body: unknown): Promise<any> {
  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body }), res);
  return res;
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

describe('handleSearch (framework-independent logic)', () => {
  it('answers a complete request with routes and links', async () => {
    const { status, body } = await handleSearch({ query: 'Nga Prishtina në Berlin më 15 shtator 2027' }, {});

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect((body.routes as any[]).length).toBeGreaterThan(0);
    expect((body.summary as string)).toContain('PRN');
  });

  it('asks a single question when something is missing', async () => {
    const { body } = await handleSearch({ query: 'Gjeje më të lirën për Gjermani' }, {});
    expect(body.status).toBe('needs_input');
    expect(body.missing).toEqual(['dates']);
  });

  it('expands a country-wide flexible search into many routes', async () => {
    const { body } = await handleSearch({ query: 'Nga Prishtina për në Gjermani gjatë dhjetorit 2027' }, {});
    expect(body.countryWide).toBe(true);
    expect((body.routes as any[]).length).toBeGreaterThan(5);
  });

  it('honours the env overrides', async () => {
    const { body } = await handleSearch(
      { query: 'Për në Gjermani gjatë dhjetorit 2027' },
      { DEFAULT_ORIGIN: 'Skopje', MAX_DESTINATIONS: '2', MAX_DATE_PAIRS: '2' },
    );
    expect((body.summary as string)).toContain('SKP');
    expect((body.routes as any[]).length).toBe(4);
  });

  it('ignores malformed env values rather than producing NaN limits', async () => {
    const { body } = await handleSearch(
      { query: 'Nga Prishtina për në Gjermani gjatë dhjetorit 2027' },
      { MAX_DESTINATIONS: 'shumë', MAX_DATE_PAIRS: '-3' },
    );
    expect((body.routes as any[]).length).toBe(30); // the 6 × 5 defaults
  });

  it('asks about an unrecognised destination instead of failing', async () => {
    // "Atlantis" is not in the airport catalog, so the request is treated as one that never named
    // a usable destination — a question the user can answer, not a dead end.
    const { status, body } = await handleSearch({ query: 'Nga Prishtina në Atlantis më 15 shtator 2027' }, {});

    expect(status).toBe(200);
    expect(body.status).toBe('needs_input');
    expect(body.missing).toEqual(['destination']);
  });

  it('says plainly when live prices were asked for but no worker is configured', async () => {
    const { body } = await handleSearch({ query: 'Nga Prishtina në Berlin më 15 shtator 2027', live: true }, {});
    expect((body.live as any).error).toContain('worker');
    // The deep links must still be there — the optional extra failing cannot cost the main answer.
    expect((body.routes as any[]).length).toBeGreaterThan(0);
  });
});

describe('/api/search — the Vercel adapter', () => {
  it('answers a GET whose url is a bare path, as Vercel supplies it', async () => {
    const res = await callGet('Nga Prishtina në Berlin më 15 shtator 2027');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json().routes[0].destination.iata).toBe('BER');
  });

  it('answers a POST using the body Vercel already parsed', async () => {
    const res = await callPost({ query: 'Nga Prishtina në Berlin më 15 shtator 2027' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('reads the stream when the body was not pre-parsed', async () => {
    const res = fakeRes();
    const req = fakeReq({ method: 'POST', body: { query: 'Nga Prishtina në Berlin më 15 shtator 2027' } });
    delete req.body; // force the stream path
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('honours ?live=1 the same way as the POST body', async () => {
    const res = await callGet('Nga Prishtina në Berlin më 15 shtator 2027', '&live=1');
    expect(res.json().live).toBeDefined();
  });

  it('always answers with JSON, never an HTML error page', async () => {
    for (const res of [
      await callGet(''),
      await callPost({}),
      await callPost({ query: '   ' }),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/json');
      expect(() => res.json()).not.toThrow();
    }
  });

  it('rejects unsupported methods with JSON', async () => {
    const res = fakeRes();
    await handler(fakeReq({ method: 'DELETE' }), res);
    expect(res.statusCode).toBe(405);
    expect(res.json().error).toBeTruthy();
  });

  it('answers a preflight without a body', async () => {
    const res = fakeRes();
    await handler(fakeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('sets no-store so a stale search is never served from cache', async () => {
    const res = await callGet('Nga Prishtina në Berlin më 15 shtator 2027');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
