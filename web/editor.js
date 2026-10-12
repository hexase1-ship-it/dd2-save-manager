// Edit view: pick a save, then change it section by section. Nothing is written until "apply".

import { fmtNum, fmtTime, gameName, t } from './i18n.js';
import { api, BASIC_JOBS, briefCharacter, gameFiles, INT32_MAX, JOB_COUNT, jobName, modeBadge, modeName, newestGameFile, PAWN_JOBS, slotLabel, state, who } from './state.js';
import { collectEdits, isStale, makeDraft, NAME_MAX, numberField, selectField, STATS, textField, updateChangeUI, wholeAffinity } from './editor-core.js';
import { gameRunningNotice, noSavesView } from './backup.js';
import { renderItems } from './items.js';
import { renderLooks } from './looks.js';
import { skillsPart } from './skills.js';
import { h, icon, put, stagger } from './ui.js';

const main = document.getElementById('main');
const VOICE_TONES = 5; // 1 very low .. 5 very high
const PARTS = ['basic', 'growth', 'jobs', 'skills', 'pawn'];

/** The sections of the editor for the save that is open, as [key, label] for the sidebar. */
export function editorSections() {
  const { model } = state.editor;
  if (state.view !== 'edit' || !model) return [];
  return [
    ['money', t('money.title')],
    model.mode ? ['game', t('game.title')] : null,
    model.portcrystals ? ['travel', t('travel.title')] : null,
    ...model.characters.map((c) => [c.who, who(c.who)]),
    ['items', t('items.title')],
    ['looks', t('looks.title')],
  ].filter(Boolean);
}

export function openEditor(fileName) {
  state.editor.file = fileName;
  state.editor.model = null;
}

/** Save list, game state or presets changed while the editor is open. */
export function onEditorStateChanged() {
  const { model, draft, file } = state.editor;
  if (!model || !gameFiles().some((f) => f.name === file)) return renderEdit();
  const dirty = collectEdits().total > 0 || draft.invalid.size > 0;
  if (isStale() && !dirty) return void loadModel(file);
  renderNotices();
  renderLooks();
  return updateChangeUI();
}

export function renderEdit({ entering = false } = {}) {
  const data = state.data;
  if (!data?.account) return put(main, h('div', { class: 'view' }, noSavesView()));
  const files = gameFiles();
  const head = h('div', { class: 'view-head' }, h('div', null, h('h2', null, t('edit.title')), h('p', null, t('edit.lede'))));
  if (!files.length) {
    return put(main, h('div', { class: 'view' }, head, h('div', { class: 'empty' }, h('p', null, t('edit.noSaves')))));
  }
  const editor = state.editor;
  if (!files.some((f) => f.name === editor.file)) {
    editor.file = newestGameFile(files).name;
    editor.model = null;
  }
  const newest = newestGameFile(files);
  const slots = h('div', { class: 'slots', role: 'group', 'aria-label': t('edit.pick') }, files.map((file) =>
    h('button', {
      class: 'slot', 'aria-pressed': String(file.name === editor.file),
      onclick: () => {
        if (file.name === editor.file) return;
        if (editor.model && collectEdits().total > 0 && !confirm(t('edit.discard'))) return;
        editor.file = file.name;
        editor.model = null;
        renderEdit();
      },
    },
    h('b', null, slotLabel(file), file === newest ? h('span', { class: 'badge badge-accent' }, t('badge.latest')) : null, modeBadge(file.summary.mode)),
    h('small', { class: 'num' }, `${briefCharacter(file.summary.player)} · ${fmtTime(file.mtimeMs)}`))));

  const view = h('div', { class: 'view' }, head,
    h('div', { class: 'stack' }, slots, h('div', { class: 'notices', id: 'editor-notices' }), h('div', { class: 'stack', id: 'editor-root' })));
  put(main, view);
  if (entering) stagger(view);
  if (editor.model) {
    renderNotices();
    renderBody();
    return updateChangeUI();
  }
  return void loadModel(editor.file);
}

async function loadModel(fileName) {
  const editor = state.editor;
  editor.loading = true;
  editor.error = null;
  // A sheet read from the save's own characters describes the file as it was.
  if (editor.sheet?.source.who) editor.sheet = null;
  put(document.getElementById('editor-root'), h('div', { class: 'skeleton-page', 'aria-busy': 'true' },
    h('div', { class: 'skeleton skeleton-row' }), h('div', { class: 'skeleton skeleton-row' }), h('div', { class: 'skeleton skeleton-row' })));
  try {
    const model = await api('GET', `/api/save?account=${encodeURIComponent(state.account)}&file=${encodeURIComponent(fileName)}`);
    if (editor.file !== fileName) return;
    editor.model = model;
    editor.draft = makeDraft(model);
    if (!model.items.some((i) => i.owner === editor.owner)) editor.owner = 'player';
    editor.filter = '';
  } catch (error) {
    if (editor.file !== fileName) return;
    editor.model = null;
    editor.error = error.message;
  } finally {
    editor.loading = false;
  }
  if (state.view !== 'edit') return;
  renderNotices();
  renderBody({ entering: true });
  updateChangeUI();
}

