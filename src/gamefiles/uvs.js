// Reader for the game's sprite maps (*.uvs.N, magic ".SVU"): which rectangle of which texture
// a (sequence, pattern) pair shows.
//
//   header    ".SVU" | i32 textureCount | i32 sequenceCount | i32 patternCount | u64 0
//             | u64 textureOffset | u64 sequenceOffset | u64 patternOffset | u64 stringOffset
//   texture   u64 | u64 pathOffset (in UTF-16 characters) | u64 x 3        (40 bytes)
//   sequence  i32 patternCount | i32 firstPattern                           (8 bytes)
//   pattern   u64 | f32 left | f32 top | f32 right | f32 bottom | i32 texture | i32   (32 bytes)

const TEXTURE_SIZE = 40;
const PATTERN_SIZE = 32;

export class UvsError extends Error {}

/**
 * @returns {{textures: string[], sequences: {left: number, top: number, right: number, bottom: number, texture: number}[][]}}
 *          rectangles are fractions of the texture size
 */
export function parseUvs(file) {
  if (file.length < 0x38 || file.toString('latin1', 0, 4) !== '.SVU') throw new UvsError('Not a sprite map file.');
  const textureCount = file.readInt32LE(4);
  const sequenceCount = file.readInt32LE(8);
  const [textureOffset, sequenceOffset, patternOffset, stringOffset] = [0x18, 0x20, 0x28, 0x30].map((o) => Number(file.readBigUInt64LE(o)));

  const textures = [];
  for (let i = 0; i < textureCount; i++) {
    const start = stringOffset + Number(file.readBigUInt64LE(textureOffset + i * TEXTURE_SIZE + 8)) * 2;
    let end = start;
    while (end + 1 < file.length && file.readUInt16LE(end) !== 0) end += 2;
    textures.push(file.toString('utf16le', start, end));
  }
  const sequences = [];
  for (let i = 0; i < sequenceCount; i++) {
    const count = file.readInt32LE(sequenceOffset + i * 8);
    const first = file.readInt32LE(sequenceOffset + i * 8 + 4);
    const patterns = [];
    for (let p = 0; p < count; p++) {
      const at = patternOffset + (first + p) * PATTERN_SIZE;
      patterns.push({
        left: file.readFloatLE(at + 8),
        top: file.readFloatLE(at + 12),
        right: file.readFloatLE(at + 16),
        bottom: file.readFloatLE(at + 20),
        texture: file.readInt32LE(at + 24),
      });
    }
    sequences.push(patterns);
  }
  return { textures, sequences };
}
