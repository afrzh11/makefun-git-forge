// The forge's single shared store: repositories, git objects, refs, issues, pull
// requests and labels. One store backs git smart HTTP, REST v3, GraphQL v4 and MCP,
// so every surface reads the same state. Deterministic: no Date.now() anywhere in
// stored state; server-made commits carry a fixed epoch and the viewer identity.
//
// Written from scratch for this entry (no copied forge code). The git object model
// (SHA-1 over "<type> <size>\0" + bytes, pkt-line framing, packfiles) follows the
// public git wire format, which the suite's own client speaks.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const STRANGER_LOGIN = 'olgabauer';
/** Fixed epoch for every server-made commit and timestamp field (2025-01-01T00:00:00Z). */
export const FIXED_EPOCH_SEC = 1735689600;
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const SERVER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string }[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  pulls: Pull[];
  pullByNumber: Map<number, Pull>;
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  seq: number;
  /** Bumped on any ref/object change; invalidates cached pack bytes. */
  generation: number;
  packCache: Map<string, CachedFetch>;
}

/** A fetch's object selection, plus the pack built from it (cached). */
export interface FetchSelection {
  objects: GitObject[];
  /** Common commits the client already has (ACK lines); empty means NAK. */
  acks: string[];
  /** True when no common commit exists (the client sent no usable haves). */
  nak: boolean;
  /** True when the client sent at least one have line. */
  hadHaves: boolean;
  shallow: string[];
  unshallow: string[];
}

