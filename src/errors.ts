/**
 * Typed errors for every failure mode the agent is expected to survive.
 *
 * The rule across the codebase: a provider failure is never fatal. It is turned into an
 * `AgentError`, attached to the provider's `SearchOutcome`, and the search continues with the
 * remaining sources. Only `InvalidRequestError` (bad user input) is surfaced before any search runs.
 */

export type ErrorKind =
  | 'website_unavailable'
  | 'captcha'
  | 'timeout'
  | 'search_failed'
  | 'no_flights_found'
  | 'price_changed'
  | 'price_unverifiable'
  | 'currency_unavailable'
  | 'invalid_airport'
  | 'invalid_date'
  | 'invalid_request'
  | 'automation_blocked'
  | 'booking_url_unavailable'
  | 'browser_unavailable'
  | 'unknown';

export class AgentError extends Error {
  readonly kind: ErrorKind;
  /** Source/provider the failure came from, when applicable. */
  readonly source?: string;
  /** True when retrying the same operation later could plausibly succeed. */
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    kind: ErrorKind,
    message: string,
    options: { source?: string; retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AgentError';
    this.kind = kind;
    this.source = options.source;
    this.retryable = options.retryable ?? RETRYABLE_KINDS.has(kind);
    this.details = options.details;
  }

  /** Short, user-facing Albanian explanation of the failure. */
  get userMessage(): string {
    const where = this.source ? ` (${this.source})` : '';
    return `${USER_MESSAGES[this.kind]}${where}`;
  }

  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      message: this.message,
      source: this.source,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

const RETRYABLE_KINDS = new Set<ErrorKind>([
  'website_unavailable',
  'timeout',
  'search_failed',
  'unknown',
]);

const USER_MESSAGES: Record<ErrorKind, string> = {
  website_unavailable: 'Faqja nuk është e disponueshme për momentin.',
  captcha: 'Faqja kërkoi verifikim CAPTCHA — kërkimi u ndal këtu, po vazhdoj me burim tjetër.',
  timeout: 'Kërkimi zgjati shumë dhe u ndërpre.',
  search_failed: 'Kërkimi i fluturimeve dështoi.',
  no_flights_found: 'Nuk u gjet asnjë fluturim për këto kritere.',
  price_changed: 'Çmimi ndryshoi gjatë verifikimit.',
  price_unverifiable: 'Çmimi nuk mund të verifikohej në mënyrë të sigurt.',
  currency_unavailable: 'Valuta e kërkuar nuk është e disponueshme në këtë burim.',
  invalid_airport: 'Aeroporti i dhënë nuk u njoh.',
  invalid_date: 'Data e dhënë nuk është e vlefshme.',
  invalid_request: 'Kërkesa nuk është e plotë ose e vlefshme.',
  automation_blocked: 'Faqja bllokoi automatizimin — po vazhdoj me burim tjetër.',
  booking_url_unavailable: 'Linku i rezervimit nuk mund të ruhej.',
  browser_unavailable: 'Browser-i nuk mund të hapej.',
  unknown: 'Ndodhi një gabim i papritur.',
};

export class InvalidRequestError extends AgentError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('invalid_request', message, { retryable: false, details });
    this.name = 'InvalidRequestError';
  }
}

export class InvalidAirportError extends AgentError {
  constructor(value: string) {
    super('invalid_airport', `Aeroporti/qyteti "${value}" nuk u njoh.`, {
      retryable: false,
      details: { value },
    });
    this.name = 'InvalidAirportError';
  }
}

export class InvalidDateError extends AgentError {
  constructor(value: string, reason?: string) {
    super('invalid_date', `Data "${value}" nuk është e vlefshme${reason ? `: ${reason}` : ''}.`, {
      retryable: false,
      details: { value, reason },
    });
    this.name = 'InvalidDateError';
  }
}

export class CaptchaError extends AgentError {
  constructor(source: string, url?: string) {
    super('captcha', `${source} kërkoi CAPTCHA. Nuk tentohet anashkalim.`, {
      source,
      retryable: false,
      details: { url },
    });
    this.name = 'CaptchaError';
  }
}

export class AutomationBlockedError extends AgentError {
  constructor(source: string, url?: string) {
    super('automation_blocked', `${source} bllokoi automatizimin.`, {
      source,
      retryable: false,
      details: { url },
    });
    this.name = 'AutomationBlockedError';
  }
}

/** Normalises anything thrown into an `AgentError` without losing the original cause. */
export function toAgentError(error: unknown, source?: string): AgentError {
  if (error instanceof AgentError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  let kind: ErrorKind = 'unknown';
  if (lower.includes('timeout') || lower.includes('timed out')) kind = 'timeout';
  else if (
    lower.includes('net::err') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('socket hang up')
  ) {
    kind = 'website_unavailable';
  } else if (lower.includes('executable doesn') || lower.includes('browsertype.launch')) {
    kind = 'browser_unavailable';
  }

  return new AgentError(kind, message, { source, cause: error });
}