function renderNotices() {
  const box = document.getElementById('editor-notices');
  if (!box) return;
  const { model } = state.editor;
  const notices = [];
  if (state.data.gameRunning) notices.push(gameRunningNotice());
  if (model && !model.exact) {
    notices.push(h('div', { class: 'notice notice-danger' }, icon('alert'),
      h('p', null, h('strong', null, t('notice.readOnly.title')), ' ', t('notice.readOnly.text'))));
  }
  if (isStale()) {
    notices.push(h('div', { class: 'notice notice-warn' }, icon('alert'),
      h('p', null, h('strong', null, t('notice.stale.title')), ' ', t('notice.stale.text')),
      h('button', { class: 'btn', onclick: () => loadModel(state.editor.file) }, icon('refresh'), t('action.reload'))));
  }
  put(box, ...notices);
}

function renderBody({ entering = false } = {}) {
  const root = document.getElementById('editor-root');
  if (!root) return;
  const editor = state.editor;
  if (editor.error) {
    return void put(root, h('div', { class: 'empty' }, h('p', null, editor.error),
      h('button', { class: 'btn', onclick: () => loadModel(editor.file) }, icon('refresh'), t('action.retry'))));
  }
  const { model, draft } = editor;
  if (!model) return;
  draft.invalid.clear();

  const money = h('section', { class: 'panel', id: 'g-money' },
    h('div', { class: 'panel-head' }, h('h3', null, t('money.title'))),
    h('div', { class: 'panel-body' }, h('div', { class: 'fields fields-wide' },
      numberField({ id: 'money-gold', label: t('money.gold'), value: draft.money.gold, original: model.money.gold, min: 0, max: 999999999, onset: (v) => { draft.money.gold = v; } }),
      numberField({ id: 'money-rim', label: t('money.rimLong'), value: draft.money.rim, original: model.money.rim, min: 0, max: 999999999, onset: (v) => { draft.money.rim = v; } }))));

  // Shown only: the mode is kept in several places of the save and the system save together.
  const game = model.mode ? h('section', { class: 'panel', id: 'g-game' },
    h('div', { class: 'panel-head' }, h('h3', null, t('game.title')), h('span', { class: 'meta' }, modeName(model.mode))),
    h('div', { class: 'panel-body' }, h('p', { class: 'note' }, t('game.note')))) : null;

  put(root,
    money,
    game,
    model.portcrystals ? travelPanel() : null,
    model.characters.map(characterPanel),
    h('section', { class: 'panel', id: 'g-items' }),
    h('section', { class: 'panel', id: 'g-looks' }));
  if (entering) [...root.children].forEach((child, i) => { child.style.setProperty('--i', i); child.style.animation = 'rise var(--t-slow) var(--ease-out) both'; child.style.animationDelay = `${Math.min(i, 6) * 30}ms`; });
  renderItems();
  renderLooks();
  document.dispatchEvent(new CustomEvent('editor-drawn'));
}

/** Permanent portcrystals: the ones found so far, and the rest to tick as found. */
function travelPanel() {
  const { model, draft } = state.editor;
  const { all, found } = model.portcrystals;
  const named = new Map((state.names.portcrystals ?? []).map((crystal) => [crystal.id, crystal.name]));
  const count = h('span', { class: 'meta num' });
  const showCount = () => { count.textContent = t('travel.count', { found: found.length + draft.portcrystals.size, total: all.length }); };
  const boxes = [];
  const checks = all.map((id) => {
    const known = found.includes(id);
    const box = h('input', { type: 'checkbox', checked: known || draft.portcrystals.has(id), disabled: known });
    if (!known) {
      boxes.push([id, box]);
      box.addEventListener('change', () => {
        if (box.checked) draft.portcrystals.add(id);
        else draft.portcrystals.delete(id);
        showCount();
        updateChangeUI();
      });
    }
    return h('label', { class: known ? 'check is-done' : 'check' }, box, gameName(named.get(id)) ?? t('travel.unnamed', { id }), known ? h('small', null, t('travel.found')) : null);
  });
  const pickAll = h('button', { class: 'btn btn-ghost', disabled: boxes.length === 0, onclick: () => {
    for (const [id, box] of boxes) {
      box.checked = true;
      draft.portcrystals.add(id);
    }
    showCount();
    updateChangeUI();
  } }, icon('check'), t('travel.pickAll'));
  showCount();
  return h('section', { class: 'panel', id: 'g-travel' },
    h('div', { class: 'panel-head' }, h('h3', null, t('travel.title')), count, h('div', { class: 'actions' }, pickAll)),
    h('div', { class: 'panel-body' },
      h('p', { class: 'lede' }, t('travel.lede')),
      h('div', { class: 'checks' }, checks),
      h('p', { class: 'note' }, t('travel.note'))));
}

