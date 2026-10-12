// Local web app: serves the UI from web/ and a small JSON API on 127.0.0.1 only.
//
//   node src/server.js [--no-open] [--port N] [--parent-pid PID] [--save-dir DIR --account ID] [--data-dir DIR]
//
// --parent-pid makes the server exit when that process is gone (the exe launcher passes its own).
// --save-dir points the app at a copy of the save folder (used for testing); the account id
// is still needed because saves are encrypted per Steam account. --data-dir says where backups/,
// looks/ and data/ (what is read from the game) are kept; by default that is the program folder.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupError, BackupStore, writeFileAtomic } from './backups.js';
import { SaveError } from './core/dsss.js';
import { GameDataError, SaveDoc, lookContexts } from './core/gamedata.js';
import { buildLookSheet } from './core/looksheet.js';
import { TreeError } from './core/savetree.js';
import { CharaEditError, EditorLayoutStore } from './gamefiles/charaedit.js';
import { IconError, planIcons } from './gamefiles/icons.js';
import { MsgError } from './gamefiles/msg.js';
import { NamesError, NameStore } from './gamefiles/names.js';
import { GameFiles, PakError } from './gamefiles/pak.js';
import { RszError } from './gamefiles/rsz.js';
import { TexError } from './gamefiles/tex.js';
import { UvsError } from './gamefiles/uvs.js';
import { LookError, LookStore } from './looks.js';
import { findGame, findSteamRoot, isGameRunning, isSaveFileName, listAccounts, listSaveFiles } from './steam.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const DEFAULT_PORT = 47820;
const BODY_LIMIT = 4 * 1024 * 1024;
const SHEET_LIMIT = 64 * 1024 * 1024;
const GAME_DATA = path.join(ROOT, 'data', 'dd2');
const TYPE_DUMP = path.join(GAME_DATA, 'rszdd2.json');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

function parseArgs(argv) {
  const args = { open: true, port: DEFAULT_PORT, parentPid: null, saveDir: null, account: null, dataDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-open') args.open = false;
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--parent-pid') args.parentPid = Number(argv[++i]);
    else if (argv[i] === '--save-dir') args.saveDir = path.resolve(argv[++i]);
    else if (argv[i] === '--account') args.account = argv[++i];
    else if (argv[i] === '--data-dir') args.dataDir = path.resolve(argv[++i]);
  }
  return args;
}

/**
 * Where backups, presets and what is read from the game are kept: next to the program when that
 * folder can be written to (an unzipped copy), otherwise in the user's own app data folder.
 */
