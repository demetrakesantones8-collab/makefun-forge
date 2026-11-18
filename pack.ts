// Packfile read and write. Pushes carry plain objects or deltas; clones are answered with plain
// objects, which git accepts anywhere a delta would be.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { TYPE_OF_CODE, type GitObject, type ObjType } from './gitobjects.ts';

const CODE_OF: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** A packfile of the given objects, in the order given, with its sha1 trailer. */
export function buildPack(objects: { type: ObjType; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(sizeHeader(CODE_OF[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The varint object header: a type code and the inflated size, seven bits at a time. */
function sizeHeader(code: number, size: number): Buffer {
  const bytes: number[] = [];
  let rest = size;
  let byte = (rest & 0x0f) | (code << 4);
  rest >>>= 4;
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest >>>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** Apply a git delta to its base, exactly as git's patch-delta does. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
  };
  varint();
  const targetSize = varint();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) copyOffset += delta[offset++] * 2 ** (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (1 << (4 + i))) copySize += delta[offset++] * 2 ** (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      written += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  return out;
}

interface RawEntry {
  offset: number;
  type?: ObjType;
  data?: Buffer;
  baseOffset?: number;
  baseSha?: string;
  delta?: Buffer;
}

/** Every entry a pack carries, deltas resolved against the objects in it. */
export function parsePack(pack: Buffer): GitObject[] {
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const raws: RawEntry[] = [];
  const byOffset = new Map<number, GitObject>();
  const bySha = new Map<string, GitObject>();

  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const code = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (code === 6) {
      let value = pack[offset++];
      let distance = value & 0x7f;
      while (value & 0x80) {
        value = pack[offset++];
        distance = ((distance + 1) << 7) | (value & 0x7f);
      }
      const inflated = inflateAt(pack, offset);
      offset = inflated.end;
      raws.push({ offset: entryOffset, baseOffset: entryOffset - distance, delta: inflated.bytes });
    } else if (code === 7) {
      const baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.end;
      raws.push({ offset: entryOffset, baseSha, delta: inflated.bytes });
    } else {
      const type = TYPE_OF_CODE(code);
      if (!type) throw new Error(`unknown pack object code ${code}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.end;
      if (inflated.bytes.length !== size) throw new Error('pack entry length mismatch');
      const object: GitObject = { type, data: inflated.bytes };
      byOffset.set(entryOffset, object);
      raws.push({ offset: entryOffset, type, data: inflated.bytes });
    }
  }

  let pending = raws.filter((raw) => raw.delta !== undefined);
  while (pending.length > 0) {
    const next: RawEntry[] = [];
    for (const raw of pending) {
      const base = raw.baseSha !== undefined
        ? bySha.get(raw.baseSha) ?? byOffset.get(-1) ?? undefined
        : byOffset.get(raw.baseOffset as number);
      if (!base) {
        next.push(raw);
        continue;
      }
      const object: GitObject = { type: base.type, data: applyDelta(base.data, raw.delta as Buffer) };
      byOffset.set(raw.offset, object);
      raw.type = object.type;
      raw.data = object.data;
    }
    if (next.length === pending.length) throw new Error('pack has an unresolved delta');
    pending = next;
  }

  const out: GitObject[] = [];
  for (const raw of raws) {
    if (!raw.type || !raw.data) throw new Error('pack entry did not resolve');
    out.push({ type: raw.type, data: raw.data });
  }
  return out;
}

/** Inflate the zlib stream at `start`, say where it ended, and hand back the object bytes. */
function inflateAt(pack: Buffer, start: number): { bytes: Buffer; end: number } {
  const result = inflateSync(pack.subarray(start), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (!consumed) throw new Error('empty zlib stream');
  return { bytes: result.buffer, end: start + consumed };
}
