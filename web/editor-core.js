// The editor's working copy of a save: the draft, the changes between it and the file, the
// apply bar, and the input fields that feed the draft. The sections of the editor build on this.

import { t, tn } from './i18n.js';
import { api, hooks, state } from './state.js';
import { h, icon, put, replay, toast, withBusy } from './ui.js';

const applybar = document.getElementById('applybar');

export const STATS = ['hp', 'stamina', 'attack', 'defence', 'magicAttack', 'magicDefence', 'weight', 'blow'];
export const NAME_MAX = 12;

/** Affinity is kept as a fraction; the editor works in whole points. */
export const wholeAffinity = (c) => (c.affinity === null ? null : Math.round(c.affinity));

export function makeDraft(model) {
  const ratings = state.features.ratings;
  return {
    money: { ...model.money },
    characters: Object.fromEntries(model.characters.map((c) => [c.who, {
      name: c.name, job: c.job,
      level: c.level, exp: c.exp, dp: c.dp, jobBits: c.jobBits, jobExp: [...c.jobExp], stats: { ...c.stats },
      nature: c.nature && { ...c.nature }, affinity: wholeAffinity(c), plagueReset: false,
      reviews: ratings && c.reviews ? ratings.draftOf(c) : null,
      // Skills and augments to unlock: weapon skill id -> level, and ids of the on/off kinds.
      skills: { custom: new Map(), normal: new Set(), abilities: new Set() },
    }])),
    curedGuests: new Set(), // hired pawns whose dragonsplague is to be cleared
    portcrystals: new Set(), // ids of permanent portcrystals to mark as found
    itemNum: new Map(),
    enhance: new Map(), // item slot -> times enhanced
    removed: new Set(),
    added: [],
    looks: {},
    invalid: new Set(),
  };
}

/**
 * Changes between the opened save and the draft, as the server expects them, with how many
 * there are per section of the editor and per part of a character's panel.
 */
