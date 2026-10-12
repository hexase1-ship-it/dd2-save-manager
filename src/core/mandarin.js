// "Mandarin" save encryption used by Dragon's Dogma 2 (and other recent RE Engine games).
//
// Algorithm as documented by the community tools MandarinJuice (mi5hmash, MIT) and
// ree-save-editor (kvasszn). This is an independent implementation of that layout:
//
//   payload = slice*            each slice = 0x210-byte header + n * 0x4000 bytes of AES-128-OFB data
//   slice header (XOR-masked) = 4 x (c1[64 bytes], c2[64 bytes]) ElGamal-wrapped key/iv words
//                               + u64 CityHash64 of the slice plaintext + u64 tag
//
// Slice sizes, the header mask and the AES key/iv all come from one SplitMix64-style stream
// seeded with a per-game constant and the (inverted) Steam account id.

import { createCipheriv, randomBytes } from 'node:crypto';
import { cityHash64 } from './hash.js';

const M64 = (1n << 64n) - 1n;

const SLICE_UNIT = 0x4000;
const SLICE_HEADER = 0x210;
const RSA_SIZE = 0x80;

const le = (hex) => BigInt('0x' + Buffer.from(hex, 'hex').reverse().toString('hex'));

// ElGamal group parameters (little-endian in the game binary).
const P = le('f33b6fb972a0b72515e45c391829e182ad8a9bdc0a64d3444d79c810ab863717');
const Q = le('f99db75c39d0db920a72ae1c8c9470c156c54d6e05b269a2a63c648855c39b0b');
const G = le('e66f544afcce68c5ef07b9a07b277585344a1db61376e831f73b9fbd5f44f715');
const EPHEMERAL = 0x14n;

// RSA modulus for the footer block (little-endian in the game binary).
const RSA_N = le(
  '4fa448364f5b3507e945075cc21994bdedef96962c74d53159d50a5c62ed5086' +
  '4885ddfe79705dfad0b638220ca2299fccae152164590cc89d33698452a8f641' +
  '6107a6952f126bb21ee3e332d2285db728c09bfa8cbd4c3b13b358b9838dea7c' +
  'f39dc12e37066a09cf7809a0d0ea06c3bbaa14776400f403f863ed83b5bdd3c2',
);
const RSA_E = 65537n;

export const GAMES = {
  dd2: {
    name: "Dragon's Dogma 2",
    appId: 2054970,
    seed: 0x5ec646997d69ae1bn,
    // DD2 keys saves with the 32-bit Steam account id (the userdata folder name).
    userKey: (steamId) => ~(BigInt(steamId) & 0xffffffffn) & M64,
  },
};

function mix(state) {
  let z = (state + 0x9e3779b97f4a7c15n) & M64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  return z ^ (z >> 31n);
}

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

function readLE(buf, offset, length) {
  let v = 0n;
  for (let i = length - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[offset + i]);
  return v;
}

function writeLE(buf, offset, length, value) {
  for (let i = 0; i < length; i++) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}

/** Slice capacities (in SLICE_UNIT units) for a payload, plus the stream state after planning. */
function planSlices(seed, length) {
  const potential = Math.ceil(length / SLICE_UNIT);
  let state = seed;
  const all = [];
  for (let i = 0; i < potential; i++) {
    all.push(Number(state & 7n) + 1);
    state = mix(state);
  }
  const slices = [];
  let left = length;
  for (const units of all) {
    slices.push(units);
    if (left <= units * SLICE_UNIT) break;
    left -= units * SLICE_UNIT;
  }
  return { slices, state };
}

