import { describe, expect, it } from 'vitest';
import { FlightSearchAgent } from '../src/agent/flight-search-agent.js';
import { Planner } from '../src/agent/planner.js';
import { formatSearchReport, toJsonReport } from '../src/agent/result-formatter.js';
import { createMockRegistry, ProviderRegistry, BaseProvider } from '../src/providers/index.js';
import type { ProviderContext, SearchTask } from '../src/providers/provider.js';
import type { FlightResult } from '../src/models/flight-result.js';
import { AgentError } from '../src/errors.js';
import { createFlightRequest } from '../src/models/flight-request.js';
import { MockProvider } from '../src/providers/mock-provider.js';

const TODAY = '2026-08-08';

/** Full pipeline against the deterministic offline provider — no browser, no network. */
function makeAgent(overrides = {}) {
  return new FlightSearchAgent({
    registry: createMockRegistry(),
    maxDestinations: 4,
    maxDatePairs: 3,
    ...overrides,
  });
}

describe('FlightSearchAgent — end to end (mock provider)', () => {
  it('runs a fixed-date round trip and produces a cheapest result', async () => {
    const planner = new Planner({ today: TODAY });
    const plan = planner.plan(
      'Më gjej fluturimin më të lirë nga Prishtina për në Berlin më 15 shtator dhe kthimin më 20 shtator.',
    );
    expect(plan.missing).toHaveLength(0);

    const agent = makeAgent();
    const report = await agent.search(plan.request);

    expect(report.comparison.cheapest).toBeDefined();
    expect(report.comparison.cheapest!.result.origin.airport).toBe('PRN');
    expect(report.comparison.cheapest!.result.destination.airport).toBe('BER');
    expect(report.comparison.cheapest!.result.departureDate).toBe('2026-09-15');
    expect(report.comparison.cheapest!.result.returnDate).toBe('2026-09-20');

    // One destination × one date pair — the fan-out must not multiply a fixed search.
    expect(report.outcomes).toHaveLength(1);
    await agent.close();
  });

  it('fans out across German airports when only the country is given', async () => {
    const planner = new Planner({ today: TODAY });
    const plan = planner.plan('Më gjej fluturimin më të lirë nga Prishtina për në Gjermani më 15 shtator.');

    const agent = makeAgent();
    const report = await agent.search(plan.request);

    expect(report.countryWide).toBe(true);
    expect(report.outcomes).toHaveLength(4); // maxDestinations
    expect(report.byCity.length).toBeGreaterThan(1);

    // The ranking must be genuinely sorted, not just the provider's order.
    const prices = report.byCity.map((option) => option.best.comparablePrice);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
    await agent.close();
  });

  it('searches several date pairs when dates are flexible', async () => {
    const planner = new Planner({ today: TODAY });
    const plan = planner.plan('Më gjej fluturimin më të lirë nga Prishtina për në Berlin gjatë shtatorit.');

    const agent = makeAgent();
    const report = await agent.search(plan.request);

    expect(report.flexibleDates).toBe(true);
    expect(report.outcomes).toHaveLength(3); // maxDatePairs
    expect(new Set(report.byDate.map((option) => option.departureDate)).size).toBeGreaterThan(1);
    await agent.close();
  });

  it('verifies the cheapest offer and reports the verified price', async () => {
    const agent = makeAgent();
    const report = await agent.search(
      createFlightRequest({
        origin: 'PRN',
        destination: 'BER',
        departureDate: '2026-09-15',
        dateMode: 'exact',
      }),
    );

    const cheapest = report.comparison.cheapest!.result;
    // The mock verifier deliberately returns a price 4 higher than the listing.
    expect(cheapest.priceConfidence).toBe('changed');
    expect(cheapest.listedPrice).toBeDefined();
    expect(cheapest.price).toBe(cheapest.listedPrice! + 4);
    expect(report.notes.some((note) => note.includes('Çmimi u rrit'))).toBe(true);
    await agent.close();
  });

  it('reports listed prices as unverified when verification is skipped', async () => {
    const agent = makeAgent({ skipVerification: true });
    const report = await agent.search(
      createFlightRequest({ origin: 'PRN', destination: 'BER', departureDate: '2026-09-15', dateMode: 'exact' }),
    );

    expect(report.comparison.cheapest!.result.priceConfidence).toBe('listed');
    expect(report.notes.some((note) => note.includes('Verifikimi'))).toBe(true);
    await agent.close();
  });

  it('emits progress events for each phase', async () => {
    const phases: string[] = [];
    const agent = makeAgent({ onProgress: (event: { phase: string }) => phases.push(event.phase) });
    await agent.search(
      createFlightRequest({ origin: 'PRN', destination: 'BER', departureDate: '2026-09-15', dateMode: 'exact' }),
    );

    expect(phases).toContain('planning');
    expect(phases).toContain('searching');
    expect(phases).toContain('comparing');
    expect(phases).toContain('done');
    await agent.close();
  });
});

