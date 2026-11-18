import type { IncomingMessage, ServerResponse } from 'node:http';
import { fail } from './http.ts';

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  fail(res, 404, 'Not Found');
}
