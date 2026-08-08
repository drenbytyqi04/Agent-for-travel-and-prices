import { afterAll, describe, expect, it } from 'vitest';
import { ChromeController } from '../../src/browser/chrome-controller.js';
import { FlightSearchAgent } from '../../src/agent/flight-search-agent.js';
import { createDefaultRegistry } from '../../src/providers/index.js';
import type { ProviderContext, SearchTask } from '../../src/providers/provider.js';
import { createFlightRequest } from '../../src/models/flight-request.js';
import { addDays, todayIso } from '../../src/utils/dates.js';
import { createLogger } from '../../src/utils/logger.js';

/**
 * Live integration tests. These hit the real flight sites, so they are opt-in:
 *
 *     RUN_LIVE=1 npm run test:live
 *
 * They are skipped by default because they need outbound internet, they are slow, and the sites
 * can legitimately serve a CAPTCHA at any moment — a failure here is not necessarily a code
 * regression. Treat them as a manual smoke check against the real DOM, not as a gate.
 */
const live = process.env.RUN_LIVE === '1' ? describe : describe.skip;

// Far enough out that schedules are published and fares exist for every carrier.
const DEPARTURE = addDays(todayIso(), 45);
const RETURN = addDays(DEPARTURE, 5);

const task: SearchTask = {
  originIata: 'PRN',
  destinationIata: 'BER',
  departureDate: DEPARTURE,
  returnDate: RETURN,
  passengers: 1,
  cabinClass: 'economy',
  currency: 'EUR',
  limit: 8,
};

const chrome = new ChromeController({ headless: process.env.FLIGHT_AGENT_HEADED !== '1' });

afterAll(async () => {
  await chrome.close().catch(() => undefined);
});

live('live providers', () => {
  for (const provider of createDefaultRegistry().all()) {
    it(
      `${provider.name} returns usable results or a clear reason`,
      async () => {
        const context: ProviderContext = {
          chrome,
          logger: createLogger(`live:${provider.id}`),
          request: createFlightRequest({ origin: 'PRN', destination: 'BER', dateMode: 'exact' }),
          budgetMs: 150_000,
        };

        const outcome = await provider.runSearch(task, context);

        // A blocked source is an acceptable outcome — but it must be reported, never silent.
        if (outcome.error) {
          console.warn(`${provider.name}: ${outcome.error.kind} — ${outcome.error.userMessage}`);
          expect(outcome.error.userMessage).toBeTruthy();
          expect(outcome.searchUrl).toMatch(/^https:\/\//);
          return;
        }

        expect(outcome.results.length).toBeGreaterThan(0);
        for (const result of outcome.results) {
          expect(result.price).toBeGreaterThan(0);
          expect(result.currency).toMatch(/^[A-Z]{3}$/);
          expect(result.departureTime).toMatch(/^\d{2}:\d{2}/);
          expect(result.arrivalTime).toMatch(/^\d{2}:\d{2}/);
          expect(result.stops).toBeGreaterThanOrEqual(0);
          expect(result.bookingUrl).toMatch(/^https:\/\//);
          expect(result.origin.airport).toBe('PRN');
          expect(result.destination.airport).toBe('BER');
        }
      },
      180_000,
    );
  }
});

live('live agent', () => {
  it(
    'completes a country-wide search and returns a verified cheapest option',
    async () => {
      const agent = new FlightSearchAgent({
        chrome,
        maxDestinations: 3,
        concurrency: 2,
        onProgress: (event) => console.log(`[${event.phase}] ${event.message}`),
      });

      const report = await agent.search(
        createFlightRequest({
          origin: 'Prishtina',
          destinationCountry: 'DE',
          departureDate: DEPARTURE,
          dateMode: 'exact',
        }),
      );

      // Every source may be blocked on a bad day; what must hold is that the agent says so
      // rather than inventing a result.
      if (!report.comparison.cheapest) {
        expect(report.failures.length).toBeGreaterThan(0);
        return;
      }

      expect(report.byCity.length).toBeGreaterThan(0);
      expect(report.comparison.cheapest.comparablePrice).toBeGreaterThan(0);
      expect(report.verification).toBeDefined();
    },
    600_000,
  );
});
