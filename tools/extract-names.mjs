// Rebuilds what the app reads out of the installed game: data/dd2/names.json (item and
// vocation names) and data/dd2/charaedit.json (the character editor's layout, for the
// appearance sheet). The app does the same from its "이름·아이콘 새로 만들기" button, which
// also makes the item icons; this is the command-line way.
//
//   node tools/extract-names.mjs [game folder]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EditorLayoutStore } from '../src/gamefiles/charaedit.js';
import { NameStore } from '../src/gamefiles/names.js';
import { findGame, findSteamRoot } from '../src/steam.js';

const data = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'dd2');
const steamRoot = findSteamRoot();
const game = process.argv[2] ? { dir: path.resolve(process.argv[2]), buildId: null } : steamRoot && findGame(steamRoot);
if (!game) {
  console.error('Game folder not found. Pass it as an argument.');
  process.exit(1);
}

const names = new NameStore(path.join(data, 'names.json'), path.join(data, 'rszdd2.json')).rebuild(game);
console.log(`${Object.keys(names.items).length} items, ${Object.keys(names.jobs).length} vocations (game build ${names.buildId ?? 'unknown'})`);

const editor = new EditorLayoutStore(path.join(data, 'charaedit.json'), path.join(data, 'rszdd2.json'), path.join(data, 'enumsdd2.json')).rebuild(game);
const entries = editor.tabs.reduce((n, tab) => n + tab.parts.reduce((m, part) => m + part.details.length, 0), 0);
console.log(`character editor: ${editor.tabs.length} tabs, ${entries} entries, ${Object.keys(editor.palettes).length} colour areas`);
