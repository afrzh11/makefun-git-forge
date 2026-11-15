// Git smart HTTP: pkt-line codec, packfile read/write, upload-pack v2 and
// receive-pack v0. Written from scratch for this entry; the wire format follows
// the public git protocol (pkt-line framing, sideband, v2 sections, report-status).
// The suite's own client (git-client.ts in the kit) is the contract this implements.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  isObjectId,
  hashObject,
  putObject,
  getObject,
  parseCommit,
  parseTree,
  parseTag,
  peelObject,
  collectReachable,
  isAncestor,
  type GitObject,
  type ObjectType,
  type Repo,
  type FetchSelection,
  type CachedFetch,
} from './store.ts';

export const PKT_LINE_MAX = 65520;
const AGENT = 'makefun-git-forge/1.0';

// -------------------------------------------------------------------------------------------------
// pkt-line codec
// -------------------------------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error('pktline-too-long');
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode every pkt-line in a buffer. Throws on malformed framing. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pktline-truncated');
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('pktline-header');
    const length = parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('pktline-header');
    if (length > PKT_LINE_MAX) throw new Error('pktline-too-long');
    if (offset + length > buf.length) throw new Error('pktline-truncated');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

/** One sideband packet: band byte + data, framed as a pkt-line. */
export function sidebandPacket(band: number, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split a payload into sideband packets of at most `chunk` data bytes each. */
export function sidebandPackets(band: number, data: Buffer, chunk = 32768): Buffer[] {
  const out: Buffer[] = [];
  if (data.length === 0) {
    out.push(sidebandPacket(band, Buffer.alloc(0)));
    return out;
  }
  for (let offset = 0; offset < data.length; offset += chunk) {
    out.push(sidebandPacket(band, data.subarray(offset, Math.min(data.length, offset + chunk))));
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Packfiles
// -------------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a packfile (version 2) holding plain (undeltified) objects. */
export function writePack(objects: { type: ObjectType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packEntryHeader(TYPE_CODE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const trailer = createHash('sha1').update(Buffer.concat(parts)).digest();
  return Buffer.concat([...parts, trailer]);
}

export interface PackReadResult {
  version: number;
  objects: Map<string, GitObject>;
  deltaCount: number;
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = buf[offset] & 0x7f;
  let next = offset + 1;
  while (buf[offset] & 0x80) {
    value = ((value + 1) << 7) + (buf[next] & 0x7f);
    offset = next;
    next += 1;
  }
  return { value, next };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVar = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta-corrupt');
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVar();
  const targetSize = readVar();
  if (sourceSize !== base.length) throw new Error('delta-base-size');
  const out: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          if (offset >= delta.length) throw new Error('delta-corrupt');
          copyOffset |= delta[offset++] << (8 * i);
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          if (offset >= delta.length) throw new Error('delta-corrupt');
          copySize |= delta[offset++] << (8 * i);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta-corrupt');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta-corrupt');
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('delta-corrupt');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || written !== targetSize) throw new Error('delta-size');
  return result;
}

export interface PackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer; // inflated bytes (delta bytes for delta entries)
  oid: string;
  delta: { kind: 'ofs' | 'ref'; baseOid: string } | null;
}

/** Parse a packfile, resolving deltas (including thin-pack REF_DELTA via resolveBase). */
function tryInflate(slice: Buffer): Buffer | null {
  try {
    return inflateSync(slice);
  } catch {
    return null;
  }
}

/**
 * Inflate one zlib stream starting at `offset` and return the data plus the exact
 * number of input bytes the stream consumed. Fast path: a single inflateSync
 * with `{info: true}` — the engine's `bytesWritten` is the number of input bytes
 * the stream consumed (verified against real git packs: the landing offset parses
 * as the next object's header, and the last object's lands exactly on the trailer).
 * The landing offset is validated; if the engine does not report it (another Node
 * build), the stream end is found by binary search instead (a slice shorter than
 * the stream throws, a slice at or past its end inflates to the full size).
 */
function inflateEntry(pack: Buffer, offset: number, expectedSize: number, limit: number): { data: Buffer; consumed: number } {
  const result = inflateSync(pack.subarray(offset, limit), { info: true });
  const data = result.buffer as Buffer;
  if (data.length !== expectedSize) throw new Error('pack-size');
  const consumed = (result.engine as { bytesWritten?: unknown }).bytesWritten;
  if (typeof consumed === 'number' && Number.isInteger(consumed) && consumed > 0 && offset + consumed <= limit) {
    const landing = offset + consumed;
    // The landing offset must be the trailer, or the start of a valid object header.
    if (landing === limit) return { data, consumed };
    const typeCode = (pack[landing] >> 4) & 0x07;
    if (typeCode === 1 || typeCode === 2 || typeCode === 3 || typeCode === 4 || typeCode === 6 || typeCode === 7) {
      return { data, consumed };
    }
  }
  let low = offset; // too short: empty or truncated
  let high = limit; // succeeds
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    const attempt = tryInflate(pack.subarray(offset, mid));
    if (attempt !== null && attempt.length === expectedSize) high = mid;
    else low = mid;
  }
  const found = tryInflate(pack.subarray(offset, high));
  if (found === null || found.length !== expectedSize) throw new Error('pack-size');
  return { data: found, consumed: high - offset };
}

export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error('pack-truncated');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack-header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack-version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const actual = pack.subarray(trailerStart).toString('hex');
  if (computed !== actual) throw new Error('pack-checksum');
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack-truncated');
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack-truncated');
      byte = pack[offset++];
      size += (byte & 0x7f) << shift;
      shift += 7;
      if (shift > 63) throw new Error('pack-corrupt');
    }
    if (typeCode !== 1 && typeCode !== 2 && typeCode !== 3 && typeCode !== 4 && typeCode !== 6 && typeCode !== 7) {
      throw new Error('pack-type');
    }
    let delta: PackEntry['delta'] = null;
    if (typeCode === 6) {
      const { value, next } = readVarint(pack, offset);
      offset = next;
      const baseOffset = entryOffset - value;
      if (value <= 0 || baseOffset < 0) throw new Error('pack-delta');
      delta = { kind: 'ofs', baseOid: '' };
      // Resolve the base offset to an oid after all entries are read; stash offset in baseOid.
      (delta as unknown as { baseOffset: number }).baseOffset = baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('pack-truncated');
      delta = { kind: 'ref', baseOid: pack.subarray(offset, offset + 20).toString('hex') };
      offset += 20;
    }
    const { data, consumed } = inflateEntry(pack, offset, size, trailerStart);
    offset += consumed;
    const entry: PackEntry = { offset: entryOffset, typeCode, size, data, oid: '', delta };
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack-trailing');
  // Resolve deltas (recursive, cycle-guarded).
  const resolved = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolveEntry = (entry: PackEntry): GitObject => {
    if (entry.oid !== '') {
      const existing = resolved.get(entry.oid);
      if (existing) return existing;
    }
    if (resolving.has(entry.offset)) throw new Error('pack-delta-cycle');
    resolving.add(entry.offset);
    try {
      if (entry.delta === null) {
        const type = CODE_TYPE[entry.typeCode];
        const oid = hashObject(type, entry.data);
        entry.oid = oid;
        const obj: GitObject = { type, data: entry.data };
        if (!resolved.has(oid)) resolved.set(oid, obj);
        return obj;
      }
      let base: GitObject | undefined;
      if (entry.delta.kind === 'ofs') {
        const baseOffset = (entry.delta as unknown as { baseOffset: number }).baseOffset;
        const baseEntry = byOffset.get(baseOffset);
        if (!baseEntry) throw new Error('pack-delta-base');
        base = resolveEntry(baseEntry);
      } else {
        const baseOid = entry.delta.baseOid;
        const baseEntry = entries.find((e) => e.oid === baseOid && e.oid !== '');
        if (baseEntry) base = resolveEntry(baseEntry);
        else {
          // Look for an entry whose resolved oid matches (entries resolve lazily).
          for (const candidate of entries) {
            if (candidate.delta === null) {
              const candidateOid = hashObject(CODE_TYPE[candidate.typeCode], candidate.data);
              if (candidateOid === baseOid) {
                base = resolveEntry(candidate);
                break;
              }
            }
          }
          if (!base && resolveBase) base = resolveBase(baseOid);
        }
        if (!base) throw new Error('pack-delta-base');
      }
      const data = applyDelta(base.data, entry.data);
      const oid = hashObject(base.type, data);
      entry.oid = oid;
      const obj: GitObject = { type: base.type, data };
      if (!resolved.has(oid)) resolved.set(oid, obj);
      return obj;
    } finally {
      resolving.delete(entry.offset);
    }
  };
  for (const entry of entries) resolveEntry(entry);
  let deltaCount = 0;
  for (const entry of entries) if (entry.delta !== null) deltaCount += 1;
  return { version, objects: resolved, deltaCount };
}

