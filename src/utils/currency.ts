import { AgentError } from '../errors.js';

/**
 * Currency handling is deliberately conservative: the agent never invents an exchange rate.
 * Providers are always asked for the user's currency; if one returns a different one, results are
 * converted only when a rate is available (env-provided or explicitly configured), and the
 * conversion is flagged. Otherwise the result is kept in its own currency and excluded from a
 * cross-currency "cheapest" claim.
 */

export const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  CHF: 'CHF',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
  TRY: '₺',
  HUF: 'Ft',
  RSD: 'din',
  MKD: 'ден',
  ALL: 'L',
  PLN: 'zł',
  CZK: 'Kč',
};

const SYMBOL_TO_CODE: Record<string, string> = {
  '€': 'EUR',
  $: 'USD',
  '£': 'GBP',
  '₺': 'TRY',
  '₣': 'CHF',
};

export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code.toUpperCase()] ?? code.toUpperCase();
}

/** "€89", "89 €", "EUR 89.00", "1,234.56 USD", "1.234,56 €" → { amount, currency }. */
export function parsePrice(text: string, defaultCurrency = 'EUR'): { amount: number; currency: string } | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/ /g, ' ').trim();

  let currency: string | undefined;
  const code = cleaned.match(/\b([A-Z]{3})\b/);
  if (code?.[1] && CURRENCY_SYMBOLS[code[1]]) currency = code[1];
  if (!currency) {
    for (const [symbol, mapped] of Object.entries(SYMBOL_TO_CODE)) {
      if (cleaned.includes(symbol)) {
        currency = mapped;
        break;
      }
    }
  }

  const amount = parseAmount(cleaned);
  if (amount === undefined) return undefined;
  return { amount, currency: currency ?? defaultCurrency };
}

/**
 * Parses the numeric part, handling both `1,234.56` (en) and `1.234,56` (de) grouping.
 * Returns undefined rather than guessing when no digits are present.
 */
export function parseAmount(text: string): number | undefined {
  const match = text.match(/\d[\d.,\s']*\d|\d/);
  if (!match) return undefined;
  let raw = match[0].replace(/[\s']/g, '');

  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    // Whichever separator comes last is the decimal one.
    if (lastComma > lastDot) raw = raw.replace(/\./g, '').replace(',', '.');
    else raw = raw.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // A lone comma is a decimal separator only when it is followed by exactly 1-2 digits.
    const decimals = raw.length - lastComma - 1;
    raw = decimals <= 2 ? raw.replace(',', '.') : raw.replace(/,/g, '');
  } else if (lastDot !== -1) {
    const decimals = raw.length - lastDot - 1;
    if (decimals === 3 && raw.split('.').length > 1 && raw.indexOf('.') !== lastDot) raw = raw.replace(/\./g, '');
    else if (decimals === 3 && /^\d{1,3}\.\d{3}$/.test(raw)) raw = raw.replace(/\./g, '');
  }

  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function formatPrice(amount: number, currency: string): string {
  const symbol = currencySymbol(currency);
  const rounded = Math.round(amount * 100) / 100;
  const shown = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  // Symbol-prefix currencies read naturally as "€89"; ISO-style codes read better suffixed.
  return symbol.length === 1 ? `${symbol}${shown}` : `${shown} ${symbol}`;
}

export interface RateTable {
  /** Base currency all rates are quoted against. */
  base: string;
  /** `rates[X]` = how many X one `base` buys. */
  rates: Record<string, number>;
  /** When the rates were captured; stale rates are reported alongside conversions. */
  fetchedAt?: string;
}

/**
 * Loads rates from `FLIGHT_AGENT_FX_RATES` (JSON, e.g. `{"base":"EUR","rates":{"USD":1.08}}`).
 * Without it, no cross-currency conversion happens at all — by design.
 */
export function loadRatesFromEnv(env: NodeJS.ProcessEnv = process.env): RateTable | undefined {
  const raw = env.FLIGHT_AGENT_FX_RATES;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as RateTable;
    if (!parsed?.base || typeof parsed.rates !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function convert(amount: number, from: string, to: string, table?: RateTable): number {
  const fromCode = from.toUpperCase();
  const toCode = to.toUpperCase();
  if (fromCode === toCode) return amount;
  if (!table) {
    throw new AgentError('currency_unavailable', `Nuk ka kurs këmbimi ${fromCode}→${toCode}.`, {
      retryable: false,
      details: { from: fromCode, to: toCode },
    });
  }

  const base = table.base.toUpperCase();
  const rateOf = (code: string): number | undefined =>
    code === base ? 1 : table.rates[code] ?? table.rates[code.toUpperCase()];

  const fromRate = rateOf(fromCode);
  const toRate = rateOf(toCode);
  if (fromRate === undefined || toRate === undefined) {
    throw new AgentError('currency_unavailable', `Nuk ka kurs këmbimi ${fromCode}→${toCode}.`, {
      retryable: false,
      details: { from: fromCode, to: toCode, base },
    });
  }
  return Math.round((amount / fromRate) * toRate * 100) / 100;
}

export function canConvert(from: string, to: string, table?: RateTable): boolean {
  try {
    convert(1, from, to, table);
    return true;
  } catch {
    return false;
  }
}
