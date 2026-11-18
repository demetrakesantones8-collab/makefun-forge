// The entry's HTTP server: one process serving git smart HTTP, the REST v3 API, GraphQL and MCP from
// the same store. The env's boot probe and the platform's contract come first; everything else is
// parsed here and handed to the surface that owns it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { authorized, fail, sendJson } from './http.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      fail(res, 400, 'Problems parsing the request URL');
      return;
    }
    const path = url.pathname;

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!authorized(req, url)) {
      fail(res, 401, 'Requires authentication');
      return;
    }

    // The API root: a 200 with the token's scopes, as api.github.com answers GET /.
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          rate_limit_url: '/api/v3/rate_limit',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          user_url: '/api/v3/user',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }

    if (path === '/api/graphql' || path === '/api/graphql/') {
      if (method !== 'POST') {
        fail(res, 405, 'Only POST is allowed on the GraphQL endpoint');
        return;
      }
      void handleGraphql(req, res, url);
      return;
    }

    if (path === '/mcp' || path === '/mcp/') {
      void handleMcp(req, res, url);
      return;
    }

    if (path.startsWith('/api/v3/')) {
      void handleRest(method, req, res, url, path.slice('/api/v3/'.length));
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
    const git = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (git) {
      void handleGit(method, req, res, url, decodeURIComponent(git[1]), decodeURIComponent(git[2]), git[3]);
      return;
    }

    fail(res, 404, 'Not Found');
  });
}
