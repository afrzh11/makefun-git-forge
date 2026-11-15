// GraphQL v4 (/api/graphql): a small parser + executor for the documents gh and
// github-mcp-server send. No schema library — the documents are fixed, so the
// executor resolves a known field table per type, with __type introspection for
// the fields gh feature-detects. Unknown fields answer 200 with an errors array
// (never an HTTP error), exactly as the suite expects.
// Written from scratch for this entry.

import {
  VIEWER_LOGIN,
  VIEWER_NAME,
  VIEWER_EMAIL,
  FIXED_ISO,
  parseGlobalId,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
  pullMergeable,
  diffTrees,
  commitTreeOid,
  squashMerge,
  type Repo,
  type Issue,
  type Pull,
  type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------------
// Lexer
// -------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{ }|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: parseFloat(text) } : { kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL lexer: unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

// -------------------------------------------------------------------------------------------------
// Parser
// -------------------------------------------------------------------------------------------------

export interface ArgumentValue {
  kind: 'variable' | 'string' | 'int' | 'float' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  value?: unknown;
  items?: ArgumentValue[];
  fields?: { name: string; value: ArgumentValue }[];
}

export interface Selection {
  kind: 'field' | 'fragmentSpread' | 'inlineFragment';
  name?: string;
  alias?: string;
  args?: { name: string; value: ArgumentValue }[];
  typeCondition?: string;
  selections?: Selection[];
}

export interface Operation {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; defaultValue?: ArgumentValue }[];
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('GraphQL parser: unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`GraphQL parser: expected '${value}'`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('GraphQL parser: expected a name');
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token?.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('GraphQL parser: expected "on" in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value;
    }
    const variables: Operation['variables'] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const dollar = this.next();
        if (dollar.kind !== 'punct' || dollar.value !== '$') throw new Error('GraphQL parser: expected $ in variable definition');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ArgumentValue | undefined;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        this.skipDirectives();
        variables.push({ name: varName, defaultValue });
      }
      this.next();
    }
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { operation, name, variables, selections };
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      throw new Error('GraphQL parser: bad fragment spread');
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Selection['args'];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      args = this.parseArguments();
    }
    this.skipDirectives();
    let selections: Selection[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): { name: string; value: ArgumentValue }[] {
    this.expectPunct('(');
    const args: { name: string; value: ArgumentValue }[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.next();
    return args;
  }

  private parseValue(): ArgumentValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', value: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ArgumentValue[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        items.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ArgumentValue }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error(`GraphQL parser: unexpected value token ${JSON.stringify(token)}`);
  }
}

function resolveValue(value: ArgumentValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': {
      const name = value.value as string;
      return variables[name];
    }
    case 'list':
      return (value.items ?? []).map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields ?? []) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
    default:
      return value.value;
  }
}

// -------------------------------------------------------------------------------------------------
// Schema field tables (for introspection and unknown-field errors)
// -------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private',
    'createdAt', 'updatedAt', 'url', 'isPrivate',
  ],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'comments',
    'labels', 'url', 'closedAt', 'repository',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRef', 'baseRef',
    'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'author', 'repository',
  ],
  Ref: ['id', 'name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
};

const SEARCH_TYPE_VALUES = [
  'CODE', 'COMMIT', 'DISCUSSION', 'ISSUE', 'MILESTONE', 'PROJECT', 'PULL_REQUEST',
  'REGISTRY_PACKAGE', 'REPOSITORY', 'TOPIC', 'USER', 'WIKI',
];

// -------------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------------

