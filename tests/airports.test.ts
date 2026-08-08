import { describe, expect, it } from 'vitest';
import {
  airportsInCountry,
  countryLabel,
  findAirportByIata,
  resolveAirport,
  resolveAirports,
  resolveAirportsExact,
  resolveCountry,
} from '../src/utils/airports.js';
import { InvalidAirportError } from '../src/errors.js';

describe('resolveAirports', () => {
  it('resolves the Prishtina spellings the spec uses', () => {
    for (const query of ['PRN', 'Prishtina', 'Prishtinë', 'Pristina', 'prishtine']) {
      expect(resolveAirports(query)[0]?.iata).toBe('PRN');
    }
  });

  it('resolves German cities in local and Albanian spellings', () => {
    expect(resolveAirports('München')[0]?.iata).toBe('MUC');
    expect(resolveAirports('Munich')[0]?.iata).toBe('MUC');
    expect(resolveAirports('Mynih')[0]?.iata).toBe('MUC');
    expect(resolveAirports('Köln')[0]?.iata).toBe('CGN');
    expect(resolveAirports('Cologne')[0]?.iata).toBe('CGN');
    expect(resolveAirports('Düsseldorf')[0]?.iata).toBe('DUS');
  });

  it('returns each airport once, even when several aliases point at it', () => {
    const matches = resolveAirports('Berlin');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.iata).toBe('BER');
  });

  it('returns every airport of a multi-airport city, busiest first', () => {
    const london = resolveAirports('London');
    expect(london.length).toBeGreaterThan(1);
    expect(london[0]?.iata).toBe('LHR');
    expect(london.map((airport) => airport.iata)).toContain('LGW');
  });

  it('ignores the word "airport" and punctuation', () => {
    expect(resolveAirports('Frankfurt Airport')[0]?.iata).toBe('FRA');
    expect(resolveAirports('  frankfurt  ')[0]?.iata).toBe('FRA');
  });

  it('returns nothing for unknown text', () => {
    expect(resolveAirports('Atlantis')).toHaveLength(0);
    expect(resolveAirports('')).toHaveLength(0);
  });

  it('throws a typed error when a single airport is required', () => {
    expect(() => resolveAirport('Atlantis')).toThrow(InvalidAirportError);
  });
});

describe('resolveAirportsExact', () => {
  it('does not fuzzy-match, so partial words stay unmatched', () => {
    expect(resolveAirportsExact('frankfur')).toHaveLength(0);
    expect(resolveAirportsExact('berli')).toHaveLength(0);
    expect(resolveAirportsExact('frankfurt')[0]?.iata).toBe('FRA');
  });

  it('still matches short real aliases — the planner’s stopword list guards those', () => {
    // "nis" is Niš's genuine alias, and also an Albanian verb stem. Exactness alone cannot
    // separate them, which is why the planner filters it before resolving mentions.
    expect(resolveAirportsExact('nis')[0]?.iata).toBe('INI');
  });
});

describe('resolveCountry', () => {
  it('resolves country names in Albanian, English and German', () => {
    expect(resolveCountry('Gjermani')).toBe('DE');
    expect(resolveCountry('Gjermania')).toBe('DE');
    expect(resolveCountry('Germany')).toBe('DE');
    expect(resolveCountry('Deutschland')).toBe('DE');
    expect(resolveCountry('Zvicër')).toBe('CH');
  });

  it('returns undefined for cities and nonsense', () => {
    expect(resolveCountry('Berlin')).toBeUndefined();
    expect(resolveCountry('xyz')).toBeUndefined();
  });
});

describe('airportsInCountry', () => {
  it('lists German airports by traffic rank', () => {
    const airports = airportsInCountry('DE', 5);
    expect(airports.map((airport) => airport.iata)).toEqual(['FRA', 'MUC', 'BER', 'DUS', 'HAM']);
  });

  it('includes every airport the spec names when the limit allows', () => {
    const codes = airportsInCountry('DE', 20).map((airport) => airport.iata);
    for (const iata of ['BER', 'FRA', 'MUC', 'HAM', 'STR', 'CGN', 'DUS', 'NUE', 'LEJ', 'DRS', 'HAJ']) {
      expect(codes).toContain(iata);
    }
  });

  it('respects the limit and returns nothing for unknown countries', () => {
    expect(airportsInCountry('DE', 3)).toHaveLength(3);
    expect(airportsInCountry('ZZ')).toHaveLength(0);
  });
});

describe('lookup helpers', () => {
  it('finds airports by IATA case-insensitively', () => {
    expect(findAirportByIata('ber')?.city).toBe('Berlin');
    expect(findAirportByIata('ZZZ')).toBeUndefined();
  });

  it('labels countries in Albanian', () => {
    expect(countryLabel('DE')).toBe('Gjermani');
    expect(countryLabel('zz')).toBe('ZZ');
  });
});