// -------------------------------------------------------------------------------------------------
// Fetch object selection
// -------------------------------------------------------------------------------------------------

export interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/**
 * The objects a fetching client already holds: the closure of its haves, except
 * that a shallow boundary's parents are NOT held (a shallow clone holds the
 * boundary commit and its tree, but not the boundary's ancestors). This is what
 * makes a deepen fetch deliver the next generation instead of nothing.
 */
function collectHeld(repo: Repo, haves: readonly string[], shallowBoundaries: readonly string[]): Set<string> {
  const held = new Set<string>();
  const boundaries = new Set(shallowBoundaries);
  const stack: string[] = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      let info;
      try {
        info = parseCommit(obj.data);
      } catch {
        continue;
      }
      stack.push(info.tree);
      if (!boundaries.has(oid)) {
        for (const parent of info.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      let entries;
      try {
        entries = parseTree(obj.data);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      let target;
      try {
        target = parseTag(obj.data).object;
      } catch {
        continue;
      }
      stack.push(target);
    }
  }
  return held;
}

/**
 * Select the objects a fetch must send: reachable from `wants`, minus what `haves`
 * already hold, honouring `depth` (deepen N) and the caller's current shallow
 * boundaries. Commit distance is measured from the nearest want.
 */
export function selectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  shallowBoundaries: string[],
  deepenSince: number | null,
  deepenNot: string[],
): FetchSelection {
  const extraHaves = [...haves];
  for (const ref of deepenNot) {
    const oid = repo.refs.get(ref);
    if (oid) extraHaves.push(oid);
  }
  const haveClosure = collectHeld(repo, extraHaves, shallowBoundaries);

  const included = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const visited = new Set<string>();
  const queue: { oid: string; depth: number }[] = [];

  const enqueueWant = (oid: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj) return;
    if (obj.type === 'tag') {
      if (!included.has(oid) && !haveClosure.has(oid)) {
        included.add(oid);
        try {
          enqueueWant(parseTag(obj.data).object);
        } catch {
          // ignore
        }
      }
      return;
    }
    if (obj.type === 'commit') queue.push({ oid, depth: 0 });
    // A want of a tree/blob is sent as-is.
    if ((obj.type === 'tree' || obj.type === 'blob') && !haveClosure.has(oid)) included.add(oid);
  };
  for (const want of wants) enqueueWant(want);

  const includeCommitTree = (commitOid: string): void => {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return;
    if (!haveClosure.has(commitOid)) included.add(commitOid);
    let info;
    try {
      info = parseCommit(obj.data);
    } catch {
      return;
    }
    const addTree = (treeOid: string): void => {
      if (haveClosure.has(treeOid) || included.has(treeOid)) return;
      included.add(treeOid);
      const treeObj = repo.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return;
      let entries;
      try {
        entries = parseTree(treeObj.data);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.mode === '160000') continue;
        if (haveClosure.has(entry.oid)) continue;
        if (entry.mode === '40000') addTree(entry.oid);
        else included.add(entry.oid);
      }
    };
    addTree(info.tree);
  };

  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift() as { oid: string; depth: number };
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (depth !== null && d >= depth) continue;
    let info;
    try {
      info = parseCommit(obj.data);
    } catch {
      continue;
    }
    const held = haveClosure.has(oid);
    if (!held) {
      if (deepenSince !== null) {
        // The author line ends "<ts> +0000"; the timestamp is the second-to-last token.
        const tokens = info.author.trim().split(/\s+/);
        const ts = parseInt(tokens[tokens.length - 2] ?? '0', 10);
        if (!Number.isNaN(ts) && ts < deepenSince) continue;
      }
      includeCommitTree(oid);
    }
    if (depth !== null && d === depth - 1) {
      // This commit becomes the new shallow boundary.
      if (!held) shallow.push(oid);
    } else if (depth !== null || !held) {
      // Traverse parents: always while deepening (a held commit's ancestors may be
      // newly wanted); otherwise only past commits the client does not hold, since a
      // held commit's ancestors are already held.
      for (const parent of info.parents) {
        if (!visited.has(parent)) queue.push({ oid: parent, depth: d + 1 });
      }
    }
  }

  // Unshallow: an old boundary whose parents are now included is no longer shallow.
  for (const boundary of shallowBoundaries) {
    if (shallow.includes(boundary)) continue;
    if (!included.has(boundary)) continue;
    let parents: string[] = [];
    try {
      parents = parseCommit((repo.objects.get(boundary) as GitObject).data).parents;
    } catch {
      parents = [];
    }
    if (parents.some((p) => included.has(p))) unshallow.push(boundary);
  }

  // Acknowledgments: ACK every have that is an ancestor-or-equal of a want.
  // With no haves there is nothing to acknowledge (nak), so the want closure
  // walk — the whole reachable history — is skipped outright.
  const acks: string[] = [];
  if (haves.length > 0) {
    const wantClosure = collectReachable(repo, wants);
    for (const have of haves) {
      if (wantClosure.has(have)) acks.push(have);
    }
  }
  const nak = acks.length === 0;

  // Deterministic pack order: sorted oids.
  const objects: GitObject[] = [];
  for (const oid of [...included].sort()) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow, unshallow, acks, nak, hadHaves: haves.length > 0 };
}

