// Works out which piece of which game texture is each item's icon, and lays those pieces out
// on one sprite sheet. The pixels themselves are decoded by the browser (the atlases are BC7,
// which a GPU decodes natively); this module only reads tables and hands over raw textures.
//
//   item data (*.user.N)  item id -> icon number
//   icon number           sequence * 1000 + pattern (sequence 10 is unused, see below)
//   sprite map (*.uvs.N)  (sequence, pattern) -> rectangle of a texture

import { parseTex } from './tex.js';
import { loadDump } from './typedump.js';
import { parseUvs } from './uvs.js';

const ITEM_DATA = 'natives/stm/appsystem/item/itemdata';
const PARAM_FILES = ['itemdata', 'exitemdata', 'itemweapondata', 'exitemweapondata', 'itemarmordata', 'exitemarmordata'];
const DLC_SLOTS = 40;
const SPRITE_MAP = 'natives/stm/gui/ui01/common/item/c00/uvs_ui01c00.uvs';
// File format versions seen so far, newest first; they go up with game updates.
const USER_VERSIONS = [3, 4, 2];
const UVS_VERSIONS = [8, 9, 7];
const TEX_VERSIONS = [251211553, 760230703];

// Offsets inside every item parameter record; the base fields come first for all item kinds.
const ID_OFFSET = 0;
const ICON_OFFSET = 24;
const MIN_RECORD = 28;
const PATTERNS_PER_SEQUENCE = 1000;
// Icon numbers count a sequence 10 that holds no icons, and this sprite map has no entry for
// it: sequence 11 of the numbering is the map's 10th, and so on (checked against the atlases).
const UNUSED_SEQUENCE = 10;

/** Index into the sprite map's sequences for an icon number, or -1 when it has no picture. */
function sequenceOf(icon) {
  const sequence = Math.floor(icon / PATTERNS_PER_SEQUENCE);
  if (sequence === UNUSED_SEQUENCE) return -1;
  return sequence > UNUSED_SEQUENCE ? sequence - 1 : sequence;
}

/** Edge of one icon on the sheet, in pixels: half the atlas cell, so downscaling is exact. */
export const SHEET_CELL = 78;

export class IconError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function extractVersioned(files, base, versions) {
  for (const version of versions) {
    const data = files.extract(`${base}.${version}`);
    if (data) return data;
  }
  return null;
}

/**
 * Extent of one record laid out by the type dump's field list, starting at `pos` (relative to
 * the RSZ block, which itself starts `base` bytes into the file; fields align to file offsets).
 */
function walkRecord(block, base, pos, fields) {
  const alignUp = (offset, n) => Math.ceil((offset + base) / n) * n - base;
  let start = null;
  for (const field of fields) {
    const text = field.type === 'String' || field.type === 'Resource';
    if (field.array) {
      pos = alignUp(pos, 4);
      const count = block.readInt32LE(pos);
      pos = alignUp(pos + 4, field.align) + count * field.size;
    } else {
      pos = alignUp(pos, text ? 4 : field.align);
      start ??= pos;
      pos += text ? 4 + block.readInt32LE(pos) * 2 : field.size;
    }
  }
  return { start: start ?? pos, end: pos };
}

/**
 * Item id -> icon number from one item data file. A file is a list of parameter records
 * followed by one container that references them all. Records are found either by their
 * common size or, when they contain strings of varying length, by walking the type layout.
 * @param {Record<string, {fields: object[]}> | null} layouts  type dump, by type hash
 */
function readItemIcons(file, layouts) {
  const at = file.indexOf(Buffer.from('RSZ\0', 'latin1'));
  if (at < 0) return [];
  const block = file.subarray(at);
  const instanceCount = block.readInt32LE(12);
  const instanceOffset = Number(block.readBigUInt64LE(24));
  const dataOffset = Number(block.readBigUInt64LE(32));
  const count = instanceCount - 2; // minus the null instance and the container
  if (count < 1) return [];

  const starts = [];
  const stride = (block.length - dataOffset - 4 - 4 * count) / count;
  if (Number.isInteger(stride) && stride >= MIN_RECORD) {
    for (let i = 0; i < count; i++) starts.push(dataOffset + i * stride);
  } else {
    const fields = layouts?.[block.readUInt32LE(instanceOffset + 8).toString(16)]?.fields;
    if (!fields) return [];
    let pos = dataOffset;
    try {
      for (let i = 0; i < count; i++) {
        const record = walkRecord(block, at, pos, fields);
        starts.push(record.start);
        pos = record.end;
      }
      // The container's reference list must start exactly where the last record ended.
      pos = Math.ceil((pos + at) / 4) * 4 - at;
      if (block.readInt32LE(pos) !== count || block.readInt32LE(pos + 4) !== 1) return [];
    } catch {
      return [];
    }
  }
  return starts.map((start) => [block.readInt32LE(start + ID_OFFSET), block.readUInt16LE(start + ICON_OFFSET)]);
}

