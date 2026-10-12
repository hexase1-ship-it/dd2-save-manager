// Reader for the game's .pak archives (RE Engine "KPKA" v4.x), enough to pull single files
// out by path. Layout as documented by Ekey's REE.PAK.Tool.
//
//   header   "KPKA" | u8 major | u8 minor | u16 features | u32 fileCount | u32 fingerprint
//   entries  fileCount x 48 bytes, XOR-masked with a key that is RSA-wrapped in the archive
//   tables   chunk tables used by files stored as a run of 512 KiB blocks
//
// Files are found by the murmur3 hashes of their lower- and upper-cased path (UTF-16).

import fs from 'node:fs';
import zlib from 'node:zlib';
import { murmur3_32 } from '../core/hash.js';

const ENTRY_SIZE = 48;
const KEY_SIZE = 128;
const CHUNK_SIZE = 0x80000;

const FEATURE_DLC_DATA = 0x04; // 9 bytes before the key
const FEATURE_ENCRYPTED = 0x08;
const FEATURE_EXTRA_DATA = 0x10; // 4 bytes before the key
const FEATURE_CHUNKED = 0x20;
const FEATURE_EXTRA_TABLE = 0x40;
const KNOWN_FEATURES = new Set([0, 0x08, 0x0c, 0x18, 0x28, 0x2c, 0x68]);

const COMPRESSION = { NONE: 0, DEFLATE: 1, ZSTD: 2 };
// Attribute values that mark an uncompressed entry as "a run of chunks".
const CHUNKED_ATTRIBUTES = new Set([0x1000000n, 0x1000400n, 0x1000800n, 0x1000c00n]);

const le = (bytes) => BigInt('0x' + Buffer.from(bytes).reverse().toString('hex'));

const TABLE_MODULUS = le(Buffer.from(
  '7d0bf8c17c23fd3bd47516d23321d81071f97cd13493ba7726fcab2ceedad91c89e7297bdd8aae5039b6016d21895da5' +
  'a13ea2c08c93133665ebe8df06176796062bac23ed8cb78b90adea71c440449d1c7bbac4b62dd6d24b62d626fc742007' +
  'ece3599ae6afb9a8358be0e8d3cd4565b091c4951bf3231ec671cf3e352d6be3', 'hex'));
const TABLE_EXPONENT = 0x10001n;

const RESOURCE_MODULUS = le(Buffer.from('13d79c8988914810d7aa78aef859df7d3c43a0d0bb3677b5f05c02af65d87703', 'hex'));
const RESOURCE_EXPONENT = le(Buffer.from('c0c2771f5b346a01c7d4d7852e422b3b163a171316ea833030df3ff425932001', 'hex'));

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

