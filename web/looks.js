// Appearance: presets saved from characters, applying them, and the sheet that lists a look as
// the values to enter in the game's own character editor.

import { fmtTime, language, t } from './i18n.js';
import { api, hooks, state, who } from './state.js';
import { updateChangeUI } from './editor-core.js';
import { openFolder } from './backup.js';
import { copyText, h, icon, put, toast, withBusy } from './ui.js';

const kind = (data) => `${t(`species.${data.species}`)} · ${t(data.female ? 'gender.female' : 'gender.male')}`;

async function openSheet(source, title) {
  const editor = state.editor;
  const sheet = { source, title, loading: true, error: null, data: null, tab: 0 };
  editor.sheet = sheet;
  renderLooks();
  document.getElementById('look-sheet')?.scrollIntoView({ block: 'nearest' });
  const query = source.id
    ? `id=${encodeURIComponent(source.id)}`
    : `account=${encodeURIComponent(state.account)}&file=${encodeURIComponent(editor.file)}&who=${encodeURIComponent(source.who)}`;
  try {
    sheet.data = await api('GET', `/api/look/sheet?${query}&lang=${language()}`);
  } catch (error) {
    sheet.error = error.message;
  }
  sheet.loading = false;
  if (editor.sheet !== sheet) return;
  renderLooks();
  document.getElementById('look-sheet')?.scrollIntoView({ block: 'start' });
}

const place = (row) => t('sheet.place', { n: row.position, total: row.total });

/** A sheet value in words; the same wording is used on screen and in the copied text. */
function sheetValueText(row) {
  if (row.type === 'number') return String(row.value);
  if (row.type === 'check') return t(row.value ? 'sheet.on' : 'sheet.off');
  if (row.type === 'teeth') return t(row.all ? 'sheet.teethAll' : 'sheet.teethSome');
  if (row.type === 'style') {
    if (row.none) return t('sheet.none');
    return row.position ? place(row) : t('sheet.styleUnknown');
  }
  const colors = [row.color, row.color2].filter(Boolean).join(' + ');
  return row.position ? `${place(row)} ${colors}` : `${t('sheet.colorUnknown')} ${colors}`;
}

function sheetValue(row) {
  const nth = () => [t('sheet.nth', { n: row.position }), h('small', null, ` / ${row.total}`)];
  if (row.type === 'number') {
    return [String(row.value), row.outOfRange ? h('span', { class: 'badge badge-warn', title: t('sheet.outOfRangeHint') }, t('sheet.outOfRange')) : null];
  }
  if (row.type === 'style' && row.position && !row.none) return nth();
  if (row.type === 'color') {
    const swatches = [row.color, row.color2].filter(Boolean).map((color) => h('span', { class: 'swatch', style: `background:${color}`, title: color }));
    return [...swatches, ...(row.position ? nth() : [h('small', null, t('sheet.colorUnknown'))])];
  }
  return sheetValueText(row);
}

function sheetText(sheet) {
  const { data } = sheet;
  const lines = [`${t('sheet.title', { name: sheet.title })} (${kind(data)})`];
  for (const tab of data.tabs) {
    lines.push('', `== ${tab.label} ==`);
    for (const part of tab.parts) {
      lines.push(`[${part.label}]`);
      for (const row of part.rows) {
        lines.push(row.type === 'header' ? `  - ${row.label}` : `${'  '.repeat(row.indent + 1)}${row.label}: ${sheetValueText(row)}`);
      }
    }
  }
  return lines.join('\n');
}

function sheetPanel() {
  const editor = state.editor;
  const sheet = editor.sheet;
  if (!sheet) return null;
  const close = h('button', { class: 'btn btn-ghost btn-icon', 'aria-label': t('sheet.close'), title: t('action.close'), onclick: () => { editor.sheet = null; renderLooks(); } }, icon('x'));
  const head = (meta, ...actions) => h('div', { class: 'part-head' }, h('div', { class: 'who' }, h('b', null, t('sheet.title', { name: sheet.title })), meta), h('div', { class: 'actions' }, actions, close));

  if (sheet.loading) {
    return h('div', { class: 'panel-part sheet', id: 'look-sheet', 'aria-busy': 'true' }, head(null),
      h('div', { class: 'skeleton-page' }, h('div', { class: 'skeleton skeleton-row' }), h('div', { class: 'skeleton skeleton-row' }), h('div', { class: 'skeleton skeleton-row' })));
  }
  if (sheet.error) {
    return h('div', { class: 'panel-part sheet', id: 'look-sheet' }, head(null),
      h('div', { class: 'empty' }, h('p', null, sheet.error),
        h('button', { class: 'btn', onclick: () => openSheet(sheet.source, sheet.title) }, icon('refresh'), t('action.retry'))));
  }

  const { data } = sheet;
  const copy = h('button', { class: 'btn' }, icon('copy'), t('sheet.copy'));
  copy.addEventListener('click', () => withBusy(copy, async () => {
    if (!(await copyText(sheetText(sheet)))) throw new Error(t('sheet.copyFailed'));
    toast(t('sheet.copied'));
  }));
  const tab = data.tabs[Math.min(sheet.tab, data.tabs.length - 1)];
  const tabs = h('div', { class: 'segmented', role: 'group', 'aria-label': t('sheet.tabs') }, data.tabs.map((entry, index) =>
    h('button', { 'aria-pressed': String(entry === tab), onclick: () => { sheet.tab = index; renderLooks(); } }, entry.label)));
  const parts = (tab?.parts ?? []).map((part) => h('section', { class: 'sheet-part' },
    h('h4', null, part.label),
    part.rows.map((row) => (row.type === 'header'
      ? h('p', { class: 'sheet-block' }, row.label)
      : h('div', { class: 'sheet-row', style: `--indent:${row.indent}` }, h('span', null, row.label), h('span', { class: 'sheet-value num' }, sheetValue(row)))))));

  return h('div', { class: 'panel-part sheet', id: 'look-sheet' },
    head(h('small', null, kind(data)), copy),
    h('p', { class: 'note' }, t('sheet.note')),
    data.unknown.length ? h('p', { class: 'note note-warn' }, t('sheet.unknown', { list: data.unknown.join(', ') })) : null,
    tabs,
    h('div', { class: 'sheet-parts' }, parts));
}

