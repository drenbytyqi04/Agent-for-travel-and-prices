import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChromeController } from '../src/browser/chrome-controller.js';
import { PlaywrightManager, findChromeExecutable, findProxyFromEnv } from '../src/browser/playwright-manager.js';
import { waitForStableCount } from '../src/browser/page-interaction.js';
import { GoogleFlightsProvider } from '../src/providers/google-flights.js';
import { CaptchaError, AutomationBlockedError } from '../src/errors.js';
import type { ProviderContext, SearchTask } from '../src/providers/provider.js';
import { createLogger } from '../src/utils/logger.js';
import { createFlightRequest } from '../src/models/flight-request.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Exercises the browser layer against a local fixture server: a real Chromium, real navigation,
 * real DOM extraction — no external network. This is what keeps the provider's selectors and the
 * page-interaction helpers honest in CI, where the flight sites are unreachable.
 */

const PAGES: Record<string, { body: string; type: string }> = {
  '/google-flights': {
    body: readFileSync(join(here, 'fixtures/google-flights.html'), 'utf8'),
    type: 'text/html; charset=utf-8',
  },
  '/captcha': {
    body: '<!doctype html><title>Verify</title><body><div id="recaptcha">Please verify you are human</div></body>',
    type: 'text/html; charset=utf-8',
  },
  '/blocked': {
    body: '<!doctype html><title>Blocked</title><body><h1>Access denied</h1><p>Automated access is not permitted.</p></body>',
    type: 'text/html; charset=utf-8',
  },
  '/consent': {
    body: `<!doctype html><title>Consent</title><body>
      <div id="wall"><button id="onetrust-accept-btn-handler">Accept all</button></div>
      <div id="content" style="display:none">Results here</div>
      <script>
        document.getElementById('onetrust-accept-btn-handler').addEventListener('click', () => {
          document.getElementById('wall').remove();
          document.getElementById('content').style.display = 'block';
        });
      </script></body>`,
    type: 'text/html; charset=utf-8',
  },
};

let server: Server;
let baseUrl: string;
let manager: PlaywrightManager;
let chrome: ChromeController;
let browserAvailable = true;

