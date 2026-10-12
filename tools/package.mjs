// Builds the public edition of the program (the one for Nexus Mods) as a folder and a zip.
//
//   node tools/package.mjs --zip <file.zip> [--stage <folder>]
//
// The public edition differs from the working copy in three ways:
//   - It never contains the pawn rating feature (src/features/ratings.js, web/features/ratings.js).
//     This is the owner's standing rule; the build fails if any trace of it ends up in the output.
//   - It contains nothing taken from the game: no names, icons or editor layout. Those are read
//     from the player's own game files the first time the program runs.
//   - It brings its own Node.js (runtime\node.exe), and only the part of the type and enum dumps
//     that reading the game files actually uses.
//
// Needs the game installed here (to learn which dump entries are used and to test the result)
// and the C# compiler that ships with Windows: the launcher is built here from its source, so
// the package never lags behind launcher\Launcher.cs or waits for a copy that is in use.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EditorLayoutStore } from '../src/gamefiles/charaedit.js';
import { planIcons } from '../src/gamefiles/icons.js';
import { NameStore } from '../src/gamefiles/names.js';
import { GameFiles } from '../src/gamefiles/pak.js';
import { usage } from '../src/gamefiles/typedump.js';
import { findGame, findSteamRoot } from '../src/steam.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'DD2SaveManager';
const LEFT_OUT = ['src/features/ratings.js', 'web/features/ratings.js'];
// What must not appear anywhere in the public edition: the save fields the rating feature edits.
const FORBIDDEN = /_GoodReviewNum|_LikeReviewNum/;
const DUMPS = ['data/dd2/rszdd2.json', 'data/dd2/enumsdd2.json'];
const TEST_PORT = 47829;
const CSC = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const WEBVIEW2 = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'];

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
};
const zipFile = option('--zip');
if (!zipFile) {
  console.error('usage: node tools/package.mjs --zip <file.zip> [--stage <folder>]');
  process.exit(2);
}
// A finished package is never overwritten; a newer one gets a new name (the version, or _v2).
if (fs.existsSync(path.resolve(zipFile))) {
  console.error(`${path.resolve(zipFile)} already exists. Give the new package another name.`);
  process.exit(2);
}
const stageRoot = path.resolve(option('--stage') ?? path.join(os.tmpdir(), 'dd2sm-package'));
const stage = path.join(stageRoot, NAME);
const temp = path.join(stageRoot, 'work');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function* filesUnder(dir, base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(full, base);
    else yield path.relative(base, full).split(path.sep).join('/');
  }
}

// ---------------------------------------------------------------------------------------

const steamRoot = findSteamRoot();
const game = steamRoot && findGame(steamRoot);
if (!game) throw new Error('The game is not installed on this PC; it is needed to build the package.');
if (!fs.existsSync(CSC)) throw new Error(`The C# compiler was not found at ${CSC}.`);

// Only ever clears its own two folders; a staging folder holding anything else is left alone.
const strangers = fs.existsSync(stageRoot) ? fs.readdirSync(stageRoot).filter((entry) => entry !== NAME && entry !== 'work') : [];
if (strangers.length) throw new Error(`${stageRoot} holds other files (${strangers.slice(0, 3).join(', ')}); give an empty folder with --stage.`);
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });

