import { Planner } from '../src/agent/planner.js';
import { buildDeepLinks, describeInterpretation } from '../src/web/deep-links.js';
import { AgentError, toAgentError } from '../src/errors.js';

/**
 * Vercel serverless endpoint: natural language in, a structured plan and deep links out.
 *
 * Deliberately browser-free. A serverless function cannot hold a Chrome session open for the
 * 30–120s a real multi-source search takes, and the flight sites block datacenter IPs anyway — so
 * this endpoint does the half of the agent that is fast and always works: understanding the
 * request, expanding it into the airports and dates worth checking, and producing links that
 * reproduce each of those searches.
 *
 * Set `WORKER_URL` to point at a self-hosted worker (`npm run worker`) and real, verified prices
 * are fetched from it and merged into the response.
 */

const MAX_QUERY_LENGTH = 500;

export default async function handler(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return json({}, 204);

  let query: string;
  let live = false;

  if (request.method === 'GET') {
    // `?q=…` makes a search a plain URL, so it can be bookmarked, shared, or curl'd.
    const params = new URL(request.url).searchParams;
    const q = params.get('q');
    if (!q?.trim()) return json({ error: 'Parametri "q" mungon.' }, 400);
    query = q.trim().slice(0, MAX_QUERY_LENGTH);
    live = params.get('live') === '1';
  } else if (request.method === 'POST') {
    try {
      const body = (await request.json()) as { query?: unknown; live?: unknown };
      if (typeof body.query !== 'string' || !body.query.trim()) {
        return json({ error: 'Fusha "query" mungon.' }, 400);
      }
      query = body.query.trim().slice(0, MAX_QUERY_LENGTH);
      live = body.live === true;
    } catch {
      return json({ error: 'Trupi i kërkesës nuk është JSON i vlefshëm.' }, 400);
    }
  } else {
    return json({ error: 'Përdor GET ose POST.' }, 405);
  }

  const planner = new Planner({
    defaultOrigin: process.env.DEFAULT_ORIGIN ?? 'Prishtina',
    defaultCurrency: process.env.DEFAULT_CURRENCY ?? 'EUR',
  });

  try {
    const plan = planner.plan(query);

    // Missing information is a question, not an error — ask for the one thing that is missing.
    if (plan.missing.length > 0) {
      return json({
        status: 'needs_input',
        question: plan.question,
        missing: plan.missing,
        notes: plan.notes,
        interpretation: describeInterpretation(plan.request),
      });
    }

    const { routes, notes, summary } = buildDeepLinks(plan.request, {
      maxDestinations: Number(process.env.MAX_DESTINATIONS ?? 6),
      maxDatePairs: Number(process.env.MAX_DATE_PAIRS ?? 5),
    });

    const response: Record<string, unknown> = {
      status: 'ok',
      summary,
      interpretation: describeInterpretation(plan.request),
      countryWide: plan.countryWide,
      flexibleDates: Boolean(plan.request.flexibleDates),
      notes: [...plan.notes, ...notes],
      routes,
    };

    const worker = process.env.WORKER_URL;
    if (live && worker) {
      response.live = await fetchLive(worker, plan.request, process.env.WORKER_TOKEN);
    } else if (live) {
      response.live = { error: 'Nuk ka worker të konfiguruar (WORKER_URL), prandaj çmimet reale nuk u kërkuan.' };
    }

    return json(response);
  } catch (error) {
    const agentError = error instanceof AgentError ? error : toAgentError(error);
    return json({ status: 'error', error: agentError.userMessage, kind: agentError.kind }, 400);
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
  // Comfortably under Vercel's function ceiling, so a slow worker degrades to "unavailable"
  // rather than a platform timeout that loses the whole response.
  const timer = setTimeout(() => controller.abort(), 55_000);

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

    if (!response.ok) {
      return { error: `Worker-i u përgjigj me ${response.status}.` };
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError';
    return { error: aborted ? 'Worker-i nuk u përgjigj në kohë.' : `Worker-i nuk u arrit: ${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'cache-control': 'no-store',
    },
  });
}