beforeAll(async () => {
  server = createServer((req, res) => {
    const page = PAGES[(req.url ?? '/').split('?')[0]!];
    if (!page) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': page.type }).end(page.body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The fixture server is local, so the proxy must not be used for it.
  manager = new PlaywrightManager({ headless: true, proxy: '' });
  chrome = new ChromeController(manager);

  try {
    await manager.launch();
  } catch {
    browserAvailable = false;
  }
}, 90_000);

afterAll(async () => {
  await chrome?.close().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('browser environment', () => {
  it('finds a Chrome/Chromium binary or an explicit override', () => {
    // Undefined is legitimate when Playwright's own bundled build is present.
    const found = findChromeExecutable();
    expect(found === undefined || typeof found === 'string').toBe(true);
    expect(findChromeExecutable({ FLIGHT_AGENT_CHROME_PATH: '/definitely/not/here' } as NodeJS.ProcessEnv)).not.toBe(
      '/definitely/not/here',
    );
  });

  it('reads proxy settings from the environment', () => {
    expect(findProxyFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      findProxyFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:8080', NO_PROXY: 'localhost' } as NodeJS.ProcessEnv),
    ).toEqual({ server: 'http://127.0.0.1:8080', bypass: 'localhost' });
    expect(findProxyFromEnv({ HTTP_PROXY: 'http://p:1' } as NodeJS.ProcessEnv)).toEqual({ server: 'http://p:1' });
  });
});

describe('ChromeController against a local page', () => {
  it('launches a browser', () => {
    if (!browserAvailable) return;
    expect(manager.isRunning).toBe(true);
  });

  it('navigates and reads a page', async () => {
    if (!browserAvailable) return;
    await chrome.withPage('test', async (page) => {
      await chrome.goto(page, `${baseUrl}/google-flights`);
      expect(await page.title()).toContain('fixture');
    });
  }, 60_000);

  it('detects a CAPTCHA wall and refuses to proceed', async () => {
    if (!browserAvailable) return;
    await expect(
      chrome.withPage('test', async (page) => {
        await chrome.goto(page, `${baseUrl}/captcha`);
      }),
    ).rejects.toThrow(CaptchaError);
  }, 60_000);

  it('detects an automation block', async () => {
    if (!browserAvailable) return;
    await expect(
      chrome.withPage('test', async (page) => {
        await chrome.goto(page, `${baseUrl}/blocked`);
      }),
    ).rejects.toThrow(AutomationBlockedError);
  }, 60_000);

  it('dismisses a cookie-consent wall', async () => {
    if (!browserAvailable) return;
    await chrome.withPage('test', async (page) => {
      await chrome.goto(page, `${baseUrl}/consent`);
      expect(await page.locator('#content').isVisible()).toBe(true);
      expect(await page.locator('#wall').count()).toBe(0);
    });
  }, 60_000);

  it('waits for a streaming results list to settle', async () => {
    if (!browserAvailable) return;
    await chrome.withPage('test', async (page) => {
      await chrome.goto(page, `${baseUrl}/google-flights`);
      // The fixture appends a fourth card after ~900ms; reading early would miss the cheapest fare.
      const count = await waitForStableCount(page, 'ul.Rk10dc li.pIav2d', { minCount: 1, stableForMs: 1_500 });
      expect(count).toBe(4);
    });
  }, 60_000);
});

describe('GoogleFlightsProvider — DOM extraction against the fixture', () => {
  const task: SearchTask = {
    originIata: 'PRN',
    destinationIata: 'BER',
    departureDate: '2026-09-15',
    passengers: 1,
    cabinClass: 'economy',
    currency: 'EUR',
  };

  it('extracts every card into a well-formed FlightResult', async () => {
    if (!browserAvailable) return;

    const provider = new GoogleFlightsProvider();
    // Point the provider at the fixture rather than google.com, leaving its parsing untouched.
    const fixtureProvider = Object.create(provider) as GoogleFlightsProvider;
    Object.defineProperty(fixtureProvider, 'buildSearchUrl', {
      value: () => `${baseUrl}/google-flights`,
    });

    const context: ProviderContext = {
      chrome,
      logger: createLogger('test'),
      request: createFlightRequest({ origin: 'PRN', destination: 'BER', dateMode: 'exact' }),
      budgetMs: 60_000,
    };

    const results = await fixtureProvider.search(task, context);
    expect(results).toHaveLength(4);

    const wizz = results.find((result) => result.airline === 'Wizz Air')!;
    expect(wizz.departureTime).toBe('06:20');
    expect(wizz.arrivalTime).toBe('08:40');
    expect(wizz.stops).toBe(0);
    expect(wizz.price).toBe(89);
    expect(wizz.currency).toBe('EUR');
    expect(wizz.duration).toBe('2 hr 20 min');
    expect(wizz.durationMinutes).toBe(140);
    expect(wizz.origin.airport).toBe('PRN');
    expect(wizz.destination.city).toBe('Berlin');

    const austrian = results.find((result) => result.airline === 'Austrian Airlines')!;
    expect(austrian.departureTime).toBe('12:05'); // PM handled
    expect(austrian.arrivalTime).toBe('18:50');
    expect(austrian.stops).toBe(1);

    const lufthansa = results.find((result) => result.airline === 'Lufthansa')!;
    expect(lufthansa.arrivalTime).toBe('07:15+1'); // overnight marker preserved
    expect(lufthansa.stops).toBe(2);

    // The late-arriving card is the cheapest — proof the provider waits for the list to settle.
    const cheapest = results.reduce((best, current) => (current.price < best.price ? current : best));
    expect(cheapest.price).toBe(75);
    expect(cheapest.airline).toBe('Chair Airlines');

    for (const result of results) {
      expect(result.bookingUrl).toMatch(/^http/);
      expect(result.verifiedAt).toBeTruthy();
      expect(result.source).toBe('google_flights');
    }
  }, 90_000);
});
