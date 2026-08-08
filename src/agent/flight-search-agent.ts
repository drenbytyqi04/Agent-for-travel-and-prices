import { ChromeController } from '../browser/chrome-controller.js';
import type { BrowserOptions } from '../browser/playwright-manager.js';
import { AgentError } from '../errors.js';
import { SessionMemory } from '../memory/session-memory.js';
import {
  describeRequest,
  isRoundTrip,
  validateFlightRequest,
  type FlightRequest,
} from '../models/flight-request.js';
import type { FlightResult, SearchOutcome } from '../models/flight-result.js';
import { createDefaultRegistry, type FlightProvider, type ProviderContext, type ProviderRegistry, type SearchTask } from '../providers/index.js';
import { airportsInCountry, resolveAirport, resolveAirports, type Airport } from '../utils/airports.js';
import { loadRatesFromEnv, type RateTable } from '../utils/currency.js';
import { expandDateWindow, type DatePair } from '../utils/dates.js';
import { createLogger } from '../utils/logger.js';
import { compareResults, cheapestByCity, cheapestByDates, type Comparison, type CityOption, type DateOption } from './price-comparator.js';
import { verifyTopCandidates, type VerificationReport } from './price-verifier.js';

const log = createLogger('agent');

export interface AgentOptions {
  registry?: ProviderRegistry;
  chrome?: ChromeController;
  browser?: BrowserOptions;
  memory?: SessionMemory;
  rates?: RateTable;
  /** Only use these provider ids. */
  only?: string[];
  exclude?: string[];
  /** Max destination airports to try when the user names a country. */
  maxDestinations?: number;
  /** Max date pairs to try when dates are flexible. */
  maxDatePairs?: number;
  /** Providers run concurrently up to this many browser tabs. */
  concurrency?: number;
  /** Wall-clock budget for one provider search, in ms. */
  providerBudgetMs?: number;
  /** Skip the price-verification pass. */
  skipVerification?: boolean;
  /** How many of the cheapest candidates to attempt verification on. */
  verifyAttempts?: number;
  /** Called as the search progresses, for CLI feedback. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  phase: 'planning' | 'searching' | 'comparing' | 'verifying' | 'done';
  message: string;
  completed?: number;
  total?: number;
}

export interface SearchReport {
  request: FlightRequest;
  /** Every provider run, including failures — the audit trail behind the answer. */
  outcomes: SearchOutcome[];
  comparison: Comparison;
  /** Cheapest per destination city; only meaningful for country-wide searches. */
  byCity: CityOption[];
  /** Cheapest per date pair; only meaningful for flexible-date searches. */
  byDate: DateOption[];
  verification?: VerificationReport;
  /** All verification attempts made. */
  verificationReports: VerificationReport[];
  /** Assumptions and warnings to show the user. */
  notes: string[];
  /** Sources that failed, so the answer can say what was and was not consulted. */
  failures: Array<{ source: string; userMessage: string; kind: string }>;
  startedAt: string;
  durationMs: number;
  countryWide: boolean;
  flexibleDates: boolean;
}

/**
 * Orchestrates one search end to end (spec §4):
 * resolve airports → expand destinations and dates → run every provider → compare → verify.
 */
export class FlightSearchAgent {
  private readonly registry: ProviderRegistry;
  private readonly chrome: ChromeController;
  private readonly ownsChrome: boolean;
  readonly memory: SessionMemory;

  constructor(private readonly options: AgentOptions = {}) {
    this.registry = options.registry ?? createDefaultRegistry();
    this.ownsChrome = !options.chrome;
    this.chrome = options.chrome ?? new ChromeController(options.browser ?? {});
    this.memory = options.memory ?? new SessionMemory();
  }

  get providers(): ProviderRegistry {
    return this.registry;
  }