function bytesLE(value, length) {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

/** Hash pair an archive files a path under. */
export function pathKey(path) {
  const lower = murmur3_32(Buffer.from(path.toLowerCase(), 'utf16le'));
  const upper = murmur3_32(Buffer.from(path.toUpperCase(), 'utf16le'));
  return (BigInt(upper) << 32n) | BigInt(lower);
}

export class PakError extends Error {}

export class Pak {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    this.entries = new Map();
    this.chunks = [];
    this.#readTables();
  }

  close() {
    fs.closeSync(this.fd);
  }

  #read(position, length) {
    const buf = Buffer.alloc(length);
    const got = fs.readSync(this.fd, buf, 0, length, position);
    if (got !== length) throw new PakError(`${this.file}: short read at ${position}`);
    return buf;
  }

  /** Reads one chunk table; returns the position after it. */
  #readChunkTable(position, entrySize) {
    const head = this.#read(position, 8);
    const count = entrySize === 16 ? head.readInt32LE(0) : head.readInt32LE(4);
    const table = this.#read(position + 8, count * entrySize);
    this.chunks = [];
    for (let i = 0; i < count; i++) {
      const offset = table.readUInt32LE(i * entrySize);
      const packed = table.readUInt32LE(i * entrySize + 4);
      this.chunks.push({ offset: offset + (packed & 0x3ff) * 0x100000000, size: packed >>> 10 });
    }
    return position + 8 + count * entrySize;
  }

  #readTables() {
    const size = fs.fstatSync(this.fd).size;
    if (size < 16) return;
    const header = this.#read(0, 16);
    if (header.toString('latin1', 0, 4) !== 'KPKA') throw new PakError(`${this.file}: not a pak archive`);
    const major = header[4];
    const features = header.readUInt16LE(6);
    const count = header.readUInt32LE(8);
    if (major !== 4) throw new PakError(`${this.file}: unsupported pak version ${major}`);
    if (!KNOWN_FEATURES.has(features)) throw new PakError(`${this.file}: unsupported pak features 0x${features.toString(16)}`);
    if (count === 0) return;

    const table = this.#read(16, count * ENTRY_SIZE);
    let position = 16 + count * ENTRY_SIZE;
    if (features & FEATURE_EXTRA_TABLE) position = this.#readChunkTable(position, 16);
    if (features & FEATURE_EXTRA_DATA) position += 4;
    if (features & FEATURE_DLC_DATA) position += 9;
    if (features & FEATURE_ENCRYPTED) {
      const key = bytesLE(modPow(le(this.#read(position, KEY_SIZE)), TABLE_EXPONENT, TABLE_MODULUS), 32);
      position += KEY_SIZE;
      for (let i = 0; i < table.length; i++) table[i] ^= (i + key[i % 32] * key[i % 29]) & 0xff;
    }
    // The 8-byte table is the one files are read through; it replaces the extra table above.
    if (features & FEATURE_CHUNKED) this.#readChunkTable(position, 8);

    for (let i = 0; i < count; i++) {
      const o = i * ENTRY_SIZE;
      const attributes = table.readBigInt64LE(o + 32);
      this.entries.set(table.readBigUInt64LE(o), {
        offset: Number(table.readBigInt64LE(o + 8)),
        packedSize: Number(table.readBigInt64LE(o + 16)),
        size: Number(table.readBigInt64LE(o + 24)),
        attributes,
        compression: Number(attributes & 0xfn),
        encryption: Number((attributes >> 16n) & 0xffn),
      });
    }
  }

  has(path) {
    return this.entries.has(pathKey(path));
  }

  /** Contents of a file, or null when the archive does not hold it. */
  extract(path) {
    const entry = this.entries.get(pathKey(path));
    if (!entry) return null;
    if (entry.compression === COMPRESSION.NONE) {
      return CHUNKED_ATTRIBUTES.has(entry.attributes) ? this.#unwrapChunks(entry) : this.#read(entry.offset, entry.size);
    }
    let data = this.#read(entry.offset, entry.packedSize);
    if (entry.encryption) data = decryptResource(data);
    if (entry.compression === COMPRESSION.DEFLATE) return zlib.inflateRawSync(data);
    if (entry.compression === COMPRESSION.ZSTD) return zlib.zstdDecompressSync(data);
    throw new PakError(`${path}: unknown compression ${entry.compression}`);
  }

  #unwrapChunks(entry) {
    const parts = [];
    let remaining = entry.packedSize;
    for (let id = entry.offset; remaining > 0; id++) {
      const chunk = this.chunks[id];
      if (!chunk) throw new PakError(`${this.file}: chunk ${id} out of range`);
      const data = this.#read(chunk.offset, chunk.size);
      parts.push(chunk.size === CHUNK_SIZE ? data : zlib.zstdDecompressSync(data));
      remaining -= chunk.size;
    }
    return Buffer.concat(parts).subarray(0, entry.size);
  }
}

/** Some resources are wrapped in 128-byte blocks: a 64-byte key and 64 bytes that yield 8 bytes of data. */
function decryptResource(data) {
  const size = Number(data.readBigInt64LE(0));
  const blocks = Math.floor((data.length - 8) / 128);
  const out = Buffer.alloc(blocks * 8 + 8);
  for (let i = 0; i < blocks; i++) {
    const at = 8 + i * 128;
    const key = modPow(le(data.subarray(at, at + 64)), RESOURCE_EXPONENT, RESOURCE_MODULUS);
    bytesLE(le(data.subarray(at + 64, at + 128)) / key, 8).copy(out, i * 8);
  }
  return out.subarray(0, size);
}

/**
 * The game's archives in load order; a file in a later archive replaces the same path in an
 * earlier one.
 */
export class GameFiles {
  constructor(gameDir) {
    const names = fs.readdirSync(gameDir).filter((n) => /^re_chunk_000\.pak(\.patch_\d+\.pak)?$/.test(n)).sort();
    const dlcDir = `${gameDir}/dlc`;
    const dlc = fs.existsSync(dlcDir) ? fs.readdirSync(dlcDir).filter((n) => n.endsWith('.pak')).sort().map((n) => `dlc/${n}`) : [];
    this.paks = [...names, ...dlc].map((n) => new Pak(`${gameDir}/${n}`));
  }

  extract(path) {
    for (let i = this.paks.length - 1; i >= 0; i--) {
      const data = this.paks[i].extract(path);
      if (data) return data;
    }
    return null;
  }

  close() {
    for (const pak of this.paks) pak.close();
  }
}
