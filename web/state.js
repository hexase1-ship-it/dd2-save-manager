// What every view shares: the app's state, the calls to src/server.js, and names from the game.

import { gameName, t } from './i18n.js';
import { h } from './ui.js';

const token = document.querySelector('meta[name="token"]').content;

export const INT32_MAX = 2147483647;
export const JOB_COUNT = 10;
export const BASIC_JOBS = 4; // always available, never flagged in the save
export const PAWN_JOBS = 6; // pawns cannot take the last four vocations

export const state = {
  view: 'backup',
  // Read from the game's own files; every name is { en, ko, ja, zh, es, fr }.
  names: { items: {}, jobs: {}, personalities: {}, subSkills: {}, portcrystals: null, skills: null, icons: null },
  data: null,
  dataKey: '',
  account: null,
  hideAuto: false,
  confirming: null, // { id, action: 'restore' | 'trash' }
  loadError: null,
  features: { ratings: null }, // optional modules under features/, null where an edition leaves one out
  editor: {
    file: null, model: null, draft: null, loading: false, error: null, owner: 'player', filter: '',
    sheet: null, // appearance sheet on show: { source: {who} | {id}, title, loading, error, data, tab }
    part: {}, // which part of a character panel is open, by character
    skillJob: {}, // which vocation's skills are listed, by character
  },
};

/** fetch() to this app's server; every call has to carry the page's session token. */
export function request(path, init = {}) {
  return fetch(path, { ...init, headers: { 'X-Token': token, ...init.headers } });
}

export async function api(method, path, body) {
  const response = await request(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data.error?.code;
    const known = t(`error.${code}`);
    const error = new Error(known !== `error.${code}` ? known : data.error?.message ?? t('error.generic'));
    error.code = code;
    throw error;
  }
  return data;
}

export async function loadNames() {
  try {
    state.names = await api('GET', '/api/names');
  } catch {
    // Without the dictionary things are shown by id; nothing else depends on it.
  }
}

/** A vocation's name: the game's own, or this program's until the game files have been read. */
export const jobName = (job) => gameName(state.names.jobs[job]) ?? (job >= 1 && job <= JOB_COUNT ? t(`job.${job}`) : t('job.none'));
export const itemName = (itemId) => gameName(state.names.items[itemId]);

/** "GameData 1/4" -> 1 */
export const slotNumber = (summary) => Number(summary?.detail?.match(/(\d+)\s*\/\s*\d+/)?.[1]) || null;
export const gameFiles = () => (state.data?.files ?? []).filter((f) => f.summary?.kind === 'game');
export const newestGameFile = (files) => files.filter((f) => f.summary?.kind === 'game').sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

export function slotLabel(file) {
  if (file.summary?.kind === 'system') return t('slot.system');
  const n = slotNumber(file.summary);
  return n ? t('slot.n', { n }) : file.name;
}

export const who = (key) => t(`who.${key}`);

/** The game's own name for a game mode ('casual', 'normal' or 'hard'). */
export const modeName = (mode) => (mode ? t(`game.${mode}`) : '');
/** A small label for a slot played in a mode other than the ordinary one. */
export const modeBadge = (mode) => (mode && mode !== 'normal' ? h('span', { class: 'badge' }, modeName(mode)) : null);
export const briefCharacter = (c) => (c ? t('character.brief', { name: c.name || t('character.unnamed'), level: c.level }) : '-');

// Views register what the shared code needs to call back into them.
export const hooks = {
  refresh: async () => {}, // re-read saves and backups from the server
  render: () => {}, // draw the current view again
  openEditor: () => {}, // switch to the edit view on a save file
};