function aesOfb(key, iv, data) {
  const cipher = createCipheriv('aes-128-ofb', key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export class MandarinError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {Buffer} payload   slices followed by the 0x80-byte RSA block
 * @param {number} length    plaintext length recorded in the file footer
 * @param {bigint} userKey   GAMES[x].userKey(steamId)
 */
export function decrypt(payload, length, userKey, game = GAMES.dd2) {
  const plan = planSlices(game.seed, length);
  let state = (plan.state + userKey) & M64;
  const shared = (c1) => modPow(c1, userKey, P);

  const out = Buffer.alloc(length);
  const tags = [];
  let src = 0;
  let dst = 0;
  for (const [index, units] of plan.slices.entries()) {
    const size = units * SLICE_UNIT;
    if (src + SLICE_HEADER + size > payload.length) {
      throw new MandarinError('truncated', 'Save file is shorter than its slice table says.');
    }
    const key = Buffer.alloc(16);
    const iv = Buffer.alloc(16);
    for (let j = 0; j < 16; j++) {
      state = mix(state);
      key[j] = Number(state & 0xffn);
      iv[j] = Number((state >> 8n) & 0xffn);
    }
    const header = Buffer.from(payload.subarray(src, src + SLICE_HEADER));
    for (let j = 0; j < SLICE_HEADER; j++) {
      state = mix(state);
      header[j] ^= Number(state & 0xffn);
    }

    // The header carries the same key/iv wrapped for this account. A mismatch means the
    // save belongs to a different Steam account.
    const wrapped = Buffer.alloc(32);
    for (let w = 0; w < 4; w++) {
      const c1 = readLE(header, w * 128, 64);
      const c2 = readLE(header, w * 128 + 64, 64);
      const s = shared(c1);
      writeLE(wrapped, w * 8, 8, s === 0n ? 0n : (c2 / s) & M64);
    }
    if (!wrapped.subarray(0, 16).equals(key) || !wrapped.subarray(16).equals(iv)) {
      throw new MandarinError('wrong-account', 'This save was written by a different Steam account.');
    }

    const plain = aesOfb(key, iv, payload.subarray(src + SLICE_HEADER, src + SLICE_HEADER + size));
    const take = Math.min(size, length - dst);
    const checksum = header.readBigUInt64LE(0x200);
    if (cityHash64(plain.subarray(0, take)) !== checksum) {
      throw new MandarinError('checksum', `Slice ${index} failed its checksum; the save is damaged.`);
    }
    tags.push({ tag: header.readBigUInt64LE(0x208), padding: plain.subarray(take) });
    plain.copy(out, dst, 0, take);
    src += SLICE_HEADER + size;
    dst += take;
  }
  return { data: out, slices: plan.slices, tags, consumed: src };
}

/** Returns the encrypted slices followed by the RSA block. */
export function encrypt(data, userKey, game = GAMES.dd2) {
  const plan = planSlices(game.seed, data.length);
  let state = (plan.state + userKey) & M64;

  const c1 = modPow(G, EPHEMERAL % Q, P);
  const personal = modPow(modPow(G, userKey % Q, P), EPHEMERAL, P);

  const total = plan.slices.reduce((n, units) => n + SLICE_HEADER + units * SLICE_UNIT, 0);
  const out = Buffer.alloc(total + RSA_SIZE);
  let src = 0;
  let dst = 0;
  for (const units of plan.slices) {
    const size = units * SLICE_UNIT;
    const remaining = data.length - src;
    const take = Math.min(size, remaining);

    const key = Buffer.alloc(16);
    const iv = Buffer.alloc(16);
    for (let j = 0; j < 16; j++) {
      state = mix(state);
      key[j] = Number(state & 0xffn);
      iv[j] = Number((state >> 8n) & 0xffn);
    }

    const header = Buffer.alloc(SLICE_HEADER);
    const keyIv = Buffer.concat([key, iv]);
    for (let w = 0; w < 4; w++) {
      writeLE(header, w * 128, 64, c1);
      writeLE(header, w * 128 + 64, 64, personal * keyIv.readBigUInt64LE(w * 8));
    }
    const plain = Buffer.alloc(size);
    data.copy(plain, 0, src, src + take);
    header.writeBigUInt64LE(cityHash64(plain.subarray(0, take)), 0x200);
    header.writeBigUInt64LE(mix(BigInt(remaining)), 0x208);
    for (let j = 0; j < SLICE_HEADER; j++) {
      state = mix(state);
      header[j] ^= Number(state & 0xffn);
    }

    header.copy(out, dst);
    aesOfb(key, iv, plain).copy(out, dst + SLICE_HEADER);
    src += take;
    dst += SLICE_HEADER + size;
  }
  rsaBlock(userKey).copy(out, dst);
  return out;
}

/**
 * Footer block: RSA-encrypted 32-byte value whose first 8 bytes are the user key. The game
 * writes different remaining bytes on every save and only holds the public key, so the block
 * cannot be checked on load; random filler matches what the game produces.
 */
export function rsaBlock(userKey) {
  const message = randomBytes(32);
  message.writeBigUInt64LE(userKey, 0);
  const block = Buffer.alloc(RSA_SIZE);
  writeLE(block, 0, RSA_SIZE, modPow(readLE(message, 0, 32), RSA_E, RSA_N));
  return block;
}

export const SIZES = { SLICE_UNIT, SLICE_HEADER, RSA_SIZE };