// 1. Which entries of the dumps does reading the game files use? Read them once and take note.
console.log('reading the game files to see which dump entries are used...');
usage.record = new Map();
const full = (rel) => path.join(ROOT, rel);
new NameStore(path.join(temp, 'names.json'), full(DUMPS[0])).rebuild(game);
new EditorLayoutStore(path.join(temp, 'charaedit.json'), full(DUMPS[0]), full(DUMPS[1])).rebuild(game);
const gameFiles = new GameFiles(game.dir);
try {
  planIcons(gameFiles, full(DUMPS[0]));
} finally {
  gameFiles.close();
}
const used = usage.record;
usage.record = null;
for (const rel of DUMPS) {
  const whole = JSON.parse(fs.readFileSync(full(rel), 'utf8'));
  const keys = [...(used.get(full(rel)) ?? [])];
  if (!keys.length) throw new Error(`No entry of ${rel} was used; something is off.`);
  const target = path.join(stage, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Of a type, only what the readers look at: its name and the place, size and kind of each field.
  const slim = (entry) => (Array.isArray(entry?.fields)
    ? { name: entry.name, fields: entry.fields.map(({ name, type, size, align, array }) => ({ name, type, size, align, array })) }
    : entry);
  fs.writeFileSync(target, JSON.stringify(Object.fromEntries(keys.sort().map((key) => [key, slim(whole[key])]))));
  console.log(`  ${rel}: ${keys.length} of ${Object.keys(whole).length} entries, ${(fs.statSync(target).size / 1024).toFixed(0)} KB`);
}

// 2. The program itself.
for (const dir of ['src', 'web']) {
  for (const rel of filesUnder(path.join(ROOT, dir))) {
    if (!LEFT_OUT.includes(`${dir}/${rel}`)) copy(path.join(ROOT, dir, rel), path.join(stage, dir, rel));
  }
}
copy(path.join(ROOT, 'package.json'), path.join(stage, 'package.json'));
for (const dll of WEBVIEW2) copy(path.join(ROOT, 'launcher', 'webview2', dll), path.join(stage, 'bin', dll));
execFileSync(CSC, [`/out:${path.join(stage, `${NAME}.exe`)}`, '@launcher\\build.rsp'], { cwd: ROOT, stdio: 'inherit' });
for (const rel of filesUnder(path.join(ROOT, 'docs', 'release'))) copy(path.join(ROOT, 'docs', 'release', rel), path.join(stage, rel));
// The launcher's source goes along, so the exe can be checked and rebuilt from the package itself (BUILD.txt).
for (const rel of filesUnder(path.join(ROOT, 'launcher'))) copy(path.join(ROOT, 'launcher', rel), path.join(stage, 'launcher', rel));

// 3. What it runs on, with the licenses those come under.
copy(process.execPath, path.join(stage, 'runtime', 'node.exe'));
copy(path.join(path.dirname(process.execPath), 'LICENSE'), path.join(stage, 'licenses', 'node-LICENSE.txt'));
copy(path.join(ROOT, 'launcher', 'webview2', 'LICENSE.txt'), path.join(stage, 'licenses', 'webview2-LICENSE.txt'));
copy(path.join(ROOT, 'launcher', 'webview2', 'NOTICE.txt'), path.join(stage, 'licenses', 'webview2-NOTICE.txt'));

// 4. The rating feature must be absent, in every form.
const TEXT = /\.(js|mjs|json|html|css|txt|md|cs|bat|rsp|ps1|manifest)$/;
for (const rel of filesUnder(stage)) {
  if (LEFT_OUT.includes(rel)) throw new Error(`${rel} must not be in the public edition.`);
  if (TEXT.test(rel) && !DUMPS.includes(rel) && FORBIDDEN.test(fs.readFileSync(path.join(stage, rel), 'utf8'))) {
    throw new Error(`${rel} mentions the pawn rating fields; the public edition must not.`);
  }
}
console.log('checked: no pawn rating feature in the package');

// 5. Does the packaged copy work from nothing? Start it on its own Node, with an empty data
//    folder, and let it read the game files with the cut-down dumps. Only reads the saves.
console.log('starting the packaged copy to test it...');
const dataDir = path.join(temp, 'data');
const server = spawn(path.join(stage, 'runtime', 'node.exe'), ['src/server.js', '--no-open', '--port', String(TEST_PORT), '--data-dir', dataDir], { cwd: stage, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (chunk) => { log += chunk; });
server.stderr.on('data', (chunk) => { log += chunk; });
const base = `http://127.0.0.1:${TEST_PORT}`;
try {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${base}/version`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const token = (await (await fetch(base)).text()).match(/name="token" content="([^"]+)"/)[1];
  const call = async (method, route) => {
    const response = await fetch(base + route, { method, headers: { 'X-Token': token } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const expect = (ok, what) => { if (!ok) throw new Error(`packaged copy: ${what}`); };
  expect((await fetch(`${base}/features/ratings.js`)).status === 404, 'the rating feature is being served');
  expect((await fetch(`${base}/lang/en.json`)).ok, 'language files are missing');
  const built = await call('POST', '/api/names/rebuild');
  expect(built.status === 200 && built.body.items > 1000 && built.body.editor, `reading the game files failed: ${JSON.stringify(built.body)}`);
  const names = (await call('GET', '/api/names')).body;
  expect(names.skills?.custom.length > 100 && names.portcrystals?.length > 0, 'skills or portcrystals were not read');
  const plan = await call('POST', '/api/icons/plan');
  expect(plan.status === 200 && plan.body.sprites.length > 1000, `the icon plan failed: ${JSON.stringify(plan.body).slice(0, 200)}`);
  const state = (await call('GET', '/api/state')).body;
  const save = state.files?.find((file) => file.summary?.kind === 'game');
  if (save) {
    const query = `account=${state.account.id}&file=${save.name}`;
    const model = (await call('GET', `/api/save?${query}`)).body;
    expect(model.characters?.length > 0, 'a save could not be opened');
    expect(model.characters.every((c) => c.reviews === null), 'the save model carries pawn ratings');
    expect(['casual', 'normal', 'hard'].includes(model.mode) && save.summary.mode === model.mode, 'the game mode of the save was not read');
    const sheet = await call('GET', `/api/look/sheet?${query}&who=player&lang=en`);
    expect(sheet.status === 200 && sheet.body.unknown.length === 0, 'the appearance sheet failed');
    console.log(`  opened ${save.name}: ${model.characters.length} characters, ${model.items.length} items, mode ${model.mode}, sheet ok`);
  } else {
    console.log('  no save on this PC to open; skipped that part');
  }
  console.log(`  read ${built.body.items} item names, ${names.skills.custom.length} weapon skills, ${plan.body.sprites.length} icons planned`);
} catch (error) {
  console.error(log.slice(-2000));
  throw error;
} finally {
  server.kill();
}

// 6. Zip it. tar.exe ships with Windows and writes zip when the name says so.
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(path.dirname(path.resolve(zipFile)), { recursive: true });
execFileSync(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', path.resolve(zipFile), '-C', stageRoot, NAME], { stdio: 'inherit' });
const count = [...filesUnder(stage)].length;
console.log(`${path.resolve(zipFile)}: ${(fs.statSync(path.resolve(zipFile)).size / 1024 / 1024).toFixed(1)} MB, ${count} files`);
