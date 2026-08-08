import { parsePrice } from '../utils/currency.js';

/**
 * Pure text→data parsing shared by all providers.
 *
 * Deliberately separated from any Playwright code: DOM extraction returns plain strings, these
 * functions turn them into structured values, and the tests exercise them against real captured
 * card text without needing a browser.
 */

/** What one result card looks like after DOM extraction, before parsing. */
export interface RawCard {
  /** `innerText` of the card, newlines preserved. */
  text: string;
  /** Every `aria-label` found inside the card — usually richer than the visible text. */
  ariaLabels: string[];
  /** Any href found on the card, for direct booking links. */
  href?: string;
  /** Provider-specific test ids or data attributes, when useful. */
  attributes?: Record<string, string>;
}

/** "6:20 AM" | "06:20" | "18:05" | "6:20 PM+1" → "18:20" (with "+1" preserved). */
export function to24h(input: string): string | undefined {
  const text = input.trim();
  const match = text.match(/(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!match?.[1] || !match[2]) return undefined;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || minutes > 59) return undefined;

  const meridiem = match[3]?.toLowerCase().replace(/\./g, '');
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23) return undefined;

  const dayOffset = text.match(/\+\s*(\d)/);
  const base = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return dayOffset?.[1] ? `${base}+${dayOffset[1]}` : base;
}

/** Pulls the "HH:MM – HH:MM" departure/arrival pair out of a card. */
export function parseTimeRange(text: string): { departureTime: string; arrivalTime: string } | undefined {
  // en dash, em dash, hyphen or " to " all appear across the sources.
  const match = text.match(
    /(\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?)\s*(?:[–—−-]|to)\s*(\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?(?:\s*\+\s*\d)?)/i,
  );
  if (!match?.[1] || !match[2]) return undefined;

  const departureTime = to24h(match[1]);
  const arrivalTime = to24h(match[2]);
  if (!departureTime || !arrivalTime) return undefined;
  return { departureTime, arrivalTime };
}

/** "Nonstop" / "Direkt" / "1 stop" / "2 stops" / "2 Stopps" → number of stops. */
export function parseStops(text: string): number | undefined {
  const lower = text.toLowerCase();
  if (/\b(nonstop|non-stop|direct|direkt|pa ndalesa|drejtpërdrejt)\b/.test(lower)) return 0;

  const numeric = lower.match(/(\d+)\s*(?:\+\s*)?(?:stop|stops|stopp|stopps|ndales|ndalesa|escale)/);
  if (numeric?.[1]) return Number(numeric[1]);

  const worded = lower.match(/\b(one|two|three|1|2|3)\s*(?:stop|ndales)/);
  if (worded?.[1]) return { one: 1, two: 2, three: 3 }[worded[1]] ?? Number(worded[1]);

  return undefined;
}

/** Cheapest-looking price on a card. Returns the smallest plausible fare, ignoring per-night noise. */
export function parseCardPrice(
  text: string,
  defaultCurrency: string,
): { amount: number; currency: string } | undefined {
  const candidates: Array<{ amount: number; currency: string }> = [];
  // Match currency-adjacent numbers only, so "2 hr 20 min" and "PRN–BER" never read as prices.
  // Each numeric run must *start* with a digit: a run allowed to be whitespace-only would match
  // the newline before "€89" and consume the symbol, hiding the price from the following branch.
  const pattern =
    /(?:([€$£₺])\s?(\d[\d.,\s']*)|(\d[\d.,\s']*)\s?([€$£₺])|\b([A-Z]{3})\s?(\d[\d.,\s']*)|(\d[\d.,\s']*)\s?\b([A-Z]{3})\b)/g;

  for (const match of text.matchAll(pattern)) {
    const parsed = parsePrice(match[0], defaultCurrency);
    if (parsed && parsed.amount >= 5 && parsed.amount <= 100_000) candidates.push(parsed);
  }
  if (candidates.length === 0) return undefined;

  return candidates.reduce((cheapest, current) => (current.amount < cheapest.amount ? current : cheapest));
}

/** Marker words that mean the price shown is per traveller. */
export function detectPerPerson(text: string): boolean | undefined {
  const lower = text.toLowerCase();
  if (/\b(per person|per traveller|per traveler|pro person|për person|each)\b/.test(lower)) return true;
  if (/\b(total|totali|gesamt|for all travellers|for all travelers|all passengers)\b/.test(lower)) return false;
  return undefined;
}

