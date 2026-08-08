import { Planner } from '../agent/planner.js';
import { AgentError, toAgentError } from '../errors.js';
import { buildDeepLinks, describeInterpretation } from './deep-links.js';

/**
 * The search endpoint's logic, independent of any HTTP framework.
 *
 * Kept separate from the Vercel adapter so it can be tested directly, and so the same logic can be
 * served from anywhere. The adapter's only job is to pull `query`/`live` out of a request and put
 * the returned status and body back onto a response.
 */

export const MAX_QUERY_LENGTH = 500;

export interface SearchInput {
  query: string;
  live?: boolean;
}

export interface SearchOutput {
  status: number;
  body: Record<string, unknown>;
}

export interface SearchEnv {
  DEFAULT_ORIGIN?: string;
  DEFAULT_CURRENCY?: string;
  MAX_DESTINATIONS?: string;
  MAX_DATE_PAIRS?: string;
  WORKER_URL?: string;
  WORKER_TOKEN?: string;
}

export async function handleSearch(input: SearchInput, env: SearchEnv = process.env): Promise<SearchOutput> {
  const query = input.query?.trim().slice(0, MAX_QUERY_LENGTH);
  if (!query) return { status: 400, body: { status: 'error', error: 'Kërkesa është bosh.' } };

  const planner = new Planner({
    defaultOrigin: env.DEFAULT_ORIGIN ?? 'Prishtina',
    defaultCurrency: env.DEFAULT_CURRENCY ?? 'EUR',
  });

  try {
    const plan = planner.plan(query);

    // Missing information is a question, not an error — ask for the one thing that is missing.
    if (plan.missing.length > 0) {
      return {
        status: 200,
        body: {
          status: 'needs_input',
          question: plan.question,
          missing: plan.missing,
          notes: plan.notes,
          interpretation: describeInterpretation(plan.request),
        },
      };
    }

    const { routes, notes, summary } = buildDeepLinks(plan.request, {
      maxDestinations: positiveInt(env.MAX_DESTINATIONS, 6),
      maxDatePairs: positiveInt(env.MAX_DATE_PAIRS, 5),
    });

    const body: Record<string, unknown> = {
      status: 'ok',
      summary,
      interpretation: describeInterpretation(plan.request),
      countryWide: plan.countryWide,
      flexibleDates: Boolean(plan.request.flexibleDates),
      notes: [...plan.notes, ...notes],
      routes,
    };

    if (input.live) {
      body.live = env.WORKER_URL
        ? await fetchLive(env.WORKER_URL, plan.request, env.WORKER_TOKEN)
        : { error: 'Nuk ka worker të konfiguruar (WORKER_URL), prandaj çmimet reale nuk u kërkuan.' };
    }

    return { status: 200, body };
  } catch (error) {
    const agentError = error instanceof AgentError ? error : toAgentError(error);
    return { status: 400, body: { status: 'error', error: agentError.userMessage, kind: agentError.kind } };
  }
}

/**
 * Asks a self-hosted worker for real prices. Never throws: the deep links are the useful part of
 * the answer, and losing them because the optional worker is down would be a bad trade.
 */
async function fetchLive(
  workerUrl: string,
  request: unknown,
  token: string | undefined,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  // Comfortably under the function's own ceiling, so a slow worker degrades to "unavailable"
  // rather than a platform timeout that loses the whole response.
  const timer = setTimeout(() => controller.abort(), 50_000);

  try {
    const response = await fetch(new URL('/search', workerUrl).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ request }),
      signal: controller.signal,
    });

    if (!response.ok) return { error: `Worker-i u përgjigj me ${response.status}.` };
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError';
    return { error: aborted ? 'Worker-i nuk u përgjigj në kohë.' : `Worker-i nuk u arrit: ${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Env values arrive as strings; a malformed one must not silently become NaN. */
function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
