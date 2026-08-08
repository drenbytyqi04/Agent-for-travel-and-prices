import { InvalidDateError } from '../errors.js';

/**
 * All date handling is done on plain ISO `YYYY-MM-DD` strings in UTC. Flight dates are calendar
 * dates, not instants — using UTC everywhere avoids the classic "search moved a day back because
 * the host is in UTC-7" bug.
 */

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && toIso(parsed) === value;
}

export function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function fromIso(value: string): Date {
  if (!isIsoDate(value)) throw new InvalidDateError(value, 'formati duhet të jetë YYYY-MM-DD');
  return new Date(`${value}T00:00:00Z`);
}

export function todayIso(now: Date = new Date()): string {
  return toIso(now);
}

export function addDays(iso: string, days: number): string {
  const date = fromIso(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

export function addMonths(iso: string, months: number): string {
  const date = fromIso(iso);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = daysInMonth(date.getUTCFullYear(), date.getUTCMonth() + 1);
  date.setUTCDate(Math.min(day, lastDay));
  return toIso(date);
}

export function compareIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((fromIso(to).getTime() - fromIso(from).getTime()) / 86_400_000);
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** 0 = Sunday … 6 = Saturday, matching `Date.getUTCDay`. */
export function weekdayOf(iso: string): number {
  return fromIso(iso).getUTCDay();
}

export function startOfMonth(year: number, month1to12: number): string {
  return `${year}-${pad(month1to12)}-01`;
}

export function endOfMonth(year: number, month1to12: number): string {
  return `${year}-${pad(month1to12)}-${pad(daysInMonth(year, month1to12))}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// ── Localised names ────────────────────────────────────────────────────────────────────────────

/** Albanian month names (with and without diacritics) plus English, mapped to 1-12. */
export const MONTH_NAMES: Record<string, number> = {
  janar: 1, janari: 1, january: 1, jan: 1,
  shkurt: 2, shkurti: 2, february: 2, feb: 2,
  mars: 3, marsi: 3, march: 3, mar: 3,
  prill: 4, prilli: 4, april: 4, apr: 4,
  maj: 5, maji: 5, may: 5,
  qershor: 6, qershori: 6, june: 6, jun: 6,
  korrik: 7, korriku: 7, july: 7, jul: 7,
  gusht: 8, gushti: 8, august: 8, aug: 8,
  shtator: 9, shtatori: 9, september: 9, sep: 9, sept: 9,
  tetor: 10, tetori: 10, october: 10, oct: 10,
  nentor: 11, nentori: 11, november: 11, nov: 11,
  dhjetor: 12, dhjetori: 12, december: 12, dec: 12,
};

export const MONTH_LABELS_SQ = [
  'Janar', 'Shkurt', 'Mars', 'Prill', 'Maj', 'Qershor',
  'Korrik', 'Gusht', 'Shtator', 'Tetor', 'Nëntor', 'Dhjetor',
];

/** Albanian + English weekday names → 0-6 (Sunday-based). */
export const WEEKDAY_NAMES: Record<string, number> = {
  diel: 0, dielen: 0, sunday: 0, sun: 0,
  hene: 1, henen: 1, monday: 1, mon: 1,
  marte: 2, marten: 2, tuesday: 2, tue: 2,
  merkure: 3, merkuren: 3, wednesday: 3, wed: 3,
  enjte: 4, enjten: 4, thursday: 4, thu: 4,
  premte: 5, premten: 5, friday: 5, fri: 5,
  shtune: 6, shtunen: 6, saturday: 6, sat: 6,
};

export const WEEKDAY_LABELS_SQ = [
  'E diel', 'E hënë', 'E martë', 'E mërkurë', 'E enjte', 'E premte', 'E shtunë',
];

/** Strips Albanian diacritics so "nëntor" and "nentor" both resolve. */
export function deaccent(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ë/gi, 'e')
    .replace(/ç/gi, 'c');
}

/**
 * Albanian marks case on month names ("shtator" → "shtatori" → "shtatorit" → "gjatë shtatorit"),
 * so a plain table lookup misses the form people actually write. Unmatched words fall back to
 * stripping the definite/oblique suffixes and trying again.
 */
const MONTH_SUFFIXES = ['it', 'ut', 'in', 'un', 'i', 't'];

export function monthFromName(name: string): number | undefined {
  const key = deaccent(name.trim().toLowerCase());
  const direct = MONTH_NAMES[key];
  if (direct) return direct;

  for (const suffix of MONTH_SUFFIXES) {
    if (key.length > suffix.length + 2 && key.endsWith(suffix)) {
      const stripped = MONTH_NAMES[key.slice(0, -suffix.length)];
      if (stripped) return stripped;
    }
  }
  return undefined;
}

export function weekdayFromName(name: string): number | undefined {
  const key = deaccent(name.trim().toLowerCase()).replace(/^e\s+/, '');
  return WEEKDAY_NAMES[key];
}

/** "2026-09-15" → "15 Shtator 2026". */
export function formatDateSq(iso: string): string {
  const date = fromIso(iso);
  const month = MONTH_LABELS_SQ[date.getUTCMonth()] ?? '';
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

/** "2026-09-15" → "15 Shtator" (no year — for compact comparison tables). */
export function formatDateShortSq(iso: string): string {
  const date = fromIso(iso);
  return `${date.getUTCDate()} ${MONTH_LABELS_SQ[date.getUTCMonth()] ?? ''}`;
}

export function formatWeekdaySq(iso: string): string {
  return WEEKDAY_LABELS_SQ[weekdayOf(iso)] ?? '';
}

// ── Flexible-date expansion ────────────────────────────────────────────────────────────────────

/**
 * Next occurrence of `weekday` (0-6) strictly after `from`, or on `from` when `includeToday`.
 */
export function nextWeekday(from: string, weekday: number, includeToday = false): string {
  const current = weekdayOf(from);
  let delta = (weekday - current + 7) % 7;
  if (delta === 0 && !includeToday) delta = 7;
  return addDays(from, delta);
}

export interface DatePair {
  departureDate: string;
  returnDate?: string;
}

export interface ExpandOptions {
  /** Inclusive window to sample from. */
  start: string;
  end: string;
  /** Nights away. Omit or 0 for one-way. */
  tripLengthNights?: number;
  /** Upper bound on how many pairs to produce — each pair is a browser search. */
  maxSamples?: number;
  /** Skip dates before this (defaults to today). */
  notBefore?: string;
}

/**
 * Turns a flexible window into a bounded list of concrete date pairs to search.
 *
 * The window is sampled evenly rather than exhaustively: a 30-day month with a 5-night trip has
 * 26 valid pairs, and running 26 browser searches per provider is neither fast nor polite. The
 * sample always includes the first and last valid departure so the extremes are covered.
 */
export function expandDateWindow(options: ExpandOptions): DatePair[] {
  const nights = options.tripLengthNights ?? 0;
  const notBefore = options.notBefore ?? todayIso();
  const maxSamples = Math.max(1, options.maxSamples ?? 6);

  const firstDeparture = compareIso(options.start, notBefore) < 0 ? notBefore : options.start;
  // Last departure that still lets the return land inside the window.
  const lastDeparture = nights > 0 ? addDays(options.end, -nights) : options.end;

  if (compareIso(lastDeparture, firstDeparture) < 0) {
    // Window too short for the requested trip length — fall back to a single departure.
    return [makePair(firstDeparture, nights)];
  }

  const span = daysBetween(firstDeparture, lastDeparture); // 0-based count of extra days
  const count = Math.min(maxSamples, span + 1);
  if (count === 1) return [makePair(firstDeparture, nights)];

  const step = span / (count - 1);
  const seen = new Set<string>();
  const pairs: DatePair[] = [];
  for (let i = 0; i < count; i++) {
    const departure = addDays(firstDeparture, Math.round(i * step));
    if (seen.has(departure)) continue;
    seen.add(departure);
    pairs.push(makePair(departure, nights));
  }
  return pairs;
}

function makePair(departureDate: string, nights: number): DatePair {
  return nights > 0 ? { departureDate, returnDate: addDays(departureDate, nights) } : { departureDate };
}