interface TypedValue {
  __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
  errors: { message: string; path?: (string | number)[] }[];
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function argValue(args: Selection['args'], name: string, variables: Record<string, unknown>): unknown {
  const arg = (args ?? []).find((a) => a.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, variables);
}

function unknownField(ctx: ExecContext, typeName: string, fieldName: string, path: (string | number)[]): void {
  ctx.errors.push({
    message: `Cannot query field "${fieldName}" on type "${typeName}".`,
    path,
  });
}

function repoObject(repo: Repo): TypedValue {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): TypedValue {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Pull): TypedValue {
  return { __typename: 'PullRequest', repo, pull };
}

function userObject(): TypedValue {
  return { __typename: 'User', login: VIEWER_LOGIN, name: VIEWER_NAME, email: VIEWER_EMAIL, id: 1000 };
}

function resolveField(ctx: ExecContext, value: TypedValue, field: Selection, path: (string | number)[]): unknown {
  const typeName = value.__typename;
  const fieldName = field.name as string;
  const fields = TYPE_FIELDS[typeName];
  if (!fields || !fields.includes(fieldName)) {
    unknownField(ctx, typeName, fieldName, path);
    return null;
  }
  switch (typeName) {
    case 'Query':
      return resolveQueryField(ctx, field, path);
    case 'Mutation':
      return resolveMutationField(ctx, field, path);
    case 'User':
      return value[fieldName] ?? null;
    case 'Repository':
      return resolveRepositoryField(ctx, value as TypedValue & { repo: Repo }, field, path);
    case 'Issue': {
      const typed = value as TypedValue & { repo: Repo; issue: Issue };
      switch (fieldName) {
        case 'id':
          return issueGlobalId(typed.repo, typed.issue);
        case 'number':
          return typed.issue.number;
        case 'title':
          return typed.issue.title;
        case 'body':
          return typed.issue.body;
        case 'state':
          return typed.issue.state.toUpperCase();
        case 'createdAt':
        case 'updatedAt':
          return FIXED_ISO;
        case 'author':
          return userObject();
        case 'url':
          return `https://github.com/${typed.repo.owner}/${typed.repo.name}/issues/${typed.issue.number}`;
        case 'repository':
          return repoObject(typed.repo);
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const typed = value as TypedValue & { repo: Repo; pull: Pull };
      switch (fieldName) {
        case 'id':
          return pullGlobalId(typed.repo, typed.pull);
        case 'number':
          return typed.pull.number;
        case 'title':
          return typed.pull.title;
        case 'body':
          return typed.pull.body;
        case 'state':
          return typed.pull.merged ? 'MERGED' : typed.pull.state.toUpperCase();
        case 'headRefName':
          return typed.pull.headRef;
        case 'baseRefName':
          return typed.pull.baseRef;
        case 'mergeable':
          return pullMergeable(typed.repo, typed.pull);
        case 'merged':
          return typed.pull.merged;
        case 'files': {
          const first = argValue(field.args, 'first', ctx.variables);
          const headTree = commitTreeOid(typed.repo, typed.pull.headSha);
          const baseTree = commitTreeOid(typed.repo, typed.pull.baseSha);
          const diffs = headTree !== null && baseTree !== null ? diffTrees(typed.repo, baseTree, headTree) : [];
          const nodes = diffs.map((d) => ({
            __typename: 'PullRequestChangedFile',
            path: d.path,
            additions: 0,
            deletions: 0,
            changes: 0,
          }));
          const limited = typeof first === 'number' ? nodes.slice(0, first) : nodes;
          return { __typename: 'PullRequestChangedFileConnection', nodes: limited, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
        }
        case 'createdAt':
        case 'updatedAt':
          return FIXED_ISO;
        case 'author':
          return userObject();
        case 'repository':
          return repoObject(typed.repo);
        default:
          return null;
      }
    }
    case 'Ref':
      return value[fieldName] ?? null;
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
      return value[fieldName] ?? null;
    case 'PageInfo':
      return value[fieldName] ?? null;
    case 'IssueComment':
      return value[fieldName] ?? null;
    case 'IssueCommentEdge':
      return value[fieldName] ?? null;
    case '__Type':
      return value[fieldName] ?? null;
    default:
      return value[fieldName] ?? null;
  }
}

function resolveQueryField(ctx: ExecContext, field: Selection, path: (string | number)[]): unknown {
  const fieldName = field.name as string;
  if (fieldName === 'viewer') return userObject();
  if (fieldName === 'repository') {
    const owner = argValue(field.args, 'owner', ctx.variables);
    const name = argValue(field.args, 'name', ctx.variables);
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    if (owner !== VIEWER_LOGIN) return null;
    const repo = ctx.store.getRepo(owner, name);
    return repo ? repoObject(repo) : null;
  }
  if (fieldName === 'node') {
    const id = argValue(field.args, 'id', ctx.variables);
    if (typeof id !== 'string') return null;
    const parsed = parseGlobalId(id);
    if (!parsed) return null;
    if (parsed.type === 'Repository') {
      const [owner, name] = parsed.key.split('/');
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoObject(repo) : null;
    }
    if (parsed.type === 'Issue') {
      const ref = parseOwnerRepoNumber(parsed.key);
      if (!ref) return null;
      const repo = ctx.store.getRepo(ref.owner, ref.name);
      const issue = repo?.issueByNumber.get(ref.number);
      return repo && issue ? issueObject(repo, issue) : null;
    }
    if (parsed.type === 'PullRequest') {
      const ref = parseOwnerRepoNumber(parsed.key);
      if (!ref) return null;
      const repo = ctx.store.getRepo(ref.owner, ref.name);
      const pull = repo?.pullByNumber.get(ref.number);
      return repo && pull ? pullObject(repo, pull) : null;
    }
    return null;
  }
  if (fieldName === '__type') {
    const name = argValue(field.args, 'name', ctx.variables);
    if (typeof name !== 'string') return null;
    if (name === 'SearchType') {
      return {
        __typename: '__Type',
        name,
        kind: 'ENUM',
        fields: null,
        enumValues: SEARCH_TYPE_VALUES.map((v) => ({ __typename: '__EnumValue', name: v, description: null })),
      };
    }
    const fields = TYPE_FIELDS[name];
    if (!fields) return null;
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      fields: fields.map((f) => ({ __typename: '__Field', name: f, description: null })),
      enumValues: null,
    };
  }
  return null;
}

function resolveRepositoryField(
  ctx: ExecContext,
  value: TypedValue & { repo: Repo },
  field: Selection,
  path: (string | number)[],
): unknown {
  const repo = value.repo;
  const fieldName = field.name as string;
  switch (fieldName) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return userObject();
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ? { __typename: 'Ref', name: repo.defaultBranch, id: repoGlobalId(repo), target: tip } : null;
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'private':
    case 'isPrivate':
      return repo.private;
    case 'createdAt':
    case 'updatedAt':
      return FIXED_ISO;
    case 'url':
      return `https://github.com/${repo.owner}/${repo.name}`;
    case 'issue': {
      const number = argValue(field.args, 'number', ctx.variables);
      if (typeof number !== 'number') return null;
      const issue = repo.issueByNumber.get(number);
      return issue ? issueObject(repo, issue) : null;
    }
    case 'issues': {
      const first = argValue(field.args, 'first', ctx.variables);
      const after = argValue(field.args, 'after', ctx.variables);
      const states = argValue(field.args, 'states', ctx.variables);
      const orderBy = argValue(field.args, 'orderBy', ctx.variables) as
        | { field?: string; direction?: string }
        | undefined;
      let items = [...repo.issues];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toUpperCase()));
        items = items.filter((i) => wanted.has(i.state.toUpperCase()));
      }
      if (orderBy && String(orderBy.direction).toUpperCase() === 'DESC') {
        items.sort((a, b) => b.seq - a.seq);
      } else {
        items.sort((a, b) => a.seq - b.seq);
      }
      const afterNumber = numberFromCursor(after);
      if (afterNumber !== null) items = items.filter((i) => i.number > afterNumber);
      const limit = typeof first === 'number' ? first : items.length;
      const page = items.slice(0, limit);
      const hasNextPage = items.length > limit;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((i) => issueObject(repo, i)),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage,
          hasPreviousPage: afterNumber !== null,
          startCursor: page.length > 0 ? cursorFor(page[0].number) : null,
          endCursor,
        },
        totalCount: items.length,
      };
    }
    case 'pullRequest': {
      const number = argValue(field.args, 'number', ctx.variables);
      if (typeof number !== 'number') return null;
      const pull = repo.pullByNumber.get(number);
      return pull ? pullObject(repo, pull) : null;
    }
    case 'pullRequests': {
      const first = argValue(field.args, 'first', ctx.variables);
      const items = [...repo.pulls].filter((p) => p.state === 'open').sort((a, b) => b.seq - a.seq);
      const limit = typeof first === 'number' ? first : items.length;
      const page = items.slice(0, limit);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((p) => pullObject(repo, p)),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: items.length > limit,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
        totalCount: items.length,
      };
    }
    default:
      return null;
  }
}

