// Reader for the game's textures (*.tex.NN, magic "TEX\0"): just enough to hand the top mip
// level to something that can decode it. The UI atlases are block-compressed (BC7), which the
// browser's GPU decodes; nothing here looks inside the blocks.
//
//   0x00 "TEX\0" | u32 version | u16 width | u16 height | u16 depth | u8 | u8 | u32 format ...
//   0x28 mip 0:  u64 offset | u32 rowPitch | u32 size
//
// Rows of blocks are stored rowPitch bytes apart, which can be more than the row needs.

/** DXGI formats the item icon atlases are known to use, by block layout. */
const FORMATS = {
  28: { name: 'rgba8', blockBytes: 4, blockSize: 1 },
  29: { name: 'rgba8', blockBytes: 4, blockSize: 1 },
  71: { name: 'bc1', blockBytes: 8, blockSize: 4 },
  72: { name: 'bc1', blockBytes: 8, blockSize: 4 },
  77: { name: 'bc3', blockBytes: 16, blockSize: 4 },
  78: { name: 'bc3', blockBytes: 16, blockSize: 4 },
  98: { name: 'bc7', blockBytes: 16, blockSize: 4 },
  99: { name: 'bc7', blockBytes: 16, blockSize: 4 },
};
const MIP_HEADER = 0x28;

export class TexError extends Error {}

/** @returns {{width: number, height: number, format: string, data: Buffer}} data is tightly packed */
export function parseTex(file) {
  if (file.length < MIP_HEADER + 16 || file.toString('latin1', 0, 4) !== 'TEX\0') throw new TexError('Not a texture file.');
  const width = file.readUInt16LE(8);
  const height = file.readUInt16LE(10);
  const format = FORMATS[file.readUInt32LE(0x10)];
  if (!format) throw new TexError(`Unsupported texture format ${file.readUInt32LE(0x10)}.`);

  const offset = Number(file.readBigUInt64LE(MIP_HEADER));
  const pitch = file.readUInt32LE(MIP_HEADER + 8);
  const size = file.readUInt32LE(MIP_HEADER + 12);
  const rowBytes = Math.ceil(width / format.blockSize) * format.blockBytes;
  const rows = Math.ceil(height / format.blockSize);
  if (pitch < rowBytes || size < pitch * (rows - 1) + rowBytes || offset + size > file.length) {
    throw new TexError('Texture layout is not what this reader expects.');
  }
  const data = Buffer.alloc(rowBytes * rows);
  for (let row = 0; row < rows; row++) file.copy(data, row * rowBytes, offset + row * pitch, offset + row * pitch + rowBytes);
  return { width, height, format: format.name, data };
}
