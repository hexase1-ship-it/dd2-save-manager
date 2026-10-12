// Object tree stored inside a decrypted save ("body").
//
// Every value carries a type tag, so the tree can be walked without the game's type database.
// Names are stored only as murmur3 hashes; schema.js turns those back into names.
//
//   body   = (u32 hash, class)*
//   class  = u32 fieldCount | u32 typeHash | field*
//   field  = u32 nameHash | i32 type | value | pad to 4
//   value  = class
//          | array:  pad4 | i32 memberType | u32 memberSize | u32 count | i32 kind | elements | pad4
//          | string: pad4 | u32 length | u16[length]
//          | scalar: pad4 | u32 size | pad by size | bytes
//
// "Pad by size" is the game's own rule: offset = (offset + size - 1) & ~(size - 1), applied to
// the offset within the whole file. For sizes that are not powers of two (a 24-byte
// via.Position) this is not a real alignment, so it has to be reproduced literally, including
// the 16-byte file header that precedes the body.

export const T = {
  ARRAY: -1,
  ENUM: 1, BOOL: 2, S8: 3, U8: 4, S16: 5, U16: 6, S32: 7, U32: 8, S64: 9, U64: 10,
  F32: 11, F64: 12, C8: 13, C16: 14, STRING: 15, STRUCT: 16, CLASS: 17,
};

export const TYPE_NAMES = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k.toLowerCase()]));

const CLASS_ARRAY = 1;
const VALUE_ARRAY = 0;
const HASH_LIST_MARKER = 0xffeeffee;
const FILE_HEADER = 16;

export class TreeError extends Error {}

const alignUp = (pos, n) => Math.ceil(pos / n) * n;
const padBySize = (pos, size) => (size > 1 ? (((pos + FILE_HEADER + size - 1) & ~(size - 1)) >>> 0) - FILE_HEADER : pos);
const isValidType = (t) => t === T.ARRAY || (t >= T.ENUM && t <= T.CLASS);

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  align(n) {
    this.pos = alignUp(this.pos, n);
  }
  padBySize(size) {
    this.pos = padBySize(this.pos, size);
  }
  u32() {
    if (this.pos + 4 > this.buf.length) throw new TreeError(`Read past end of save body at ${this.pos}.`);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  i32() {
    return this.u32() | 0;
  }
  bytes(n) {
    if (this.pos + n > this.buf.length) throw new TreeError(`Read past end of save body at ${this.pos}.`);
    const v = Buffer.from(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return v;
  }
}

function decodeScalar(type, raw) {
  switch (type) {
    case T.BOOL: return raw[0] !== 0;
    case T.S8: return raw.readInt8(0);
    case T.U8: case T.C8: return raw[0];
    case T.S16: return raw.readInt16LE(0);
    case T.U16: case T.C16: return raw.readUInt16LE(0);
    case T.S32: return raw.readInt32LE(0);
    case T.U32: return raw.readUInt32LE(0);
    case T.S64: return raw.readBigInt64LE(0);
    case T.U64: return raw.readBigUInt64LE(0);
    case T.F32: return raw.readFloatLE(0);
    case T.F64: return raw.readDoubleLE(0);
    case T.ENUM:
      if (raw.length === 1) return raw.readInt8(0);
      if (raw.length === 2) return raw.readInt16LE(0);
      if (raw.length === 4) return raw.readInt32LE(0);
      if (raw.length === 8) return raw.readBigInt64LE(0);
      throw new TreeError(`Enum of size ${raw.length}.`);
    case T.STRUCT: return undefined;
    default: throw new TreeError(`Unknown value type ${type}.`);
  }
}

// Untouched values keep their original bytes (NaN payloads, bools stored as 2..255), so a
// tree that was only read serializes back byte for byte.
function readScalar(r, type, size) {
  r.padBySize(size);
  const raw = r.bytes(size);
  return { value: decodeScalar(type, raw), raw };
}

function readString(r) {
  r.align(4);
  const length = r.u32();
  return { value: r.bytes(length * 2).toString('utf16le') };
}

function readArray(r) {
  r.align(4);
  const memberType = r.i32();
  const memberSize = r.u32();
  const count = r.u32();
  const kind = r.i32();
  const node = { memberType, memberSize, kind, items: [] };
  if (kind === CLASS_ARRAY) {
    if (r.pos + 4 <= r.buf.length && r.buf.readUInt32LE(r.pos) === HASH_LIST_MARKER) {
      r.pos += 4;
      node.hashes = [];
      for (let i = 0; i < count; i++) node.hashes.push(r.u32());
    }
    for (let i = 0; i < count; i++) node.items.push(readClass(r));
  } else if (kind === VALUE_ARRAY) {
    for (let i = 0; i < count; i++) {
      node.items.push(memberType === T.STRING ? readString(r) : readScalar(r, memberType, memberSize));
    }
  } else {
    throw new TreeError(`Unknown array kind ${kind} at ${r.pos}.`);
  }
  r.align(4);
  return node;
}

function readClass(r) {
  const count = r.u32();
  const hash = r.u32();
  if (count > 0x10000) throw new TreeError(`Implausible field count ${count} at ${r.pos - 8}.`);
  const fields = [];
  for (let i = 0; i < count; i++) {
    const nameHash = r.u32();
    const type = r.i32();
    let node;
    if (type === T.ARRAY) node = readArray(r);
    else if (type === T.CLASS) node = readClass(r);
    else if (type === T.STRING) node = readString(r);
    else if (isValidType(type)) {
      r.align(4);
      node = readScalar(r, type, r.u32());
    } else {
      throw new TreeError(`Unknown value type ${type} at ${r.pos - 4}.`);
    }
    r.align(4);
    fields.push({ hash: nameHash, type, node });
  }
  return { hash, fields };
}

/** @returns {{roots: {hash: number, cls: object}[], tail: Buffer}} */
export function parseBody(body) {
  const r = new Reader(body);
  const roots = [];
  while (r.pos + 12 <= body.length) {
    const hash = r.u32();
    roots.push({ hash, cls: readClass(r) });
  }
  return { roots, tail: r.bytes(body.length - r.pos) };
}

class Writer {
  constructor() {
    this.chunks = [];
    this.pos = 0;
  }
  push(buf) {
    this.chunks.push(buf);
    this.pos += buf.length;
  }
  align(n) {
    this.padTo(alignUp(this.pos, n));
  }
  padBySize(size) {
    this.padTo(padBySize(this.pos, size));
  }
  padTo(pos) {
    if (pos > this.pos) this.push(Buffer.alloc(pos - this.pos));
  }
  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    this.push(b);
  }
}

