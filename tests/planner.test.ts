import { describe, expect, it } from 'vitest';
import { Planner } from '../src/agent/planner.js';
import { SessionMemory } from '../src/memory/session-memory.js';

/** 2026-08-08 is a Saturday — weekday resolution below depends on that. */
const TODAY = '2026-08-08';
const planner = new Planner({ today: TODAY, defaultCurrency: 'EUR' });

describe('Planner — the spec’s worked examples', () => {
  it('parses origin + country with no dates, and asks only about dates', () => {
    const plan = planner.plan('Më gjej fluturimin më të lirë nga Prishtina për në Gjermani.');

    expect(plan.request.origin).toBe('prishtina');
    expect(plan.request.destinationCountry).toBe('DE');
    expect(plan.request.destination).toBeUndefined();
    expect(plan.countryWide).toBe(true);
    expect(plan.missing).toEqual(['dates']);
    expect(plan.question).toContain('datë');
  });

  it('parses a fully-specified round trip', () => {
    const plan = planner.plan(
      'Më gjej fluturimin më të lirë nga Prishtina për në Berlin më 15 shtator dhe kthimin më 20 shtator.',
    );

    expect(plan.request.origin).toBe('prishtina');
    expect(plan.request.destination).toBe('berlin');
    expect(plan.request.dateMode).toBe('exact');
    expect(plan.request.departureDate).toBe('2026-09-15');
    expect(plan.request.returnDate).toBe('2026-09-20');
    expect(plan.missing).toHaveLength(0);
  });

  it('resolves "muajin tjetër" to the whole next month', () => {
    const plan = planner.plan('Gjeje më të lirën për Gjermani muajin tjetër.');

    expect(plan.request.dateMode).toBe('flexible_month');
    expect(plan.request.dateWindow).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(plan.request.flexibleDates).toBe(true);
    expect(plan.missing).toEqual(['origin']);
  });

  it('resolves "gjatë shtatorit" — the definite case form', () => {
    const plan = planner.plan('Më gjej fluturimin më të lirë gjatë shtatorit nga Prishtina në Gjermani.');

    expect(plan.request.dateMode).toBe('flexible_month');
    expect(plan.request.dateWindow?.start).toBe('2026-09-01');
    expect(plan.request.dateWindow?.end).toBe('2026-09-30');
  });

  it('treats a trip length with no period as an open date search', () => {
    const plan = planner.plan('Dua të shkoj në Berlin për 4 ditë, gjeje datat më të lira.');

    expect(plan.request.destination).toBe('berlin');
    expect(plan.request.tripLengthNights).toBe(4);
    expect(plan.request.dateMode).toBe('flexible_range');
    expect(plan.request.flexibleDates).toBe(true);
    expect(plan.notes.join(' ')).toContain('fleksibile');
  });

  it('resolves weekday phrases, using the return marker to order them', () => {
    const plan = planner.plan('Gjeje një fluturim nga Prishtina për Munich, të premten dhe kthimin të dielën.');

    expect(plan.request.destination).toBe('munich');
    expect(plan.request.departureDate).toBe('2026-08-14'); // next Friday
    expect(plan.request.returnDate).toBe('2026-08-16'); // the Sunday after it
  });

  it('understands "cheapest city in Germany" as a country-wide search', () => {
    const plan = planner.plan('Cili është qyteti më i lirë në Gjermani për të fluturuar nga Prishtina?');

    expect(plan.request.origin).toBe('prishtina');
    expect(plan.request.destinationCountry).toBe('DE');
    expect(plan.countryWide).toBe(true);
  });

  it('reads "vetëm direkt" as maxStops 0', () => {
    const plan = planner.plan('Gjeje më të lirën nga Prishtina për Berlin më 15 shtator, por vetëm direkt.');
    expect(plan.request.maxStops).toBe(0);
  });

  it('clears a time preference when the user says they do not care', () => {
    const plan = planner.plan('Gjeje më të lirën nga Prishtina për Berlin më 15 shtator, nuk më intereson ora.');
    expect(plan.request.timePreference).toBeUndefined();
  });
});

