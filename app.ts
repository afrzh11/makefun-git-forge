// The server: one Node http server routing healthz, REST v3, GraphQL v4, MCP and
// git smart HTTP onto the single shared store. This file replaces the starter's
// app.ts (same createApp() signature main.ts imports); main.ts is unchanged.
// Written from scratch for this entry.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleRest, isAuthenticated, nextRequestId, type HttpRequest, type RestContext } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  uploadPackV2Advertisement,
  uploadPackV0Advertisement,
  receivePackAdvertisement,
  lsRefsResponse,
  selectFetchObjects,
  fetchV2Response,
  fetchV0Response,
  writePack,
  readPack,
  parsePushBody,
  applyPush,
  pushReportResponse,
  cachedFetchPack,
  decodePktLines,
} from './gitproto.ts';
const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN && process.env.MAKEFUN_SHOP_TOKEN !== ''
  ? process.env.MAKEFUN_SHOP_TOKEN
  : 'test-token';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    ...(body === null ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const ctx: RestContext = { store, token: TOKEN, requestCounter: { value: 0 } };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId(ctx);
      const baseHeaders = { 'x-github-request-id': requestId };
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 400, { message: 'Bad Request' }, baseHeaders);
        return;
      }

      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, baseHeaders);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          const httpReq: HttpRequest = { method, url, headers: req.headers, body };
          const reply = handleRest(ctx, httpReq);
          if (reply !== null) {
            if (reply.status === 204) {
              res.writeHead(204, baseHeaders);
              res.end();
              return;
            }
            sendJson(res, reply.status, reply.body, { ...baseHeaders, ...(reply.headers ?? {}) });
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
            return;
          }
          const body = await readBody(req);
          const httpReq: HttpRequest = { method, url, headers: req.headers, body };
          if (!isAuthenticated(ctx, httpReq)) {
            sendJson(res, 401, { message: 'Unauthorized' }, baseHeaders);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { data: null, errors: [{ message: 'GraphQL: request body is not JSON' }] }, baseHeaders);
            return;
          }
          const runOne = (entry: unknown): Record<string, unknown> => {
            const record = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
              ? (entry as Record<string, unknown>)
              : {};
            const query = typeof record['query'] === 'string' ? (record['query'] as string) : '';
            const variables = record['variables'] !== null && typeof record['variables'] === 'object'
              ? (record['variables'] as Record<string, unknown>)
              : {};
            const operationName = typeof record['operationName'] === 'string' ? (record['operationName'] as string) : undefined;
            const result = executeGraphQL(store, query, variables, operationName);
            return { data: result.data, errors: result.errors };
          };
          if (Array.isArray(parsed)) {
            sendJson(res, 200, parsed.map(runOne), baseHeaders);
          } else {
            sendJson(res, 200, runOne(parsed), baseHeaders);
          }
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            // Session close (legacy era): best-effort, always 200.
            sendJson(res, 200, {}, baseHeaders);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
            return;
          }
          const body = await readBody(req);
          const httpReq: HttpRequest = { method, url, headers: req.headers, body };
          const authenticated = isAuthenticated(ctx, httpReq);
          const reply = handleMcp(store, body.toString('utf8'), authenticated);
          sendJson(res, reply.status, reply.body, baseHeaders);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const service = gitMatch[3];
          const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
            return;
          }
          if (service === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
              return;
            }
            const serviceParam = url.searchParams.get('service');
            if (serviceParam === 'git-upload-pack') {
              const wantsV2 = headerValue(req, 'git-protocol') === 'version=2';
              const body = wantsV2 ? uploadPackV2Advertisement() : uploadPackV0Advertisement(repo);
              sendBytes(res, 200, body, 'application/x-git-upload-pack-advertisement', baseHeaders);
              return;
            }
            if (serviceParam === 'git-receive-pack') {
              sendBytes(res, 200, receivePackAdvertisement(repo), 'application/x-git-receive-pack-advertisement', baseHeaders);
              return;
            }
            sendJson(res, 400, { message: 'Missing or invalid service parameter' }, baseHeaders);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
            return;
          }
          const body = await readBody(req);
          if (service === 'git-upload-pack') {
            const reply = handleUploadPack(store, repo, body, headerValue(req, 'git-protocol') === 'version=2');
            if (reply.status === 200) {
              sendBytes(res, 200, reply.body, 'application/x-git-upload-pack-result', baseHeaders);
            } else {
              sendJson(res, reply.status, { message: reply.message }, baseHeaders);
            }
            return;
          }
          // git-receive-pack
          const reply = handleReceivePack(repo, body);
          if (reply.status === 200) {
            sendBytes(res, 200, reply.body, 'application/x-git-receive-pack-result', baseHeaders);
          } else {
            sendJson(res, reply.status, { message: reply.message }, baseHeaders);
          }
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      } catch (err) {
        // A handler must never take the server down (repo-survives-errors).
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, baseHeaders);
        } catch {
          // The response is already gone; nothing more to do.
        }
      }
    })();
  });
}

