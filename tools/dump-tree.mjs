// Development aid: writes the whole object tree of a save as indented text, with type, field
// and enum names resolved from data/dd2/*.json. Use it to find where a value lives before
// teaching src/core/gamedata.js about it.
//
//   node tools/dump-tree.mjs <save.bin> <steam account id> <output.txt>
//
// Read-only for the save. Names missing from the type dump are printed as #hash.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSave } from '../src/core/dsss.js';
import { T, TYPE_NAMES, parseBody } from '../src/core/savetree.js';
import { Schema } from '../src/core/schema.js';

const [savePath, steamId, outPath] = process.argv.slice(2);
if (!savePath || !steamId || !outPath) {
  console.error('usage: node tools/dump-tree.mjs <save.bin> <steam account id> <output.txt>');
  process.exit(2);
}

const data = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'dd2');
const schema = Schema.load(path.join(data, 'rszdd2.json'), path.join(data, 'enumsdd2.json'));
const tree = parseBody(readSave(fs.readFileSync(savePath), steamId).body);
const ARRAY_PREVIEW = 24;

const lines = [];
const hex = (hash) => `#${hash.toString(16)}`;

function scalar(type, node, cls, field) {
  if (type === T.STRING) return JSON.stringify(node.value);
  if (type === T.STRUCT) return `[${node.raw.length} bytes] ${node.raw.toString('hex')}`;
  if (type !== T.ENUM) return String(node.value);
  const enumType = schema.fieldType(cls.hash, field.hash);
  const label = enumType && schema.enumLabel(enumType, node.value);
  return `${node.value}${label ? ` = ${label}` : ''} <${enumType ?? '?'}>`;
}

function walk(cls, depth, label) {
  lines.push(`${'  '.repeat(depth)}${label}{${schema.typeName(cls.hash) ?? hex(cls.hash)}}`);
  const pad = '  '.repeat(depth + 1);
  for (const field of cls.fields) {
    const name = schema.fieldName(cls.hash, field.hash) ?? hex(field.hash);
    if (field.type === T.CLASS) {
      walk(field.node, depth + 1, `${name}: `);
    } else if (field.type !== T.ARRAY) {
      lines.push(`${pad}${name}: ${TYPE_NAMES[field.type]} = ${scalar(field.type, field.node, cls, field)}`);
    } else if (field.node.kind === 1) {
      lines.push(`${pad}${name}: [${field.node.items.length} classes]`);
      field.node.items.forEach((item, i) => walk(item, depth + 2, `[${i}] `));
    } else {
      const { items, memberType, memberSize } = field.node;
      const shown = items.slice(0, ARRAY_PREVIEW).map((item) => {
        if (memberType === T.STRING) return JSON.stringify(item.value);
        return memberType === T.STRUCT ? item.raw.toString('hex') : String(item.value);
      });
      lines.push(`${pad}${name}: [${items.length} x ${TYPE_NAMES[memberType]}(${memberSize})] ${shown.join(', ')}${items.length > ARRAY_PREVIEW ? ' ...' : ''}`);
    }
  }
}

for (const root of tree.roots) walk(root.cls, 0, `ROOT ${hex(root.hash)} `);
fs.writeFileSync(outPath, lines.join('\n'));
console.log(`${lines.length} lines -> ${outPath}`);
