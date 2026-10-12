// Checks the language files against the English one: same keys, same {placeholders}.
// English and other languages with a singular may have extra "<key>.one" entries.
//
//   node tools/check-lang.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'lang');
const read = (code) => JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8'));
const places = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const singular = (key) => key.endsWith('.one');

const base = read('en');
let problems = 0;
for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'en.json').sort()) {
  const code = file.replace('.json', '');
  let strings;
  try {
    strings = read(code);
  } catch (error) {
    console.log(`${code}: not valid JSON (${error.message})`);
    problems++;
    continue;
  }
  const missing = Object.keys(base).filter((key) => !singular(key) && !(key in strings));
  const extra = Object.keys(strings).filter((key) => !(key in base) && !(singular(key) && key.slice(0, -4) in base));
  const mismatched = Object.keys(strings).filter((key) => key in base && places(strings[key]) !== places(base[key]));
  const empty = Object.keys(strings).filter((key) => typeof strings[key] !== 'string' || !strings[key].trim());
  const bad = missing.length + extra.length + mismatched.length + empty.length;
  problems += bad;
  console.log(`${code}: ${Object.keys(strings).length} entries${bad ? '' : ', ok'}`);
  if (missing.length) console.log(`  missing: ${missing.join(', ')}`);
  if (extra.length) console.log(`  not in en: ${extra.join(', ')}`);
  if (mismatched.length) console.log(`  placeholders differ: ${mismatched.join(', ')}`);
  if (empty.length) console.log(`  empty: ${empty.join(', ')}`);
}
process.exit(problems ? 1 : 0);