/** A provider that always throws, to prove one bad source cannot sink the search. */
class BrokenProvider extends BaseProvider {
  readonly id = 'broken';
  readonly name = 'Broken Source';
  override readonly priority = 5;

  buildSearchUrl(): string {
    return 'https://broken.example/search?q=1';
  }

  async search(_task: SearchTask, _context: ProviderContext): Promise<FlightResult[]> {
    throw new AgentError('captcha', 'Broken Source kërkoi CAPTCHA.', { source: 'broken' });
  }
}

describe('FlightSearchAgent — resilience', () => {
  it('continues with the remaining sources when one is blocked', async () => {
    const registry = new ProviderRegistry().register(new BrokenProvider()).register(new MockProvider());
    const agent = new FlightSearchAgent({ registry });

    const report = await agent.search(
      createFlightRequest({ origin: 'PRN', destination: 'BER', departureDate: '2026-09-15', dateMode: 'exact' }),
    );

    expect(report.failures.map((failure) => failure.source)).toContain('broken');
    expect(report.failures[0]?.kind).toBe('captcha');
    expect(report.comparison.cheapest).toBeDefined();
    expect(report.comparison.cheapest!.result.source).toBe('mock');

    // The failure must reach the user, and the search URL survives so they can continue manually.
    const output = formatSearchReport(report);
    expect(output).toContain('CAPTCHA');
    expect(report.outcomes.find((outcome) => outcome.source === 'broken')?.searchUrl).toBeTruthy();
    await agent.close();
  });

  it('reports no results without inventing any when every source fails', async () => {
    const registry = new ProviderRegistry().register(new BrokenProvider());
    const agent = new FlightSearchAgent({ registry });

    const report = await agent.search(
      createFlightRequest({ origin: 'PRN', destination: 'BER', departureDate: '2026-09-15', dateMode: 'exact' }),
    );

    expect(report.comparison.cheapest).toBeUndefined();
    const output = formatSearchReport(report);
    expect(output).toContain('Nuk u gjet asnjë fluturim');
    expect(output).not.toMatch(/€\d/);
    await agent.close();
  });

  it('rejects an unknown destination before opening a browser', async () => {
    const agent = makeAgent();
    await expect(
      agent.search(
        createFlightRequest({ origin: 'PRN', destination: 'Atlantis', departureDate: '2026-09-15', dateMode: 'exact' }),
      ),
    ).rejects.toThrow(AgentError);
    await agent.close();
  });

  it('rejects a past departure date', async () => {
    const agent = makeAgent();
    await expect(
      agent.search(
        createFlightRequest({ origin: 'PRN', destination: 'BER', departureDate: '2020-01-01', dateMode: 'exact' }),
      ),
    ).rejects.toThrow(/kaluar/);
    await agent.close();
  });
});

describe('JSON output', () => {
  it('serialises the report without losing the key fields', async () => {
    const agent = makeAgent();
    const report = await agent.search(
      createFlightRequest({ origin: 'PRN', destination: 'BER', departureDate: '2026-09-15', dateMode: 'exact' }),
    );

    const json = toJsonReport(report) as Record<string, unknown>;
    const cheapest = json.cheapest as Record<string, unknown>;

    expect(cheapest.airline).toBeTruthy();
    expect(cheapest.bookingUrl).toMatch(/^https:\/\//);
    expect(cheapest.verifiedAt).toBeTruthy();
    expect(json.verified).toBe(true);
    expect(JSON.parse(JSON.stringify(json))).toBeTruthy();
    await agent.close();
  });
});