  async search(request: FlightRequest): Promise<SearchReport> {
    const startedAt = new Date();
    const notes: string[] = [];
    validateFlightRequest(request);

    this.progress({ phase: 'planning', message: describeRequest(request) });

    const origin = resolveAirport(request.origin);
    const destinations = this.resolveDestinations(request, notes);
    const datePairs = this.resolveDatePairs(request, notes);

    const tasks = this.buildTasks(request, origin, destinations, datePairs);
    const providers = this.registry.select(request, {
      only: this.options.only,
      exclude: this.options.exclude,
    });

    if (providers.length === 0) {
      throw new AgentError('search_failed', 'Asnjë burim i disponueshëm për këtë kërkesë.', { retryable: false });
    }

    log.info(
      `${tasks.length} kërkime × ${providers.length} burime (${destinations.map((d) => d.iata).join(',')})`,
    );

    const outcomes = await this.runSearches(tasks, providers, request);
    const results = outcomes.flatMap((outcome) => outcome.results);

    this.progress({ phase: 'comparing', message: `${results.length} rezultate të mbledhura` });

    const rates = this.options.rates ?? loadRatesFromEnv();
    const comparison = compareResults(results, { request, rates });

    if (comparison.incomparable.length > 0) {
      notes.push(
        `${comparison.incomparable.length} rezultate u lanë jashtë krahasimit sepse valuta e tyre nuk konvertohej në ${request.currency}.`,
      );
    }

    const report: SearchReport = {
      request,
      outcomes,
      comparison,
      byCity: cheapestByCity(comparison.ranked),
      byDate: cheapestByDates(comparison.ranked),
      verificationReports: [],
      notes,
      failures: outcomes
        .filter((outcome) => outcome.error)
        .map((outcome) => ({
          source: outcome.source,
          userMessage: outcome.error!.userMessage,
          kind: outcome.error!.kind,
        })),
      startedAt: startedAt.toISOString(),
      durationMs: 0,
      countryWide: Boolean(request.destinationCountry && !request.destination),
      flexibleDates: Boolean(request.flexibleDates),
    };

    if (comparison.ranked.length > 0 && !this.options.skipVerification) {
      await this.runVerification(report, request);
    } else if (comparison.ranked.length > 0) {
      notes.push('Verifikimi i çmimit u anashkalua — çmimet janë ato të listuara, jo të verifikuara.');
    }

    report.durationMs = Date.now() - startedAt.getTime();
    this.memory.recordSearch(request);
    this.progress({ phase: 'done', message: `përfundoi për ${Math.round(report.durationMs / 1000)}s` });
    return report;
  }

  /** Expands "Germany" into the airports to actually search (spec §7). */
  private resolveDestinations(request: FlightRequest, notes: string[]): Airport[] {
    if (request.destination) {
      const matches = resolveAirports(request.destination);
      if (matches.length === 0) throw new AgentError('invalid_airport', `Destinacioni "${request.destination}" nuk u njoh.`, { retryable: false });
      // A multi-airport city (London, Milan) is worth searching in full — the price gap is large.
      const sameCity = matches.filter((airport) => airport.city === matches[0]!.city);
      if (sameCity.length > 1) {
        notes.push(`${matches[0]!.city} ka ${sameCity.length} aeroporte — po i krahasoj të gjitha.`);
      }
      return sameCity.slice(0, this.options.maxDestinations ?? 4);
    }

    if (request.destinationCountry) {
      const limit = this.options.maxDestinations ?? 6;
      const airports = airportsInCountry(request.destinationCountry, limit);
      if (airports.length === 0) {
        throw new AgentError('invalid_airport', `Nuk njoh aeroporte për shtetin "${request.destinationCountry}".`, {
          retryable: false,
        });
      }
      notes.push(`Po krahasoj ${airports.length} aeroporte: ${airports.map((a) => `${a.city} (${a.iata})`).join(', ')}.`);
      return airports;
    }

    throw new AgentError('invalid_request', 'Destinacioni mungon.', { retryable: false });
  }

  /** Expands a flexible window into the date pairs to search (spec §8). */
  private resolveDatePairs(request: FlightRequest, notes: string[]): DatePair[] {
    if (request.dateMode === 'exact' && request.departureDate) {
      return [{ departureDate: request.departureDate, returnDate: request.returnDate }];
    }

    if (request.dateWindow) {
      const nights =
        request.tripLengthNights ?? (isRoundTrip(request) ? defaultNightsFor(request) : 0);
      const pairs = expandDateWindow({
        start: request.dateWindow.start,
        end: request.dateWindow.end,
        tripLengthNights: nights,
        maxSamples: this.options.maxDatePairs ?? 5,
      });
      notes.push(
        `Data fleksibile: po provoj ${pairs.length} kombinime midis ${request.dateWindow.start} dhe ${request.dateWindow.end}.`,
      );
      return pairs;
    }

    if (request.departureDate) {
      return [{ departureDate: request.departureDate, returnDate: request.returnDate }];
    }

    throw new AgentError('invalid_date', 'Nuk ka datë ose periudhë për të kërkuar.', { retryable: false });
  }