/** Parse an Issue/PullRequest global-id key of the form `owner/repo:number`. */
function parseOwnerRepoNumber(key: string): { owner: string; name: string; number: number } | null {
  const colon = key.lastIndexOf(':');
  if (colon < 1) return null;
  const ownerRepo = key.slice(0, colon);
  const number = parseInt(key.slice(colon + 1), 10);
  if (Number.isNaN(number)) return null;
  const slash = ownerRepo.indexOf('/');
  if (slash < 1) return null;
  return { owner: ownerRepo.slice(0, slash), name: ownerRepo.slice(slash + 1), number };
}

function resolveMutationField(ctx: ExecContext, field: Selection, path: (string | number)[]): unknown {
  const fieldName = field.name as string;
  const input = argValue(field.args, 'input', ctx.variables) as Record<string, unknown> | undefined;
  if (fieldName === 'createIssue') {
    const repositoryId = typeof input?.['repositoryId'] === 'string' ? (input['repositoryId'] as string) : '';
    const title = typeof input?.['title'] === 'string' ? (input['title'] as string) : '';
    const body = typeof input?.['body'] === 'string' ? (input['body'] as string) : '';
    const parsed = parseGlobalId(repositoryId);
    if (!parsed || parsed.type !== 'Repository') {
      ctx.errors.push({ message: 'createIssue: repositoryId does not name a repository', path });
      return null;
    }
    const [owner, name] = parsed.key.split('/');
    const repo = ctx.store.getRepo(owner, name);
    if (!repo) {
      ctx.errors.push({ message: 'createIssue: repository not found', path });
      return null;
    }
    const issue: Issue = {
      id: ctx.store.nextIssueId++,
      number: repo.nextIssue++,
      title,
      body,
      state: 'open',
      labels: [],
      comments: [],
      seq: ctx.store.nextSeq++,
    };
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
  }
  if (fieldName === 'closeIssue') {
    const issueId = typeof input?.['issueId'] === 'string' ? (input['issueId'] as string) : '';
    const parsed = parseGlobalId(issueId);
    if (!parsed || parsed.type !== 'Issue') {
      ctx.errors.push({ message: 'closeIssue: issueId does not name an issue', path });
      return null;
    }
    const ref = parseOwnerRepoNumber(parsed.key);
    if (!ref) {
      ctx.errors.push({ message: 'closeIssue: issueId does not name an issue', path });
      return null;
    }
    const repo = ctx.store.getRepo(ref.owner, ref.name);
    const issue = repo?.issueByNumber.get(ref.number);
    if (!repo || !issue) {
      ctx.errors.push({ message: 'closeIssue: issue not found', path });
      return null;
    }
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
  }
  if (fieldName === 'createPullRequest') {
    const repositoryId = typeof input?.['repositoryId'] === 'string' ? (input['repositoryId'] as string) : '';
    const baseRefName = typeof input?.['baseRefName'] === 'string' ? (input['baseRefName'] as string) : '';
    const headRefName = typeof input?.['headRefName'] === 'string' ? (input['headRefName'] as string) : '';
    const title = typeof input?.['title'] === 'string' ? (input['title'] as string) : '';
    const body = typeof input?.['body'] === 'string' ? (input['body'] as string) : '';
    const parsed = parseGlobalId(repositoryId);
    if (!parsed || parsed.type !== 'Repository') {
      ctx.errors.push({ message: 'createPullRequest: repositoryId does not name a repository', path });
      return null;
    }
    const [owner, name] = parsed.key.split('/');
    const repo = ctx.store.getRepo(owner, name);
    if (!repo) {
      ctx.errors.push({ message: 'createPullRequest: repository not found', path });
      return null;
    }
    const headSha = repo.refs.get(`refs/heads/${headRefName}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRefName}`);
    if (!headSha || !baseSha) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist', path });
      return null;
    }
    const existing = repo.pulls.find((p) => p.headRef === headRefName && p.baseRef === baseRefName && p.state === 'open');
    if (existing) {
      ctx.errors.push({ message: 'createPullRequest: a pull request already exists for this branch', path });
      return null;
    }
    const pull: Pull = {
      id: ctx.store.nextPullId++,
      number: repo.nextPull++,
      title,
      body,
      state: 'open',
      headRef: headRefName,
      headSha,
      baseRef: baseRefName,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: ctx.store.nextSeq++,
    };
    repo.pulls.push(pull);
    repo.pullByNumber.set(pull.number, pull);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
  }
  if (fieldName === 'mergePullRequest') {
    const pullRequestId = typeof input?.['pullRequestId'] === 'string' ? (input['pullRequestId'] as string) : '';
    const parsed = parseGlobalId(pullRequestId);
    if (!parsed || parsed.type !== 'PullRequest') {
      ctx.errors.push({ message: 'mergePullRequest: pullRequestId does not name a pull request', path });
      return null;
    }
    const ref = parseOwnerRepoNumber(parsed.key);
    if (!ref) {
      ctx.errors.push({ message: 'mergePullRequest: pullRequestId does not name a pull request', path });
      return null;
    }
    const repo = ctx.store.getRepo(ref.owner, ref.name);
    const pull = repo?.pullByNumber.get(ref.number);
    if (!repo || !pull) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found', path });
      return null;
    }
    if (pull.merged || pull.state !== 'open') {
      ctx.errors.push({ message: 'mergePullRequest: pull request is already closed', path });
      return null;
    }
    const result = squashMerge(ctx.store, repo, pull);
    if (!result.ok) {
      ctx.errors.push({ message: 'mergePullRequest: merge conflict', path });
      return null;
    }
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = result.mergeCommit;
    pull.baseSha = result.mergeCommit;
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
  }
  if (fieldName === 'addComment') {
    const subjectId = typeof input?.['subjectId'] === 'string' ? (input['subjectId'] as string) : '';
    const body = typeof input?.['body'] === 'string' ? (input['body'] as string) : '';
    const parsed = parseGlobalId(subjectId);
    if (!parsed || parsed.type !== 'Issue') {
      ctx.errors.push({ message: 'addComment: subjectId does not name an issue', path });
      return null;
    }
    const ref = parseOwnerRepoNumber(parsed.key);
    if (!ref) {
      ctx.errors.push({ message: 'addComment: subjectId does not name an issue', path });
      return null;
    }
    const repo = ctx.store.getRepo(ref.owner, ref.name);
    const issue = repo?.issueByNumber.get(ref.number);
    if (!repo || !issue) {
      ctx.errors.push({ message: 'addComment: issue not found', path });
      return null;
    }
    const commentId = ctx.store.nextCommentId++;
    issue.comments.push({ id: commentId, body });
    const comment: TypedValue = {
      __typename: 'IssueComment',
      id: commentGlobalId(repo, issue, commentId),
      body,
      author: userObject(),
      createdAt: FIXED_ISO,
    };
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'IssueCommentEdge', node: comment, cursor: cursorFor(commentId) },
    };
  }
  return null;
}

