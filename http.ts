// HTTP plumbing shared by every surface: bodies, JSON replies, the auth gate and path parsing.

import type { IncomingMessage, ServerResponse } from 'node:http';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The whole request body as bytes. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The body parsed as JSON; throws SyntaxError on a malformed one. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  if (body.length === 0) return {};
  return JSON.parse(body.toString('utf8'));
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

export function sendBytes(res: ServerResponse, status: number, body: Buffer, type: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(body);
}

let counter = 0;
const requestId = (): string => `${(counter += 1).toString(16).padStart(8, '0')}-forge`;

/** GitHub's error body: one string message on JSON, with the request id header. */
export function fail(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest', ...extra });
}

/** Whether the request carries the trial's token, as a bearer, a basic password or a query token. */
export function authorized(req: IncomingMessage, url: URL): boolean {
  if (TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  if (header.toLowerCase().startsWith('bearer ') && header.slice(7).trim() === TOKEN) return true;
  if (header.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (password === TOKEN) return true;
  }
  const query = url.searchParams.get('access_token');
  return query === TOKEN;
}

/** The JSON body of a request, or 400 already answered (null). */
export async function bodyOr400(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
  try {
    return await readJson(req);
  } catch {
    fail(res, 400, 'Problems parsing JSON');
    return null;
  }
}

/** A body member as a string, '' when absent. */
export function str(body: unknown, key: string): string {
  if (body === null || typeof body !== 'object') return '';
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/** A body member as a string array, [] when absent. */
export function strList(body: unknown, key: string): string[] {
  if (body === null || typeof body !== 'object') return [];
  const value = (body as Record<string, unknown>)[key];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

/** An int query parameter, `fallback` when absent or unusable. */
export function intParam(url: URL, key: string, fallback: number, max: number): number {
  const raw = Number(url.searchParams.get(key));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}
