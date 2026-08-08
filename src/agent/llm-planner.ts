import type { PlanResult, PlannerOptions } from './planner.js';
import { Planner } from './planner.js';
import {
  createFlightRequest,
  missingFields,
  MISSING_FIELD_QUESTIONS,
  validateFlightRequest,
  type CabinClass,
  type FlightRequest,
} from '../models/flight-request.js';
import { resolveCountry } from '../utils/airports.js';
import { isIsoDate, todayIso } from '../utils/dates.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('planner:llm');

/**
 * Optional LLM-backed planner.
 *
 * The rule-based `Planner` handles every phrasing in the spec and runs offline, so it stays the
 * default. This class wraps it: the rules run first, and Claude is consulted only when they come
 * back with something missing — the phrasings that are genuinely hard to pattern-match. If no API
 * key is configured, or the call fails for any reason, the rule-based result is returned as-is.
 *
 * Extraction is done with a forced tool call rather than free-form JSON, so the model's output is
 * schema-validated by the API instead of by a fragile parser on our side.
 */
export class LlmPlanner {
  private readonly fallback: Planner;
  private client?: unknown;
  private clientLoad?: Promise<unknown>;

  constructor(private readonly options: PlannerOptions & { model?: string; apiKey?: string } = {}) {
    this.fallback = new Planner(options);
  }

  get enabled(): boolean {
    return Boolean(this.options.apiKey ?? process.env.ANTHROPIC_API_KEY);
  }

  /** Rule-based plan only — synchronous, always available. */
  planSync(text: string): PlanResult {
    return this.fallback.plan(text);
  }

  async plan(text: string): Promise<PlanResult> {
    const ruleBased = this.fallback.plan(text);
    if (ruleBased.missing.length === 0 || !this.enabled) return ruleBased;

    try {
      const extracted = await this.extract(text);
      if (!extracted) return ruleBased;

      // The rules win wherever they produced a value: they are deterministic and already
      // validated. The model only fills the gaps that made the request unusable.
      const merged = mergeRequests(ruleBased.request, extracted);
      const missing = missingFields(merged);

      const result: PlanResult = {
        request: merged,
        missing,
        stated: ruleBased.stated,
        notes: [...ruleBased.notes, 'Disa fusha u plotësuan nga interpretimi me model gjuhësor.'],
        countryWide: Boolean(merged.destinationCountry && !merged.destination),
      };
      if (missing.length > 0) {
        result.question = MISSING_FIELD_QUESTIONS[missing[0]!];
        return result;
      }

      validateFlightRequest(merged, this.options.today ?? todayIso());
      return result;
    } catch (error) {
      log.warn(`interpretimi me LLM dështoi, po përdor rregullat: ${(error as Error).message}`);
      return ruleBased;
    }
  }

  private async extract(text: string): Promise<Partial<FlightRequest> | undefined> {
    const client = await this.loadClient();
    if (!client) return undefined;

    const today = this.options.today ?? todayIso();
    const response = await (client as AnthropicLike).messages.create({
      model: this.options.model ?? 'claude-opus-5',
      max_tokens: 2048,
      system: SYSTEM_PROMPT.replace('{{TODAY}}', today),
      tools: [FLIGHT_REQUEST_TOOL],
      tool_choice: { type: 'tool', name: FLIGHT_REQUEST_TOOL.name },
      messages: [{ role: 'user', content: text }],
    });

    const block = response.content.find((item) => item.type === 'tool_use');
    if (!block || typeof block.input !== 'object' || block.input === null) return undefined;
    return sanitise(block.input as Record<string, unknown>, today);
  }

  /** Loads the SDK lazily so the package stays an optional dependency. */
  private async loadClient(): Promise<unknown> {
    if (this.client) return this.client;
    if (!this.clientLoad) {
      this.clientLoad = (async () => {
        try {
          const module = (await import('@anthropic-ai/sdk')) as { default: new (options: unknown) => unknown };
          const apiKey = this.options.apiKey ?? process.env.ANTHROPIC_API_KEY;
          this.client = new module.default(apiKey ? { apiKey } : {});
          return this.client;
        } catch (error) {
          log.debug(`@anthropic-ai/sdk nuk u ngarkua: ${(error as Error).message}`);
          return undefined;
        }
      })();
    }
    return this.clientLoad;
  }
}

interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<{ content: Array<{ type: string; input?: unknown }> }>;
  };
}

const SYSTEM_PROMPT = `Ti je një parser kërkesash fluturimi. Sot është {{TODAY}} (ISO).
Nga teksti i përdoruesit (shqip ose anglisht) nxirr një kërkesë fluturimi të strukturuar.

Rregulla:
- Datat gjithmonë ISO YYYY-MM-DD, kurrë në të kaluarën.
- Nëse përdoruesi jep vetëm një shtet, plotëso destinationCountry (kod ISO alpha-2) dhe lëre destination bosh.
- Nëse jep vetëm një muaj ose periudhë, vendos dateMode="flexible_month" ose "flexible_range" dhe plotëso dateWindow.
- Mos shpik data, qytete apo preferenca që nuk janë në tekst. Lëri fushat bosh nëse mungojnë.`;

