import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  daysBetween,
  endOfMonth,
  expandDateWindow,
  formatDateSq,
  isIsoDate,
  monthFromName,
  nextWeekday,
  weekdayFromName,
} from '../src/utils/dates.js';
import { InvalidDateError } from '../src/errors.js';

describe('isIsoDate', () => {
  it('accepts real calendar dates', () => {
    expect(isIsoDate('2026-09-15')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
  });

  it('rejects malformed and impossible dates', () => {
    expect(isIsoDate('2026-9-15')).toBe(false);
    expect(isIsoDate('15/09/2026')).toBe(false);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2025-02-29')).toBe(false);
  });
});

describe('date arithmetic', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-09-28', 5)).toBe('2026-10-03');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('clamps to the last day when the target month is shorter', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-30');
  });

  it('counts days between dates', () => {
    expect(daysBetween('2026-09-15', '2026-09-20')).toBe(5);
    expect(daysBetween('2026-09-20', '2026-09-15')).toBe(-5);
  });

  it('throws a typed error on invalid input', () => {
    expect(() => addDays('nope', 1)).toThrow(InvalidDateError);
  });

  it('reports month ends including leap years', () => {
    expect(endOfMonth(2026, 2)).toBe('2026-02-28');
    expect(endOfMonth(2028, 2)).toBe('2028-02-29');
  });
});

describe('localised names', () => {
  it('resolves Albanian months in every case form', () => {
    expect(monthFromName('shtator')).toBe(9);
    expect(monthFromName('Shtatori')).toBe(9);
    expect(monthFromName('shtatorit')).toBe(9); // "gjatë shtatorit"
    expect(monthFromName('nëntor')).toBe(11);
    expect(monthFromName('nentorit')).toBe(11);
    expect(monthFromName('korrikut')).toBe(7);
  });

  it('resolves English months', () => {
    expect(monthFromName('September')).toBe(9);
    expect(monthFromName('dec')).toBe(12);
  });

  it('returns undefined for non-months', () => {
    expect(monthFromName('berlin')).toBeUndefined();
    expect(monthFromName('')).toBeUndefined();
  });

  it('resolves weekdays with and without the article', () => {
    expect(weekdayFromName('premte')).toBe(5);
    expect(weekdayFromName('e premte')).toBe(5);
    expect(weekdayFromName('premten')).toBe(5);
    expect(weekdayFromName('Sunday')).toBe(0);
  });

  it('formats dates in Albanian', () => {
    expect(formatDateSq('2026-09-15')).toBe('15 Shtator 2026');
    expect(formatDateSq('2026-11-02')).toBe('2 Nëntor 2026');
  });
});

describe('nextWeekday', () => {
  it('finds the next occurrence strictly after the given date', () => {
    // 2026-08-08 is a Saturday.
    expect(nextWeekday('2026-08-08', 5)).toBe('2026-08-14'); // Friday
    expect(nextWeekday('2026-08-08', 6)).toBe('2026-08-15'); // next Saturday
  });

  it('can include the given day when asked', () => {
    expect(nextWeekday('2026-08-08', 6, true)).toBe('2026-08-08');
  });
});

describe('expandDateWindow', () => {
  it('samples a month into a bounded set of round-trip pairs', () => {
    const pairs = expandDateWindow({
      start: '2026-09-01',
      end: '2026-09-30',
      tripLengthNights: 5,
      maxSamples: 5,
      notBefore: '2026-08-08',
    });

    expect(pairs).toHaveLength(5);
    expect(pairs[0]).toEqual({ departureDate: '2026-09-01', returnDate: '2026-09-06' });
    // The last departure still lands the return inside the window.
    expect(pairs.at(-1)).toEqual({ departureDate: '2026-09-25', returnDate: '2026-09-30' });
  });

  it('produces one-way pairs when no trip length is given', () => {
    const pairs = expandDateWindow({ start: '2026-09-01', end: '2026-09-03', notBefore: '2026-08-08' });
    expect(pairs.every((pair) => pair.returnDate === undefined)).toBe(true);
    expect(pairs).toHaveLength(3);
  });

  it('never samples a departure before today', () => {
    const pairs = expandDateWindow({ start: '2026-08-01', end: '2026-08-20', notBefore: '2026-08-08' });
    expect(pairs.every((pair) => pair.departureDate >= '2026-08-08')).toBe(true);
  });

  it('falls back to a single departure when the window is shorter than the trip', () => {
    const pairs = expandDateWindow({
      start: '2026-09-01',
      end: '2026-09-03',
      tripLengthNights: 10,
      notBefore: '2026-08-08',
    });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.returnDate).toBe('2026-09-11');
  });

  it('never returns more pairs than maxSamples', () => {
    const pairs = expandDateWindow({ start: '2026-09-01', end: '2026-12-31', maxSamples: 4, notBefore: '2026-08-08' });
    expect(pairs.length).toBeLessThanOrEqual(4);
  });
});
