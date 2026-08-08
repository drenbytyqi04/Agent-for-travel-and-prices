import type { CabinClass, FlightRequest } from '../models/flight-request.js';

/**
 * Preferences remembered for the duration of a session (spec §10).
 *
 * Scope is deliberately narrow: only search preferences, only in memory, never written to disk.
 * Nothing here is personal data — no names, no payment details, no credentials — because the
 * agent has no reason to hold any of that and holding it would be a liability.
 */
export interface Preferences {
  cabinClass?: CabinClass;
  passengers?: number;
  baggage?: boolean;
  maxStops?: number;
  currency?: string;
  /** Default origin, so "find me something to Germany" works after the first search. */
  origin?: string;
  timePreference?: { earliest?: string; latest?: string };
}

const PREFERENCE_LABELS: Record<keyof Preferences, string> = {
  cabinClass: 'klasa',
  passengers: 'udhëtarë',
  baggage: 'bagazhi',
  maxStops: 'ndalesat',
  currency: 'valuta',
  origin: 'origjina',
  timePreference: 'orari',
};

export class SessionMemory {
  private preferences: Preferences = {};
  private readonly history: FlightRequest[] = [];

  /** Merges explicitly-stated preferences. Only defined values overwrite. */
  remember(preferences: Preferences): void {
    for (const [key, value] of Object.entries(preferences) as Array<[keyof Preferences, unknown]>) {
      if (value === undefined || value === null) continue;
      (this.preferences as Record<string, unknown>)[key] = value;
    }
  }

  get(): Readonly<Preferences> {
    return { ...this.preferences };
  }

  /**
   * Fills gaps in a freshly-parsed request from memory.
   * A value the user stated in *this* request always wins — memory only fills what is absent.
   */
  applyTo(request: FlightRequest, statedFields: ReadonlySet<string> = new Set()): FlightRequest {
    const merged: FlightRequest = { ...request };
    const prefs = this.preferences;

    if (!statedFields.has('cabinClass') && prefs.cabinClass) merged.cabinClass = prefs.cabinClass;
    if (!statedFields.has('passengers') && prefs.passengers) merged.passengers = prefs.passengers;
    if (!statedFields.has('baggage') && prefs.baggage !== undefined) merged.baggage = prefs.baggage;
    if (!statedFields.has('maxStops') && prefs.maxStops !== undefined) merged.maxStops = prefs.maxStops;
    if (!statedFields.has('currency') && prefs.currency) merged.currency = prefs.currency;
    if (!statedFields.has('origin') && !merged.origin && prefs.origin) merged.origin = prefs.origin;
    if (!statedFields.has('timePreference') && prefs.timePreference && !merged.timePreference) {
      merged.timePreference = prefs.timePreference;
    }
    return merged;
  }

  /** Records a completed request so follow-ups like "and the same in October" have a base. */
  recordSearch(request: FlightRequest): void {
    this.history.push(request);
    if (this.history.length > 20) this.history.shift();
    this.remember({
      cabinClass: request.cabinClass,
      passengers: request.passengers,
      currency: request.currency,
      origin: request.origin,
    });
  }

  lastSearch(): FlightRequest | undefined {
    return this.history[this.history.length - 1];
  }

  clear(): void {
    this.preferences = {};
    this.history.length = 0;
  }

  /** Human-readable summary for the CLI's `/prefs` command. */
  describe(): string {
    const entries = Object.entries(this.preferences).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return 'Nuk ka preferenca të ruajtura.';
    return entries
      .map(([key, value]) => {
        const label = PREFERENCE_LABELS[key as keyof Preferences] ?? key;
        const shown =
          typeof value === 'object' && value !== null
            ? Object.entries(value)
                .map(([k, v]) => `${k}=${v}`)
                .join(' ')
            : String(value);
        return `  ${label}: ${shown}`;
      })
      .join('\n');
  }
}