function defaultDataDir() {
  const probe = path.join(ROOT, `.write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return ROOT;
  } catch {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'DD2SaveManager', 'data');
  }
}

const args = parseArgs(process.argv.slice(2));
args.dataDir ??= defaultDataDir();
// Everything read out of the game files is built on the player's PC and kept with their data.
const GENERATED = path.join(args.dataDir, 'data', 'dd2');
const ICON_SHEET = path.join(GENERATED, 'icons.png');
const ICON_INDEX = path.join(GENERATED, 'icons.json');
const token = randomBytes(24).toString('hex');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------
// Accounts and save files

function findAccounts() {
  if (args.saveDir) {
    return [{ id: args.account, name: null, saveDir: args.saveDir, lastPlayedMs: 0, sandbox: true }];
  }
  const steamRoot = findSteamRoot();
  return steamRoot ? listAccounts(steamRoot) : [];
}

function accountFor(id) {
  const accounts = findAccounts();
  const account = id ? accounts.find((a) => a.id === id) : accounts[0];
  if (!account) throw new HttpError(404, 'no-saves', 'No Dragon\'s Dogma 2 saves were found for this Steam account.');
  return account;
}

const summaryCache = new Map();
const SYSTEM_SAVE = 'data00-1.bin';

/** Summary of a save file, or a reason it could not be read. */
function summarize(file, steamId) {
  try {
    return SaveDoc.open(file, steamId).summary();
  } catch (error) {
    return { kind: 'unreadable', error: error.code ?? 'error' };
  }
}

function describeFiles(account) {
  const files = listSaveFiles(account.saveDir).map((f) => {
    const key = `${account.saveDir}|${f.name}|${f.mtimeMs}|${f.size}`;
    let summary = summaryCache.get(key);
    if (!summary) {
      summary = summarize(fs.readFileSync(path.join(account.saveDir, f.name)), account.id);
      summaryCache.set(key, summary);
    }
    return { ...f, summary };
  });
  // The system save knows the game mode of each slot better than the slot's own save does.
  const modes = files.find((f) => f.summary.kind === 'system')?.summary.slotModes ?? {};
  return files.map((f) => (f.summary.kind === 'game' ? { ...f, summary: { ...f.summary, mode: modes[f.summary.slot] ?? f.summary.mode } } : f));
}

/** The game mode the system save next to a save file records for a slot, or null. */
function slotMode(file, steamId, slot) {
  try {
    return SaveDoc.open(fs.readFileSync(path.join(path.dirname(file), SYSTEM_SAVE)), steamId).summary().slotModes?.[slot] ?? null;
  } catch {
    return null;
  }
}

function backupsFor(account) {
  return new BackupStore(path.join(args.dataDir, 'backups', account.id), account.saveDir, (file) => summarize(file, account.id));
}

const looks = new LookStore(path.join(args.dataDir, 'looks'));
const names = new NameStore(path.join(GENERATED, 'names.json'), TYPE_DUMP);
const editorLayouts = new EditorLayoutStore(path.join(GENERATED, 'charaedit.json'), TYPE_DUMP, path.join(GAME_DATA, 'enumsdd2.json'));

function installedGame() {
  const steamRoot = findSteamRoot();
  return steamRoot ? findGame(steamRoot) : null;
}

/** What the game's own tables allow, for the edits that are checked against them. */
function gameCatalog() {
  const { portcrystals, skills } = names.read();
  return { portcrystals: portcrystals?.map((crystal) => crystal.id), skills: skills ?? undefined };
}

/** How the game's character editor is laid out; read from the game files the first time it is asked for. */
function editorLayout() {
  const stored = editorLayouts.read();
  if (stored) return stored;
  const game = installedGame();
  if (!game) throw new HttpError(404, 'no-game', 'The game is not installed on this PC.');
  return editorLayouts.rebuild(game);
}

// Item icons are cut out of the game's textures by the page (its GPU decodes them) and sent
// back as one sprite sheet. The plan and the raw textures wait here in between.
let pendingIcons = null;

/** Where each item's icon sits on the saved sprite sheet, or null when there is no sheet yet. */
function readIconIndex() {
  try {
    if (!fs.existsSync(ICON_SHEET)) return null;
    return JSON.parse(fs.readFileSync(ICON_INDEX, 'utf8'));
  } catch {
    return null;
  }
}

/** Path of a save file in the live folder or inside a backup. */
function resolveSave(account, name, backupId) {
  if (!isSaveFileName(name)) throw new HttpError(400, 'bad-file', 'Unknown save file.');
  if (backupId) return backupsFor(account).filePath(backupId, name);
  const file = path.join(account.saveDir, name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'not-found', 'That save file no longer exists.');
  return file;
}

function requireGameClosed(account) {
  if (!account.sandbox && isGameRunning()) {
    throw new HttpError(409, 'game-running', 'Dragon\'s Dogma 2 is running. Close the game first.');
  }
}

// ---------------------------------------------------------------------------------------
// API

const api = {
  'GET /api/state': ({ query }) => {
    const accounts = findAccounts();
    if (!accounts.length) return { accounts: [], account: null };
    const account = accounts.find((a) => a.id === query.account) ?? accounts[0];
    return {
      accounts: accounts.map(({ id, name }) => ({ id, name })),
      account: { id: account.id, name: account.name, saveDir: account.saveDir, sandbox: Boolean(account.sandbox) },
      gameRunning: account.sandbox ? false : isGameRunning(),
      files: describeFiles(account),
      backups: backupsFor(account).list(),
      looks: looks.list(),
      // The name dictionary is rebuilt from the game's files; a different build id means the
      // game has been updated since.
      names: { builtAt: names.read().builtAt, buildId: names.read().buildId, gameBuildId: installedGame()?.buildId ?? null },
    };
  },

  // Everything read out of the game files for display, each name in every supported language.
  'GET /api/names': () => {
    const { items, jobs, personalities, subSkills, portcrystals, skills } = names.read();
    return { items, jobs, personalities, subSkills, portcrystals, skills, icons: readIconIndex() };
  },

  'POST /api/icons/plan': () => {
    const game = installedGame();
    if (!game) throw new HttpError(404, 'no-game', 'The game is not installed on this PC.');
    const files = new GameFiles(game.dir);
    try {
      const { sheet, textures } = planIcons(files, TYPE_DUMP);
      pendingIcons = { sheet, textures, buildId: game.buildId };
      return { ...sheet, items: undefined, textures: textures.map(({ width, height, format }) => ({ width, height, format })) };
    } finally {
      files.close();
    }
  },

  'GET /api/icons/texture': ({ query }) => {
    const texture = pendingIcons?.textures[Number(query.index)];
    if (!texture) throw new HttpError(404, 'not-found', 'No such texture.');
    return texture.data;
  },

  'POST /api/icons/sheet': ({ raw }) => {
    if (!pendingIcons) throw new HttpError(409, 'no-plan', 'There is no icon sheet being built.');
    if (!raw?.subarray(0, 8).equals(PNG_MAGIC)) throw new HttpError(400, 'bad-image', 'The icon sheet must be a PNG image.');
    const { cell, columns, rows, items } = pendingIcons.sheet;
    fs.mkdirSync(path.dirname(ICON_SHEET), { recursive: true });
    writeFileAtomic(ICON_SHEET, raw);
    fs.writeFileSync(ICON_INDEX, JSON.stringify({ builtAt: new Date().toISOString(), buildId: pendingIcons.buildId, cell, columns, rows, items }));
    pendingIcons = null;
    return { icons: Object.keys(items).length };
  },

  'POST /api/names/rebuild': () => {
    const game = installedGame();
    if (!game) throw new HttpError(404, 'no-game', 'The game is not installed on this PC.');
    const built = names.rebuild(game);
    // The character editor's layout comes from the same files. Names matter more: when the
    // layout cannot be read the names are kept and the sheet goes on using its old layout.
    let editor = true;
    try {
      editorLayouts.rebuild(game);
    } catch (error) {
      if (!(error instanceof CharaEditError || error instanceof RszError || error instanceof MsgError)) throw error;
      editor = false;
    }
    return { items: Object.keys(built.items).length, jobs: Object.keys(built.jobs).length, editor };
  },

  'POST /api/backup': ({ body }) => {
    const account = accountFor(body.account);
    return backupsFor(account).create({ kind: 'manual', memo: body.memo ?? '' });
  },

  'POST /api/backup/memo': ({ body }) => backupsFor(accountFor(body.account)).setMemo(body.id, body.memo ?? ''),

  'POST /api/backup/restore': ({ body }) => {
    const account = accountFor(body.account);
    requireGameClosed(account);
    return backupsFor(account).restore(body.id);
  },

  'POST /api/backup/trash': ({ body }) => {
    backupsFor(accountFor(body.account)).trash(body.id);
    return {};
  },

  'GET /api/save': ({ query }) => {
    const account = accountFor(query.account);
    const file = resolveSave(account, query.file, query.backup);
    const model = SaveDoc.open(fs.readFileSync(file), account.id).model();
    // The game's own table says which portcrystals there are, once it has been read.
    const { portcrystals } = gameCatalog();
    if (model.portcrystals && portcrystals) model.portcrystals.all = portcrystals;
    model.mode = slotMode(file, account.id, model.slot) ?? model.mode;
    return { ...model, file: query.file, backup: query.backup ?? null, mtimeMs: fs.statSync(file).mtimeMs };
  },

  'POST /api/save/apply': ({ body }) => {
    const account = accountFor(body.account);
    requireGameClosed(account);
    const file = resolveSave(account, body.file, null);
    if (fs.statSync(file).mtimeMs !== body.mtimeMs) {
      throw new HttpError(409, 'stale', 'The save changed since it was opened. Reload it and try again.');
    }
    const edits = { ...body.edits };
    if (edits.looks) {
      edits.looks = Object.fromEntries(Object.entries(edits.looks).map(([who, id]) => [who, looks.read(id)]));
    }
    const doc = SaveDoc.open(fs.readFileSync(file), account.id);
    doc.apply(edits, gameCatalog());
    const output = doc.build(account.id);
    const safety = backupsFor(account).create({ kind: 'auto', reason: 'before-edit' });
    writeFileAtomic(file, output);
    return { safety: safety.id, mtimeMs: fs.statSync(file).mtimeMs };
  },

  'POST /api/look/export': ({ body }) => {
    const account = accountFor(body.account);
    const file = resolveSave(account, body.file, body.backup);
    const look = SaveDoc.open(fs.readFileSync(file), account.id).exportLook(body.who);
    return looks.save(look, body.label);
  },

  // Appearance of a character in a save, or of a stored preset (id), as the values to enter in
  // the game's character editor.
  'GET /api/look/sheet': ({ query }) => {
    let look;
    if (query.id) {
      look = looks.read(query.id);
    } else {
      const account = accountFor(query.account);
      const file = resolveSave(account, query.file, query.backup);
      look = SaveDoc.open(fs.readFileSync(file), account.id).exportLook(query.who);
    }
    return { from: look.from, label: look.label ?? null, ...buildLookSheet(lookContexts(look), editorLayout(), query.lang) };
  },

  'POST /api/look/trash': ({ body }) => {
    looks.trash(body.id);
    return {};
  },

  'POST /api/open-folder': ({ body }) => {
    const account = accountFor(body.account);
    const folder = { saves: account.saveDir, backups: path.join(args.dataDir, 'backups', account.id), looks: path.join(args.dataDir, 'looks') }[body.which];
    if (!folder) throw new HttpError(400, 'bad-folder', 'Unknown folder.');
    fs.mkdirSync(folder, { recursive: true });
    execFile('explorer.exe', [folder]);
    return {};
  },
};

// ---------------------------------------------------------------------------------------
// HTTP plumbing

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'too-large', 'Request too large.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBody(req) {
  const raw = await readRaw(req, BODY_LIMIT);
  try {
    return raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'bad-json', 'Malformed request.');
  }
}

function send(res, status, type, data) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(WEB, relative);
  if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  }
  let data = fs.readFileSync(file);
  // The page carries the session token; API calls without it are refused, so other sites
  // open in the same browser cannot drive this server.
  if (relative === 'index.html') data = Buffer.from(data.toString('utf8').replace('__TOKEN__', token));
  send(res, 200, MIME[path.extname(file)] ?? 'application/octet-stream', data);
}

function statusFor(error) {
  if (error instanceof HttpError) return error.status;
  if (error instanceof BackupError || error instanceof LookError) return error.code === 'not-found' ? 404 : 400;
  if (error instanceof GameDataError || error instanceof SaveError || error instanceof TreeError) return 422;
  if (error instanceof NamesError || error instanceof PakError || error instanceof MsgError) return 422;
  if (error instanceof IconError || error instanceof TexError || error instanceof UvsError) return 422;
  if (error instanceof CharaEditError || error instanceof RszError) return 422;
  return 500;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const host = req.headers.host ?? '';
  if (host !== `127.0.0.1:${args.port}` && host !== `localhost:${args.port}`) {
    return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
  }
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    // Lets the exe launcher tell a server left over from an older copy apart from its own.
    if (url.pathname === '/version') return send(res, 200, MIME['.json'], JSON.stringify({ version: VERSION }));
    if (url.pathname === '/icons.png') {
      if (!fs.existsSync(ICON_SHEET)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
      return send(res, 200, 'image/png', fs.readFileSync(ICON_SHEET));
    }
    return serveStatic(res, url.pathname);
  }
  try {
    if (req.headers['x-token'] !== token) throw new HttpError(403, 'token', 'This page is out of date. Reload it.');
    const handler = api[`${req.method} ${url.pathname}`];
    if (!handler) throw new HttpError(404, 'no-route', 'Unknown request.');
    // The icon sheet arrives as an image; everything else is JSON.
    const binary = req.method === 'POST' && req.headers['content-type'] === 'image/png';
    const raw = binary ? await readRaw(req, SHEET_LIMIT) : null;
    const body = req.method === 'POST' && !binary ? await readBody(req) : {};
    const result = handler({ query: Object.fromEntries(url.searchParams), body, raw });
    if (Buffer.isBuffer(result)) send(res, 200, 'application/octet-stream', result);
    else send(res, 200, MIME['.json'], JSON.stringify(result ?? {}));
  } catch (error) {
    const status = statusFor(error);
    if (status === 500) console.error(error);
    send(res, status, MIME['.json'], JSON.stringify({ error: { code: error.code ?? 'error', message: error.message } }));
  }
});

const address = `http://127.0.0.1:${args.port}/`;
const openBrowser = () => execFile('cmd', ['/c', 'start', '', address], { windowsHide: true });

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    // Already running in another window: just bring up the page.
    if (args.open) openBrowser();
    console.log(`이미 실행 중이에요. 브라우저에서 ${address} 를 열어요.`);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  throw error;
});

if (args.parentPid) {
  const PARENT_CHECK_MS = 2000;
  setInterval(() => {
    try {
      process.kill(args.parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, PARENT_CHECK_MS).unref();
}

server.listen(args.port, '127.0.0.1', () => {
  console.log(`DD2 세이브 매니저 실행 중: ${address}`);
  console.log('이 창을 닫으면 프로그램이 종료돼요.');
  if (args.open) openBrowser();
});