export function renderLooks() {
  const section = document.getElementById('g-looks');
  if (!section) return;
  const editor = state.editor;
  const { model, draft } = editor;
  if (!model) return;
  const looks = state.data.looks;
  const withLook = model.characters.filter((c) => c.hasLook);
  const fromLabel = (from) => (from?.who ? `${who(from.who)} ${from.name ?? ''}` : '');

  // Pawns hired from other players are in the save while they travel with the party, so their
  // looks can be saved from here too.
  const guests = (model.guests ?? []).filter((g) => g.hasLook);
  const guestLabel = (g) => `${who('guest')} · ${g.name}${g.owner ? ` (${t('guest.owner', { name: g.owner })})` : ''}`;
  const source = h('select', { 'aria-label': t('looks.character') },
    withLook.map((c) => h('option', { value: c.who }, `${who(c.who)} · ${c.name}`)),
    guests.map((g) => h('option', { value: g.who }, guestLabel(g))));
  const label = h('input', { type: 'text', maxlength: '60', placeholder: t('looks.namePlaceholder') });
  const save = h('button', { class: 'btn', type: 'submit' }, icon('archive'), t('looks.save'));
  const showSheet = h('button', { class: 'btn', type: 'button', onclick: () => openSheet({ who: source.value }, source.selectedOptions[0]?.textContent ?? '') }, icon('list'), t('sheet.show'));
  const saveForm = h('form', {
    class: 'look-save',
    onsubmit: (event) => {
      event.preventDefault();
      withBusy(save, async () => {
        await api('POST', '/api/look/export', { account: state.account, file: editor.file, who: source.value, label: label.value });
        toast(t('looks.saved'));
        label.value = '';
        state.dataKey = '';
        await hooks.refresh({ quiet: true });
      });
    },
  },
  h('label', { class: 'field' }, h('span', null, t('looks.character')), source),
  h('label', { class: 'field' }, h('span', null, t('looks.name')), label),
  save,
  showSheet);

  const pending = Object.entries(draft.looks).map(([target, lookId]) => {
    const look = looks.find((l) => l.id === lookId);
    return h('div', { class: 'pending' }, icon('user'),
      h('span', null, t('looks.pending', { who: who(target), name: look?.label || t('looks.unnamed') })),
      h('button', { class: 'btn btn-ghost', onclick: () => { delete draft.looks[target]; renderLooks(); updateChangeUI(); } }, icon('x'), t('action.cancel')));
  });

  const rows = looks.map((look) => h('tr', null,
    h('td', null, h('div', { class: 'who' }, h('b', null, look.label || t('looks.unnamed')),
      h('small', null, [fromLabel(look.from), look.gender ? t(`gender.${look.gender}`) : null].filter(Boolean).join(' · ')))),
    h('td', { class: 'num nowrap' }, fmtTime(Date.parse(look.createdAt))),
    h('td', { class: 'actions' },
      h('button', { class: 'btn btn-ghost', onclick: () => openSheet({ id: look.id }, look.label || t('looks.unnamed')) }, icon('list'), t('sheet.short')),
      withLook.map((c) => h('button', { class: 'btn', onclick: () => { draft.looks[c.who] = look.id; renderLooks(); updateChangeUI(); } }, t('looks.applyTo', { who: who(c.who) }))),
      h('button', { class: 'btn btn-ghost btn-icon', 'aria-label': t('looks.trashOf', { name: look.label || t('looks.unnamed') }), title: t('backup.trash'),
        onclick: async () => {
          try {
            await api('POST', '/api/look/trash', { id: look.id });
            for (const target of Object.keys(draft.looks)) if (draft.looks[target] === look.id) delete draft.looks[target];
            if (editor.sheet?.source.id === look.id) editor.sheet = null;
            state.dataKey = '';
            await hooks.refresh({ quiet: true });
            updateChangeUI();
          } catch (error) {
            toast(error.message, 'error');
          }
        } }, icon('trash')))));

  put(section,
    h('div', { class: 'panel-head' }, h('h3', null, t('looks.title')),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', onclick: () => openFolder('looks') }, icon('folder'), t('looks.openFolder')))),
    h('div', { class: 'panel-body' },
      h('p', { class: 'lede' }, t('looks.lede')),
      h('div', { class: 'notice' }, icon('user'),
        h('p', null, h('strong', null, t('looks.guests.title')), ' ', guests.length ? t('looks.guests.some', { n: guests.length }) : t('looks.guests.none'))),
      saveForm,
      pending,
      looks.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, t('looks.preset')), h('th', null, t('col.saved')), h('th', null))),
          h('tbody', null, rows)))
        : h('div', { class: 'empty' }, h('p', null, t('looks.empty'))),
      sheetPanel()));
}
