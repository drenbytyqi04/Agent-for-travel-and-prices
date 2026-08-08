import {
  createFlightRequest,
  missingFields,
  MISSING_FIELD_QUESTIONS,
  validateFlightRequest,
  type CabinClass,
  type FlightRequest,
  type MissingField,
} from '../models/flight-request.js';
import { SessionMemory } from '../memory/session-memory.js';
import { COUNTRY_NAMES, resolveAirportsExact, resolveCountry, type Airport } from '../utils/airports.js';
import {
  addDays,
  addMonths,
  compareIso,
  deaccent,
  endOfMonth,
  isIsoDate,
  monthFromName,
  nextWeekday,
  startOfMonth,
  todayIso,
  weekdayFromName,
} from '../utils/dates.js';

/**
 * Rule-based natural-language planner (spec §15).
 *
 * Everything the agent needs is extracted deterministically from Albanian or English text; there
 * is no model call on the default path, so the agent works offline and its behaviour is testable.
 * `llm-planner.ts` layers an optional Claude call on top for phrasings these rules do not cover.
 */

export interface PlanResult {
  request: FlightRequest;
  /** Fields the user must still supply before a search can run. */
  missing: MissingField[];
  /** The single question to ask when something is missing. */
  question?: string;
  /** Fields the user stated explicitly this turn (as opposed to filled from memory/defaults). */
  stated: Set<string>;
  /** Assumptions worth surfacing, e.g. "muaji u interpretua si Shtator 2026". */
  notes: string[];
  /** True when the user named a country rather than a city — triggers the multi-airport fan-out. */
  countryWide: boolean;
}

export interface PlannerOptions {
  today?: string;
  memory?: SessionMemory;
  /** Default origin when the text names none and memory is empty. */
  defaultOrigin?: string;
  defaultCurrency?: string;
}

export class Planner {
  constructor(private readonly options: PlannerOptions = {}) {}

  private get today(): string {
    return this.options.today ?? todayIso();
  }

  plan(text: string): PlanResult {
    const today = this.today;
    const normalised = deaccent(text).toLowerCase();
    const stated = new Set<string>();
    const notes: string[] = [];

    const places = extractPlaces(text, normalised);
    const dates = extractDates(text, normalised, today, notes);
    const passengers = extractPassengers(normalised);
    const cabinClass = extractCabinClass(normalised);
    const maxStops = extractMaxStops(normalised);
    const baggage = extractBaggage(normalised);
    const timePreference = extractTimePreference(normalised);
    const currency = extractCurrency(normalised) ?? this.options.defaultCurrency;

    let request = createFlightRequest({
      origin: places.origin ?? this.options.defaultOrigin ?? '',
      rawQuery: text,
    });

    if (places.origin) stated.add('origin');
    if (places.destination) {
      request.destination = places.destination;
      stated.add('destination');
    }
    if (places.destinationCountry) {
      request.destinationCountry = places.destinationCountry;
      stated.add('destination');
    }

    request.dateMode = dates.mode;
    if (dates.departureDate) request.departureDate = dates.departureDate;
    if (dates.returnDate) request.returnDate = dates.returnDate;
    if (dates.window) request.dateWindow = dates.window;
    if (dates.tripLengthNights !== undefined) request.tripLengthNights = dates.tripLengthNights;
    request.flexibleDates = dates.mode === 'flexible_month' || dates.mode === 'flexible_range';
    if (dates.mode !== 'unspecified') stated.add('dates');

    if (passengers !== undefined) {
      request.passengers = passengers;
      stated.add('passengers');
    }
    if (cabinClass) {
      request.cabinClass = cabinClass;
      stated.add('cabinClass');
    }
    if (maxStops !== undefined) {
      request.maxStops = maxStops;
      stated.add('maxStops');
    }
    if (baggage !== undefined) {
      request.baggage = baggage;
      stated.add('baggage');
    }
    if (timePreference) {
      request.timePreference = timePreference;
      stated.add('timePreference');
    }
    if (currency) {
      request.currency = currency;
      stated.add('currency');
    }

    // Memory fills only what this turn left unstated (spec §10).
    if (this.options.memory) request = this.options.memory.applyTo(request, stated);

    const missing = missingFields(request);
    const result: PlanResult = {
      request,
      missing,
      stated,
      notes,
      countryWide: Boolean(request.destinationCountry && !request.destination),
    };
    if (missing.length > 0) {
      result.question = MISSING_FIELD_QUESTIONS[missing[0]!];
      return result;
    }

    validateFlightRequest(request, today);
    return result;
  }
}

