// DSSS save container: 16-byte header, encrypted payload, 0x8C-byte footer.
//
//   header  "DSSS" | u32 version (2) | u32 flags | u32 0
//   payload Mandarin slices (see mandarin.js)
//   footer  0x80 RSA block | u64 plaintext length | u32 murmur3 of everything before it
//
// With the DEFLATE flag the plaintext is itself a small wrapper around a raw deflate stream:
//   u64 compressedSize + 0x10 | u32 1 | u32 compressedSize | u64 rawSize | deflate data

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { murmur3_32 } from './hash.js';
import { GAMES, SIZES, MandarinError, decrypt, encrypt } from './mandarin.js';

export const FLAG_DEFLATE = 0x8;
export const FLAG_MANDARIN = 0x10;

const HEADER_SIZE = 0x10;
const DEFLATE_HEADER = 24;

export class SaveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function readHeader(file) {
  if (file.length < HEADER_SIZE + SIZES.RSA_SIZE + 12 || file.toString('latin1', 0, 4) !== 'DSSS') {
    throw new SaveError('not-a-save', 'Not a DSSS save file.');
  }
  const version = file.readUInt32LE(4);
  const flags = file.readUInt32LE(8);
  if (version !== 2) throw new SaveError('version', `Unsupported save version ${version}.`);
  if (!(flags & FLAG_MANDARIN) || flags & ~(FLAG_MANDARIN | FLAG_DEFLATE)) {
    throw new SaveError('flags', `Unsupported save flags 0x${flags.toString(16)}.`);
  }
  return {
    flags,
    signatureOk: murmur3_32(file.subarray(0, file.length - 4)) === file.readUInt32LE(file.length - 4),
    plainLength: Number(file.readBigUInt64LE(file.length - 12)),
  };
}

/** Decrypts and decompresses a save. Returns the serialized object tree ("body"). */
export function readSave(file, steamId, game = GAMES.dd2) {
  const header = readHeader(file);
  if (!header.signatureOk) throw new SaveError('signature', 'Save file signature does not match; the file is damaged.');
  const payload = file.subarray(HEADER_SIZE, file.length - 12);
  let result;
  try {
    result = decrypt(payload, header.plainLength, game.userKey(steamId), game);
  } catch (error) {
    if (error instanceof MandarinError) throw new SaveError(error.code, error.message);
    throw error;
  }
  let body = result.data;
  if (header.flags & FLAG_DEFLATE) {
    const packed = body.readUInt32LE(12);
    const rawSize = Number(body.readBigUInt64LE(16));
    body = inflateRawSync(body.subarray(DEFLATE_HEADER, DEFLATE_HEADER + packed));
    if (body.length !== rawSize) throw new SaveError('inflate', 'Decompressed size does not match the save header.');
  }
  return { flags: header.flags, body, plain: result.data, slices: result.slices, tags: result.tags };
}

function wrapDeflate(body, level) {
  const packed = deflateRawSync(body, { level });
  const head = Buffer.alloc(DEFLATE_HEADER);
  head.writeBigUInt64LE(BigInt(packed.length + 0x10), 0);
  head.writeUInt32LE(1, 8);
  head.writeUInt32LE(packed.length, 12);
  head.writeBigUInt64LE(BigInt(body.length), 16);
  return Buffer.concat([head, packed]);
}

/** Builds a complete save file from a body. */
export function writeSave(body, flags, steamId, game = GAMES.dd2) {
  let plain = body;
  if (flags & FLAG_DEFLATE) {
    // Community tools disagree on the slice plan when the plaintext is an exact multiple of
    // the slice unit, so step the compression level until it is not.
    for (let level = 6; level <= 9; level++) {
      plain = wrapDeflate(body, level);
      if (plain.length % SIZES.SLICE_UNIT !== 0) break;
    }
  }
  return sealSave(plain, flags, steamId, game);
}

/** Encrypts an already-prepared plaintext (used to verify the cipher against real saves). */
export function sealSave(plain, flags, steamId, game = GAMES.dd2) {
  const payload = encrypt(plain, game.userKey(steamId), game);
  const file = Buffer.alloc(HEADER_SIZE + payload.length + 12);
  file.write('DSSS', 0, 'latin1');
  file.writeUInt32LE(2, 4);
  file.writeUInt32LE(flags, 8);
  payload.copy(file, HEADER_SIZE);
  file.writeBigUInt64LE(BigInt(plain.length), file.length - 12);
  file.writeUInt32LE(murmur3_32(file.subarray(0, file.length - 4)), file.length - 4);
  return file;
}
