// REST v3 surface (/api/v3). Implements the routes the suite exercises: repos,
// branches, commits, contents, labels, issues, comments, pull requests. Every
// JSON reply carries X-GitHub-Request-Id; errors are {"message": ...}.
// Written from scratch for this entry.

import {
  FIXED_ISO,
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  VIEWER_EMAIL,
  ZERO_OID,
  isObjectId,
  putObject,
  getObject,
  buildCommit,
  parseCommit,
  treeGetFile,
  treeSetFile,
  treeListDir,
  diffTrees,
  lineCount,
  commitTreeOid,
  squashMerge,
  type Repo,
  type Issue,
  type Pull,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  /** The bearer token the suite presents (MAKEFUN_SHOP_TOKEN or a local default). */
  token: string;
  /** Monotonic counter for X-GitHub-Request-Id values. */
  requestCounter: { value: number };
}

export interface HttpRequest {
  method: string;
  url: URL;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface HttpReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): HttpReply {
  return { status, body, headers };
}

export function errorReply(status: number, message: string): HttpReply {
  return { status, body: { message } };
}

export function nextRequestId(ctx: RestContext): string {
  ctx.requestCounter.value += 1;
  return `req-${ctx.requestCounter.value}`;
}

function bearerToken(req: HttpRequest): string | null {
  const auth = req.headers['authorization'];
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (!value || !value.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length);
}

export function isAuthenticated(ctx: RestContext, req: HttpRequest): boolean {
  const token = bearerToken(req);
  return token !== null && token === ctx.token;
}

