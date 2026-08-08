import type { FlightRequest } from '../models/flight-request.js';
import type { FlightResult } from '../models/flight-result.js';
import { formatPrice } from '../utils/currency.js';
import { formatDateSq, formatDateShortSq } from '../utils/dates.js';
import { perPersonPrice, type RankedResult } from './price-comparator.js';
import type { SearchReport } from './flight-search-agent.js';

/**
 * Renders the final answer (spec §6–§9).
 *
 * Two rules run through all of it: never state a price as final unless it was verified, and never
 * hand back a bare homepage as the booking link.
 */

export interface FormatOptions {
  /** Include the per-source audit trail (which sources ran, which failed). */
  includeDiagnostics?: boolean;
  /** How many alternatives to list. */
  alternatives?: number;
}

export function formatSearchReport(report: SearchReport, options: FormatOptions = {}): string {
  const sections: string[] = [];
  const { comparison, request } = report;

  if (!comparison.cheapest) {
    return formatNoResults(report);
  }

  sections.push(formatCheapest(comparison.cheapest, request));

  if (report.countryWide && report.byCity.length > 1) {
    sections.push(formatCityRanking(report.byCity, request));
  }

  if (report.flexibleDates && report.byDate.length > 1) {
    sections.push(formatDateOptions(report.byDate, request));
  }

  const alternatives = comparison.ranked.slice(1, 1 + (options.alternatives ?? 3));
  if (alternatives.length > 0 && !report.countryWide && !report.flexibleDates) {
    sections.push(formatAlternatives(alternatives, request));
  }

  const warnings = collectWarnings(report);
  if (warnings.length > 0) sections.push(`⚠️  Shënime\n\n${warnings.map((line) => `• ${line}`).join('\n')}`);

  if (options.includeDiagnostics) sections.push(formatDiagnostics(report));

  return sections.join('\n\n');
}

/** The headline block from spec §6. */
export function formatCheapest(entry: RankedResult, request: FlightRequest): string {
  const result = entry.result;
  const lines: string[] = ['✈️ Fluturimi më i lirë', ''];

  lines.push(`Nga: ${result.origin.city} (${result.origin.airport})`);
  lines.push(`Për: ${result.destination.city} (${result.destination.airport})`);
  lines.push(`Data e nisjes: ${formatDateSq(result.departureDate)}`);
  lines.push(result.returnDate ? `Data e kthimit: ${formatDateSq(result.returnDate)}` : 'Kthimi: One-way');
  lines.push('');

  lines.push(`💰 Çmimi: ${formatPrice(entry.comparablePrice, request.currency)}${priceQualifier(result)}`);
  if (request.passengers > 1) {
    lines.push(`👤 Për: ${request.passengers} persona (${formatPrice(perPersonPrice(entry, request.passengers), request.currency)}/person)`);
  } else {
    lines.push('👤 Për: 1 person');
  }
  lines.push(`🛫 Kompania: ${result.airline}`);
  lines.push(`${result.stops === 0 ? '🔄 Direkt' : `🔄 ${result.stops} ndalesë${result.stops > 1 ? 'a' : ''}`}${formatReturnStops(result)}`);
  lines.push(`⏱️ Kohëzgjatja: ${result.duration}`);
  lines.push(`🕐 Orari: ${result.departureTime} → ${result.arrivalTime}`);
  lines.push(`🧳 Bagazhi: ${formatBaggage(result)}`);
  lines.push(`🔎 Burimi: ${result.source}${entry.alsoOn.length > 0 ? ` (edhe te: ${entry.alsoOn.map((a) => a.source).join(', ')})` : ''}`);
  lines.push('');

  lines.push('🔗 Rezervimi:');
  lines.push(formatBookingLink(result));

  return lines.join('\n');
}