// ── Places ─────────────────────────────────────────────────────────────────────────────────────

interface PlaceExtraction {
  origin?: string;
  destination?: string;
  destinationCountry?: string;
}

const ORIGIN_MARKERS = ['nga', 'prej', 'from'];
const DESTINATION_MARKERS = ['per ne', 'per te', 'per', 'ne', 'drejt', 'to', 'into', 'toward'];

interface Mention {
  /** Character index in the normalised text. */
  index: number;
  /** Matched surface text. */
  text: string;
  airports: Airport[];
  country?: string;
  /** Marker word immediately before the mention, if any. */
  marker?: 'origin' | 'destination';
}

/**
 * Scans the text for every known city/airport/country, then assigns roles by the preposition
 * in front of each mention. Working from mentions outward (rather than parsing prepositions
 * forward) is what makes "nga Prishtina për në Gjermani" and "Berlin nga Prishtina" both work.
 */
function extractPlaces(original: string, normalised: string): PlaceExtraction {
  const mentions = findMentions(normalised);
  if (mentions.length === 0) return {};

  const originMention = mentions.find((mention) => mention.marker === 'origin');
  const destinationMentions = mentions.filter((mention) => mention !== originMention);

  const destinationMention =
    destinationMentions.find((mention) => mention.marker === 'destination') ?? destinationMentions[0];

  const result: PlaceExtraction = {};
  if (originMention) result.origin = originMention.text;

  if (destinationMention) {
    if (destinationMention.country) result.destinationCountry = destinationMention.country;
    else result.destination = destinationMention.text;
  }

  // "Berlin nga Prishtina" — a leading mention with no marker is the destination when the only
  // marked mention is the origin. Already handled above; nothing more to do.
  void original;
  return result;
}

function findMentions(normalised: string): Mention[] {
  const tokens = tokenise(normalised);
  const mentions: Mention[] = [];
  const consumed = new Set<number>();

  // Longest n-gram first so "mal i zi" and "baden baden" beat their single-word prefixes.
  for (let size = 3; size >= 1; size--) {
    for (let i = 0; i + size <= tokens.length; i++) {
      if (Array.from({ length: size }, (_, k) => i + k).some((index) => consumed.has(index))) continue;

      const slice = tokens.slice(i, i + size);
      const phrase = slice.map((token) => token.text).join(' ');
      if (STOPWORDS.has(phrase)) continue;

      const country = resolveCountry(phrase);
      const airports = country ? [] : resolveAirportsExact(phrase);
      if (!country && airports.length === 0) continue;

      for (let k = 0; k < size; k++) consumed.add(i + k);
      mentions.push({
        index: slice[0]!.index,
        text: phrase,
        airports,
        country,
        marker: markerBefore(tokens, i),
      });
    }
  }

  return mentions.sort((a, b) => a.index - b.index);
}

function markerBefore(tokens: Token[], mentionStart: number): 'origin' | 'destination' | undefined {
  // Look back up to two tokens: "per ne Gjermani", "nga Prishtina".
  const previous = [tokens[mentionStart - 2]?.text, tokens[mentionStart - 1]?.text].filter(Boolean) as string[];
  if (previous.length === 0) return undefined;

  const one = previous[previous.length - 1]!;
  const two = previous.length > 1 ? `${previous[0]} ${one}` : one;

  if (ORIGIN_MARKERS.includes(one)) return 'origin';
  if (DESTINATION_MARKERS.includes(two) || DESTINATION_MARKERS.includes(one)) return 'destination';
  return undefined;
}