/** Dragonsplague of the main pawn and of the pawns hired alongside it, with a way to clear each. */
function plagueTable(c, d) {
  const { model, draft } = state.editor;
  const row = (label, plague, cured, oncure) => {
    const clean = !plague.level && !plague.progress;
    const box = h('input', { type: 'checkbox', checked: cured, 'aria-label': t('plague.resetOf', { name: label }) });
    box.addEventListener('change', () => { oncure(box.checked); updateChangeUI(); });
    return h('tr', null,
      h('td', null, label),
      h('td', { class: 'right num' }, fmtNum(plague.level)),
      h('td', { class: 'right num' }, fmtNum(plague.progress)),
      h('td', null, clean ? h('span', { class: 'muted' }, t('plague.clean')) : h('label', { class: 'check' }, box, t('plague.reset'))));
  };
  const guests = (model.guests ?? []).filter((g) => g.plague);
  return h('div', { class: 'panel-part' },
    h('h4', null, t('plague.title')),
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, t('plague.pawn')), h('th', { class: 'right' }, t('plague.level')), h('th', { class: 'right' }, t('plague.progress')), h('th', null))),
      h('tbody', null,
        row(`${who('pawn')} · ${c.name}`, c.plague, d.plagueReset, (on) => { d.plagueReset = on; }),
        guests.map((g) => row(`${who('guest')} · ${g.name}${g.owner ? ` (${t('guest.owner', { name: g.owner })})` : ''}`, g.plague, draft.curedGuests.has(g.who),
          (on) => { if (on) draft.curedGuests.add(g.who); else draft.curedGuests.delete(g.who); }))))),
    h('p', { class: 'note' }, t('plague.note')));
}

