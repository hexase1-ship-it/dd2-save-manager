// Development aid: reads names and types out of the game's own executable, for what the type
// dump in data/dd2 is too old to know. Read-only.
//
//   node tools/exe-types.mjs names <hash>...
//       Finds the names behind hashes that tools/dump-tree.mjs prints as #xxxxxxxx, by hashing
//       every name-like string in DD2.exe. Field names are found this way; a class name is not,
//       because the executable keeps namespace and name apart (use "type #hash" for those).
//
//   node tools/exe-types.mjs type <full type name | #hash>...
//       Prints a type's fields with their types, and for an enum the number of each member,
//       from the type database ("TDB") inside DD2.exe.
//
// The type database layout below was worked out for version 83 of it (the game as of 2026-10):
// the table positions and counts come from its header, the record sizes from the gaps between
// tables, the bit fields by checking against types whose contents were already known. A later
// game version may change it; the tool says so instead of printing nonsense.

import fs from 'node:fs';
import path from 'node:path';
import { hashName } from '../src/core/hash.js';
import { findGame, findSteamRoot } from '../src/steam.js';

const [mode, ...wanted] = process.argv.slice(2);
if (!['names', 'type'].includes(mode) || !wanted.length) {
  console.error('usage: node tools/exe-types.mjs names <hash>...\n       node tools/exe-types.mjs type <full type name | #hash>...');
  process.exit(2);
}
const steamRoot = findSteamRoot();
const game = steamRoot && findGame(steamRoot);
if (!game) throw new Error('The game is not installed on this PC.');
const exe = fs.readFileSync(path.join(game.dir, 'DD2.exe'));
const asHash = (text) => parseInt(text.replace(/^#/, ''), 16) >>> 0;

if (mode === 'names') {
  const targets = new Map(wanted.map((text) => [asHash(text), []]));
  const text = exe.latin1Slice();
  for (const [name] of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,63}/g)) {
    const found = targets.get(hashName(name) >>> 0);
    if (found && !found.includes(name)) found.push(name);
  }
  for (const [hash, names] of targets) console.log(`#${hash.toString(16).padStart(8, '0')} = ${names.join(' / ') || '(not found)'}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------
// the type database

const TDB_VERSION = 83;
const base = (() => {
  for (let at = exe.indexOf('TDB\0', 0, 'latin1'); at >= 0; at = exe.indexOf('TDB\0', at + 1, 'latin1')) {
    const version = exe.readUInt32LE(at + 4);
    if (version > 40 && version < 200) return at;
  }
  throw new Error('No type database was found in DD2.exe.');
})();
const version = exe.readUInt32LE(base + 4);
if (version !== TDB_VERSION) console.error(`Warning: type database version ${version}; this tool was written for ${TDB_VERSION} and may misread it.`);

// Header: counts as 32-bit numbers from +8, then from +0x60 the position of each table.
const table = (index) => base + Number(exe.readBigUInt64LE(base + 0x60 + index * 8));
const TYPES = table(1), TYPE_IMPLS = table(2), FIELDS = table(5), FIELD_IMPLS = table(6), INIT_DATA = table(12), STRINGS = table(15), BYTES = table(16);
const TYPE_COUNT = exe.readUInt32LE(base + 8);
const TYPE_SIZE = 80, TYPE_IMPL_SIZE = 48, FIELD_SIZE = 8, FIELD_IMPL_SIZE = 12;
if (TYPE_IMPLS < TYPES + TYPE_COUNT * TYPE_SIZE) throw new Error('The type database is laid out differently from what this tool knows.');

const bits = (q, from, count) => Number((q >> BigInt(from)) & ((1n << BigInt(count)) - 1n));
const text = (offset) => exe.toString('utf8', STRINGS + offset, exe.indexOf(0, STRINGS + offset));

function typeDef(index) {
  const at = TYPES + index * TYPE_SIZE;
  const a = exe.readBigUInt64LE(at), b = exe.readBigUInt64LE(at + 8), e = exe.readBigUInt64LE(at + 0x20);
  return { parent: bits(a, 19, 19), declaring: bits(a, 38, 19), impl: bits(b, 38, 18), firstField: bits(e, 44, 20), nameHash: exe.readUInt32LE(at + 0x18) };
}

/** Full name: the types it is declared inside, or else its namespace, then its own name. */
function typeName(index, depth = 0) {
  if (index <= 0 || index >= TYPE_COUNT || depth > 8) return `#${index}`;
  const def = typeDef(index);
  const names = exe.readBigUInt64LE(TYPE_IMPLS + def.impl * TYPE_IMPL_SIZE);
  const name = text(bits(names, 0, 28));
  if (def.declaring) return `${typeName(def.declaring, depth + 1)}.${name}`;
  const namespace = text(bits(names, 28, 28));
  return namespace ? `${namespace}.${name}` : name;
}

function field(index) {
  const def = exe.readBigUInt64LE(FIELDS + index * FIELD_SIZE);
  const impl = FIELD_IMPLS + bits(def, 19, 19) * FIELD_IMPL_SIZE;
  const flags = exe.readUInt16LE(impl + 2) >> 1, b = exe.readUInt32LE(impl + 4), c = exe.readUInt32LE(impl + 8);
  // Where a constant's value is kept: 16 bits spread over the two records.
  const init = (b >>> 26) | ((c >>> 28) << 6) | (bits(def, 57, 6) << 10);
  return { declaring: bits(def, 0, 19), type: bits(def, 38, 19), name: text(c & 0xfffffff), isStatic: Boolean(flags & 0x10), init };
}

const byHash = new Map();
for (let i = 0; i < TYPE_COUNT; i++) byHash.set(exe.readUInt32LE(TYPES + i * TYPE_SIZE + 0x18), i);

for (const name of wanted) {
  const index = byHash.get(name.startsWith('#') ? asHash(name) : hashName(name) >>> 0);
  if (index === undefined) {
    console.log(`\n${name}: not in the type database`);
    continue;
  }
  const def = typeDef(index);
  console.log(`\n${typeName(index)}  (#${def.nameHash.toString(16).padStart(8, '0')}, extends ${typeName(def.parent)})`);
  for (let i = def.firstField; ; i++) {
    const f = field(i);
    if (f.declaring !== index) break;
    let value = '';
    if (f.init) {
      const at = exe.readInt32LE(INIT_DATA + f.init * 4);
      value = at >= 0 ? ` = ${exe.readInt32LE(BYTES + at)}` : ' = (text)';
    }
    console.log(`  ${f.name}: ${typeName(f.type)}${value}${f.isStatic && !value ? '  [static]' : ''}`);
  }
}
