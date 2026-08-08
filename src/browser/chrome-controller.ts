import type { BrowserContext, Page } from 'playwright';
import { AgentError, AutomationBlockedError, CaptchaError, toAgentError } from '../errors.js';
import { createLogger } from '../utils/logger.js';
import { PlaywrightManager, type BrowserOptions } from './playwright-manager.js';
import { debugShot, dismissConsent, dismissModals } from './page-interaction.js';

const log = createLogger('chrome');

/**
 * Signals that a page is a CAPTCHA / bot wall rather than a results page.
 * We detect these to *stop* — the agent never attempts to solve or bypass a challenge (spec §3).
 */
const CAPTCHA_MARKERS = [
  'recaptcha',
  'g-recaptcha',
  'hcaptcha',
  'px-captcha',
  'are you a robot',
  'unusual traffic',
  'verify you are human',
  'verifying you are human',
  'confirm you are a human',
  'jeni robot',
  'cf-challenge',
  'challenge-platform',
];

const BLOCK_MARKERS = [
  'access denied',
  'you have been blocked',
  'request blocked',
  'automated access',
  'bot detected',
  'sorry, we are unable to process',
  'error 1015',
  'rate limited',
];

export interface NavigateOptions {
  /** Extra ms to wait after load for client-side rendering. */
  settleMs?: number;
  timeout?: number;
  /** Attempts including the first. Only network-ish failures are retried. */
  attempts?: number;
  /** Skip the consent-dialog pass (some pages have none and the check costs ~1.5s). */
  skipConsent?: boolean;
}

export interface PageSession {
  page: Page;
  close(): Promise<void>;
}

/**
 * High-level Chrome driver used by providers: open a page, navigate with retries, and classify
 * what came back (results / captcha / block / dead site).
 */
export class ChromeController {
  private readonly manager: PlaywrightManager;

  constructor(managerOrOptions: PlaywrightManager | BrowserOptions = {}) {
    this.manager =
      managerOrOptions instanceof PlaywrightManager ? managerOrOptions : new PlaywrightManager(managerOrOptions);
  }

  get playwright(): PlaywrightManager {
    return this.manager;
  }

  /** Opens a fresh tab inside the named provider's isolated context. */
  async open(contextName: string): Promise<PageSession> {
    let context: BrowserContext;
    try {
      context = await this.manager.context(contextName);
    } catch (error) {
      throw toAgentError(error, contextName);
    }

    const page = await context.newPage();
    return {
      page,
      close: async () => {
        await page.close().catch(() => undefined);
      },
    };
  }

  /**
   * Navigates and returns once the page has settled. Throws `CaptchaError` /
   * `AutomationBlockedError` when the destination is a wall — callers treat that as
   * "skip this source", never as "try harder".
   */
  async goto(page: Page, url: string, options: NavigateOptions = {}): Promise<void> {
    const attempts = Math.max(1, options.attempts ?? 2);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        log.debug(`goto (${attempt}/${attempts}) ${url}`);
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: options.timeout ?? 45_000,
        });

        if (!options.skipConsent) await dismissConsent(page);
        await dismissModals(page);
        if (options.settleMs) await page.waitForTimeout(options.settleMs);

        await this.assertNotBlocked(page, contextNameOf(url));
        return;
      } catch (error) {
        // A wall is a verdict, not a transient failure: do not burn retries on it.
        if (error instanceof CaptchaError || error instanceof AutomationBlockedError) throw error;
        lastError = error;
        const agentError = toAgentError(error, contextNameOf(url));
        if (!agentError.retryable || attempt === attempts) throw agentError;
        const backoff = 1_000 * 2 ** (attempt - 1);
        log.debug(`navigation failed (${agentError.kind}), retrying in ${backoff}ms`);
        await page.waitForTimeout(backoff);
      }
    }

    throw toAgentError(lastError, contextNameOf(url));
  }

  /** Inspects the current page for CAPTCHA / block walls. */
  async assertNotBlocked(page: Page, source: string): Promise<void> {
    const verdict = await this.classify(page);
    if (verdict === 'captcha') {
      await debugShot(page, `${source}-captcha`);
      throw new CaptchaError(source, page.url());
    }
    if (verdict === 'blocked') {
      await debugShot(page, `${source}-blocked`);
      throw new AutomationBlockedError(source, page.url());
    }
  }

  async classify(page: Page): Promise<'ok' | 'captcha' | 'blocked'> {
    let html = '';
    try {
      // Reading the whole DOM is wasteful; the markers all live in the title, body text or
      // iframe srcs of the first screenful.
      html = (
        await page.evaluate(() => {
          const title = document.title ?? '';
          const body = document.body?.innerText?.slice(0, 4000) ?? '';
          const frames = Array.from(document.querySelectorAll('iframe'))
            .map((frame) => frame.getAttribute('src') ?? '')
            .join(' ');
          const ids = Array.from(document.querySelectorAll('[id],[class]'))
            .slice(0, 200)
            .map((el) => `${el.id} ${el.className}`)
            .join(' ');
          return `${title}\n${body}\n${frames}\n${ids}`;
        })
      ).toLowerCase();
    } catch {
      return 'ok';
    }

    if (CAPTCHA_MARKERS.some((marker) => html.includes(marker))) return 'captcha';
    if (BLOCK_MARKERS.some((marker) => html.includes(marker))) return 'blocked';
    return 'ok';
  }

  /**
   * Runs `task` against a page in the given context, guaranteeing the tab is closed afterwards.
   * The whole task is bounded by `timeoutMs` so one stuck provider cannot hang the search.
   */
  async withPage<T>(
    contextName: string,
    task: (page: Page) => Promise<T>,
    timeoutMs = 120_000,
  ): Promise<T> {
    const session = await this.open(contextName);
    try {
      return await withTimeout(task(session.page), timeoutMs, contextName);
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.manager.close();
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AgentError('timeout', `${label} kaloi ${Math.round(ms / 1000)}s pa përfunduar.`, { source: label })),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function contextNameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
