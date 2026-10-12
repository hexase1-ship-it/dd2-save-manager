// Reader for the game's message files (*.msg.NN, magic "GMSG"): localized strings keyed by
// GUID and by entry name. Layout as documented by dtlnor's REMSG_Converter.
//
//   header   u32 version | "GMSG" | u64 headerOffset | u32 entryCount | u32 attributeCount
//            | u32 languageCount | u32 pad | u64 dataOffset | u64 unknown | u64 languageOffset
//            | u64 attributeOffset | u64 attributeNameOffset | u64 entryOffset[entryCount]
//   entry    guid[16] | u32 crc | u32 nameHash | u64 nameOffset | u64 attributeOffset
//            | u64 textOffset[languageCount]
//   strings  UTF-16, null-terminated, in a pool at dataOffset that is XOR-chained with a fixed key

const POOL_KEY = [0xcf, 0xce, 0xfb, 0xf8, 0xec, 0x0a, 0x33, 0x66, 0x93, 0xa9, 0x1d, 0x93, 0x50, 0x39, 0x5f, 0x09];

/** via.Language values of the columns the editor cares about. */
export const LANGUAGE = { ja: 0, en: 1, ko: 11 };
/** The languages this program's own screens come in, by the game's number for each. */
export const LANGUAGES = { en: 1, ko: 11, ja: 0, zh: 13, es: 5, fr: 2 };

export class MsgError extends Error {}

function formatGuid(b) {
  const hex = (from, to, reverse) => {
    const part = [...b.subarray(from, to)];
    return (reverse ? part.reverse() : part).map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  return `${hex(0, 4, true)}-${hex(4, 6, true)}-${hex(6, 8, true)}-${hex(8, 10)}-${hex(10, 16)}`;
}

/**
 * @returns {{version: number, languages: number[], entries: {guid: string, name: string, text: Record<number, string>}[]}}
 *          text is keyed by via.Language value
 */
export function parseMsg(file) {
  if (file.length < 0x48 || file.toString('latin1', 4, 8) !== 'GMSG') throw new MsgError('Not a message file.');
  const version = file.readUInt32LE(0);
  const entryCount = file.readUInt32LE(0x10);
  const languageCount = file.readUInt32LE(0x18);
  const dataOffset = Number(file.readBigUInt64LE(0x20));
  const languageOffset = Number(file.readBigUInt64LE(0x30));

  const pool = Buffer.from(file.subarray(dataOffset));
  let previous = 0;
  for (let i = 0; i < pool.length; i++) {
    const current = pool[i];
    pool[i] = current ^ previous ^ POOL_KEY[i & 0xf];
    previous = current;
  }
  const stringAt = (offset) => {
    let end = offset - dataOffset;
    if (end < 0 || end >= pool.length) return '';
    const start = end;
    while (end + 1 < pool.length && (pool[end] !== 0 || pool[end + 1] !== 0)) end += 2;
    return pool.toString('utf16le', start, end);
  };

  const languages = [];
  for (let i = 0; i < languageCount; i++) languages.push(file.readInt32LE(languageOffset + i * 4));

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const at = Number(file.readBigUInt64LE(0x48 + i * 8));
    const text = {};
    for (let l = 0; l < languageCount; l++) text[languages[l]] = stringAt(Number(file.readBigUInt64LE(at + 40 + l * 8)));
    entries.push({
      guid: formatGuid(file.subarray(at, at + 16)),
      name: stringAt(Number(file.readBigUInt64LE(at + 24))),
      text,
    });
  }
  return { version, languages, entries };
}