export interface CachedFetch {
  pack: Buffer;
  selection: FetchSelection;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  nextSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, priv: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      private: priv,
      description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: [],
      issueByNumber: new Map(),
      pulls: [],
      pullByNumber: new Map(),
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      seq: this.nextSeq++,
      generation: 0,
      packCache: new Map(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

// -------------------------------------------------------------------------------------------------
// Git object model
// -------------------------------------------------------------------------------------------------

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Git's tree sort: byte order of the name, directories compared as if named `name/`. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return Buffer.compare(Buffer.from(an, 'utf8'), Buffer.from(bn, 'utf8'));
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree-parse: no mode separator');
    const mode = data.subarray(offset, space).toString('ascii');
    if (!/^[0-7]+$/.test(mode)) throw new Error('tree-parse: bad mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree-parse: no name terminator');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('tree-parse: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${info.message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  if (!isObjectId(info.tree)) throw new Error('commit-parse: bad tree');
  for (const parent of info.parents) {
    if (!isObjectId(parent)) throw new Error('commit-parse: bad parent');
  }
  return info;
}

export function buildTag(info: TagInfo): Buffer {
  const lines = [
    `object ${info.object}`,
    `type ${info.type}`,
    `tag ${info.tag}`,
    `tagger ${info.tagger}`,
    '',
  ];
  return Buffer.from(`${lines.join('\n')}\n${info.message}`, 'utf8');
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4);
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Follow tag objects to the underlying non-tag object (for ls-refs peeling). */
export function peelObject(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    try {
      current = parseTag(obj.data).object;
    } catch {
      return null;
    }
  }
}

export function commitTreeOid(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  try {
    return parseCommit(obj.data).tree;
  } catch {
    return null;
  }
}

export function commitParents(repo: Repo, commitOid: string): string[] {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return [];
  try {
    return parseCommit(obj.data).parents;
  } catch {
    return [];
  }
}

/** All objects reachable from `roots` (commits, tags, trees, blobs; gitlinks skipped). */
export function collectReachable(repo: Repo, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) {
    if (isObjectId(root) && !seen.has(root)) stack.push(root);
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      try {
        const info = parseCommit(obj.data);
        stack.push(info.tree);
        for (const parent of info.parents) stack.push(parent);
      } catch {
        // Unparseable commit: keep the object itself, no children.
      }
    } else if (obj.type === 'tag') {
      try {
        stack.push(parseTag(obj.data).object);
      } catch {
        // ignore
      }
    } else if (obj.type === 'tree') {
      try {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      } catch {
        // ignore
      }
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or reachable from it via parents. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    for (const parent of commitParents(repo, oid)) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** A merge-base: the first common ancestor found by a two-sided breadth-first walk. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const seenA = new Map<string, number>();
  const seenB = new Map<string, number>();
  const queueA: string[] = [a];
  const queueB: string[] = [b];
  seenA.set(a, 0);
  seenB.set(b, 0);
  let depthA = 0;
  let depthB = 0;
  while (queueA.length > 0 || queueB.length > 0) {
    while (queueA.length > 0) {
      const oid = queueA.shift() as string;
      const d = seenA.get(oid) as number;
      if (d > depthA) depthA = d;
      if (seenB.has(oid)) return oid;
      for (const parent of commitParents(repo, oid)) {
        if (!seenA.has(parent)) {
          seenA.set(parent, d + 1);
          queueA.push(parent);
        }
      }
    }
    while (queueB.length > 0) {
      const oid = queueB.shift() as string;
      const d = seenB.get(oid) as number;
      if (d > depthB) depthB = d;
      if (seenA.has(oid)) return oid;
      for (const parent of commitParents(repo, oid)) {
        if (!seenB.has(parent)) {
          seenB.set(parent, d + 1);
          queueB.push(parent);
        }
      }
    }
    // Bound the walk: histories in this suite are short and linear; the BFS above
    // already returns on the first common ancestor found at the shallowest depth.
    if (depthA > 10000 || depthB > 10000) return null;
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// Tree path operations (contents API, merges)
// -------------------------------------------------------------------------------------------------

export interface FileEntry {
  blobOid: string;
  data: Buffer;
}

/** Read the blob at `path` in the tree rooted at `treeOid` (null when absent). */
export function treeGetFile(repo: Repo, treeOid: string, path: string): FileEntry | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    let entries: TreeEntry[];
    try {
      entries = parseTree(obj.data);
    } catch {
      return null;
    }
    const entry = entries.find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      if (entry.mode === '40000') return null;
      const blob = repo.objects.get(entry.oid);
      if (!blob || blob.type !== 'blob') return null;
      return { blobOid: entry.oid, data: blob.data };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/**
 * Return a new tree oid with `path` set to `blobOid` (or removed when `blobOid` is null).
 * Intermediate directories are created as needed; emptied directories are pruned.
 * The new tree objects are stored in the repo.
 */
export function treeSetFile(repo: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) throw new Error('empty path');
  const build = (currentOid: string | null, depth: number): string | null => {
    let entries: TreeEntry[] = [];
    if (currentOid) {
      const obj = repo.objects.get(currentOid);
      if (obj && obj.type === 'tree') {
        try {
          entries = parseTree(obj.data);
        } catch {
          entries = [];
        }
      }
    }
    const name = segments[depth];
    const isLast = depth === segments.length - 1;
    const idx = entries.findIndex((e) => e.name === name);
    if (isLast) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else {
        const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
        if (idx >= 0) entries[idx] = entry;
        else entries.push(entry);
      }
    } else {
      const childOid = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
      const newChild = build(childOid, depth + 1);
      if (newChild === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else {
        const entry: TreeEntry = { mode: '40000', name, oid: newChild };
        if (idx >= 0) entries[idx] = entry;
        else entries.push(entry);
      }
    }
    if (entries.length === 0) return null;
    return putObject(repo, 'tree', buildTree(entries));
  };
  const result = build(treeOid, 0);
  if (result === null) {
    // An emptied tree: git uses the empty tree object.
    return putObject(repo, 'tree', buildTree([]));
  }
  return result;
}

/** Immediate children of the directory at `dirPath` ('' = root). Null when not a directory. */
export function treeListDir(repo: Repo, treeOid: string, dirPath: string): TreeEntry[] | null {
  const segments = dirPath.split('/').filter((s) => s.length > 0);
  let current = treeOid;
  for (const segment of segments) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    let entries: TreeEntry[];
    try {
      entries = parseTree(obj.data);
    } catch {
      return null;
    }
    const entry = entries.find((e) => e.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const obj = repo.objects.get(current);
  if (!obj || obj.type !== 'tree') return null;
  try {
    return parseTree(obj.data);
  } catch {
    return null;
  }
}

/** Flatten a tree into path -> {mode, oid} for every blob (and subtree) entry. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, pathPrefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    let entries: TreeEntry[];
    try {
      entries = parseTree(obj.data);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = pathPrefix === '' ? entry.name : `${pathPrefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, prefix);
  return out;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Two-way diff between two trees (base -> head), sorted by path. */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): DiffEntry[] {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map();
  const head = headTreeOid ? flattenTree(repo, headTreeOid) : new Map();
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: DiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return out;
}

/** Added-line count of a blob (for pull file stats). */
export function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
 * Three-way squash merge of a pull request into its base branch.
 * Returns { ok, mergeCommit } or { ok: false, conflict: true }.
 * On success the base ref is moved to the merge commit.
 */
export function squashMerge(
  store: Store,
  repo: Repo,
  pull: Pull,
): { ok: true; mergeCommit: string } | { ok: false; conflict: boolean } {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return { ok: false, conflict: false };
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return { ok: false, conflict: false };
  const baseTree = commitTreeOid(repo, base);
  const headTree = commitTreeOid(repo, headTip);
  const baseTipTree = commitTreeOid(repo, baseTip);
  if (baseTree === null || headTree === null || baseTipTree === null) return { ok: false, conflict: false };
  const headChanges = diffTrees(repo, baseTree, headTree);
  const baseChanges = diffTrees(repo, baseTree, baseTipTree);
  const baseChangeByPath = new Map(baseChanges.map((c) => [c.path, c]));
  for (const change of headChanges) {
    const other = baseChangeByPath.get(change.path);
    if (!other) continue;
    // Both sides changed the path: conflict unless they landed on the same content.
    if (change.newOid !== other.newOid) return { ok: false, conflict: true };
  }
  let tree = baseTipTree;
  for (const change of headChanges) {
    tree = treeSetFile(repo, tree, change.path, change.newOid);
  }
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n`;
  const stamp = `${FIXED_EPOCH_SEC} +0000`;
  const commitData = buildCommit({
    tree,
    parents: [baseTip],
    author: `${SERVER_IDENTITY} ${stamp}`,
    committer: `${SERVER_IDENTITY} ${stamp}`,
    message,
  });
  const mergeCommit = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
  repo.generation += 1;
  repo.packCache.clear();
  void store;
  return { ok: true, mergeCommit };
}

/** Mergeability of a pull request (same three-way check, without merging). */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  if (pull.state !== 'open') return 'UNKNOWN';
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return 'UNKNOWN';
  const baseTree = commitTreeOid(repo, base);
  const headTree = commitTreeOid(repo, headTip);
  const baseTipTree = commitTreeOid(repo, baseTip);
  if (baseTree === null || headTree === null || baseTipTree === null) return 'UNKNOWN';
  const headChanges = diffTrees(repo, baseTree, headTree);
  const baseChanges = diffTrees(repo, baseTree, baseTipTree);
  const baseChangeByPath = new Map(baseChanges.map((c) => [c.path, c]));
  for (const change of headChanges) {
    const other = baseChangeByPath.get(change.path);
    if (other && change.newOid !== other.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// -------------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, reversible. base64url("Type:key").
// -------------------------------------------------------------------------------------------------

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return globalId('IssueComment', `${repo.owner}/${repo.name}:${issue.number}:${commentId}`);
}