// -------------------------------------------------------------------------------------------------
// Advertisement
// -------------------------------------------------------------------------------------------------

export interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headOid(repo: Repo): string {
  return repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/**
 * Upload-pack v2 advertisement: service line, flush, `version 2`, capability lines, flush.
 * The advertisement is constant (no repo input), so it is built once at module load
 * instead of per info/refs request — the 50-concurrent-clone workload asks for it 50 times.
 * Callers only ever write the buffer to a socket, never mutate it.
 */
const V2_ADVERTISEMENT: Buffer = (() => {
  const lines = [
    '# service=git-upload-pack\n',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow unborn\n',
    'object-format=sha1\n',
  ];
  const parts: Buffer[] = [pktLine(lines[0]), pktFlush()];
  for (const line of lines.slice(1)) parts.push(pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
})();

export function uploadPackV2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** Upload-pack v0 advertisement (when the client did not ask for version 2). */
export function uploadPackV0Advertisement(repo: Repo): Buffer {
  const caps = `side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
      if (repo.objects.get(ref.oid)?.type === 'tag') {
        const peeled = peelObject(repo, ref.oid);
        if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Receive-pack v0 advertisement. */
export function receivePackAdvertisement(repo: Repo): Buffer {
  const caps = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (repo.objects.get(ref.oid)?.type === 'tag') {
        const peeled = peelObject(repo, ref.oid);
        if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// ls-refs (v2)
// -------------------------------------------------------------------------------------------------

export function lsRefsResponse(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean, unborn: boolean): Buffer {
  const parts: Buffer[] = [];
  const head = headOid(repo);
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (matches('HEAD')) {
    if (head === ZERO_OID) {
      if (unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else if (symrefs) {
      parts.push(pktLine(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else {
      parts.push(pktLine(`${head} HEAD\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && repo.objects.get(ref.oid)?.type === 'tag') {
      const peeled = peelObject(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// Fetch responses
// -------------------------------------------------------------------------------------------------

export function fetchV2Response(selection: FetchSelection, pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent haves: a fresh
  // clone (no haves) goes straight to the packfile section. Real git rejects an
  // acknowledgments section on a no-haves fetch.
  if (selection.hadHaves) {
    parts.push(pktLine('acknowledgments\n'));
    if (selection.nak) parts.push(pktLine('NAK\n'));
    else {
      for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(pktFlush());
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function fetchV0Response(selection: FetchSelection, pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  // v0 likewise: ACK/NAK lines only when the client sent haves.
  if (selection.hadHaves) {
    if (selection.nak) parts.push(pktLine('NAK\n'));
    else {
      for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
    }
  }
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// Receive-pack (push)
// -------------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  refs: { ref: string; ok: boolean; reason: string }[];
}

/** Parse a receive-pack request body: pkt-lined commands up to the flush, then raw pack bytes. */
export function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  // Find the first flush packet (0000) — everything after it is the pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('pktline-header');
    const length = parseInt(header, 16);
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length === 1 || length === 2) throw new Error('pktline-header');
    if (length > PKT_LINE_MAX) throw new Error('pktline-too-long');
    if (offset + length > body.length) throw new Error('pktline-truncated');
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const commandText = nul >= 0 ? line.slice(0, nul) : line;
    const parts = commandText.split(' ');
    if (parts.length < 3) throw new Error('push-command');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  if (commands.length === 0) throw new Error('push-command');
  const pack = packStart < body.length ? body.subarray(packStart) : null;
  return { commands, pack };
}

export function applyPush(repo: Repo, commands: PushCommand[], packObjects: Map<string, GitObject> | null, hasPack: boolean): PushOutcome {
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (updatesRef && !hasPack) {
    return { unpackOk: false, unpackDetail: 'unpacker error', refs: [] };
  }
  if (packObjects !== null) {
    for (const [oid, obj] of packObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  // Every new tip must be present after unpacking.
  for (const command of commands) {
    if (command.newOid !== ZERO_OID && !repo.objects.has(command.newOid)) {
      return { unpackOk: false, unpackDetail: 'unpacker error', refs: [] };
    }
    if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) {
      return { unpackOk: false, unpackDetail: 'unpacker error', refs: [] };
    }
    if (!command.ref.startsWith('refs/') || command.ref.length > 200 || /[\s\u0000-\u001f]/.test(command.ref)) {
      return { unpackOk: false, unpackDetail: 'unpacker error', refs: [] };
    }
  }
  const results: PushOutcome['refs'] = [];
  let changed = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.delete(command.ref);
      changed = true;
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      changed = true;
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update: current must match old, and new must descend from old.
    if (current === undefined || current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === command.oldOid || isAncestor(repo, command.oldOid, command.newOid)) {
      repo.refs.set(command.ref, command.newOid);
      changed = true;
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  if (changed) {
    repo.generation += 1;
    repo.packCache.clear();
  }
  return { unpackOk: true, unpackDetail: 'ok', refs: results };
}

/** The report-status stream (pkt-lined), wrapped in sideband band 1 when asked. */
export function pushReportResponse(outcome: PushOutcome, sideband: boolean): Buffer {
  const lines: Buffer[] = [pktLine(`unpack ${outcome.unpackDetail}\n`)];
  for (const ref of outcome.refs) {
    lines.push(pktLine(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`));
  }
  // The report-status stream is itself a pkt-line stream, so it ends with its own flush
  // packet. With sideband that flush lives INSIDE band 1; the sideband stream then ends
  // with a second, outer flush. Without sideband the single trailing flush is the same one.
  lines.push(pktFlush());
  const report = Buffer.concat(lines);
  if (!sideband) return report;
  const parts: Buffer[] = [];
  for (const packet of sidebandPackets(1, report)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// Cached pack bytes for identical fetches (the 50-concurrent-clone workload).
// -------------------------------------------------------------------------------------------------

export function cachedFetchPack(repo: Repo, key: string, build: () => CachedFetch): CachedFetch {
  const hit = repo.packCache.get(key);
  if (hit) return hit;
  const pack = build();
  // Bound the cache so a long trial cannot grow it without limit.
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(key, pack);
  return pack;
}
