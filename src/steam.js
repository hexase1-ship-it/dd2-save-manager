// Finds Dragon's Dogma 2 saves in the local Steam install.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const APP_ID = '2054970';
const GAME_EXE = 'DD2.exe';
const STEAM_ID64_BASE = 76561197960265728n;
const SAVE_FILE = /^data[0-9-]+(Slot)?\.bin$/;

export function findSteamRoot() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
    const match = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (match && fs.existsSync(match[1].trim())) return path.normalize(match[1].trim());
  } catch {
    // Steam not registered for this user; fall through to the default location.
  }
  const fallback = 'C:\\Program Files (x86)\\Steam';
  return fs.existsSync(fallback) ? fallback : null;
}

/** Persona names by 32-bit account id, from Steam's own login list. */
function readPersonaNames(steamRoot) {
  const names = new Map();
  try {
    const text = fs.readFileSync(path.join(steamRoot, 'config', 'loginusers.vdf'), 'utf8');
    for (const match of text.matchAll(/"(\d{17})"\s*\{([^}]*)\}/g)) {
      const persona = match[2].match(/"PersonaName"\s+"([^"]*)"/);
      if (persona) names.set(String(BigInt(match[1]) - STEAM_ID64_BASE), persona[1]);
    }
  } catch {
    // Names are cosmetic.
  }
  return names;
}

/** Install folder of the game and its Steam build id, or null when it is not installed. */
export function findGame(steamRoot) {
  const libraries = [steamRoot];
  try {
    const text = fs.readFileSync(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    // VDF escapes backslashes.
    for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) libraries.push(match[1].replaceAll('\\\\', '\\'));
  } catch {
    // Only the main library then.
  }
  for (const library of libraries) {
    try {
      const manifest = fs.readFileSync(path.join(library, 'steamapps', `appmanifest_${APP_ID}.acf`), 'utf8');
      const installDir = manifest.match(/"installdir"\s+"([^"]+)"/)?.[1];
      const dir = installDir && path.join(library, 'steamapps', 'common', installDir);
      if (dir && fs.existsSync(dir)) return { dir, buildId: manifest.match(/"buildid"\s+"(\d+)"/)?.[1] ?? null };
    } catch {
      // Not in this library.
    }
  }
  return null;
}

export function isSaveFileName(name) {
  return SAVE_FILE.test(name);
}

export function listSaveFiles(saveDir) {
  if (!fs.existsSync(saveDir)) return [];
  return fs.readdirSync(saveDir).filter(isSaveFileName).sort().map((name) => {
    const stat = fs.statSync(path.join(saveDir, name));
    return { name, size: stat.size, mtimeMs: stat.mtimeMs };
  });
}

/** Steam accounts on this PC that have Dragon's Dogma 2 saves, most recently played first. */
export function listAccounts(steamRoot) {
  const userdata = path.join(steamRoot, 'userdata');
  if (!fs.existsSync(userdata)) return [];
  const names = readPersonaNames(steamRoot);
  const accounts = [];
  for (const id of fs.readdirSync(userdata)) {
    if (!/^\d+$/.test(id)) continue;
    const saveDir = path.join(userdata, id, APP_ID, 'remote', 'win64_save');
    const files = listSaveFiles(saveDir);
    if (!files.length) continue;
    accounts.push({
      id,
      name: names.get(id) ?? null,
      saveDir,
      lastPlayedMs: Math.max(...files.map((f) => f.mtimeMs)),
    });
  }
  return accounts.sort((a, b) => b.lastPlayedMs - a.lastPlayedMs);
}

export function isGameRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${GAME_EXE}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return out.toLowerCase().includes(GAME_EXE.toLowerCase());
  } catch {
    // If the process list cannot be read, assume the worst so nothing is overwritten mid-game.
    return true;
  }
}