function writeString(w, node) {
  const raw = Buffer.from(node.value, 'utf16le');
  w.align(4);
  w.u32(raw.length / 2);
  w.push(raw);
}

function writeArray(w, node) {
  w.align(4);
  w.u32(node.memberType);
  w.u32(node.memberSize);
  w.u32(node.items.length);
  w.u32(node.kind);
  if (node.kind === CLASS_ARRAY) {
    if (node.hashes) {
      w.u32(HASH_LIST_MARKER);
      for (const h of node.hashes) w.u32(h);
    }
    for (const item of node.items) writeClass(w, item);
  } else if (node.memberType === T.STRING) {
    for (const item of node.items) writeString(w, item);
  } else {
    for (const item of node.items) {
      w.padBySize(node.memberSize);
      w.push(item.raw);
    }
  }
  w.align(4);
}

function writeClass(w, cls) {
  w.u32(cls.fields.length);
  w.u32(cls.hash);
  for (const field of cls.fields) {
    w.u32(field.hash);
    w.u32(field.type);
    if (field.type === T.ARRAY) writeArray(w, field.node);
    else if (field.type === T.CLASS) writeClass(w, field.node);
    else if (field.type === T.STRING) writeString(w, field.node);
    else {
      w.align(4);
      w.u32(field.node.raw.length);
      w.padBySize(field.node.raw.length);
      w.push(field.node.raw);
    }
    w.align(4);
  }
}

export function serializeBody(tree) {
  const w = new Writer();
  for (const root of tree.roots) {
    w.u32(root.hash);
    writeClass(w, root.cls);
  }
  w.push(tree.tail);
  return Buffer.concat(w.chunks);
}