  private buildTasks(
    request: FlightRequest,
    origin: Airport,
    destinations: Airport[],
    datePairs: DatePair[],
  ): SearchTask[] {
    const tasks: SearchTask[] = [];
    for (const destination of destinations) {
      if (destination.iata === origin.iata) continue;
      for (const pair of datePairs) {
        tasks.push({
          originIata: origin.iata,
          destinationIata: destination.iata,
          departureDate: pair.departureDate,
          returnDate: pair.returnDate,
          passengers: request.passengers,
          cabinClass: request.cabinClass,
          currency: request.currency,
          maxStops: request.maxStops,
          baggage: request.baggage,
          limit: 10,
        });
      }
    }
    return tasks;
  }

  /**
   * Runs every (provider, task) pair with bounded concurrency.
   *
   * Concurrency is capped low on purpose: each unit is a real browser tab, and hammering a flight
   * site in parallel is both slow and the fastest way to get rate-limited into a CAPTCHA.
   */
  private async runSearches(
    tasks: SearchTask[],
    providers: FlightProvider[],
    request: FlightRequest,
  ): Promise<SearchOutcome[]> {
    const units: Array<{ provider: FlightProvider; task: SearchTask }> = [];
    for (const provider of providers) {
      for (const task of tasks) units.push({ provider, task });
    }

    const outcomes: SearchOutcome[] = [];
    const concurrency = Math.max(1, this.options.concurrency ?? 3);
    let index = 0;
    let completed = 0;

    const worker = async (): Promise<void> => {
      while (index < units.length) {
        const unit = units[index++];
        if (!unit) return;

        const context: ProviderContext = {
          chrome: this.chrome,
          logger: log.child(unit.provider.id),
          request,
          budgetMs: this.options.providerBudgetMs ?? 120_000,
        };

        this.progress({
          phase: 'searching',
          message: `${unit.provider.name}: ${unit.task.originIata}→${unit.task.destinationIata} ${unit.task.departureDate}`,
          completed,
          total: units.length,
        });

        const outcome = await unit.provider.runSearch(unit.task, context);
        outcomes.push(outcome);
        completed++;
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, units.length) }, worker));
    return outcomes;
  }

  private async runVerification(report: SearchReport, request: FlightRequest): Promise<void> {
    const attempts = this.options.verifyAttempts ?? 2;
    const entries = report.comparison.ranked.slice(0, attempts);
    this.progress({ phase: 'verifying', message: `po verifikoj ${entries.length} ofertën/at më të lira` });

    const { reports, verified } = await verifyTopCandidates(
      entries.map((entry) => entry.result),
      (source) => this.registry.get(source),
      { chrome: this.chrome, request, maxAttempts: attempts },
    );

    report.verificationReports = reports;
    report.verification = verified ?? reports[0];

    // Fold the verified price back into the ranking so the recommendation reflects reality.
    // Reports come back in candidate order, so the nth report belongs to the nth ranked entry.
    if (verified) {
      const entry = entries[reports.indexOf(verified)];
      if (entry) {
        entry.result = verified.result;
        if (verified.result.currency.toUpperCase() === request.currency.toUpperCase()) {
          entry.comparablePrice = verified.result.totalPrice;
        }
        report.comparison.ranked.sort((a, b) => a.comparablePrice - b.comparablePrice);
        report.comparison.cheapest = report.comparison.ranked[0];
        report.byCity = cheapestByCity(report.comparison.ranked);
        report.byDate = cheapestByDates(report.comparison.ranked);
      }
    }

    for (const entry of reports) report.notes.push(...entry.notes);
  }

  private progress(event: ProgressEvent): void {
    this.options.onProgress?.(event);
  }

  /** Releases the browser. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.ownsChrome) await this.chrome.close();
  }
}

/** Sensible default trip length when the user implied a round trip without saying how long. */
function defaultNightsFor(request: FlightRequest): number {
  return request.tripLengthNights ?? 5;
}

export type { FlightResult };
