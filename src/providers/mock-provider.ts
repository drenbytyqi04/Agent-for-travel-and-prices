import { normaliseResult, type FlightResult } from '../models/flight-result.js';
import { airportRef } from '../utils/airports.js';
import { buildGoogleFlightsUrl } from '../utils/url-builder.js';
import { BaseProvider, type ProviderCapabilities, type ProviderContext, type SearchTask } from './provider.js';

/**
 * Deterministic offline provider.
 *
 * Its only job is to let the orchestration, comparison and formatting layers be exercised
 * end-to-end without a network — in tests and via `--mock`. Its numbers are synthetic and it says
 * so on every result, so a mock price can never be mistaken for a real quote.
 */
export class MockProvider extends BaseProvider {
  readonly id = 'mock';
  readonly name = 'Mock (të dhëna demo)';
  override readonly priority = 1;
  override readonly capabilities: ProviderCapabilities = {
    priceVerification: true,
    baggageInfo: true,
    directBookingLinks: false,
    roundTrip: true,
  };

  buildSearchUrl(task: SearchTask): string {
    return buildGoogleFlightsUrl({
      originIata: task.originIata,
      destinationIata: task.destinationIata,
      departureDate: task.departureDate,
      returnDate: task.returnDate,
      passengers: task.passengers,
      cabinClass: task.cabinClass,
      currency: task.currency,
    });
  }

  async search(task: SearchTask, _context: ProviderContext): Promise<FlightResult[]> {
    const searchUrl = this.buildSearchUrl(task);
    const seed = hash(`${task.originIata}${task.destinationIata}${task.departureDate}`);

    return [0, 1, 2].map((index) => {
      const stops = index === 0 ? 0 : index;
      const base = 45 + (seed % 60) + index * 23 + (task.returnDate ? 40 : 0);
      const departureHour = 6 + ((seed + index * 5) % 12);
      const durationMinutes = 140 + stops * 165;
      const arrival = departureHour * 60 + durationMinutes;

      return normaliseResult(
        {
          airline: ['Wizz Air', 'Lufthansa', 'Austrian Airlines'][index] ?? 'Demo Air',
          origin: airportRef(task.originIata),
          destination: airportRef(task.destinationIata),
          departureDate: task.departureDate,
          returnDate: task.returnDate,
          departureTime: clock(departureHour * 60),
          arrivalTime: clock(arrival),
          duration: `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}min`,
          durationMinutes,
          stops,
          price: base,
          currency: task.currency,
          priceIsPerPerson: true,
          taxesIncluded: true,
          baggage: { description: index === 0 ? '1 personal item' : 'Bagazh dore 8kg', cabinBagIncluded: index > 0, checkedBagIncluded: false },
          cabinClass: task.cabinClass,
          source: this.id,
          bookingUrl: searchUrl,
          bookingUrlIsSearch: true,
          notes: ['TË DHËNA DEMO — jo çmim real.'],
        },
        { passengers: task.passengers, source: this.id },
      );
    });
  }

  async verify(result: FlightResult): Promise<{ price: number; currency: string; priceIsPerPerson: boolean }> {
    // Mirrors reality: the verified price is often a little above the listed one.
    return { price: result.price + 4, currency: result.currency, priceIsPerPerson: result.priceIsPerPerson };
  }
}

function hash(value: string): number {
  let total = 0;
  for (let i = 0; i < value.length; i++) total = (total * 31 + value.charCodeAt(i)) % 100_000;
  return total;
}

function clock(totalMinutes: number): string {
  const day = Math.floor(totalMinutes / 1440);
  const minutes = totalMinutes % 1440;
  const base = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return day > 0 ? `${base}+${day}` : base;
}
