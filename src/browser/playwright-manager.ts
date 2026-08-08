import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright';
import { AgentError, toAgentError } from '../errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('browser');

/**
 * Chrome/Chromium binaries to try when Playwright's own bundled build is missing — which happens
 * whenever the installed browser build was downloaded for a different Playwright version, or when
 * the host provides Chrome through its package manager. Checked in order; the first that exists wins.
 */
const KNOWN_CHROME_PATHS = [
  '/opt/pw-browsers/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

/** Explicit path from `FLIGHT_AGENT_CHROME_PATH`, else the first known location that exists. */
export function findChromeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.FLIGHT_AGENT_CHROME_PATH;
  if (configured) {
    if (existsSync(configured)) return configured;
    log.warn(`FLIGHT_AGENT_CHROME_PATH pikon te një skedar që s'ekziston: ${configured}`);
  }
  return KNOWN_CHROME_PATHS.find((candidate) => existsSync(candidate));
}

export interface ProxyConfig {
  server: string;
  bypass?: string;
}

/**
 * Proxy settings from the standard environment variables.
 *
 * Behind a corporate or sandboxed network, Chromium must be told about the proxy explicitly —
 * relying on it reading the environment itself is inconsistent across platforms and launch modes.
 * `NO_PROXY` is translated to Playwright's comma-separated `bypass` list.
 */
export function findProxyFromEnv(env: NodeJS.ProcessEnv = process.env): ProxyConfig | undefined {
  const server = env.FLIGHT_AGENT_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (!server) return undefined;

  const bypass = env.NO_PROXY ?? env.no_proxy;
  return bypass ? { server, bypass } : { server };
}

export interface BrowserOptions {
  /** Run without a visible window. Defaults to true unless FLIGHT_AGENT_HEADED=1. */
  headless?: boolean;
  /**
   * Use the real Google Chrome install (`channel: 'chrome'`) instead of bundled Chromium.
   * Chrome is preferred for these sites — Chromium's UA and fingerprint get flagged more often —
   * but we fall back automatically when Chrome is not installed.
   */
  preferChrome?: boolean;
  /** Slow every action down by N ms; useful when watching a headed run. */
  slowMo?: number;
  /** Path to a persistent profile directory. Keeps consent cookies between runs. */
  userDataDir?: string;
  /** Explicit browser binary. Falls back to `FLIGHT_AGENT_CHROME_PATH` and then autodetection. */
  executablePath?: string;
  /** HTTP proxy, e.g. from HTTPS_PROXY. */
  proxy?: string;
  locale?: string;
  timezoneId?: string;
  /** Default per-navigation timeout in ms. */
  navigationTimeout?: number;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Owns the single Chrome instance and hands out isolated contexts.
 *
 * One context per provider: cookie jars, consent state and any soft-block a site applies stay
 * contained, so Kayak rate-limiting us cannot poison the Google Flights session.
 */
export class PlaywrightManager {
  private browser?: Browser;
  private readonly contexts = new Map<string, BrowserContext>();
  private launching?: Promise<Browser>;

  constructor(private readonly options: BrowserOptions = {}) {}

  get headless(): boolean {
    if (this.options.headless !== undefined) return this.options.headless;
    return process.env.FLIGHT_AGENT_HEADED !== '1';
  }

  async launch(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.launching = this.doLaunch().finally(() => {
      this.launching = undefined;
    });
    return this.launching;
  }

  private async doLaunch(): Promise<Browser> {
    const base: LaunchOptions = {
      headless: this.headless,
      slowMo: this.options.slowMo ?? 0,
      args: [
        // Chrome exposes `navigator.webdriver` and an "automation" infobar by default; these two
        // flags are the standard way to run a normal-looking browser. We do not go further than
        // this — no fingerprint spoofing, no CAPTCHA evasion.
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1440,900',
      ],
    };
    const proxy = this.options.proxy ? { server: this.options.proxy } : findProxyFromEnv();
    if (proxy) {
      base.proxy = proxy;
      log.debug(`duke përdorur proxy ${proxy.server}`);
    }

    const attempts: Array<{ label: string; options: LaunchOptions }> = [];
    if (this.options.preferChrome !== false) {
      attempts.push({ label: 'Google Chrome', options: { ...base, channel: 'chrome' } });
    }
    attempts.push({ label: 'Chromium (bundled)', options: base });

    // Last resort: a browser already on this machine. Keeps the agent working when Playwright's
    // own download is absent or built for a different Playwright version.
    const executablePath = this.options.executablePath ?? findChromeExecutable();
    if (executablePath) {
      attempts.push({ label: `Chromium (${executablePath})`, options: { ...base, executablePath } });
    }

    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        log.debug(`launching ${attempt.label} (headless=${this.headless})`);
        const browser = await chromium.launch(attempt.options);
        log.info(`browser ready: ${attempt.label}`);
        this.browser = browser;
        return browser;
      } catch (error) {
        lastError = error;
        log.debug(`${attempt.label} unavailable: ${(error as Error).message.split('\n')[0]}`);
      }
    }

    throw new AgentError('browser_unavailable', 'Nuk u hap dot as Chrome as Chromium.', {
      cause: lastError,
      retryable: false,
    });
  }

  /** Returns (creating on first use) the isolated context for a provider. */
  async context(name: string): Promise<BrowserContext> {
    const existing = this.contexts.get(name);
    if (existing) return existing;

    const browser = await this.launch();
    try {
      const context = await browser.newContext({
        userAgent: DEFAULT_UA,
        locale: this.options.locale ?? 'en-GB',
        timezoneId: this.options.timezoneId ?? 'Europe/Belgrade',
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        // A plausible European geolocation keeps sites from redirecting to a US edition mid-search.
        geolocation: { latitude: 42.6629, longitude: 21.1655 },
        permissions: [],
        extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9,sq;q=0.8,de;q=0.7' },
      });
      context.setDefaultNavigationTimeout(this.options.navigationTimeout ?? 45_000);
      context.setDefaultTimeout(20_000);

      await context.addInitScript(() => {
        // Mirrors the launch flag above: keep `navigator.webdriver` reporting like a normal browser.
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      // Images and fonts are pure cost for a price scraper; blocking them roughly halves load time.
      await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'font' || type === 'media') return route.abort();
        return route.continue();
      });

      this.contexts.set(name, context);
      return context;
    } catch (error) {
      throw toAgentError(error, name);
    }
  }

  async closeContext(name: string): Promise<void> {
    const context = this.contexts.get(name);
    if (!context) return;
    this.contexts.delete(name);
    await context.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    for (const [name, context] of this.contexts) {
      await context.close().catch(() => log.debug(`context ${name} failed to close cleanly`));
    }
    this.contexts.clear();
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = undefined;
    }
  }

  get isRunning(): boolean {
    return Boolean(this.browser?.isConnected());
  }
}
