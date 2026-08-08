import { AgentError, toAgentError } from '../errors.js';
import type { FlightRequest } from '../models/flight-request.js';
import type { FlightResult } from '../models/flight-result.js';
import type { FlightProvider, ProviderContext } from '../providers/provider.js';
import type { ChromeController } from '../browser/chrome-controller.js';
import { isHomepageUrl } from '../utils/url-builder.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('verify');

/**
 * Price verification (spec §5).
 *
 * Search-result prices are advertisements: they go stale, they exclude fees, and they are often
 * quoted per traveller when the user asked for three. So before the agent recommends anything, it
 * opens the offer and re-reads the price. The outcome is always recorded on the result — including
 * "could not verify", which is reported as such rather than being papered over.
 */

export interface VerificationReport {
  /** The result after verification — a new object; the input is not mutated. */
  result: FlightResult;
  /** True when the verified price differs from the listed one. */
  changed: boolean;
  /** Absolute difference in the result's currency, when changed. */
  delta?: number;
  /** Present when verification failed. The result stays `unverified`. */
  error?: AgentError;
  /** Plain-language notes for the final answer. */
  notes: string[];
}

export interface VerifyOptions {
  chrome: ChromeController;
  request: FlightRequest;
  /** Wall-clock budget for one verification attempt. */
  budgetMs?: number;
}

/**
 * Verifies one result against its own source. Never throws: a failure to verify is information
 * the user needs, not a reason to abandon the answer.
 */
export async function verifyResult(
  result: FlightResult,
  provider: FlightProvider | undefined,
  options: VerifyOptions,
): Promise<VerificationReport> {
  const notes: string[] = [];

  if (!provider?.verify || !provider.capabilities.priceVerification) {
    return {
      result: { ...result, priceConfidence: 'unverified' },
      changed: false,
      notes: [`${result.source}: ky burim nuk mbështet verifikim automatik të çmimit.`],
      error: new AgentError('price_unverifiable', 'Burimi nuk mbështet verifikim.', { source: result.source }),
    };
  }

  if (isHomepageUrl(result.bookingUrl)) {
    return {
      result: { ...result, priceConfidence: 'unverified' },
      changed: false,
      notes: ['Linku i ofertës mungon, prandaj çmimi nuk u verifikua.'],
      error: new AgentError('booking_url_unavailable', 'Nuk ka URL të përdorshme për verifikim.', {
        source: result.source,
      }),
    };
  }

  const context: ProviderContext = {
    chrome: options.chrome,
    logger: log.child(result.source),
    request: options.request,
    budgetMs: options.budgetMs ?? 90_000,
  };

  try {
    log.info(`po verifikoj ${result.airline} ${result.origin.airport}→${result.destination.airport} (${result.source})`);
    const outcome = await provider.verify(result, context);

    if (outcome.error || outcome.price === undefined) {
      return {
        result: {
          ...result,
          priceConfidence: 'unverified',
          bookingUrl: outcome.bookingUrl ?? result.bookingUrl,
          bookingUrlIsSearch: outcome.bookingUrl ? false : result.bookingUrlIsSearch,
        },
        changed: false,
        notes: ['Çmimi nuk mund të verifikohej në mënyrë të sigurt.'],
        error: outcome.error ?? new AgentError('price_unverifiable', 'Çmimi nuk u lexua.', { source: result.source }),
      };
    }

    const currency = outcome.currency ?? result.currency;
    const priceIsPerPerson = outcome.priceIsPerPerson ?? result.priceIsPerPerson;
    const passengers = Math.max(1, options.request.passengers);
    const totalPrice = round2(priceIsPerPerson ? outcome.price * passengers : outcome.price);

    // Compare like with like: the listed total against the verified total, same currency.
    const changed = currency === result.currency && Math.abs(totalPrice - result.totalPrice) >= 0.5;
    const delta = changed ? round2(totalPrice - result.totalPrice) : undefined;

    if (changed) {
      notes.push(
        delta! > 0
          ? `Çmimi u rrit me ${Math.abs(delta!)} ${currency} gjatë verifikimit — po raportoj çmimin e verifikuar.`
          : `Çmimi ra me ${Math.abs(delta!)} ${currency} gjatë verifikimit — po raportoj çmimin e verifikuar.`,
      );
    }
    if (outcome.taxesIncluded === false) notes.push('Kujdes: çmimi i shfaqur nuk i përfshin taksat.');
    if (priceIsPerPerson && passengers > 1) {
      notes.push(`Çmimi i burimit është për person; totali për ${passengers} udhëtarë është ${totalPrice} ${currency}.`);
    }
    if (outcome.baggage?.checkedBagIncluded === false) notes.push('Bagazhi i regjistruar nuk është i përfshirë.');

    return {
      result: {
        ...result,
        price: outcome.price,
        currency,
        priceIsPerPerson,
        totalPrice,
        listedPrice: changed ? result.price : undefined,
        taxesIncluded: outcome.taxesIncluded ?? result.taxesIncluded,
        baggage: outcome.baggage ?? result.baggage,
        bookingUrl: outcome.bookingUrl ?? result.bookingUrl,
        bookingUrlIsSearch: outcome.bookingUrl ? false : result.bookingUrlIsSearch,
        priceConfidence: changed ? 'changed' : 'verified',
        verifiedAt: new Date().toISOString(),
      },
      changed,
      delta,
      notes,
    };
  } catch (error) {
    const agentError = toAgentError(error, result.source);
    log.warn(`verifikimi dështoi: ${agentError.kind} — ${agentError.message.split('\n')[0]}`);
    return {
      result: { ...result, priceConfidence: 'unverified' },
      changed: false,
      notes: [`Çmimi nuk mund të verifikohej në mënyrë të sigurt (${agentError.userMessage}).`],
      error: agentError,
    };
  }
}

/**
 * Verifies the top candidates in order and returns the first that verifies successfully, along
 * with every report gathered. Trying more than one matters: if the headline fare evaporates on
 * the offer page, the honest answer is the next one that actually holds up.
 */
export async function verifyTopCandidates(
  candidates: FlightResult[],
  providerFor: (source: string) => FlightProvider | undefined,
  options: VerifyOptions & { maxAttempts?: number },
): Promise<{ reports: VerificationReport[]; verified?: VerificationReport }> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const reports: VerificationReport[] = [];

  for (const candidate of candidates.slice(0, maxAttempts)) {
    const report = await verifyResult(candidate, providerFor(candidate.source), options);
    reports.push(report);
    if (!report.error) return { reports, verified: report };
  }

  return { reports };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