export function collectEdits() {
  const { model, draft } = state.editor;
  const edits = {};
  const counts = { money: 0, game: 0, travel: 0, player: 0, pawn: 0, items: 0, looks: 0 };
  const parts = {};
  const bump = (who, part, n = 1) => {
    counts[who] += n;
    parts[`${who}:${part}`] = (parts[`${who}:${part}`] ?? 0) + n;
  };

  const money = {};
  for (const key of ['gold', 'rim']) if (draft.money[key] !== model.money[key]) { money[key] = draft.money[key]; counts.money++; }
  if (counts.money) edits.money = money;
  if (draft.portcrystals.size) {
    // In the game's own order, whatever order they were ticked in.
    edits.portcrystals = model.portcrystals.all.filter((id) => draft.portcrystals.has(id));
    counts.travel = draft.portcrystals.size;
  }

  for (const c of model.characters) {
    const d = draft.characters[c.who];
    const change = {};
    for (const key of ['name', 'job', 'level', 'exp', 'dp']) if (d[key] !== c[key]) { change[key] = d[key]; bump(c.who, 'basic'); }
    const stats = {};
    for (const key of STATS) if (d.stats[key] !== c.stats[key]) { stats[key] = d.stats[key]; bump(c.who, 'growth'); }
    if (Object.keys(stats).length) change.stats = stats;
    if (d.jobBits !== c.jobBits) { change.jobBits = d.jobBits; bump(c.who, 'jobs'); }
    const changedJobs = d.jobExp.filter((v, i) => v !== c.jobExp[i]).length;
    if (changedJobs) { change.jobExp = d.jobExp; bump(c.who, 'jobs', changedJobs); }

    const unlocked = d.skills.custom.size + d.skills.normal.size + d.skills.abilities.size;
    if (unlocked) {
      const on = (ids) => Object.fromEntries([...ids].map((id) => [id, true]));
      change.skills = { custom: Object.fromEntries(d.skills.custom), normal: on(d.skills.normal), abilities: on(d.skills.abilities) };
      bump(c.who, 'skills', unlocked);
    }

    const nature = {};
    for (const key of Object.keys(c.nature ?? {})) if (d.nature[key] !== c.nature[key]) { nature[key] = d.nature[key]; bump(c.who, 'pawn'); }
    if (Object.keys(nature).length) change.nature = nature;
    if (d.affinity !== wholeAffinity(c)) { change.affinity = d.affinity; bump(c.who, 'pawn'); }
    if (d.plagueReset) { change.plagueReset = true; bump(c.who, 'pawn'); }
    if (d.reviews) {
      const reviews = state.features.ratings.collect(c, d);
      if (reviews) { change.reviews = reviews; bump(c.who, 'pawn', Object.keys(reviews).length); }
    }
    if (Object.keys(change).length) (edits.characters ??= {})[c.who] = change;
  }
  // Hired pawns travel with the main pawn, and so do their changes in the counts.
  if (draft.curedGuests.size) {
    edits.guests = Object.fromEntries([...draft.curedGuests].map((who) => [who, { plagueReset: true }]));
    bump('pawn', 'pawn', draft.curedGuests.size);
  }

  const set = [...draft.itemNum].filter(([index]) => !draft.removed.has(index)).map(([index, num]) => ({ index, num }));
  const enhance = [...draft.enhance].filter(([index]) => !draft.removed.has(index)).map(([index, level]) => ({ index, level }));
  const remove = [...draft.removed];
  counts.items = set.length + enhance.length + remove.length + draft.added.length;
  if (counts.items) edits.items = { set, enhance, remove, add: draft.added };

  counts.looks = Object.keys(draft.looks).length;
  if (counts.looks) edits.looks = { ...draft.looks };

  return { edits, counts, parts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

export function isStale() {
  const { model, file } = state.editor;
  const live = state.data?.files.find((f) => f.name === file);
  return Boolean(model && live && live.mtimeMs !== model.mtimeMs);
}

function blockedReason() {
  const { model, draft } = state.editor;
  if (!model) return null;
  if (!model.exact) return t('blocked.inexact');
  if (state.data?.gameRunning) return t('blocked.gameRunning');
  if (isStale()) return t('blocked.stale');
  if (draft.invalid.size) return t('blocked.invalid');
  return null;
}

function showCount(badge, n) {
  if (!badge) return;
  const before = badge.hidden ? 0 : Number(badge.dataset.n ?? 0);
  badge.hidden = n === 0;
  badge.dataset.n = String(n);
  badge.textContent = String(n);
  if (n && n !== before) replay(badge, 'is-popping');
}

/** Brings the count badges and the apply bar in line with the draft. */
export function updateChangeUI() {
  if (state.view !== 'edit' || !state.editor.model) return updateApplybar();
  const { counts, parts } = collectEdits();
  for (const badge of document.querySelectorAll('[data-count]')) showCount(badge, counts[badge.dataset.count] ?? 0);
  for (const badge of document.querySelectorAll('[data-part-count]')) showCount(badge, parts[badge.dataset.partCount] ?? 0);
  return updateApplybar();
}

export function updateApplybar() {
  const editor = state.editor;
  if (state.view !== 'edit' || !editor.model) {
    applybar.hidden = true;
    return;
  }
  const { total } = collectEdits();
  if (!total && !editor.draft.invalid.size) {
    applybar.hidden = true;
    return;
  }
  const reason = blockedReason();
  const apply = h('button', { class: 'btn btn-primary', disabled: Boolean(reason) || total === 0 }, icon('check'), t('apply.go'));
  apply.addEventListener('click', () => withBusy(apply, applyEdits));
  put(applybar, h('div', { class: 'applybar-inner' },
    h('p', null, h('b', null, tn('apply.changes', total)), ' · ', reason ? h('span', { class: 'why' }, reason) : t('apply.hint')),
    h('button', { class: 'btn btn-ghost', onclick: () => { editor.draft = makeDraft(editor.model); hooks.render(); } }, icon('undo'), t('apply.revert')),
    apply));
  applybar.hidden = false;
}

async function applyEdits() {
  const editor = state.editor;
  const { edits } = collectEdits();
  await api('POST', '/api/save/apply', { account: state.account, file: editor.file, mtimeMs: editor.model.mtimeMs, edits });
  toast(t('apply.done'));
  // Dropping the model makes the refresh below rebuild the editor from the file just written.
  editor.model = null;
  updateApplybar();
  state.dataKey = '';
  await hooks.refresh();
}

/**
 * Whole-number input bound to a draft value. `original` drives the "changed" highlight; an
 * unparsable or out-of-range entry is flagged and blocks applying instead of being guessed at.
 */
export function numberField({ id, label, value, original, min, max, onset, bare = false }) {
  const { draft } = state.editor;
  const input = h('input', { type: 'number', id, min: String(min), max: String(max), step: '1', value: String(value), inputmode: 'numeric', 'aria-label': bare ? label : null });
  const sync = (v, valid) => {
    input.classList.toggle('is-invalid', !valid);
    input.classList.toggle('is-changed', valid && v !== original);
    if (valid) draft.invalid.delete(id);
    else draft.invalid.add(id);
  };
  sync(value, true);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    const valid = input.value.trim() !== '' && Number.isInteger(v) && v >= min && v <= max;
    if (valid) onset(v);
    sync(v, valid);
    updateChangeUI();
  });
  if (bare) return input;
  return h('label', { class: 'field' }, h('span', null, label), input);
}

/** Text input bound to a draft value; `problem` returns why an entry is not acceptable, if it is not. */
export function textField({ id, label, value, original, maxlength, problem, onset }) {
  const { draft } = state.editor;
  const input = h('input', { type: 'text', id, value, maxlength: String(maxlength), autocomplete: 'off', spellcheck: 'false' });
  const sync = () => {
    const text = input.value.trim();
    const why = problem(text);
    input.classList.toggle('is-invalid', Boolean(why));
    input.classList.toggle('is-changed', !why && text !== original);
    input.title = why ?? '';
    if (why) draft.invalid.add(id);
    else draft.invalid.delete(id);
    return why ? null : text;
  };
  sync();
  input.addEventListener('input', () => {
    const text = sync();
    if (text !== null) onset(text);
    updateChangeUI();
  });
  return h('label', { class: 'field' }, h('span', null, label), input);
}

/**
 * Drop-down bound to a draft value. `options` is [value, label, disabled?][]; a current value
 * that is not among them (something a newer game version added) is kept as its own entry.
 */
export function selectField({ label, value, original, options, onset, bare = false }) {
  const known = options.some(([v]) => v === original) ? options : [[original, t('value.unknown', { value: original })], ...options];
  const select = h('select', { 'aria-label': bare ? label : null }, known.map(([v, text, disabled]) =>
    h('option', { value: String(v), selected: v === value, disabled: Boolean(disabled) }, text)));
  select.classList.toggle('is-changed', value !== original);
  select.addEventListener('change', () => {
    const picked = known.find(([v]) => String(v) === select.value)[0];
    select.classList.toggle('is-changed', picked !== original);
    onset(picked);
    updateChangeUI();
  });
  if (bare) return select;
  return h('label', { class: 'field' }, h('span', null, label), select);
}
