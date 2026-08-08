import { describe, expect, it } from 'vitest';
import { canConvert, convert, formatPrice, loadRatesFromEnv, parseAmount, parsePrice } from '../src/utils/currency.js';
import { AgentError } from '../src/errors.js';

describe('parseAmount', () => {
  it('parses plain and grouped numbers', () => {
    expect(parseAmount('89')).toBe(89);
    expect(parseAmount('1,234')).toBe(1234);
    expect(parseAmount('1.234')).toBe(1234); // German grouping
  });

  it('picks the decimal separator by position, not by character', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56); // en
    expect(parseAmount('1.234,56')).toBe(1234.56); // de
    expect(parseAmount('89,50')).toBe(89.5);
  });

  it('ignores thin spaces and apostrophes used as separators', () => {
    expect(parseAmount("1'234")).toBe(1234);
  });

  it('returns undefined when there is no number', () => {
    expect(parseAmount('nonstop')).toBeUndefined();
    expect(parseAmount('')).toBeUndefined();
  });
});

describe('parsePrice', () => {
  it('reads the currency from a symbol on either side', () => {
    expect(parsePrice('€89')).toEqual({ amount: 89, currency: 'EUR' });
    expect(parsePrice('89 €')).toEqual({ amount: 89, currency: 'EUR' });
    expect(parsePrice('$1,234.56')).toEqual({ amount: 1234.56, currency: 'USD' });
    expect(parsePrice('£99')).toEqual({ amount: 99, currency: 'GBP' });
  });

  it('reads an ISO currency code', () => {
    expect(parsePrice('EUR 89.00')).toEqual({ amount: 89, currency: 'EUR' });
    expect(parsePrice('149 CHF')).toEqual({ amount: 149, currency: 'CHF' });
  });

  it('falls back to the default currency when none is stated', () => {
    expect(parsePrice('89', 'EUR')).toEqual({ amount: 89, currency: 'EUR' });
  });

  it('returns undefined for text with no price', () => {
    expect(parsePrice('Nonstop')).toBeUndefined();
  });
});

describe('formatPrice', () => {
  it('prefixes single-character symbols and suffixes codes', () => {
    expect(formatPrice(89, 'EUR')).toBe('€89');
    expect(formatPrice(89.5, 'EUR')).toBe('€89.50');
    expect(formatPrice(149, 'CHF')).toBe('149 CHF');
  });
});

describe('convert', () => {
  const rates = { base: 'EUR', rates: { USD: 1.1, GBP: 0.85 } };

  it('is a no-op for the same currency', () => {
    expect(convert(100, 'EUR', 'EUR')).toBe(100);
    expect(convert(100, 'eur', 'EUR', undefined)).toBe(100);
  });

  it('converts through the base currency', () => {
    expect(convert(100, 'EUR', 'USD', rates)).toBe(110);
    expect(convert(110, 'USD', 'EUR', rates)).toBe(100);
    expect(convert(110, 'USD', 'GBP', rates)).toBe(85);
  });

  it('refuses to invent a rate when none is configured', () => {
    expect(() => convert(100, 'USD', 'EUR')).toThrow(AgentError);
    expect(() => convert(100, 'EUR', 'SEK', rates)).toThrow(/kurs këmbimi/);
    expect(canConvert('USD', 'EUR')).toBe(false);
    expect(canConvert('USD', 'EUR', rates)).toBe(true);
  });
});

describe('loadRatesFromEnv', () => {
  it('reads a valid table', () => {
    const table = loadRatesFromEnv({ FLIGHT_AGENT_FX_RATES: '{"base":"EUR","rates":{"USD":1.1}}' } as NodeJS.ProcessEnv);
    expect(table?.base).toBe('EUR');
    expect(table?.rates.USD).toBe(1.1);
  });

  it('returns undefined for missing or malformed configuration', () => {
    expect(loadRatesFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(loadRatesFromEnv({ FLIGHT_AGENT_FX_RATES: 'not json' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(loadRatesFromEnv({ FLIGHT_AGENT_FX_RATES: '{"rates":{}}' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