/**
 * Icon number of every item in the game's item data.
 * @param {import('./pak.js').GameFiles} files
 * @param {string} layoutsPath  the RSZ type dump; only needed for records of varying size
 * @returns {Map<number, number>}
 */
export function readIconNumbers(files, layoutsPath) {
  let layouts = null;
  const loadLayouts = () => {
    if (layouts === null) {
      try {
        layouts = loadDump(layoutsPath);
      } catch {
        layouts = {};
      }
    }
    return layouts;
  };
  const sources = PARAM_FILES.map((name) => `${ITEM_DATA}/${name}.user`);
  for (let i = 1; i <= DLC_SLOTS; i++) {
    const id = String(i).padStart(4, '0');
    sources.push(`natives/stm/appdata/extracontents/contents_${id}/itemdata_contents_${id}.user`);
  }
  const iconOf = new Map();
  for (const base of sources) {
    const file = extractVersioned(files, base, USER_VERSIONS);
    if (!file) continue;
    let pairs = readItemIcons(file, null);
    if (!pairs.length) pairs = readItemIcons(file, loadLayouts());
    for (const [id, icon] of pairs) iconOf.set(id, icon);
  }
  return iconOf;
}

/**
 * @param {import('./pak.js').GameFiles} files
 * @param {string} layoutsPath  the RSZ type dump; only needed for records of varying size
 * @returns {{sheet: object, textures: {width: number, height: number, format: string, data: Buffer}[]}}
 *          sheet: { cell, columns, rows, sprites: [texture, x, y, size][], items: {id: spriteIndex} }
 */
export function planIcons(files, layoutsPath) {
  const map = extractVersioned(files, SPRITE_MAP, UVS_VERSIONS);
  if (!map) throw new IconError('no-icons', 'The item icon sprite map was not found in the game files.');
  const { textures: texturePaths, sequences } = parseUvs(map);
  const iconOf = readIconNumbers(files, layoutsPath);

  const textures = [];
  const textureIndex = new Map(); // index in the sprite map -> index in `textures`
  const useTexture = (index) => {
    if (!textureIndex.has(index)) {
      const path = `natives/stm/${texturePaths[index].toLowerCase()}`;
      const file = extractVersioned(files, path, TEX_VERSIONS);
      textureIndex.set(index, file ? textures.push(parseTex(file)) - 1 : -1);
    }
    return textureIndex.get(index);
  };

  const sprites = [];
  const spriteIndex = new Map(); // icon number -> index in `sprites`
  const items = {};
  for (const [id, icon] of iconOf) {
    if (!spriteIndex.has(icon)) {
      const pattern = sequences[sequenceOf(icon)]?.[icon % PATTERNS_PER_SEQUENCE];
      const texture = pattern ? useTexture(pattern.texture) : -1;
      if (texture < 0) {
        spriteIndex.set(icon, -1);
      } else {
        const { width, height } = textures[texture];
        const x = Math.round(pattern.left * width);
        const y = Math.round(pattern.top * height);
        const size = Math.round((pattern.right - pattern.left) * width);
        spriteIndex.set(icon, sprites.push([texture, x, y, size]) - 1);
      }
    }
    if (spriteIndex.get(icon) >= 0) items[id] = spriteIndex.get(icon);
  }
  if (!sprites.length) throw new IconError('no-icons', 'No item icons were found in the game files.');

  const columns = Math.ceil(Math.sqrt(sprites.length));
  const rows = Math.ceil(sprites.length / columns);
  return { sheet: { cell: SHEET_CELL, columns, rows, sprites, items }, textures };
}
