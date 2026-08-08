#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { FlightSearchAgent } from './agent/flight-search-agent.js';
import { Planner } from './agent/planner.js';
import { toJsonReport } from './agent/result-formatter.js';
import { AgentError, toAgentError } from './errors.js';
import { validateFlightRequest, type FlightRequest } from './models/flight-request.js';
import { createDefaultRegistry, createMockRegistry } from './providers/index.js';
import { createLogger } from './utils/logger.js';

/**
 * Long-running worker that performs the real browser searches.
 *
 * The hosted web app cannot do this itself — serverless functions are too short-lived to drive a
 * browser through a multi-source search, and flight sites block datacenter IPs. So the browser
 * half of the agent lives here: run it on your own machine (or any host that gives you a
 * persistent process), point `WORKER_URL` at it, and the hosted UI gains real verified prices.
 *
 *     npm run worker                       # listens on :8787
 *     WORKER_TOKEN=secret npm run worker   # require an Authorization: Bearer header
 */

const log = createLogger('worker');
const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.WORKER_TOKEN;
/** One search at a time: each runs several browser tabs, and piling them up helps nobody. */
const MAX_CONCURRENT = Number(process.env.WORKER_CONCURRENCY ?? 1);

/**
 * `WORKER_MOCK=1` runs the offline provider instead of a browser. It exists so the wiring between
 * the hosted site and this worker can be verified in seconds; its prices are synthetic and every
 * result says so, so a mock reply can never be mistaken for a real quote.
 */
const useMock = process.env.WORKER_MOCK === '1';

const agent = new FlightSearchAgent({
  registry: useMock ? createMockRegistry() : createDefaultRegistry(),
  maxDestinations: Number(process.env.MAX_DESTINATIONS ?? 4),
  maxDatePairs: Number(process.env.MAX_DATE_PAIRS ?? 3),
  concurrency: Number(process.env.BROWSER_CONCURRENCY ?? 3),
});

let inFlight = 0;

const server = createServer((req, res) => {
  void handle(req, res).catch((error) => {
    log.error('gabim i patrajtuar', error);
    send(res, 500, { error: 'Gabim i brendshëm.' });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') return send(res, 204, null);
  if (url.pathname === '/health') return send(res, 200, { ok: true, inFlight, mock: useMock });
  if (url.pathname !== '/search') return send(res, 404, { error: 'Not found.' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Përdor POST.' });

  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { error: 'Token i pavlefshëm.' });
  }
  if (inFlight >= MAX_CONCURRENT) {
    return send(res, 429, { error: 'Worker-i është i zënë, provo pas pak.' });
  }

  let payload: { request?: FlightRequest; query?: string };
  try {
    payload = JSON.parse(await readBody(req)) as typeof payload;
  } catch {
    return send(res, 400, { error: 'JSON i pavlefshëm.' });
  }

  // Accept either a structured request (from the hosted API) or raw text (for direct use).
  let request: FlightRequest;
  try {
    if (payload.request) {
      request = validateFlightRequest(payload.request);
    } else if (payload.query) {
      const plan = new Planner({ defaultOrigin: process.env.DEFAULT_ORIGIN }).plan(payload.query);
      if (plan.missing.length > 0) {
        return send(res, 400, { error: plan.question, missing: plan.missing });
      }
      request = plan.request;
    } else {
      return send(res, 400, { error: 'Duhet "request" ose "query".' });
    }
  } catch (error) {
    const agentError = error instanceof AgentError ? error : toAgentError(error);
    return send(res, 400, { error: agentError.userMessage, kind: agentError.kind });
  }

  inFlight++;
  const startedAt = Date.now();
  try {
    log.info(`kërkim: ${request.origin} → ${request.destination ?? request.destinationCountry}`);
    const report = await agent.search(request);
    log.info(`përfundoi për ${Math.round((Date.now() - startedAt) / 1000)}s`);
    send(res, 200, toJsonReport(report));
  } catch (error) {
    const agentError = error instanceof AgentError ? error : toAgentError(error);
    log.warn(`kërkimi dështoi: ${agentError.kind}`);
    send(res, 502, { error: agentError.userMessage, kind: agentError.kind });
  } finally {
    inFlight--;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      // A search request is a few hundred bytes; anything larger is not a search request.
      if (body.length > 100_000) reject(new Error('Trupi shumë i madh.'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': process.env.ALLOWED_ORIGIN ?? '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
  });
  res.end(body === null ? undefined : JSON.stringify(body));
}

server.listen(PORT, () => {
  log.info(`worker-i po dëgjon në http://localhost:${PORT}${useMock ? ' (MOCK — çmime demo)' : ''}`);
  if (!TOKEN) log.warn('WORKER_TOKEN nuk është vendosur — kushdo që arrin këtë port mund të kërkojë.');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('po mbyllet…');
    server.close();
    void agent.close().finally(() => process.exit(0));
  });
}