/** Medal ranking of destination cities (spec §7). */
export function formatCityRanking(cities: SearchReport['byCity'], request: FlightRequest): string {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = ['🌍 Krahasimi sipas qyteteve', ''];

  cities.slice(0, 6).forEach((option, index) => {
    const entry = option.best;
    const marker = medals[index] ?? `${index + 1}.`;
    lines.push(`${marker} ${entry.result.origin.airport} → ${option.city} (${option.airport})`);
    lines.push(`   ${formatDateShortSq(entry.result.departureDate)}${entry.result.returnDate ? ` → ${formatDateShortSq(entry.result.returnDate)}` : ''}`);
    lines.push(`   ${formatPrice(entry.comparablePrice, request.currency)} · ${entry.result.airline} · ${entry.result.stops === 0 ? 'direkt' : `${entry.result.stops} ndalesa`}`);
    lines.push('');
  });

  const best = cities[0];
  if (best) {
    lines.push(
      `👉 Rekomandimi: ${best.city} (${best.airport}) me ${formatPrice(best.best.comparablePrice, request.currency)}.`,
    );
  }
  return lines.join('\n').trimEnd();
}

/** Cheapest date pairs with alternatives (spec §8). */
export function formatDateOptions(dates: SearchReport['byDate'], request: FlightRequest): string {
  const lines = ['📅 Datat më të lira', ''];
  const best = dates[0];
  if (!best) return '';

  lines.push('Data më e lirë:');
  lines.push(`${formatDateShortSq(best.departureDate)}${best.returnDate ? ` → ${formatDateShortSq(best.returnDate)}` : ' (one-way)'}`);
  lines.push('');
  lines.push('Çmimi:');
  lines.push(formatPrice(best.best.comparablePrice, request.currency));

  const rest = dates.slice(1, 5);
  if (rest.length > 0) {
    lines.push('');
    lines.push('Alternativa:');
    for (const option of rest) {
      const range = `${formatDateShortSq(option.departureDate)}${option.returnDate ? ` → ${formatDateShortSq(option.returnDate)}` : ''}`;
      lines.push(`${range} — ${formatPrice(option.best.comparablePrice, request.currency)}`);
    }
  }
  return lines.join('\n');
}

export function formatAlternatives(entries: RankedResult[], request: FlightRequest): string {
  const lines = ['🔁 Alternativa', ''];
  entries.forEach((entry, index) => {
    const result = entry.result;
    lines.push(
      `${index + 2}. ${formatPrice(entry.comparablePrice, request.currency)} · ${result.airline} · ` +
        `${result.departureTime}→${result.arrivalTime} · ${result.stops === 0 ? 'direkt' : `${result.stops} ndalesa`} · ${result.source}`,
    );
    lines.push(`   ${formatBookingLink(result, true)}`);
  });
  return lines.join('\n');
}

function formatNoResults(report: SearchReport): string {
  const lines = ['❌ Nuk u gjet asnjë fluturim që përputhet me kriteret.', ''];

  if (report.failures.length > 0) {
    lines.push('Burimet që dështuan:');
    for (const failure of report.failures) lines.push(`• ${failure.source}: ${failure.userMessage}`);
    lines.push('');
  }

  if (report.comparison.filteredOut.length > 0) {
    lines.push(`${report.comparison.filteredOut.length} rezultate u përjashtuan nga filtrat:`);
    const reasons = new Map<string, number>();
    for (const item of report.comparison.filteredOut) {
      reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
    }
    for (const [reason, count] of reasons) lines.push(`• ${reason} (${count})`);
    lines.push('');
    lines.push('Provo të lirosh filtrat (p.sh. hiq "vetëm direkt" ose zgjero datat).');
  } else {
    lines.push('Provo data të tjera, një aeroport tjetër, ose kritere më të gjera.');
  }

  // A search URL still lets the user continue by hand — better than a dead end.
  const anyUrl = report.outcomes.find((outcome) => outcome.searchUrl)?.searchUrl;
  if (anyUrl) {
    lines.push('');
    lines.push('Kërko manualisht:');
    lines.push(anyUrl);
  }
  return lines.join('\n');
}

/** Explicit statement of how much the price can be trusted — never silently implied. */
function priceQualifier(result: FlightResult): string {
  switch (result.priceConfidence) {
    case 'verified':
      return ' ✅ (i verifikuar)';
    case 'changed':
      return ` ⚠️ (i verifikuar; i listuar ishte ${result.listedPrice ?? '?'})`;
    case 'unverified':
      return ' ❓ (i palistuar si i verifikuar)';
    default:
      return ' (çmim i listuar, i paverifikuar)';
  }
}

function formatReturnStops(result: FlightResult): string {
  if (result.returnStops === undefined) return '';
  return ` (kthimi: ${result.returnStops === 0 ? 'direkt' : `${result.returnStops} ndalesa`})`;
}