// -------------------------------------------------------------------------------------------------
// git-upload-pack: ls-refs and fetch (v2 when the client asked for it, v0 otherwise)
// -------------------------------------------------------------------------------------------------

function handleUploadPack(
  store: Store,
  repo: Parameters<typeof selectFetchObjects>[0],
  body: Buffer,
  isV2: boolean,
): { status: number; body: Buffer; message?: string } {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, body: Buffer.alloc(0), message: 'Malformed pkt-line' };
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const command = (lines[0] ?? '').replace(/\n$/, '');
  if (command === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of lines.slice(1)) {
      const text = line.replace(/\n$/, '');
      if (text === '') continue;
      if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
      else if (text === 'unborn') unborn = true;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    }
    return { status: 200, body: lsRefsResponse(repo, prefixes, peel, symrefs, unborn) };
  }
  if (command === 'command=fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    let deepenSince: number | null = null;
    const deepenNot: string[] = [];
    for (const line of lines.slice(1)) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7).trim(), 10);
      else if (text.startsWith('deepen-since ')) deepenSince = parseInt(text.slice(13).trim(), 10);
      else if (text.startsWith('deepen-not ')) deepenNot.push(text.slice(11).trim());
    }
    const cacheKey = `${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${depth ?? ''}|${[...shallow].sort().join(',')}`;
    const { pack, selection } = cachedFetchPack(repo, cacheKey, () => {
      const sel = selectFetchObjects(repo, wants, haves, depth, shallow, deepenSince, deepenNot);
      return { pack: writePack(sel.objects.map((obj) => ({ type: obj.type, data: obj.data }))), selection: sel };
    });
    if (isV2) return { status: 200, body: fetchV2Response(selection, pack) };
    return { status: 200, body: fetchV0Response(selection, pack) };
  }
  // A v0 fetch body has no `command=` line: two flush-terminated sections.
  // Re-parse the raw packets into sections.
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind === 'data') sections[sections.length - 1].push(packet.payload.toString('utf8'));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenSince: number | null = null;
  const deepenNot: string[] = [];
  const firstSection = sections[0] ?? [];
  for (const raw of firstSection) {
    const text = raw.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      // The first want line carries features after the oid; take the first token.
      wants.push(text.slice(5).trim().split(/\s+/)[0]);
    } else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7).trim(), 10);
    else if (text.startsWith('deepen-since ')) deepenSince = parseInt(text.slice(13).trim(), 10);
    else if (text.startsWith('deepen-not ')) deepenNot.push(text.slice(11).trim());
  }
  const secondSection = sections[1] ?? [];
  for (const raw of secondSection) {
    const text = raw.replace(/\n$/, '');
    if (text.startsWith('have ')) haves.push(text.slice(5).trim());
  }
  if (wants.length === 0) {
    return { status: 400, body: Buffer.alloc(0), message: 'No want in fetch request' };
  }
  const cacheKey = `v0|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${depth ?? ''}|${[...shallow].sort().join(',')}`;
  const { pack, selection } = cachedFetchPack(repo, cacheKey, () => {
    const sel = selectFetchObjects(repo, wants, haves, depth, shallow, deepenSince, deepenNot);
    return { pack: writePack(sel.objects.map((obj) => ({ type: obj.type, data: obj.data }))), selection: sel };
  });
  return { status: 200, body: fetchV0Response(selection, pack) };
}

// -------------------------------------------------------------------------------------------------
// git-receive-pack: push
// -------------------------------------------------------------------------------------------------

function handleReceivePack(
  repo: Parameters<typeof applyPush>[0],
  body: Buffer,
): { status: number; body: Buffer; message?: string } {
  let parsed;
  try {
    parsed = parsePushBody(body);
  } catch {
    return { status: 400, body: Buffer.alloc(0), message: 'Malformed pkt-line' };
  }
  const sideband = body.toString('utf8', 0, Math.min(body.length, 4096)).includes('side-band-64k');
  let packObjects: Map<string, import('./store.ts').GitObject> | null = null;
  let hasPack = false;
  if (parsed.pack !== null && parsed.pack.length > 0) {
    hasPack = true;
    try {
      const read = readPack(parsed.pack, (oid) => {
        const obj = repo.objects.get(oid);
        return obj;
      });
      packObjects = read.objects;
    } catch {
      const outcome = { unpackOk: false, unpackDetail: 'unpacker error', refs: [] };
      return { status: 200, body: pushReportResponse(outcome, sideband) };
    }
  } else if (parsed.pack !== null) {
    // A zero-length pack after the flush is not a pack at all (delete-only).
    hasPack = false;
  }
  const outcome = applyPush(repo, parsed.commands, packObjects, hasPack);
  return { status: 200, body: pushReportResponse(outcome, sideband) };
}
