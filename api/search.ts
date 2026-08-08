import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSearch } from '../src/web/handle-search.js';

/**
 * Vercel serverless endpoint: natural language in, a structured plan and deep links out.
 *
 * Uses the Node `(req, res)` signature, which is what Vercel's Node runtime invokes handlers with.
 * `req.url` there is a path only — never a full URL — so it must be resolved against a base before
 * being parsed; doing otherwise throws and takes the whole function down.
 *
 * The endpoint is deliberately browser-free. A serverless function cannot hold a Chrome session
 * open for the 30–120s a real multi-source search takes, and the flight sites block datacenter IPs
 * anyway — so this does the half of the agent that is fast and always works. Set `WORKER_URL` to
 * point at a self-hosted worker (`npm run worker`) and real prices are merged into the response.
 */

interface VercelRequest extends IncomingMessage {
  /** Vercel parses JSON bodies for us; absent for GET or a non-JSON content type. */
  body?: unknown;
  query?: Partial<Record<string, string | string[]>>;
}

export default async function handler(req: VercelRequest, res: ServerResponse): Promise<void> {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('cache-control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    let query = '';
    let live = false;

    if (req.method === 'GET') {
      // `?q=…` makes a search a plain URL, so it can be bookmarked, shared, or curl'd.
      // `req.url` is path-only, hence the dummy base — the origin is irrelevant here.
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      query = params.get('q') ?? '';
      live = params.get('live') === '1';
    } else if (req.method === 'POST') {
      const body = await readJsonBody(req);
      query = typeof body.query === 'string' ? body.query : '';
      live = body.live === true;
    } else {
      send(res, 405, { status: 'error', error: 'Përdor GET ose POST.' });
      return;
    }

    if (!query.trim()) {
      send(res, 400, { status: 'error', error: 'Kërkesa mungon (përdor ?q=… ose {"query":"…"}).' });
      return;
    }

    const { status, body } = await handleSearch({ query, live });
    send(res, status, body);
  } catch (error) {
    // A crash here would return Vercel's HTML error page, which the page cannot parse as JSON.
    // Always answer with JSON so the UI can show something useful.
    console.error('search handler failed', error);
    send(res, 500, { status: 'error', error: 'Gabim i brendshëm gjatë përpunimit të kërkesës.' });
  }
}

/** Uses Vercel's parsed body when present, and falls back to reading the stream. */
async function readJsonBody(req: VercelRequest): Promise<{ query?: unknown; live?: unknown }> {
  if (req.body && typeof req.body === 'object') return req.body as { query?: unknown; live?: unknown };
  if (typeof req.body === 'string') return safeParse(req.body);

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    // A search request is a few hundred bytes; anything larger is not a search request.
    if (chunks.reduce((total, part) => total + part.length, 0) > 100_000) break;
  }
  return safeParse(Buffer.concat(chunks).toString('utf8'));
}

function safeParse(text: string): { query?: unknown; live?: unknown } {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as { query?: unknown; live?: unknown }) : {};
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