function formatBaggage(result: FlightResult): string {
  const baggage = result.baggage;
  if (!baggage) return 'nuk u raportua nga burimi';

  const parts: string[] = [];
  if (baggage.description) parts.push(baggage.description);
  if (baggage.cabinBagIncluded !== undefined) parts.push(`bagazh dore: ${baggage.cabinBagIncluded ? 'po' : 'jo'}`);
  if (baggage.checkedBagIncluded !== undefined) {
    parts.push(`bagazh i regjistruar: ${baggage.checkedBagIncluded ? 'po' : 'jo'}`);
  }
  if (baggage.checkedBagFee !== undefined) parts.push(`tarifë bagazhi: ${baggage.checkedBagFee}`);
  return parts.length > 0 ? parts.join(', ') : 'nuk u raportua nga burimi';
}

/** Spec §9: prefer a direct offer link; a reproducible search URL is the accepted fallback. */
function formatBookingLink(result: FlightResult, inline = false): string {
  const label = result.bookingUrlIsSearch ? 'Hap kërkimin (link i ofertës nuk ishte i disponueshëm)' : 'Hap ofertën';
  return inline ? `${result.bookingUrl}` : `${label}:\n${result.bookingUrl}`;
}

function collectWarnings(report: SearchReport): string[] {
  const warnings = [...report.notes];

  for (const failure of report.failures) {
    // "No flights on this source" is normal noise in a fan-out; only surface real problems.
    if (failure.kind === 'no_flights_found') continue;
    warnings.push(`${failure.source}: ${failure.userMessage}`);
  }

  const cheapest = report.comparison.cheapest?.result;
  if (cheapest?.priceConfidence === 'unverified') {
    warnings.push('Çmimi nuk mund të verifikohej në mënyrë të sigurt — trajtoje si orientues.');
  }
  if (cheapest?.taxesIncluded === false) warnings.push('Çmimi mund të mos i përfshijë taksat.');
  if (cheapest?.bookingUrlIsSearch) {
    warnings.push('Linku i drejtpërdrejtë i ofertës nuk u ruajt dot; linku më sipër riprodhon të njëjtin kërkim.');
  }
  if (cheapest?.notes) warnings.push(...cheapest.notes);

  return [...new Set(warnings)];
}

function formatDiagnostics(report: SearchReport): string {
  const lines = ['🔍 Diagnostikë', ''];
  lines.push(`Kohëzgjatja: ${Math.round(report.durationMs / 1000)}s · ${report.outcomes.length} kërkime`);

  const bySource = new Map<string, { ok: number; failed: number; results: number }>();
  for (const outcome of report.outcomes) {
    const entry = bySource.get(outcome.source) ?? { ok: 0, failed: 0, results: 0 };
    if (outcome.error) entry.failed++;
    else entry.ok++;
    entry.results += outcome.results.length;
    bySource.set(outcome.source, entry);
  }

  for (const [source, stats] of bySource) {
    lines.push(`• ${source}: ${stats.ok} ok, ${stats.failed} dështime, ${stats.results} rezultate`);
  }
  return lines.join('\n');
}

/** Machine-readable form of the answer, for callers embedding this agent. */
export function toJsonReport(report: SearchReport): Record<string, unknown> {
  return {
    request: report.request,
    cheapest: report.comparison.cheapest?.result ?? null,
    comparablePrice: report.comparison.cheapest?.comparablePrice ?? null,
    ranked: report.comparison.ranked.slice(0, 10).map((entry) => ({
      ...entry.result,
      comparablePrice: entry.comparablePrice,
      alsoOn: entry.alsoOn,
    })),
    byCity: report.byCity.map((option) => ({
      airport: option.airport,
      city: option.city,
      price: option.best.comparablePrice,
      departureDate: option.best.result.departureDate,
      returnDate: option.best.result.returnDate ?? null,
    })),
    byDate: report.byDate.map((option) => ({
      departureDate: option.departureDate,
      returnDate: option.returnDate ?? null,
      price: option.best.comparablePrice,
    })),
    failures: report.failures,
    notes: report.notes,
    verified: report.verification ? !report.verification.error : false,
    durationMs: report.durationMs,
  };
}
