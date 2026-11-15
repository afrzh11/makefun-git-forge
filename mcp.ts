// MCP (/mcp): JSON-RPC 2.0 over Streamable HTTP, modern revision 2026-07-28 with a
// legacy initialize fallback. Tools are the six github-mcp-server tools the suite
// requires, backed by the same store as REST/GraphQL/git.
// Written from scratch for this entry.

import {
  VIEWER_LOGIN,
  FIXED_ISO,
  squashMerge,
  type Store,
  type Repo,
} from './store.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_NAME = 'makefun-git-forge';
export const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolJson(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  };
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface ToolResult {
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  errorText?: string;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function intArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult | RpcError {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { code: -32601, message: `Method not found: ${name}` };
  const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return { code: -32602, message: `Invalid params: missing required argument(s): ${missing.join(', ')}` };
  }

  if (name === 'create_repo') {
    const repoName = stringArg(args, 'name');
    if (store.getRepo(VIEWER_LOGIN, repoName)) {
      return { structuredContent: {}, isError: true, errorText: 'Repository already exists' };
    }
    const repo = store.createRepo(
      VIEWER_LOGIN,
      repoName,
      typeof args['private'] === 'boolean' ? (args['private'] as boolean) : false,
      stringArg(args, 'description'),
    );
    const content = repoJson(repo);
    return { structuredContent: content };
  }

  const owner = stringArg(args, 'owner');
  const repoName = stringArg(args, 'repo');
  const repo: Repo | undefined = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  if (name !== 'create_repo' && !repo) {
    return { structuredContent: {}, isError: true, errorText: 'Repository not found' };
  }

  if (name === 'get_repo') {
    const content = repoJson(repo as Repo);
    return { structuredContent: content };
  }
  if (name === 'create_issue') {
    const title = stringArg(args, 'title');
    const body = stringArg(args, 'body');
    const issue = {
      id: store.nextIssueId++,
      number: (repo as Repo).nextIssue++,
      title,
      body,
      state: 'open' as const,
      labels: [] as string[],
      comments: [] as { id: number; body: string }[],
      seq: store.nextSeq++,
    };
    (repo as Repo).issues.push(issue);
    (repo as Repo).issueByNumber.set(issue.number, issue);
    const content = issueJson(issue);
    return { structuredContent: content };
  }
  if (name === 'list_issues') {
    const state = stringArg(args, 'state') || 'open';
    let items = [...(repo as Repo).issues];
    if (state === 'open') items = items.filter((i) => i.state === 'open');
    else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
    items.sort((a, b) => a.seq - b.seq);
    const content = { issues: items.map(issueJson) };
    return { structuredContent: content };
  }
  if (name === 'create_pull_request') {
    const title = stringArg(args, 'title');
    const head = stringArg(args, 'head');
    const base = stringArg(args, 'base');
    const body = stringArg(args, 'body');
    const headSha = (repo as Repo).refs.get(`refs/heads/${head}`);
    const baseSha = (repo as Repo).refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) {
      return { structuredContent: {}, isError: true, errorText: 'Head or base branch does not exist' };
    }
    const existing = (repo as Repo).pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
    if (existing) {
      return { structuredContent: {}, isError: true, errorText: 'A pull request already exists for this branch' };
    }
    const pull = {
      id: store.nextPullId++,
      number: (repo as Repo).nextPull++,
      title,
      body,
      state: 'open' as const,
      headRef: head,
      headSha,
      baseRef: base,
      baseSha,
      merged: false,
      mergedAt: null as string | null,
      mergeCommitSha: null as string | null,
      seq: store.nextSeq++,
    };
    (repo as Repo).pulls.push(pull);
    (repo as Repo).pullByNumber.set(pull.number, pull);
    const content = pullJson(pull, repo as Repo);
    return { structuredContent: content };
  }
  if (name === 'merge_pull_request') {
    const number = intArg(args, 'pull_number');
    if (number === null) return { code: -32602, message: 'Invalid params: pull_number must be an integer' };
    const pull = (repo as Repo).pullByNumber.get(number);
    if (!pull) {
      return { structuredContent: {}, isError: true, errorText: 'Pull request not found' };
    }
    if (pull.merged || pull.state !== 'open') {
      return { structuredContent: {}, isError: true, errorText: 'Pull request is already closed' };
    }
    const result = squashMerge(store, repo as Repo, pull);
    if (!result.ok) {
      return { structuredContent: {}, isError: true, errorText: result.conflict ? 'Merge conflict' : 'Cannot merge this pull request' };
    }
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = result.mergeCommit;
    pull.baseSha = result.mergeCommit;
    const content = { merged: true, number: pull.number, state: pull.state, sha: result.mergeCommit };
    return { structuredContent: content };
  }
  return { code: -32601, message: `Method not found: ${name}` };
}

export interface McpRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpReply {
  status: number;
  body: unknown;
}

/**
 * Handle one POST /mcp request. `authenticated` is whether the request carried the
 * suite's bearer token; unauthenticated calls answer HTTP 401.
 * Returns null when the body is not a JSON-RPC request the server can answer
 * (the caller then answers 400 with a -32700 parse error).
 */
export function handleMcp(store: Store, bodyText: string, authenticated: boolean): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (!authenticated) {
    const id = parsed !== null && typeof parsed === 'object' ? (parsed as McpRequest).id ?? null : null;
    return {
      status: 401,
      body: { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } },
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const request = parsed as McpRequest;
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id === undefined ? null : request.id;
  const isNotification = request.id === undefined;

  const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};

  const errorReply = (error: RpcError): McpReply => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } },
  });

  // Notifications (no id): acknowledge with 202 and no body.
  if (isNotification) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: MCP_SUPPORTED_REVISIONS,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'A GitHub-compatible git forge: create repos, issues and pull requests.',
        },
      },
    };
  }

  if (method === 'initialize') {
    const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
    const negotiated = MCP_SUPPORTED_REVISIONS.includes(offered) ? offered : MCP_REVISION;
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      },
    };
  }

  if (method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }

  if (method === 'tools/list') {
    return {
      status: 200,
      body: { jsonrpc: '2.0', id, result: { tools: TOOLS.map(toolJson) } },
    };
  }

  if (method === 'tools/call') {
    const toolName = typeof params['name'] === 'string' ? (params['name'] as string) : '';
    const args = params['arguments'] !== null && typeof params['arguments'] === 'object' && !Array.isArray(params['arguments'])
      ? (params['arguments'] as Record<string, unknown>)
      : {};
    const outcome = callTool(store, toolName, args);
    if ('code' in outcome) return errorReply(outcome);
    const text = JSON.stringify(outcome.structuredContent);
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
          structuredContent: outcome.structuredContent,
          isError: outcome.isError === true,
        },
      },
    };
  }

  return errorReply({ code: -32601, message: `Method not found: ${method}` });
}
