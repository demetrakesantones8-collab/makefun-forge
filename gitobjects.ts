// Git object model: hashing, parsing and the graph walks the forge needs. Plain bytes in, plain
// bytes out; nothing here touches HTTP or the store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The sha1 of an object as git names it: the type, the length, a NUL, then the bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** The zlib-compressed loose-object form, as a pack entry stores it. */
export function encodeLoose(obj: GitObject): Buffer {
  const head = Buffer.from(`${obj.type} ${obj.data.length}\u0000`, 'utf8');
  return deflateSync(Buffer.concat([head, obj.data]));
}

/** Decompress a loose object and split its header off; throws on a broken body. */
export function decodeLoose(raw: Buffer): GitObject {
  const full = inflateSync(raw);
  const nul = full.indexOf(0);
  if (nul < 0) throw new Error('object has no header');
  const space = full.indexOf(32);
  const type = full.subarray(0, space).toString('ascii') as ObjType;
  const size = Number(full.subarray(space + 1, nul).toString('ascii'));
  const data = full.subarray(nul + 1);
  if (data.length !== size) throw new Error('object length does not match its header');
  return { type, data };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** A tree's entries in wire order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < 0) break;
    const nul = data.indexOf(0, space);
    if (nul < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Build tree bytes from entries, in the order given (git sorts them, so callers sort first). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** A commit's tree, parents and message; an unparsable commit gives empty parts, never a throw. */
export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const commit: Commit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

/** Build commit bytes; `time` is seconds since the epoch. */
export function buildCommit(input: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`, `committer ${input.committer}`, '', input.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export const TYPE_CODE_OF = (type: ObjType): number => TYPE_CODE[type];
export const TYPE_OF_CODE = (code: number): ObjType | undefined => CODE_TYPE[code];