describe('Planner — attributes', () => {
  it('extracts passengers, cabin class and baggage together', () => {
    const plan = planner.plan(
      'Nga Prishtina në Berlin më 15 shtator për 2 persona, business, me bagazh.',
    );

    expect(plan.request.passengers).toBe(2);
    expect(plan.request.cabinClass).toBe('business');
    expect(plan.request.baggage).toBe(true);
  });

  it('reads "pa bagazh" as an explicit no', () => {
    const plan = planner.plan('Nga Prishtina në Berlin më 15 shtator, pa bagazh.');
    expect(plan.request.baggage).toBe(false);
  });

  it('reads a morning preference as a departure window', () => {
    const plan = planner.plan('Nga Prishtina në Berlin më 15 shtator, në mëngjes.');
    expect(plan.request.timePreference).toEqual({ earliest: '05:00', latest: '11:00' });
  });

  it('handles English phrasing and one-way trips', () => {
    const plan = planner.plan('Find me the cheapest flight from Pristina to Frankfurt on 2026-10-03 one way.');

    expect(plan.request.origin).toBe('pristina');
    expect(plan.request.destination).toBe('frankfurt');
    expect(plan.request.departureDate).toBe('2026-10-03');
    expect(plan.request.returnDate).toBeUndefined();
  });

  it('parses day-first numeric dates', () => {
    const plan = planner.plan('Nga Prishtina në Berlin më 15/09/2026.');
    expect(plan.request.departureDate).toBe('2026-09-15');
  });

  it('rolls a bare day/month forward when it has already passed this year', () => {
    const plan = planner.plan('Nga Prishtina në Berlin më 3 mars.');
    expect(plan.request.departureDate).toBe('2027-03-03');
  });
});

describe('Planner — session memory', () => {
  it('reuses a remembered cabin class without being asked again', () => {
    const memory = new SessionMemory();
    const withMemory = new Planner({ today: TODAY, memory });

    withMemory.plan('Nga Prishtina në Berlin më 15 shtator, economy.');
    memory.remember({ cabinClass: 'economy' });

    const next = withMemory.plan('Më gjej një fluturim për Gjermani në tetor.');
    expect(next.request.cabinClass).toBe('economy');
  });

  it('lets the current request override a remembered preference', () => {
    const memory = new SessionMemory();
    memory.remember({ cabinClass: 'economy', passengers: 1 });
    const withMemory = new Planner({ today: TODAY, memory });

    const plan = withMemory.plan('Nga Prishtina në Berlin më 15 shtator, business për 3 persona.');
    expect(plan.request.cabinClass).toBe('business');
    expect(plan.request.passengers).toBe(3);
  });

  it('fills a missing origin from memory', () => {
    const memory = new SessionMemory();
    memory.remember({ origin: 'Prishtina' });
    const withMemory = new Planner({ today: TODAY, memory });

    const plan = withMemory.plan('Gjeje më të lirën për Gjermani muajin tjetër.');
    expect(plan.request.origin).toBe('Prishtina');
    expect(plan.missing).toHaveLength(0);
  });
});

describe('Planner — incomplete requests', () => {
  it('asks for one field at a time, origin first', () => {
    const plan = planner.plan('Gjeje më të lirën, nuk më intereson ora.');
    expect(plan.missing).toEqual(['origin', 'destination', 'dates']);
    expect(plan.question).toBe('Nga cili qytet/aeroport dëshiron të niseni?');
  });

  it('still captures the constraints of an otherwise-empty request', () => {
    const plan = planner.plan('Gjeje më të lirën por vetëm direkt.');
    expect(plan.request.maxStops).toBe(0);
    expect(plan.missing).toContain('destination');
  });
});