function parseJsonBody(req: HttpRequest): { ok: true; value: unknown } | { ok: false } {
  if (req.body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(req.body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function boolField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  return typeof value === 'boolean' ? value : fallback;
}

// -------------------------------------------------------------------------------------------------
// Serializers (minimum shapes per the suite; extra fields are allowed)
// -------------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    fork: false,
    has_issues: true,
  };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

export function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function pagination(req: HttpRequest): { perPage: number; page: number } {
  const perPageRaw = parseInt(req.url.searchParams.get('per_page') ?? '', 10);
  const pageRaw = parseInt(req.url.searchParams.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function pageSlice<T>(items: T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(req: HttpRequest, total: number, perPage: number, page: number): string {
  const host = req.headers['host'];
  const hostValue = Array.isArray(host) ? host[0] : host ?? 'localhost';
  const base = `http://${hostValue}${req.url.pathname}`;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const params = new URLSearchParams(req.url.searchParams);
  const linkFor = (p: number, rel: string): string => {
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `<${base}?${params.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  links.push(linkFor(1, 'first'));
  links.push(linkFor(totalPages, 'last'));
  return links.join(', ');
}

// -------------------------------------------------------------------------------------------------
// Git helpers for the contents API
// -------------------------------------------------------------------------------------------------

function resolveRefTip(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  if (isObjectId(ref) && repo.objects.has(ref)) return ref;
  const full = repo.refs.get(ref);
  if (full) return full;
  return null;
}

function makeCommit(
  repo: Repo,
  message: string,
  treeOid: string,
  parent: string | null,
): string {
  const stamp = `${1735689600} +0000`;
  const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const data = buildCommit({
    tree: treeOid,
    parents: parent ? [parent] : [],
    author: `${identity} ${stamp}`,
    committer: `${identity} ${stamp}`,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  return putObject(repo, 'commit', data);
}

function walkCommits(repo: Repo, tip: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    let info;
    try {
      info = parseCommit(obj.data);
    } catch {
      continue;
    }
    out.push({ sha: oid, message: info.message });
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// The router
// -------------------------------------------------------------------------------------------------

/**
 * Handle a /api/v3 request. Returns null when the path is not a REST route.
 * `body` is the raw request body (already read).
 */
export function handleRest(ctx: RestContext, req: HttpRequest): HttpReply | null {
  const path = req.url.pathname;
  if (!path.startsWith('/api/v3')) return null;
  const method = req.method;
  const store = ctx.store;

  // API root and meta are public (the protocol checks call them without a token).
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    return jsonReply(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    return jsonReply(200, { installed_version: '1.0.0' });
  }

  // Everything else needs the bearer token.
  if (!isAuthenticated(ctx, req)) {
    return errorReply(401, 'Bad credentials');
  }

  const segments = path.split('/').filter((s) => s.length > 0);
  // segments[0] === 'api', segments[1] === 'v3'

  // GET /api/v3/user
  if (method === 'GET' && segments.length === 3 && segments[2] === 'user') {
    return jsonReply(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
    });
  }

  // POST /api/v3/user/repos  |  GET /api/v3/user/repos
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
      const body = record(parsed.value) ?? {};
      const name = stringField(body, 'name');
      if (name === '') return errorReply(422, 'Repository name is required');
      if (store.getRepo(VIEWER_LOGIN, name)) return errorReply(422, 'Repository already exists');
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        boolField(body, 'private', false),
        stringField(body, 'description'),
      );
      return jsonReply(201, repoJson(repo));
    }
    if (method === 'GET') {
      const { perPage, page } = pagination(req);
      const repos = store.listRepos(VIEWER_LOGIN);
      const items = pageSlice(repos, perPage, page).map(repoJson);
      const headers: Record<string, string> = {};
      if (repos.length > perPage || page > 1) headers['link'] = linkHeader(req, repos.length, perPage, page);
      return jsonReply(200, items, headers);
    }
    return errorReply(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (segments.length >= 5 && segments[2] === 'repos') {
    const owner = decodeURIComponent(segments[3]);
    const name = decodeURIComponent(segments[4]);
    // A repo under any other owner is hidden as 404, never 403.
    if (owner !== VIEWER_LOGIN) return errorReply(404, 'Not Found');
    const repo = store.getRepo(owner, name);
    const rest = segments.slice(5);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return errorReply(404, 'Not Found');
        return jsonReply(200, repoJson(repo));
      }
      if (method === 'PATCH') {
        if (!repo) return errorReply(404, 'Not Found');
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
        const body = record(parsed.value) ?? {};
        if (typeof body['description'] === 'string') repo.description = body['description'] as string;
        if (typeof body['private'] === 'boolean') repo.private = body['private'] as boolean;
        return jsonReply(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        if (!repo) return errorReply(404, 'Not Found');
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return errorReply(404, 'Not Found');
    }

    if (!repo) return errorReply(404, 'Not Found');

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
        const body = record(parsed.value) ?? {};
        const ref = stringField(body, 'ref');
        const sha = stringField(body, 'sha');
        if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
          return errorReply(422, 'Invalid ref or sha');
        }
        if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        repo.generation += 1;
        repo.packCache.clear();
        return jsonReply(201, { ref, object: { sha } });
      }
      if (method === 'GET' && rest.length >= 3) {
        // GET /repos/{o}/{r}/git/refs/heads/{branch} (MCP setup reads a branch this way).
        const refName = rest.slice(2).join('/');
        const oid = repo.refs.get(refName);
        if (!oid) return errorReply(404, 'Not Found');
        return jsonReply(200, { ref: refName, object: { sha: oid } });
      }
      return errorReply(404, 'Not Found');
    }

    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const items: Record<string, unknown>[] = [];
        for (const [refName, oid] of [...repo.refs.entries()].sort()) {
          if (!refName.startsWith('refs/heads/')) continue;
          items.push({ name: refName.slice('refs/heads/'.length), commit: { sha: oid } });
        }
        return jsonReply(200, items);
      }
      if (method === 'GET' && rest.length === 2) {
        const branch = decodeURIComponent(rest[1]);
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (!oid) return errorReply(404, 'Not Found');
        return jsonReply(200, { name: branch, commit: { sha: oid } });
      }
      return errorReply(404, 'Not Found');
    }

    // commits
    if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
      const refParam = req.url.searchParams.get('sha');
      const tip = resolveRefTip(repo, refParam);
      if (!tip) return errorReply(404, 'Not Found');
      const items = walkCommits(repo, tip).map((c) => ({
        sha: c.sha,
        commit: {
          // GitHub presents the message without the trailing newline the object carries.
          message: c.message.replace(/\n+$/, ''),
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
        },
      }));
      return jsonReply(200, items);
    }

    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'PUT') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
        const body = record(parsed.value) ?? {};
        const message = stringField(body, 'message');
        const contentB64 = stringField(body, 'content');
        const branch = typeof body['branch'] === 'string' ? (body['branch'] as string) : null;
        const givenSha = typeof body['sha'] === 'string' ? (body['sha'] as string) : null;
        if (filePath === '') return errorReply(422, 'A path is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/[\r\n\t ]/g, ''), 'base64');
        } catch {
          return errorReply(422, 'content is not valid base64');
        }
        const tip = resolveRefTip(repo, branch);
        const branchName = branch ?? repo.defaultBranch;
        if (branch !== null && !repo.refs.has(`refs/heads/${branch}`) && tip === null) {
          return errorReply(404, 'Not Found');
        }
        const currentTree = tip ? commitTreeOid(repo, tip) : null;
        const existing = currentTree ? treeGetFile(repo, currentTree, filePath) : null;
        if (existing) {
          if (givenSha !== null && givenSha.toLowerCase() !== existing.blobOid.toLowerCase()) {
            return errorReply(409, 'sha does not match the current blob');
          }
          const blobOid = putObject(repo, 'blob', content);
          if (blobOid === existing.blobOid) {
            // No change: still answer the update shape with the current blob.
            return jsonReply(200, {
              content: { sha: blobOid, encoding: 'base64' },
              commit: { sha: tip },
            });
          }
          const treeOid = treeSetFile(repo, currentTree, filePath, blobOid);
          const commitOid = makeCommit(repo, message, treeOid, tip);
          repo.refs.set(`refs/heads/${branchName}`, commitOid);
          repo.generation += 1;
          repo.packCache.clear();
          return jsonReply(200, {
            content: { sha: blobOid, encoding: 'base64' },
            commit: { sha: commitOid },
          });
        }
        if (givenSha !== null) return errorReply(409, 'sha does not match the current blob');
        const blobOid = putObject(repo, 'blob', content);
        const treeOid = treeSetFile(repo, currentTree, filePath, blobOid);
        const commitOid = makeCommit(repo, message, treeOid, tip);
        repo.refs.set(`refs/heads/${branchName}`, commitOid);
        repo.generation += 1;
        repo.packCache.clear();
        return jsonReply(201, {
          content: { sha: blobOid, encoding: 'base64' },
          commit: { sha: commitOid },
        });
      }
      if (method === 'GET') {
        const refParam = req.url.searchParams.get('ref');
        const tip = resolveRefTip(repo, refParam);
        if (!tip) return errorReply(404, 'Not Found');
        const treeOid = commitTreeOid(repo, tip);
        if (!treeOid) return errorReply(404, 'Not Found');
        if (filePath === '') {
          const entries = treeListDir(repo, treeOid, '') ?? [];
          return jsonReply(
            200,
            entries.map((e) => ({
              type: e.mode === '40000' ? 'dir' : 'file',
              name: e.name,
              path: e.name,
              sha: e.oid,
            })),
          );
        }
        const file = treeGetFile(repo, treeOid, filePath);
        if (file) {
          return jsonReply(200, {
            type: 'file',
            encoding: 'base64',
            content: file.data.toString('base64'),
            sha: file.blobOid,
            size: file.data.length,
            name: filePath.split('/').pop(),
            path: filePath,
          });
        }
        const dir = treeListDir(repo, treeOid, filePath);
        if (dir) {
          return jsonReply(
            200,
            dir.map((e) => ({
              type: e.mode === '40000' ? 'dir' : 'file',
              name: e.name,
              path: `${filePath}/${e.name}`,
              sha: e.oid,
            })),
          );
        }
        return errorReply(404, 'Not Found');
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
        const body = record(parsed.value) ?? {};
        const message = stringField(body, 'message');
        const givenSha = typeof body['sha'] === 'string' ? (body['sha'] as string) : null;
        const branch = typeof body['branch'] === 'string' ? (body['branch'] as string) : null;
        const tip = resolveRefTip(repo, branch);
        if (!tip) return errorReply(404, 'Not Found');
        const branchName = branch ?? repo.defaultBranch;
        const currentTree = commitTreeOid(repo, tip);
        const existing = currentTree ? treeGetFile(repo, currentTree, filePath) : null;
        if (!existing) return errorReply(404, 'Not Found');
        if (givenSha !== null && givenSha.toLowerCase() !== existing.blobOid.toLowerCase()) {
          return errorReply(409, 'sha does not match the current blob');
        }
        const treeOid = treeSetFile(repo, currentTree, filePath, null);
        const commitOid = makeCommit(repo, message, treeOid, tip);
        repo.refs.set(`refs/heads/${branchName}`, commitOid);
        repo.generation += 1;
        repo.packCache.clear();
        return jsonReply(200, { commit: { sha: commitOid } });
      }
      return errorReply(404, 'Not Found');
    }

    // labels
    if (rest[0] === 'labels' && method === 'POST' && rest.length === 1) {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
      const body = record(parsed.value) ?? {};
      const name = stringField(body, 'name');
      const color = stringField(body, 'color') || 'ededed';
      if (name === '') return errorReply(422, 'Label name is required');
      if (repo.labels.has(name)) return errorReply(422, 'Label already exists');
      repo.labels.set(name, { name, color });
      return jsonReply(201, { name, color });
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
          const body = record(parsed.value) ?? {};
          const title = stringField(body, 'title');
          const issueBody = stringField(body, 'body');
          const labelsRaw = body['labels'];
          const labels: string[] = Array.isArray(labelsRaw)
            ? labelsRaw.filter((l): l is string => typeof l === 'string')
            : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return errorReply(422, `Label does not exist: ${label}`);
          }
          const issue: Issue = {
            id: ctx.store.nextIssueId++,
            number: repo.nextIssue++,
            title,
            body: issueBody,
            state: 'open',
            labels,
            comments: [],
            seq: ctx.store.nextSeq++,
          };
          repo.issues.push(issue);
          repo.issueByNumber.set(issue.number, issue);
          return jsonReply(201, issueJson(issue));
        }
        if (method === 'GET') {
          const stateParam = req.url.searchParams.get('state') ?? 'open';
          const sortParam = req.url.searchParams.get('sort') ?? 'created';
          const directionParam = req.url.searchParams.get('direction') ?? 'desc';
          let items = [...repo.issues];
          if (stateParam === 'open') items = items.filter((i) => i.state === 'open');
          else if (stateParam === 'closed') items = items.filter((i) => i.state === 'closed');
          if (sortParam === 'created') {
            items.sort((a, b) => (directionParam === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const { perPage, page } = pagination(req);
          const pageItems = pageSlice(items, perPage, page);
          const headers: Record<string, string> = {};
          if (items.length > perPage || page > 1) headers['link'] = linkHeader(req, items.length, perPage, page);
          return jsonReply(200, pageItems.map(issueJson), headers);
        }
        return errorReply(404, 'Not Found');
      }
      const number = parseInt(rest[1], 10);
      if (!Number.isFinite(number)) return errorReply(404, 'Not Found');
      const issue = repo.issueByNumber.get(number);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!issue) return errorReply(404, 'Not Found');
          return jsonReply(200, issueJson(issue));
        }
        if (method === 'PATCH') {
          if (!issue) return errorReply(404, 'Not Found');
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
          const body = record(parsed.value) ?? {};
          if (body['state'] === 'open' || body['state'] === 'closed') issue.state = body['state'] as 'open' | 'closed';
          if (typeof body['title'] === 'string') issue.title = body['title'] as string;
          if (typeof body['body'] === 'string') issue.body = body['body'] as string;
          return jsonReply(200, issueJson(issue));
        }
        return errorReply(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return errorReply(404, 'Not Found');
        if (method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
          const body = record(parsed.value) ?? {};
          const commentBody = stringField(body, 'body');
          const comment = { id: ctx.store.nextCommentId++, body: commentBody };
          issue.comments.push(comment);
          return jsonReply(201, { id: comment.id, body: comment.body });
        }
        if (method === 'GET') {
          return jsonReply(
            200,
            issue.comments.map((c) => ({ id: c.id, body: c.body })),
          );
        }
        return errorReply(404, 'Not Found');
      }
      return errorReply(404, 'Not Found');
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const parsed = parseJsonBody(req);
          if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
          const body = record(parsed.value) ?? {};
          const head = stringField(body, 'head');
          const base = stringField(body, 'base');
          const title = stringField(body, 'title');
          const pullBody = stringField(body, 'body');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) return errorReply(422, 'Head or base branch does not exist');
          const existing = repo.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
          if (existing) return errorReply(422, 'A pull request already exists for this branch');
          const pull: Pull = {
            id: ctx.store.nextPullId++,
            number: repo.nextPull++,
            title,
            body: pullBody,
            state: 'open',
            headRef: head,
            headSha,
            baseRef: base,
            baseSha,
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            seq: ctx.store.nextSeq++,
          };
          repo.pulls.push(pull);
          repo.pullByNumber.set(pull.number, pull);
          return jsonReply(201, pullJson(pull, repo));
        }
        if (method === 'GET') {
          const stateParam = req.url.searchParams.get('state') ?? 'open';
          let items = [...repo.pulls];
          if (stateParam === 'open') items = items.filter((p) => p.state === 'open');
          else if (stateParam === 'closed') items = items.filter((p) => p.state === 'closed');
          items.sort((a, b) => b.seq - a.seq);
          const { perPage, page } = pagination(req);
          const pageItems = pageSlice(items, perPage, page);
          const headers: Record<string, string> = {};
          if (items.length > perPage || page > 1) headers['link'] = linkHeader(req, items.length, perPage, page);
          return jsonReply(200, pageItems.map((p) => pullJson(p, repo)), headers);
        }
        return errorReply(404, 'Not Found');
      }
      const number = parseInt(rest[1], 10);
      if (!Number.isFinite(number)) return errorReply(404, 'Not Found');
      const pull = repo.pullByNumber.get(number);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!pull) return errorReply(404, 'Not Found');
          return jsonReply(200, pullJson(pull, repo));
        }
        return errorReply(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) return errorReply(404, 'Not Found');
        const headTree = commitTreeOid(repo, pull.headSha);
        const baseTree = commitTreeOid(repo, pull.baseSha);
        if (headTree === null || baseTree === null) return jsonReply(200, []);
        const diffs = diffTrees(repo, baseTree, headTree);
        const files = diffs.map((d) => {
          let additions = 0;
          let deletions = 0;
          if (d.newOid) {
            const blob = getObject(repo, d.newOid);
            if (blob) additions = lineCount(blob.data);
          }
          if (d.oldOid) {
            const blob = getObject(repo, d.oldOid);
            if (blob) deletions = lineCount(blob.data);
          }
          const status = d.status === 'added' ? 'added' : d.status === 'removed' ? 'removed' : 'modified';
          return {
            filename: d.path,
            status,
            additions,
            deletions,
            changes: additions + deletions,
          };
        });
        return jsonReply(200, files);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) return errorReply(404, 'Not Found');
        if (pull.merged || pull.state !== 'open') return errorReply(405, 'Pull request is already closed');
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return errorReply(400, 'Problems parsing JSON');
        const result = squashMerge(ctx.store, repo, pull);
        if (!result.ok) {
          if (result.conflict) return errorReply(405, 'Merge conflict');
          return errorReply(422, 'Cannot merge this pull request');
        }
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = FIXED_ISO;
        pull.mergeCommitSha = result.mergeCommit;
        pull.baseSha = result.mergeCommit;
        return jsonReply(200, {
          merged: true,
          sha: result.mergeCommit,
          message: `Pull request #${pull.number} merged`,
        });
      }
      return errorReply(404, 'Not Found');
    }
  }

  return errorReply(404, 'Not Found');
}
