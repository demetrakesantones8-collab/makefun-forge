import type { IncomingMessage, ServerResponse } from 'node:http';
import { fail } from './http.ts';

export async function handleGit(
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  owner: string,
  repo: string,
  service: string,
): Promise<void> {
  fail(res, 404, 'Not Found');
}