interface Token {
  text: string;
  index: number;
}

function tokenise(normalised: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[a-z0-9]+/g;
  for (const match of normalised.matchAll(pattern)) {
    tokens.push({ text: match[0], index: match.index });
  }
  return tokens;
}

/** Words that resolve to a place but almost never mean one in these sentences. */
const STOPWORDS = new Set(['maj', 'mars', 'bar', 'nis', 'me', 'te', 'e', 'i']);

// ── Dates ──────────────────────────────────────────────────────────────────────────────────────

interface DateExtraction {
  mode: FlightRequest['dateMode'];
  departureDate?: string;
  returnDate?: string;
  window?: { start: string; end: string };
  tripLengthNights?: number;
}

const RETURN_MARKERS = /(kthim\w*|kthehem|return|coming back|back on|inbound)/;

/**
 * Parses everything date-shaped: explicit dates, month names, relative expressions
 * ("muajin tjetër"), weekdays ("të premten"), and trip lengths ("për 4 ditë").
 */
function extractDates(original: string, normalised: string, today: string, notes: string[]): DateExtraction {
  const tripLengthNights = extractTripLength(normalised);
  const returnMarkerIndex = normalised.search(RETURN_MARKERS);

  const explicit = findExplicitDates(normalised, today);
  if (explicit.length > 0) {
    const departure = explicit[0]!;
    // A date appearing after "kthimin"/"return" is the inbound one.
    const inbound = explicit.find(
      (candidate) => returnMarkerIndex >= 0 && candidate.index > returnMarkerIndex && candidate.iso !== departure.iso,
    );
    const second = inbound ?? (explicit.length > 1 ? explicit[1] : undefined);

    // "nga 15 deri 20 shtator" is a flexible window, not a fixed round trip.
    if (!inbound && second && /\b(deri|nder|between|to|until|derisa)\b/.test(normalised) && !RETURN_MARKERS.test(normalised)) {
      return {
        mode: 'flexible_range',
        window: { start: departure.iso, end: second.iso },
        tripLengthNights,
      };
    }

    const result: DateExtraction = { mode: 'exact', departureDate: departure.iso };
    if (second && compareIso(second.iso, departure.iso) >= 0) result.returnDate = second.iso;
    else if (tripLengthNights) result.returnDate = addDays(departure.iso, tripLengthNights);
    if (tripLengthNights !== undefined) result.tripLengthNights = tripLengthNights;
    return result;
  }

  const weekdays = findWeekdays(normalised, today, returnMarkerIndex);
  if (weekdays.departureDate) {
    notes.push(
      `Ditët e javës u interpretuan si data më të afërta: ${weekdays.departureDate}` +
        (weekdays.returnDate ? ` → ${weekdays.returnDate}` : ''),
    );
    const result: DateExtraction = { mode: 'exact', departureDate: weekdays.departureDate };
    if (weekdays.returnDate) result.returnDate = weekdays.returnDate;
    else if (tripLengthNights) result.returnDate = addDays(weekdays.departureDate, tripLengthNights);
    if (tripLengthNights !== undefined) result.tripLengthNights = tripLengthNights;
    return result;
  }

  const window = findMonthOrRelativeWindow(normalised, today, notes);
  if (window) {
    return { mode: window.mode, window: window.range, tripLengthNights };
  }

  // "gjeje datat më të lira" / "for 4 days" with no period named: the user is telling us the
  // dates are ours to choose, so search a bounded near-term window rather than stopping to ask.
  if (wantsFlexibleDates(normalised) || tripLengthNights !== undefined) {
    const start = addDays(today, DEFAULT_FLEX_LEAD_DAYS);
    const end = addDays(start, DEFAULT_FLEX_SPAN_DAYS);
    notes.push(`Nuk u dha periudhë — po kërkoj data fleksibile ${start} … ${end}.`);
    return { mode: 'flexible_range', window: { start, end }, tripLengthNights };
  }

  return { mode: 'unspecified', tripLengthNights };
}

