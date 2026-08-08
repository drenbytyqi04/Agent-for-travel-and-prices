import type { Page } from 'playwright';
import type { ChromeController } from '../browser/chrome-controller.js';
import { AgentError, toAgentError } from '../errors.js';
import type { CabinClass, FlightRequest } from '../models/flight-request.js';
import type { FlightResult, SearchOutcome } from '../models/flight-result.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * One concrete origin→destination→dates search. The agent explodes a `FlightRequest` (which may
 * name a whole country and a flexible month) into many of these.
 */
export interface SearchTask {
  originIata: string;
  destinationIata: string;
  /** ISO YYYY-MM-DD. */
  departureDate: string;
  /** ISO YYYY-MM-DD, absent for one-way. */
  returnDate?: string;
  passengers: number;
  cabinClass: CabinClass;
  currency: string;
  maxStops?: number;
  baggage?: boolean;
  /** Cap on results to read from the page. */
  limit?: number;
}

export interface ProviderCapabilities {
  /** Can open an offer and read a confirmed price. */
  priceVerification: boolean;
  /** Reports whether checked baggage is included. */
  baggageInfo: boolean;
  /** Yields a link to the airline/OTA rather than only a search URL. */
  directBookingLinks: boolean;
  /** Handles round-trip searches (some airline sites are one-way only). */
  roundTrip: boolean;
}

export interface FlightProvider {
  /** Stable id used in results, logs and CLI flags. */
  readonly id: string;
  /** Human-readable name shown to the user. */
  readonly name: string;
  /** Lower runs first; the agent uses this to pick the MVP source before the fallbacks. */
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;

  /** URL that reproduces this search in a normal browser. Must never be a bare homepage. */
  buildSearchUrl(task: SearchTask): string;

  /** Runs one search. Implementations should throw `AgentError`; the base class wraps the rest. */
  search(task: SearchTask, context: ProviderContext): Promise<FlightResult[]>;

  /**
   * Search wrapped so it never throws — the agent calls this one. `BaseProvider` implements it in
   * terms of `search`, which is why providers only have to write the happy path.
   */
  runSearch(task: SearchTask, context: ProviderContext): Promise<SearchOutcome>;

  /**
   * Opens a result and re-reads its price. Implemented only when
   * `capabilities.priceVerification` is true.
   */
  verify?(result: FlightResult, context: ProviderContext): Promise<VerificationOutcome>;

  /** True when this provider can serve the request at all (e.g. airline sites only fly their routes). */
  supports?(request: FlightRequest): boolean;
}

export interface ProviderContext {
  chrome: ChromeController;
  logger: Logger;
  /** Original user request, for providers that need preferences beyond the task. */
  request: FlightRequest;
  /** Wall-clock budget for this provider's whole search, in ms. */
  budgetMs: number;
}

export interface VerificationOutcome {
  /** Price actually shown on the offer page, in `currency`. */
  price?: number;
  currency?: string;
  /** True when the price shown is per traveller. */
  priceIsPerPerson?: boolean;
  taxesIncluded?: boolean;
  baggage?: FlightResult['baggage'];
  /** A more direct link discovered while verifying. */
  bookingUrl?: string;
  /** Set when verification could not read a price. */
  error?: AgentError;
}

/**
 * Shared plumbing: timing, error classification, and turning throws into a `SearchOutcome` so a
 * failing source never aborts the overall search (spec §11).
 */
export abstract class BaseProvider implements FlightProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  readonly priority: number = 50;
  readonly capabilities: ProviderCapabilities = {
    priceVerification: false,
    baggageInfo: false,
    directBookingLinks: false,
    roundTrip: true,
  };

  abstract buildSearchUrl(task: SearchTask): string;
  abstract search(task: SearchTask, context: ProviderContext): Promise<FlightResult[]>;

  protected logger(): Logger {
    return createLogger(this.id);
  }

  /** Never throws. Always returns an outcome describing what happened. */
  async runSearch(task: SearchTask, context: ProviderContext): Promise<SearchOutcome> {
    const startedAt = Date.now();
    const searchUrl = safeUrl(() => this.buildSearchUrl(task));

    try {
      const results = await this.search(task, context);
      return {
        source: this.id,
        results,
        searchUrl,
        durationMs: Date.now() - startedAt,
        ...(results.length === 0
          ? {
              error: describe(
                new AgentError('no_flights_found', `${this.name}: asnjë fluturim për ${task.originIata}→${task.destinationIata} më ${task.departureDate}.`, {
                  source: this.id,
                }),
              ),
            }
          : {}),
      };
    } catch (error) {
      const agentError = toAgentError(error, this.id);
      context.logger.warn(`${this.name} dështoi: ${agentError.kind} — ${agentError.message.split('\n')[0]}`);
      return {
        source: this.id,
        results: [],
        searchUrl,
        error: describe(agentError),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /** Convenience wrapper providers use to get a page bounded by the provider budget. */
  protected withPage<T>(context: ProviderContext, task: (page: Page) => Promise<T>): Promise<T> {
    return context.chrome.withPage(this.id, task, context.budgetMs);
  }
}

function describe(error: AgentError): NonNullable<SearchOutcome['error']> {
  return { kind: error.kind, message: error.message, userMessage: error.userMessage };
}

function safeUrl(build: () => string): string | undefined {
  try {
    return build();
  } catch {
    return undefined;
  }
}

/** Ordered collection of providers, with enable/disable by id. */
export class ProviderRegistry {
  private readonly providers = new Map<string, FlightProvider>();

  register(provider: FlightProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): FlightProvider | undefined {
    return this.providers.get(id);
  }

  /** All providers, cheapest-to-run first. */
  all(): FlightProvider[] {
    return [...this.providers.values()].sort((a, b) => a.priority - b.priority);
  }

  ids(): string[] {
    return this.all().map((provider) => provider.id);
  }

  /**
   * Providers to use for a request: filtered to `only` when given, minus `exclude`, minus any
   * that declare they cannot serve the request.
   */
  select(request: FlightRequest, options: { only?: string[]; exclude?: string[] } = {}): FlightProvider[] {
    const only = options.only?.map((id) => id.toLowerCase());
    const exclude = new Set(options.exclude?.map((id) => id.toLowerCase()) ?? []);

    return this.all().filter((provider) => {
      if (exclude.has(provider.id)) return false;
      if (only && !only.includes(provider.id)) return false;
      if (provider.supports && !provider.supports(request)) return false;
      return true;
    });
  }
}
