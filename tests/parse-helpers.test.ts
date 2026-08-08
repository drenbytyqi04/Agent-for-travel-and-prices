import { describe, expect, it } from 'vitest';
import {
  detectPerPerson,
  detectTaxesIncluded,
  lines,
  parseAirline,
  parseBaggage,
  parseCardPrice,
  parseDurationText,
  parseStops,
  parseTimeRange,
  to24h,
} from '../src/providers/parse-helpers.js';

describe('to24h', () => {
  it('converts 12-hour times', () => {
    expect(to24h('6:20 AM')).toBe('06:20');
    expect(to24h('6:20 PM')).toBe('18:20');
    expect(to24h('12:05 AM')).toBe('00:05');
    expect(to24h('12:05 PM')).toBe('12:05');
  });

  it('passes 24-hour times through', () => {
    expect(to24h('18:05')).toBe('18:05');
    expect(to24h('06:20')).toBe('06:20');
  });

  it('preserves a next-day marker', () => {
    expect(to24h('7:15 AM+1')).toBe('07:15+1');
    expect(to24h('23:50+2')).toBe('23:50+2');
  });

  it('rejects nonsense', () => {
    expect(to24h('nonstop')).toBeUndefined();
    expect(to24h('25:00')).toBeUndefined();
    expect(to24h('10:75')).toBeUndefined();
  });
});

describe('parseTimeRange', () => {
  it('handles the dash variants the sources use', () => {
    expect(parseTimeRange('6:20 AM – 8:40 AM')).toEqual({ departureTime: '06:20', arrivalTime: '08:40' });
    expect(parseTimeRange('06:20 - 08:40')).toEqual({ departureTime: '06:20', arrivalTime: '08:40' });
    expect(parseTimeRange('06:20 — 08:40')).toEqual({ departureTime: '06:20', arrivalTime: '08:40' });
    expect(parseTimeRange('6:20 AM to 8:40 AM')).toEqual({ departureTime: '06:20', arrivalTime: '08:40' });
  });

  it('keeps the overnight marker on the arrival', () => {
    expect(parseTimeRange('22:10 – 07:15+1')).toEqual({ departureTime: '22:10', arrivalTime: '07:15+1' });
  });

  it('takes the first range when a card lists both legs', () => {
    expect(parseTimeRange('06:20 – 08:40\n14:00 – 16:20')).toEqual({
      departureTime: '06:20',
      arrivalTime: '08:40',
    });
  });

  it('returns undefined when there is no range', () => {
    expect(parseTimeRange('Nonstop · Wizz Air')).toBeUndefined();
  });
});

describe('parseStops', () => {
  it('reads direct flights in every wording', () => {
    for (const text of ['Nonstop', 'Non-stop', 'Direct', 'Direkt', 'pa ndalesa']) {
      expect(parseStops(text)).toBe(0);
    }
  });

  it('reads numbered stops', () => {
    expect(parseStops('1 stop')).toBe(1);
    expect(parseStops('2 stops')).toBe(2);
    expect(parseStops('2 Stopps')).toBe(2);
    expect(parseStops('1 ndalesë')).toBe(1);
  });

  it('returns undefined when stops are not stated', () => {
    expect(parseStops('Wizz Air')).toBeUndefined();
  });
});

describe('parseCardPrice', () => {
  it('only reads numbers adjacent to a currency', () => {
    // "2 hr 20 min" and the route codes must not be read as a price.
    const card = '6:20 AM – 8:40 AM\nWizz Air\n2 hr 20 min\nPRN–BER\nNonstop\n€89\nround trip';
    expect(parseCardPrice(card, 'EUR')).toEqual({ amount: 89, currency: 'EUR' });
  });

  it('takes the cheapest of several prices on a card', () => {
    expect(parseCardPrice('€149 was €199', 'EUR')).toEqual({ amount: 149, currency: 'EUR' });
  });

  it('handles German-formatted prices', () => {
    expect(parseCardPrice('1.234,56 €', 'EUR')).toEqual({ amount: 1234.56, currency: 'EUR' });
  });

  it('ignores implausible values', () => {
    expect(parseCardPrice('€1', 'EUR')).toBeUndefined();
  });

  it('returns undefined for cards with no price', () => {
    expect(parseCardPrice('6:20 AM – 8:40 AM\nNonstop', 'EUR')).toBeUndefined();
  });
});

describe('parseAirline', () => {
  it('picks the carrier out of a Google Flights card', () => {
    const card = '6:20 AM – 8:40 AM\nWizz Air\n2 hr 20 min\nPRN–BER\nNonstop\n€89';
    expect(parseAirline(lines(card))).toBe('Wizz Air');
  });

  it('skips times, durations, prices, route codes and noise words', () => {
    const card = '06:20 – 08:40\n2h 20min\nPRN–BER\nNonstop\n€89\nAustrian Airlines';
    expect(parseAirline(lines(card))).toBe('Austrian Airlines');
  });

  it('keeps multi-carrier itineraries as written', () => {
    expect(parseAirline(lines('06:20 – 12:40\nWizz Air, Lufthansa\n1 stop\n€149'))).toBe('Wizz Air, Lufthansa');
  });

  it('returns undefined when nothing looks like a carrier', () => {
    expect(parseAirline(lines('06:20 – 08:40\nNonstop\n€89'))).toBeUndefined();
  });
});

describe('parseDurationText', () => {
  it('reads the source-specific duration formats', () => {
    expect(parseDurationText('2 hr 20 min')).toBe('2 hr 20 min');
    expect(parseDurationText('2h 20m')).toBe('2h 20m');
    expect(parseDurationText('total 14 h 05 min')).toBe('14 h 05 min');
  });

  it('returns undefined when absent', () => {
    expect(parseDurationText('Nonstop €89')).toBeUndefined();
  });
});

describe('price qualifiers', () => {
  it('detects per-person vs total pricing', () => {
    expect(detectPerPerson('€89 per person')).toBe(true);
    expect(detectPerPerson('€267 total')).toBe(false);
    expect(detectPerPerson('€89')).toBeUndefined();
  });

  it('detects whether taxes are stated as included', () => {
    expect(detectTaxesIncluded('€89 incl. taxes')).toBe(true);
    expect(detectTaxesIncluded('€89 plus taxes')).toBe(false);
    expect(detectTaxesIncluded('€89')).toBeUndefined();
  });
});

describe('parseBaggage', () => {
  it('reads the personal-item-only case', () => {
    const baggage = parseBaggage('Basic fare: 1 personal item', 'EUR');
    expect(baggage?.cabinBagIncluded).toBe(false);
    expect(baggage?.checkedBagIncluded).toBe(false);
    expect(baggage?.description).toBe('1 personal item');
  });

  it('reads an included carry-on', () => {
    expect(parseBaggage('Carry-on bag included', 'EUR')?.cabinBagIncluded).toBe(true);
  });

  it('reads an excluded checked bag', () => {
    expect(parseBaggage('Checked bag not included', 'EUR')?.checkedBagIncluded).toBe(false);
  });

  it('reads a checked-bag fee', () => {
    expect(parseBaggage('Checked bag from €25', 'EUR')?.checkedBagFee).toBe(25);
  });

  it('returns undefined when baggage is not mentioned', () => {
    expect(parseBaggage('Nonstop · €89', 'EUR')).toBeUndefined();
  });
});