/** Start the flexible window a week out; fares within a few days are rarely the cheap ones. */
const DEFAULT_FLEX_LEAD_DAYS = 7;
const DEFAULT_FLEX_SPAN_DAYS = 60;

function wantsFlexibleDates(normalised: string): boolean {
  return /\b(datat?\s+me\s+t[e]?\s*lir\w*|data\s+fleksibile|fleksibil\w*|kur\s+eshte\s+me\s+lir\w*|cheapest\s+dates?|flexible\s+dates?|any\s+dates?|whenever)\b/.test(
    normalised,
  );
}

interface DateMention {
  index: number;
  iso: string;
}

/**
 * Finds concrete dates: ISO, `15/09/2026`, `15.09`, `15 shtator [2026]`, `September 15`.
 * A date without a year is resolved to the next occurrence at or after today.
 */
function findExplicitDates(normalised: string, today: string): DateMention[] {
  const found: DateMention[] = [];
  const claimed: Array<[number, number]> = [];

  const claim = (start: number, end: number): boolean => {
    if (claimed.some(([from, to]) => start < to && end > from)) return false;
    claimed.push([start, end]);
    return true;
  };

  // ISO first — unambiguous.
  for (const match of normalised.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const iso = match[0];
    if (isIsoDate(iso) && claim(match.index, match.index + iso.length)) {
      found.push({ index: match.index, iso });
    }
  }

  // dd/mm[/yyyy] and dd.mm[.yyyy] — day-first, the convention in Kosovo and across Europe.
  for (const match of normalised.matchAll(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/g)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;
    if (!claim(match.index, match.index + match[0].length)) continue;
    const year = match[3] ? normaliseYear(Number(match[3])) : undefined;
    const iso = resolveYear(day, month, year, today);
    if (iso) found.push({ index: match.index, iso });
  }

  // "15 shtator 2026" / "15 shtator"
  for (const match of normalised.matchAll(/\b(\d{1,2})\s+([a-z]{3,12})(?:\s+(\d{4}))?\b/g)) {
    const month = monthFromName(match[2] ?? '');
    if (!month) continue;
    if (!claim(match.index, match.index + match[0].length)) continue;
    const iso = resolveYear(Number(match[1]), month, match[3] ? Number(match[3]) : undefined, today);
    if (iso) found.push({ index: match.index, iso });
  }

  // "september 15" / "shtator 15"
  for (const match of normalised.matchAll(/\b([a-z]{3,12})\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/g)) {
    const month = monthFromName(match[1] ?? '');
    if (!month) continue;
    if (!claim(match.index, match.index + match[0].length)) continue;
    const iso = resolveYear(Number(match[2]), month, match[3] ? Number(match[3]) : undefined, today);
    if (iso) found.push({ index: match.index, iso });
  }

  return found.sort((a, b) => a.index - b.index);
}

function normaliseYear(value: number): number {
  return value < 100 ? 2000 + value : value;
}

/** Builds an ISO date, rolling to next year when the day/month has already passed. */
function resolveYear(day: number, month: number, year: number | undefined, today: string): string | undefined {
  if (day < 1 || day > 31 || month < 1 || month > 12) return undefined;

  const build = (y: number): string | undefined => {
    const iso = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return isIsoDate(iso) ? iso : undefined;
  };

  if (year) return build(year);

  const currentYear = Number(today.slice(0, 4));
  const thisYear = build(currentYear);
  if (thisYear && compareIso(thisYear, today) >= 0) return thisYear;
  return build(currentYear + 1);
}