export function detectTaxesIncluded(text: string): boolean | undefined {
  const lower = text.toLowerCase();
  if (/\b(incl\.? taxes|including taxes|taxes and fees included|inkl\. steuern|me taksa|taksat e përfshira)\b/.test(lower)) {
    return true;
  }
  if (/\b(excl\.? taxes|excluding taxes|plus taxes|taxes not included|pa taksa)\b/.test(lower)) return false;
  return undefined;
}

export interface ParsedBaggage {
  description?: string;
  cabinBagIncluded?: boolean;
  checkedBagIncluded?: boolean;
  checkedBagFee?: number;
}

export function parseBaggage(text: string, currency: string): ParsedBaggage | undefined {
  const lower = text.toLowerCase();
  const result: ParsedBaggage = {};
  let found = false;

  if (/\b(carry[- ]on|cabin bag|hand luggage|handgep(ä|ae)ck|bagazh dore)\b/.test(lower)) {
    result.cabinBagIncluded = !/\b(carry[- ]on|cabin bag)\b[^.]{0,25}\b(not included|extra|fee|nuk përfshihet)\b/.test(lower);
    found = true;
  }
  if (/\b(checked bag|checked baggage|hold luggage|aufgegebenes gep(ä|ae)ck|bagazh i regjistruar|valixhe)\b/.test(lower)) {
    result.checkedBagIncluded = !/\b(checked bag(?:gage)?|hold luggage)\b[^.]{0,25}\b(not included|extra|fee|nuk përfshihet)\b/.test(lower);
    found = true;
  }
  if (/\b(1 personal item|personal item only|only a personal item)\b/.test(lower)) {
    result.cabinBagIncluded = false;
    result.checkedBagIncluded = false;
    result.description = '1 personal item';
    found = true;
  }

  const fee = lower.match(/(?:checked bag|bagazh)[^.]{0,40}?([€$£]\s?[\d.,]+|\b[\d.,]+\s?(?:eur|usd|gbp)\b)/i);
  if (fee?.[1]) {
    const parsed = parseCardPrice(fee[1], currency);
    if (parsed) {
      result.checkedBagFee = parsed.amount;
      found = true;
    }
  }

  return found ? result : undefined;
}

/**
 * Airline name from a card. Sources list operating carriers in wildly different places, so this
 * works by elimination: drop lines that are clearly times, prices, durations, codes or noise.
 */
export function parseAirline(lines: string[]): string | undefined {
  const noise =
    /^(nonstop|non-stop|direct|direkt|drejtpërdrejt|pa ndalesa|\d+\s*(stops?|stopps?|ndalesa?)|round trip|one way|per person|total|select|view deal|cheapest|best|fastest|separate tickets|self transfer)$/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.length < 3 || line.length > 60) continue;
    if (noise.test(line)) continue;
    if (/^[\d\s:.,+–—-]+$/.test(line)) continue; // times, numbers
    if (/^\d{1,2}[:.]\d{2}/.test(line)) continue; // starts with a time
    if (/^\d+\s*(h|hr|hour|min|m)\b/i.test(line)) continue; // duration
    if (/[€$£₺]/.test(line)) continue; // price
    if (/^[A-Z]{3}\s*[–—-]\s*[A-Z]{3}$/.test(line)) continue; // route codes
    if (/^\d+\s*(kg|lb)$/i.test(line)) continue;

    // Multiple carriers on one itinerary: Google writes "Wizz Air, Lufthansa".
    return line.replace(/\s*,\s*$/, '').trim();
  }
  return undefined;
}

/** Splits `innerText` into trimmed, non-empty lines. */
export function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Finds the first duration-looking token, e.g. "2 hr 20 min", "2h 20m", "2:20". */
export function parseDurationText(text: string): string | undefined {
  const explicit = text.match(/\b\d{1,2}\s*(?:h|hr|hrs|hour|hours|orë|ore)\s*\d{0,2}\s*(?:m|min|mins|minutes?|minuta)?\b/i);
  if (explicit?.[0]) return explicit[0].replace(/\s+/g, ' ').trim();

  const minutesOnly = text.match(/\b\d{2,3}\s*(?:m|min|mins|minutes)\b/i);
  if (minutesOnly?.[0]) return minutesOnly[0].trim();

  return undefined;
}