/** Replaces a scalar node's value, re-encoding its bytes at the same size. */
export function setScalar(node, type, value) {
  const raw = Buffer.alloc(node.raw.length);
  switch (type) {
    case T.BOOL: raw[0] = value ? 1 : 0; break;
    case T.S8: raw.writeInt8(value); break;
    case T.U8: case T.C8: raw.writeUInt8(value); break;
    case T.S16: raw.writeInt16LE(value); break;
    case T.U16: case T.C16: raw.writeUInt16LE(value); break;
    case T.S32: raw.writeInt32LE(value); break;
    case T.U32: raw.writeUInt32LE(value); break;
    case T.S64: raw.writeBigInt64LE(BigInt(value)); break;
    case T.U64: raw.writeBigUInt64LE(BigInt(value)); break;
    case T.F32: raw.writeFloatLE(value); break;
    case T.F64: raw.writeDoubleLE(value); break;
    case T.ENUM:
      if (raw.length === 1) raw.writeInt8(value);
      else if (raw.length === 2) raw.writeInt16LE(value);
      else if (raw.length === 4) raw.writeInt32LE(value);
      else raw.writeBigInt64LE(BigInt(value));
      break;
    default:
      throw new TreeError(`Type ${type} cannot be edited as a scalar.`);
  }
  node.raw = raw;
  node.value = decodeScalar(type, raw);
}

/** Deep copy of a class, array or value node. */
export function cloneNode(node) {
  if (Buffer.isBuffer(node)) return Buffer.from(node);
  if (Array.isArray(node)) return node.map(cloneNode);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, cloneNode(v)]));
  }
  return node;
}

// JSON form of a class, used for files the user keeps outside a save (appearance presets).
// Scalars are stored as their raw bytes in hex so nothing is lost in translation.

export function classToJson(cls) {
  return {
    hash: cls.hash,
    fields: cls.fields.map(({ hash, type, node }) => {
      if (type === T.CLASS) return { hash, type, cls: classToJson(node) };
      if (type === T.STRING) return { hash, type, str: node.value };
      if (type !== T.ARRAY) return { hash, type, hex: node.raw.toString('hex') };
      const { memberType, memberSize, kind, hashes, items } = node;
      return {
        hash,
        type,
        arr: {
          memberType,
          memberSize,
          kind,
          ...(hashes ? { hashes } : {}),
          items: items.map((item) => {
            if (kind === CLASS_ARRAY) return classToJson(item);
            return memberType === T.STRING ? item.value : item.raw.toString('hex');
          }),
        },
      };
    }),
  };
}

function scalarFromHex(type, hex, size) {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})*$/.test(hex)) throw new TreeError('Malformed value in preset.');
  const raw = Buffer.from(hex, 'hex');
  if (size !== undefined && raw.length !== size) throw new TreeError('Value size mismatch in preset.');
  return { value: decodeScalar(type, raw), raw };
}

export function classFromJson(json) {
  if (!json || !Number.isInteger(json.hash) || !Array.isArray(json.fields)) throw new TreeError('Malformed class in preset.');
  return {
    hash: json.hash >>> 0,
    fields: json.fields.map((f) => {
      if (!Number.isInteger(f.hash) || !isValidType(f.type)) throw new TreeError('Malformed field in preset.');
      const head = { hash: f.hash >>> 0, type: f.type };
      if (f.type === T.CLASS) return { ...head, node: classFromJson(f.cls) };
      if (f.type === T.STRING) return { ...head, node: { value: String(f.str) } };
      if (f.type !== T.ARRAY) return { ...head, node: scalarFromHex(f.type, f.hex) };
      const a = f.arr;
      if (!a || !Array.isArray(a.items) || (a.kind !== CLASS_ARRAY && a.kind !== VALUE_ARRAY)) {
        throw new TreeError('Malformed array in preset.');
      }
      const node = { memberType: a.memberType, memberSize: a.memberSize, kind: a.kind, items: [] };
      if (a.hashes) node.hashes = a.hashes.map((h) => h >>> 0);
      node.items = a.items.map((item) => {
        if (a.kind === CLASS_ARRAY) return classFromJson(item);
        return a.memberType === T.STRING ? { value: String(item) } : scalarFromHex(a.memberType, item, a.memberSize);
      });
      return { ...head, node };
    }),
  };
}