function findWeekdays(
  normalised: string,
  today: string,
  returnMarkerIndex: number,
): { departureDate?: string; returnDate?: string } {
  const mentions: Array<{ index: number; weekday: number }> = [];
  for (const match of normalised.matchAll(/\b(?:te\s+|ne\s+|on\s+|next\s+)?(e\s+)?([a-z]{3,10})\b/g)) {
    const weekday = weekdayFromName(match[2] ?? '');
    if (weekday === undefined) continue;
    mentions.push({ index: match.index, weekday });
  }
  if (mentions.length === 0) return {};

  const departure = nextWeekday(today, mentions[0]!.weekday);
  const inbound =
    mentions.find((mention) => returnMarkerIndex >= 0 && mention.index > returnMarkerIndex) ?? mentions[1];

  const result: { departureDate?: string; returnDate?: string } = { departureDate: departure };
  if (inbound) result.returnDate = nextWeekday(departure, inbound.weekday, false);
  return result;
}

/** "gjatë shtatorit", "në tetor", "muajin tjetër", "javën tjetër", "next month". */
function findMonthOrRelativeWindow(
  normalised: string,
  today: string,
  notes: string[],
): { mode: FlightRequest['dateMode']; range: { start: string; end: string } } | undefined {
  if (/\b(muajin\s+(tjeter|e\s+ardhshem|ardhshem)|next\s+month)\b/.test(normalised)) {
    const target = addMonths(`${today.slice(0, 8)}01`, 1);
    const year = Number(target.slice(0, 4));
    const month = Number(target.slice(5, 7));
    notes.push(`"Muajin tjetër" u interpretua si ${month}/${year}.`);
    return { mode: 'flexible_month', range: { start: startOfMonth(year, month), end: endOfMonth(year, month) } };
  }

  if (/\b(javen\s+(tjeter|e\s+ardhshme)|next\s+week)\b/.test(normalised)) {
    const start = addDays(today, 7);
    notes.push(`"Javën tjetër" u interpretua si ${start} … ${addDays(start, 6)}.`);
    return { mode: 'flexible_range', range: { start, end: addDays(start, 6) } };
  }

  if (/\b(kete\s+muaj|this\s+month)\b/.test(normalised)) {
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    return { mode: 'flexible_month', range: { start: today, end: endOfMonth(year, month) } };
  }

  // Bare month name, optionally with a year: "gjatë shtatorit", "in October", "shtator 2027".
  for (const match of normalised.matchAll(/\b([a-z]{3,12})\b(?:\s+(\d{4}))?/g)) {
    const word = match[1] ?? '';
    const month = monthFromName(word);
    if (!month) continue;
    // A word that also names a place is far more likely to be the destination than a month.
    if (resolveAirportsExact(word).length > 0 || resolveCountry(word)) continue;

    const currentYear = Number(today.slice(0, 4));
    const currentMonth = Number(today.slice(5, 7));

    // An explicitly stated year always wins; only guess when the user left it out.
    const stated = match[2] ? Number(match[2]) : undefined;
    const year = stated ?? (month >= currentMonth ? currentYear : currentYear + 1);
    if (year < currentYear || (year === currentYear && month < currentMonth)) continue;

    const start = year === currentYear && month === currentMonth ? today : startOfMonth(year, month);
    notes.push(`Muaji u interpretua si ${month}/${year}.`);
    return { mode: 'flexible_month', range: { start, end: endOfMonth(year, month) } };
  }

  return undefined;
}

/** "për 4 ditë", "4 nights", "një javë" → nights away. */
function extractTripLength(normalised: string): number | undefined {
  const numeric = normalised.match(/\b(\d{1,2})\s*(dite|ditesh|dit|nete|net|days?|nights?)\b/);
  if (numeric?.[1]) {
    const value = Number(numeric[1]);
    const unit = numeric[2] ?? '';
    // "4 ditë" colloquially means 4 days away → 3 nights would be pedantic; travellers mean 4.
    return /net|night/.test(unit) ? value : value;
  }

  if (/\b(nje\s+jave|a\s+week|one\s+week)\b/.test(normalised)) return 7;
  if (/\b(dy\s+jave|two\s+weeks)\b/.test(normalised)) return 14;
  if (/\b(fundjave|weekend)\b/.test(normalised)) return 2;
  return undefined;
}

// ── Simple attributes ──────────────────────────────────────────────────────────────────────────

