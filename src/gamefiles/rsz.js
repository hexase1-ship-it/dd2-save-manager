// Reader for the game's data tables (*.user.N): a list of typed records ("instances") that
// reference each other by index. The file names only the type of each record; how a type is
// laid out comes from the RSZ type dump (data/dd2/rszdd2.json).
//
//   "USR\0" ... "RSZ\0" | u32 version | i32 objectCount | i32 instanceCount | i32 userdataCount | i32
//                       | u64 instanceOffset | u64 dataOffset | u64 userdataOffset
//                       | i32 rootInstance[objectCount]
//   @instanceOffset     (u32 typeHash, u32 crc) per instance; instance 0 is null
//   @dataOffset         the records, in instance order, each field aligned within the file
//
// The dump can be older than the game. Every read is bounds-checked and the caller is told
// how much of the data was consumed, so a layout that no longer fits shows up as a mismatch
// instead of as quietly wrong values.

export class RszError extends Error {}

const USERDATA_INFO_SIZE = 16; // i32 instance | u32 typeHash | u64 pathOffset


function formatGuid(b) {
  const hex = (from, to, reverse) => {
    const part = [...b.subarray(from, to)];
    return (reverse ? part.reverse() : part).map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  return `${hex(0, 4, true)}-${hex(4, 6, true)}-${hex(6, 8, true)}-${hex(8, 10)}-${hex(10, 16)}`;
}

const floats = (count) => (b, o) => Array.from({ length: count }, (_, i) => b.readFloatLE(o + i * 4));

const DECODERS = {
  Bool: (b, o) => b[o] !== 0,
  S8: (b, o) => b.readInt8(o),
  U8: (b, o) => b[o],
  S16: (b, o) => b.readInt16LE(o),
  U16: (b, o) => b.readUInt16LE(o),
  S32: (b, o) => b.readInt32LE(o),
  U32: (b, o) => b.readUInt32LE(o),
  S64: (b, o) => b.readBigInt64LE(o),
  U64: (b, o) => b.readBigUInt64LE(o),
  F32: (b, o) => b.readFloatLE(o),
  F64: (b, o) => b.readDoubleLE(o),
  Object: (b, o) => ({ ref: b.readInt32LE(o) }),
  UserData: (b, o) => ({ userdata: b.readInt32LE(o) }),
  Guid: (b, o) => formatGuid(b.subarray(o, o + 16)),
  Vec2: floats(2),
  Vec3: floats(3),
  Vec4: floats(4),
  Quaternion: floats(4),
  Range: floats(2),
  Position: (b, o) => [0, 8, 16].map((i) => b.readDoubleLE(o + i)),
};

const isText = (field) => field.type === 'String' || field.type === 'Resource';

function readValue(block, pos, field) {
  if (isText(field)) {
    const count = block.readInt32LE(pos);
    if (count < 0 || pos + 4 + count * 2 > block.length) throw new RszError('String runs past the end of the data.');
    // The stored length counts the terminating null.
    return { value: block.toString('utf16le', pos + 4, pos + 4 + Math.max(0, count - 1) * 2), end: pos + 4 + count * 2 };
  }
  if (pos + field.size > block.length) throw new RszError('Field runs past the end of the data.');
  const decode = DECODERS[field.type];
  return { value: decode ? decode(block, pos) : Buffer.from(block.subarray(pos, pos + field.size)), end: pos + field.size };
}

/**
 * @param {Buffer} file
 * @param {Record<string, {name: string, fields: object[]}>} layouts  type dump, keyed by type hash in hex
 * @returns {{instances: ({type: string, fields: Record<string, any>} | null)[], roots: number[], unread: number}}
 *          unread: bytes of record data left over; 0 when every layout fitted exactly
 */
export function parseRsz(file, layouts) {
  const at = file.indexOf(Buffer.from('RSZ\0', 'latin1'));
  if (at < 0) throw new RszError('No RSZ block in this file.');
  const block = file.subarray(at);
  const objectCount = block.readInt32LE(8);
  const instanceCount = block.readInt32LE(12);
  const instanceOffset = Number(block.readBigUInt64LE(24));
  const dataOffset = Number(block.readBigUInt64LE(32));

  const roots = [];
  for (let i = 0; i < objectCount; i++) roots.push(block.readInt32LE(48 + i * 4));

  // Instances that only point at another file carry no data here.
  const external = new Set();
  const userdataCount = block.readInt32LE(16);
  const userdataOffset = Number(block.readBigUInt64LE(40));
  for (let i = 0; i < userdataCount; i++) external.add(block.readInt32LE(userdataOffset + i * USERDATA_INFO_SIZE));

  // Fields are aligned to their offset in the file, and the RSZ block need not start on an
  // aligned offset itself.
  const alignUp = (pos, n) => Math.ceil((pos + at) / n) * n - at;

  const instances = [null];
  let pos = dataOffset;
  for (let i = 1; i < instanceCount; i++) {
    const hash = block.readUInt32LE(instanceOffset + i * 8);
    const layout = layouts[hash.toString(16)];
    if (external.has(i)) {
      instances.push({ type: layout?.name ?? hash.toString(16), external: true, fields: {} });
      continue;
    }
    if (!layout) throw new RszError(`Type ${hash.toString(16)} is not in the type dump.`);
    const fields = {};
    for (const field of layout.fields) {
      if (field.array) {
        pos = alignUp(pos, 4);
        const count = block.readInt32LE(pos);
        pos += 4;
        if (count < 0 || count > block.length) throw new RszError(`Implausible array length in ${layout.name}.`);
        const items = [];
        for (let n = 0; n < count; n++) {
          pos = alignUp(pos, isText(field) ? 4 : field.align);
          const read = readValue(block, pos, field);
          items.push(read.value);
          pos = read.end;
        }
        fields[field.name] = items;
      } else {
        pos = alignUp(pos, isText(field) ? 4 : field.align);
        const read = readValue(block, pos, field);
        fields[field.name] = read.value;
        pos = read.end;
      }
    }
    instances.push({ type: layout.name, fields });
  }
  return { instances, roots, unread: block.length - pos };
}