function characterPanel(c) {
  const editor = state.editor;
  const d = editor.draft.characters[c.who];
  const isPawn = c.who === 'pawn';
  const jobLimit = isPawn ? PAWN_JOBS : JOB_COUNT;
  const id = (name) => `${c.who}-${name}`;
  const parts = PARTS.filter((part) => part !== 'pawn' || c.nature);
  if (!parts.includes(editor.part[c.who])) editor.part[c.who] = 'basic';
  const body = h('div', { class: 'panel-body' });

  const basic = () => {
    const options = Array.from({ length: jobLimit }, (_, i) => {
      const locked = i >= BASIC_JOBS && !(d.jobBits & (1 << i));
      return [i + 1, locked ? t('job.locked', { name: jobName(i + 1) }) : jobName(i + 1), locked && i + 1 !== c.job];
    });
    return [
      h('div', { class: 'fields' },
        textField({
          id: id('name'), label: t('character.name'), value: d.name, original: c.name, maxlength: NAME_MAX,
          // A name the game itself accepted is never flagged, whatever its length.
          problem: (text) => (text === c.name || (text && [...text].length <= NAME_MAX && !/[<>]/.test(text)) ? null : t('error.name')),
          onset: (text) => { d.name = text; },
        }),
        selectField({ label: t('character.job'), value: d.job, original: c.job, options, onset: (v) => { d.job = v; } }),
        numberField({ id: id('level'), label: t('character.level'), value: d.level, original: c.level, min: 1, max: 999, onset: (v) => { d.level = v; } }),
        numberField({ id: id('exp'), label: t('character.exp'), value: d.exp, original: c.exp, min: 0, max: INT32_MAX, onset: (v) => { d.exp = v; } }),
        numberField({ id: id('dp'), label: t('character.dp'), value: d.dp, original: c.dp, min: 0, max: INT32_MAX, onset: (v) => { d.dp = v; } })),
      h('p', { class: 'note' }, t(isPawn ? 'character.basicNote.pawn' : 'character.basicNote.player')),
    ];
  };

  const growth = () => [
    h('div', { class: 'fields' }, STATS.map((key) =>
      numberField({ id: id(`stat-${key}`), label: t(`stat.${key}`), value: d.stats[key], original: c.stats[key], min: 0, max: INT32_MAX, onset: (v) => { d.stats[key] = v; } }))),
    h('p', { class: 'note' }, t('character.growthNote')),
  ];

  const jobs = () => {
    const rows = Array.from({ length: JOB_COUNT }, (_, i) => {
      const available = i < jobLimit;
      let unlock;
      if (!available) unlock = h('span', { class: 'muted' }, t('job.arisenOnly'));
      else if (i < BASIC_JOBS) unlock = h('span', { class: 'muted' }, t('job.basic'));
      else {
        const box = h('input', { type: 'checkbox', checked: Boolean(d.jobBits & (1 << i)) });
        box.addEventListener('change', () => {
          d.jobBits = box.checked ? d.jobBits | (1 << i) : d.jobBits & ~(1 << i);
          // A vocation that is locked again cannot stay picked as the one to change to.
          if (!box.checked && d.job === i + 1 && d.job !== c.job) d.job = c.job;
          updateChangeUI();
        });
        unlock = h('label', { class: 'check' }, box, t('job.unlocked'));
      }
      const name = jobName(i + 1);
      return h('tr', { class: available ? null : 'is-muted' },
        h('td', null, h('div', { class: 'job-name' }, h('span', null, name), c.job === i + 1 ? h('span', { class: 'badge badge-accent' }, t('job.current')) : null)),
        h('td', null, unlock),
        h('td', { class: 'right' }, available
          ? numberField({ id: id(`job-${i}`), label: t('job.expOf', { name }), bare: true, value: d.jobExp[i], original: c.jobExp[i], min: 0, max: INT32_MAX, onset: (v) => { d.jobExp[i] = v; } })
          : h('span', { class: 'num muted' }, fmtNum(c.jobExp[i]))));
    });
    return [
      h('div', { class: 'table-wrap' }, h('table', { class: 'jobs' },
        h('thead', null, h('tr', null, h('th', null, t('job.vocation')), h('th', null, t('job.unlock')), h('th', { class: 'right' }, t('job.exp')))),
        h('tbody', null, rows))),
      h('p', { class: 'note' }, t('job.note')),
    ];
  };

  const pawn = () => {
    const named = (table, fallback) => Object.entries(table ?? {}).map(([value, name]) => [Number(value), gameName(name) ?? fallback(value)]);
    const personalities = named(state.names.personalities, (v) => t('value.unknown', { value: v }));
    const subSkills = [[0, t('pawn.noSubSkill')], ...named(state.names.subSkills, (v) => t('value.unknown', { value: v }))];
    const tones = Array.from({ length: VOICE_TONES }, (_, i) => [i + 1, t(`voice.${i + 1}`)]);
    const ratings = state.features.ratings;
    return [
      h('div', { class: 'fields' },
        selectField({ label: t('pawn.personality'), value: d.nature.personality, original: c.nature.personality, options: personalities, onset: (v) => { d.nature.personality = v; } }),
        selectField({ label: t('pawn.voice'), value: d.nature.voiceTone, original: c.nature.voiceTone, options: tones, onset: (v) => { d.nature.voiceTone = v; } }),
        selectField({ label: t('pawn.subSkill'), value: d.nature.subSkill, original: c.nature.subSkill, options: subSkills, onset: (v) => { d.nature.subSkill = v; } }),
        c.affinity !== null
          ? numberField({ id: id('affinity'), label: t('pawn.affinity'), value: d.affinity, original: wholeAffinity(c), min: 0, max: 999, onset: (v) => { d.affinity = v; } })
          : null),
      h('p', { class: 'note' }, t('pawn.note')),
      plagueTable(c, d),
      ratings && d.reviews ? h('div', { class: 'panel-part' }, ratings.render(c, d, { id, numberField })) : null,
    ];
  };

  const content = { basic, growth, jobs, skills: () => skillsPart(c, d), pawn };
  const draw = () => {
    // Only one part is on screen; fields of the part that just left cannot stay flagged.
    for (const key of [...editor.draft.invalid]) if (key.startsWith(`${c.who}-`)) editor.draft.invalid.delete(key);
    put(body, content[editor.part[c.who]]());
  };
  const tabs = h('div', { class: 'segmented', role: 'group', 'aria-label': t('character.parts') }, parts.map((part) => {
    const button = h('button', { 'aria-pressed': String(part === editor.part[c.who]) },
      t(`part.${part}`), h('span', { class: 'count', dataset: { partCount: `${c.who}:${part}` }, hidden: true }));
    button.addEventListener('click', () => {
      editor.part[c.who] = part;
      for (const other of tabs.children) other.setAttribute('aria-pressed', String(other === button));
      draw();
      updateChangeUI();
    });
    return button;
  }));
  draw();

  return h('section', { class: 'panel', id: `g-${c.who}` },
    h('div', { class: 'panel-head' },
      h('h3', null, `${who(c.who)} · ${c.name || t('character.unnamed')}`),
      h('span', { class: 'meta' }, [c.gender ? t(`gender.${c.gender}`) : null, jobName(c.job)].filter(Boolean).join(' · ')),
      h('div', { class: 'actions' }, tabs)),
    body);
}