const WORD_NUMBERS: Record<string, number> = {
  nje: 1, dy: 2, tre: 3, kater: 4, pese: 5, gjashte: 6, shtate: 7, tete: 8, nente: 9,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};

function extractPassengers(normalised: string): number | undefined {
  const numeric = normalised.match(
    /\b(\d{1,2})\s*(persona|person|veta|udhetare|udhetar|pasagjere|pasagjer|adults?|people|passengers?|pax)\b/,
  );
  if (numeric?.[1]) return clampPassengers(Number(numeric[1]));

  const worded = normalised.match(
    /\b(nje|dy|tre|kater|pese|gjashte|shtate|tete|nente|one|two|three|four|five|six|seven|eight|nine)\s*(persona|person|veta|udhetare|udhetar|adults?|people|passengers?)\b/,
  );
  if (worded?.[1] && WORD_NUMBERS[worded[1]]) return clampPassengers(WORD_NUMBERS[worded[1]]!);

  if (/\b(vetem\s+une|only\s+me|just\s+me|per\s+vete)\b/.test(normalised)) return 1;
  return undefined;
}

function clampPassengers(value: number): number | undefined {
  return Number.isInteger(value) && value >= 1 && value <= 9 ? value : undefined;
}

function extractCabinClass(normalised: string): CabinClass | undefined {
  if (/\b(first\s*class|klasa\s*e\s*pare)\b/.test(normalised)) return 'first';
  if (/\b(business|biznes)\b/.test(normalised)) return 'business';
  if (/\b(premium\s*economy|premium)\b/.test(normalised)) return 'premium_economy';
  if (/\b(economy|ekonomik|ekonomike|klase\s*ekonomike)\b/.test(normalised)) return 'economy';
  return undefined;
}

function extractMaxStops(normalised: string): number | undefined {
  if (/\b(vetem\s+direkt|direkt|drejtperdrejt|pa\s+ndalesa|nonstop|non-stop|direct\s+only|only\s+direct)\b/.test(normalised)) {
    return 0;
  }
  const max = normalised.match(/\b(?:maksimum|max|maksimalisht)\s*(\d)\s*(ndales\w*|stops?)\b/);
  if (max?.[1]) return Number(max[1]);
  if (/\b(nuk\s+me\s+intereson\s+ndalesa|any\s+stops)\b/.test(normalised)) return undefined;
  return undefined;
}

function extractBaggage(normalised: string): boolean | undefined {
  if (/\b(pa\s+bagazh|no\s+baggage|without\s+baggage|vetem\s+bagazh\s+dore|hand\s+luggage\s+only)\b/.test(normalised)) {
    return false;
  }
  if (/\b(me\s+bagazh|with\s+baggage|checked\s+bag|bagazh\s+i\s+regjistruar|valixhe)\b/.test(normalised)) return true;
  return undefined;
}

function extractTimePreference(normalised: string): { earliest?: string; latest?: string } | undefined {
  if (/\b(nuk\s+me\s+intereson\s+ora|any\s+time|s'ka\s+rendesi\s+ora)\b/.test(normalised)) return undefined;
  if (/\b(mengjes|herret|early|morning)\b/.test(normalised)) return { earliest: '05:00', latest: '11:00' };
  if (/\b(pasdite|afternoon)\b/.test(normalised)) return { earliest: '12:00', latest: '17:00' };
  if (/\b(mbremje|vone|evening|night|nate)\b/.test(normalised)) return { earliest: '17:00', latest: '23:59' };
  return undefined;
}

function extractCurrency(normalised: string): string | undefined {
  if (/\b(euro|eur|€)\b/.test(normalised)) return 'EUR';
  if (/\b(dollar|usd|\$)\b/.test(normalised)) return 'USD';
  if (/\b(pound|gbp|sterlina)\b/.test(normalised)) return 'GBP';
  if (/\b(franga|chf)\b/.test(normalised)) return 'CHF';
  return undefined;
}

/** Exposed so the CLI can hint at recognised countries when a destination fails to resolve. */
export const KNOWN_COUNTRY_KEYS = Object.keys(COUNTRY_NAMES);
