import type { IncomingMessage, ServerResponse } from 'node:http';
import { fail } from './http.ts';

export async function handleRest(
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rest: string,
): Promise<void> {
  fail(res, 404, 'Not Found');
}
