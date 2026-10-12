// Hash functions the RE Engine save container relies on.
//   murmur3_32  - whole-file signature and field/type name hashes
//   cityHash64  - per-slice plaintext checksum (CityHash v1.1)

const M64 = (1n << 64n) - 1n;

export function murmur3_32(buf, seed = 0xffffffff) {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;
  const blocks = buf.length >>> 2;
  for (let i = 0; i < blocks; i++) {
    let k = buf.readUInt32LE(i * 4);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  const tail = blocks * 4;
  let k = 0;
  switch (buf.length & 3) {
    case 3: k ^= buf[tail + 2] << 16; // fallthrough
    case 2: k ^= buf[tail + 1] << 8; // fallthrough
    case 1:
      k ^= buf[tail];
      k = Math.imul(k, c1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, c2);
      h ^= k;
  }
  h ^= buf.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash the engine uses for type and field names. */
export const hashName = (name) => murmur3_32(Buffer.from(name, 'utf8'));

const K0 = 0xc3a5c85c97cb3127n;
const K1 = 0xb492b66fbe98f273n;
const K2 = 0x9ae16a3b2f90404fn;
const KMUL = 0x9ddfea08eb382d69n;

const rotr = (v, s) => ((v >> s) | (v << (64n - s))) & M64;
const shiftMix = (v) => v ^ (v >> 47n);
const f64 = (b, o) => b.readBigUInt64LE(o);
const f32 = (b, o) => BigInt(b.readUInt32LE(o));
const bswap = (v) => {
  let r = 0n;
  for (let i = 0n; i < 8n; i++) r = (r << 8n) | ((v >> (8n * i)) & 0xffn);
  return r;
};

function hashLen16(u, v, mul = KMUL) {
  let a = ((u ^ v) * mul) & M64;
  a ^= a >> 47n;
  let b = ((v ^ a) * mul) & M64;
  b ^= b >> 47n;
  return (b * mul) & M64;
}

function hashLen0to16(s, len) {
  const L = BigInt(len);
  if (len >= 8) {
    const mul = (K2 + L * 2n) & M64;
    const a = (f64(s, 0) + K2) & M64;
    const b = f64(s, len - 8);
    const c = (rotr(b, 37n) * mul + a) & M64;
    const d = ((rotr(a, 25n) + b) * mul) & M64;
    return hashLen16(c, d, mul);
  }
  if (len >= 4) {
    const mul = (K2 + L * 2n) & M64;
    const a = f32(s, 0);
    return hashLen16((L + (a << 3n)) & M64, f32(s, len - 4), mul);
  }
  if (len > 0) {
    const a = s[0];
    const b = s[len >> 1];
    const c = s[len - 1];
    const y = BigInt((a + (b << 8)) >>> 0);
    const z = BigInt((len + (c << 2)) >>> 0);
    return (shiftMix(((y * K2) & M64) ^ ((z * K0) & M64)) * K2) & M64;
  }
  return K2;
}

function hashLen17to32(s, len) {
  const mul = (K2 + BigInt(len) * 2n) & M64;
  const a = (f64(s, 0) * K1) & M64;
  const b = f64(s, 8);
  const c = (f64(s, len - 8) * mul) & M64;
  const d = (f64(s, len - 16) * K2) & M64;
  return hashLen16(
    (rotr((a + b) & M64, 43n) + rotr(c, 30n) + d) & M64,
    (a + rotr((b + K2) & M64, 18n) + c) & M64,
    mul,
  );
}

function hashLen33to64(s, len) {
  const mul = (K2 + BigInt(len) * 2n) & M64;
  let a = (f64(s, 0) * K2) & M64;
  let b = f64(s, 8);
  const c = f64(s, len - 24);
  const d = f64(s, len - 32);
  const e = (f64(s, 16) * K2) & M64;
  const f = (f64(s, 24) * 9n) & M64;
  const g = f64(s, len - 8);
  const h = (f64(s, len - 16) * mul) & M64;
  const u = (rotr((a + g) & M64, 43n) + ((rotr(b, 30n) + c) * 9n)) & M64;
  const v = ((((a + g) & M64) ^ d) + f + 1n) & M64;
  const w = (bswap(((u + v) * mul) & M64) + h) & M64;
  const x = (rotr((e + f) & M64, 42n) + c) & M64;
  const y = ((bswap(((v + w) * mul) & M64) + g) * mul) & M64;
  const z = (e + f + c) & M64;
  a = (bswap(((x + z) * mul + y) & M64) + b) & M64;
  b = (shiftMix(((z + a) * mul + d + h) & M64) * mul) & M64;
  return (b + x) & M64;
}

function weakHash32(s, o, a, b) {
  const w = f64(s, o);
  const x = f64(s, o + 8);
  const y = f64(s, o + 16);
  const z = f64(s, o + 24);
  a = (a + w) & M64;
  b = rotr((b + a + z) & M64, 21n);
  const c = a;
  a = (a + x + y) & M64;
  b = (b + rotr(a, 44n)) & M64;
  return [(a + z) & M64, (b + c) & M64];
}

export function cityHash64(s) {
  const len = s.length;
  if (len <= 16) return hashLen0to16(s, len);
  if (len <= 32) return hashLen17to32(s, len);
  if (len <= 64) return hashLen33to64(s, len);

  const L = BigInt(len);
  let x = f64(s, len - 40);
  let y = (f64(s, len - 16) + f64(s, len - 56)) & M64;
  let z = hashLen16((f64(s, len - 48) + L) & M64, f64(s, len - 24));
  let v = weakHash32(s, len - 64, L, z);
  let w = weakHash32(s, len - 32, (y + K1) & M64, x);
  x = (x * K1 + f64(s, 0)) & M64;

  let o = 0;
  let remaining = (len - 1) & ~63;
  do {
    x = (rotr((x + y + v[0] + f64(s, o + 8)) & M64, 37n) * K1) & M64;
    y = (rotr((y + v[1] + f64(s, o + 48)) & M64, 42n) * K1) & M64;
    x ^= w[1];
    y = (y + v[0] + f64(s, o + 40)) & M64;
    z = (rotr((z + w[0]) & M64, 33n) * K1) & M64;
    v = weakHash32(s, o, (v[1] * K1) & M64, (x + w[0]) & M64);
    w = weakHash32(s, o + 32, (z + w[1]) & M64, (y + f64(s, o + 16)) & M64);
    [z, x] = [x, z];
    o += 64;
    remaining -= 64;
  } while (remaining !== 0);

  return hashLen16(
    (hashLen16(v[0], w[0]) + ((shiftMix(y) * K1) & M64) + z) & M64,
    (hashLen16(v[1], w[1]) + x) & M64,
  );
}