const FLIGHT_REQUEST_TOOL = {
  name: 'submit_flight_request',
  description: 'Dërgon kërkesën e strukturuar të fluturimit të nxjerrë nga teksti i përdoruesit.',
  input_schema: {
    type: 'object',
    properties: {
      origin: { type: 'string', description: 'Qyteti ose kodi IATA i nisjes.' },
      destination: { type: 'string', description: 'Qyteti ose kodi IATA i destinacionit, nëse u përmend.' },
      destinationCountry: { type: 'string', description: 'Kod shteti ISO alpha-2, p.sh. DE.' },
      departureDate: { type: 'string', description: 'ISO YYYY-MM-DD.' },
      returnDate: { type: 'string', description: 'ISO YYYY-MM-DD. Bosh për one-way.' },
      dateMode: { type: 'string', enum: ['exact', 'flexible_range', 'flexible_month', 'unspecified'] },
      dateWindowStart: { type: 'string', description: 'ISO YYYY-MM-DD, fillimi i periudhës fleksibile.' },
      dateWindowEnd: { type: 'string', description: 'ISO YYYY-MM-DD, fundi i periudhës fleksibile.' },
      tripLengthNights: { type: 'integer', description: 'Netë qëndrimi, nëse u përmend.' },
      passengers: { type: 'integer', description: 'Numri i udhëtarëve (1-9).' },
      cabinClass: { type: 'string', enum: ['economy', 'premium_economy', 'business', 'first'] },
      maxStops: { type: 'integer', description: '0 për vetëm fluturime direkte.' },
      baggage: { type: 'boolean', description: 'True nëse kërkohet bagazh i regjistruar.' },
      currency: { type: 'string', description: 'Kod valute ISO, p.sh. EUR.' },
    },
    required: [],
  },
} as const;

/** Validates and narrows the model's output. Anything unparseable is dropped, never guessed at. */
function sanitise(input: Record<string, unknown>, today: string): Partial<FlightRequest> {
  const result: Partial<FlightRequest> = {};

  const str = (key: string): string | undefined => {
    const value = input[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const date = (key: string): string | undefined => {
    const value = str(key);
    return value && isIsoDate(value) && value >= today ? value : undefined;
  };
  const int = (key: string, min: number, max: number): number | undefined => {
    const value = input[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
  };

  const origin = str('origin');
  if (origin) result.origin = origin;

  const destination = str('destination');
  if (destination) result.destination = destination;

  const country = str('destinationCountry');
  if (country) {
    const resolved = resolveCountry(country);
    if (resolved) result.destinationCountry = resolved;
  }

  const departureDate = date('departureDate');
  if (departureDate) result.departureDate = departureDate;
  const returnDate = date('returnDate');
  if (returnDate) result.returnDate = returnDate;

  const start = date('dateWindowStart');
  const end = date('dateWindowEnd');
  if (start && end && end >= start) result.dateWindow = { start, end };

  const mode = str('dateMode');
  if (mode === 'exact' || mode === 'flexible_range' || mode === 'flexible_month' || mode === 'unspecified') {
    result.dateMode = mode;
    result.flexibleDates = mode === 'flexible_month' || mode === 'flexible_range';
  }

  const nights = int('tripLengthNights', 0, 90);
  if (nights !== undefined) result.tripLengthNights = nights;

  const passengers = int('passengers', 1, 9);
  if (passengers !== undefined) result.passengers = passengers;

  const cabin = str('cabinClass');
  if (cabin && ['economy', 'premium_economy', 'business', 'first'].includes(cabin)) {
    result.cabinClass = cabin as CabinClass;
  }

  const maxStops = int('maxStops', 0, 3);
  if (maxStops !== undefined) result.maxStops = maxStops;

  if (typeof input.baggage === 'boolean') result.baggage = input.baggage;

  const currency = str('currency');
  if (currency && /^[A-Za-z]{3}$/.test(currency)) result.currency = currency.toUpperCase();

  return result;
}

/** Rule-derived values take precedence; the model only supplies what the rules left empty. */
function mergeRequests(base: FlightRequest, extra: Partial<FlightRequest>): FlightRequest {
  const merged = createFlightRequest({ ...base });

  if (!merged.origin?.trim() && extra.origin) merged.origin = extra.origin;
  if (!merged.destination && !merged.destinationCountry) {
    if (extra.destination) merged.destination = extra.destination;
    if (extra.destinationCountry) merged.destinationCountry = extra.destinationCountry;
  }

  if (merged.dateMode === 'unspecified' && extra.dateMode && extra.dateMode !== 'unspecified') {
    merged.dateMode = extra.dateMode;
    merged.flexibleDates = extra.flexibleDates;
    if (extra.departureDate) merged.departureDate = extra.departureDate;
    if (extra.returnDate) merged.returnDate = extra.returnDate;
    if (extra.dateWindow) merged.dateWindow = extra.dateWindow;
  }

  if (merged.tripLengthNights === undefined && extra.tripLengthNights !== undefined) {
    merged.tripLengthNights = extra.tripLengthNights;
  }
  return merged;
}