function executeSelections(
  ctx: ExecContext,
  value: TypedValue,
  selections: Selection[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name as string);
      if (fragment && (!fragment.typeCondition || fragment.typeCondition === value.__typename)) {
        Object.assign(out, executeSelections(ctx, value, fragment.selections, path));
      }
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (!selection.typeCondition || selection.typeCondition === value.__typename) {
        Object.assign(out, executeSelections(ctx, value, selection.selections ?? [], path));
      }
      continue;
    }
    const responseKey = selection.alias ?? (selection.name as string);
    const fieldPath = [...path, responseKey];
    const resolved = resolveField(ctx, value, selection, fieldPath);
    if (resolved === null || resolved === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (selection.selections && selection.selections.length > 0) {
      if (Array.isArray(resolved)) {
        out[responseKey] = resolved.map((item, index) =>
          item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)
            ? executeSelections(ctx, item as TypedValue, selection.selections as Selection[], [...fieldPath, index])
            : item,
        );
      } else if (typeof resolved === 'object' && '__typename' in (resolved as Record<string, unknown>)) {
        out[responseKey] = executeSelections(ctx, resolved as TypedValue, selection.selections, fieldPath);
      } else {
        out[responseKey] = resolved;
      }
    } else {
      out[responseKey] = resolved;
    }
  }
  return out;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: { message: string; path?: (string | number)[] }[];
}

export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): GraphQLResult {
  const errors: { message: string; path?: (string | number)[] }[] = [];
  let document: Document;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL syntax error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  let operation: Operation | undefined;
  if (operationName) operation = document.operations.find((op) => op.name === operationName);
  if (!operation) operation = document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'GraphQL: no operation in document' }] };
  const ctx: ExecContext = { store, variables, fragments: document.fragments, errors };
  const root: TypedValue = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelections(ctx, root, operation.selections, []);
  return { data, errors };
}
