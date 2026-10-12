// Writes the public source tree (what the GitHub repository holds) into a folder.
//
//   node tools/export-public.mjs --out <folder> [--stage <packaged folder>] [--deny <text>]...
//
// The public tree is the source of the public edition: everything tools/package.mjs builds the
// release from, and nothing else. Like the release it never contains the pawn rating feature,
// and it carries the cut-down type and enum dumps of the last package (--stage, by default
// where package.mjs leaves it) instead of the full ones.
//
// <folder> must be empty, or one this tool wrote before (it may be a git clone; .git is left
// alone and everything else in it is replaced). The export fails if a file mentions the rating
// fields, a path into this PC's user folder, or any text given with --deny.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '.dd2sm-public';
const LEFT_OUT = ['src/features/ratings.js', 'web/features/ratings.js'];
const FORBIDDEN = /_GoodReviewNum|_LikeReviewNum/;
// The two tools that check for those names have to spell them.
const CHECKERS = ['tools/package.mjs', 'tools/export-public.mjs'];
const DUMPS = ['data/dd2/rszdd2.json', 'data/dd2/enumsdd2.json'];
const TREES = ['src', 'web', 'launcher', 'tools', 'test', 'docs/release'];
const FILES = ['package.json', 'DESIGN.md', 'docs/glossary.md', 'docs/design-source.md', 'docs/design-license.txt'];
const RENAMED = { 'docs/github/README.md': 'README.md', 'docs/github/gitignore.txt': '.gitignore' };
const TEXT = /\.(js|mjs|json|html|css|txt|md|cs|bat|rsp|ps1|manifest)$|^\.gitignore$/;

const values = (name) => process.argv.flatMap((arg, i) => (arg === name ? [process.argv[i + 1]] : []));
const out = values('--out')[0] && path.resolve(values('--out')[0]);
if (!out) {
  console.error('usage: node tools/export-public.mjs --out <folder> [--stage <packaged folder>] [--deny <text>]...');
  process.exit(2);
}
const stage = path.resolve(values('--stage')[0] ?? path.join(os.tmpdir(), 'dd2sm-package', 'DD2SaveManager'));
// A path into this PC's user folder has no business in public files.
const denied = [`Users\\${os.userInfo().username}`, `Users/${os.userInfo().username}`, ...values('--deny')].filter(Boolean);

function* filesUnder(dir, base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(full, base);
    else yield path.relative(base, full).split(path.sep).join('/');
  }
}
const copy = (from, rel) => {
  const to = path.join(out, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

// Only an empty folder, or one of ours, is written into.
const existing = fs.existsSync(out) ? fs.readdirSync(out).filter((name) => name !== '.git') : [];
if (existing.length && !existing.includes(MARKER)) throw new Error(`${out} holds other files; give an empty folder.`);
for (const name of existing) fs.rmSync(path.join(out, name), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, MARKER), 'Written by tools/export-public.mjs; do not edit files here, edit the project and export again.\n');

for (const tree of TREES) {
  for (const rel of filesUnder(path.join(ROOT, tree))) {
    if (!LEFT_OUT.includes(`${tree}/${rel}`)) copy(path.join(ROOT, tree, rel), `${tree}/${rel}`);
  }
}
for (const rel of FILES) copy(path.join(ROOT, rel), rel);
for (const [from, to] of Object.entries(RENAMED)) copy(path.join(ROOT, from), to);
for (const rel of DUMPS) {
  const slim = path.join(stage, rel);
  if (!fs.existsSync(slim) || fs.statSync(slim).size > 1_000_000) throw new Error(`${slim} is missing or not the cut-down dump; run tools/package.mjs first.`);
  copy(slim, rel);
}

let count = 0;
for (const rel of filesUnder(out)) {
  if (rel.startsWith('.git/')) continue;
  count++;
  if (LEFT_OUT.includes(rel)) throw new Error(`${rel} must not be public.`);
  if (!TEXT.test(rel)) continue;
  const text = fs.readFileSync(path.join(out, rel), 'utf8');
  if (FORBIDDEN.test(text) && !CHECKERS.includes(rel)) throw new Error(`${rel} mentions the pawn rating fields.`);
  for (const word of denied) if (text.includes(word)) throw new Error(`${rel} contains "${word}".`);
}
console.log(`${out}: ${count} files, checked`);
