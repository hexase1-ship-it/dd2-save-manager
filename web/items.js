// The item storage of a save: counts, smithing, removing and adding.

import { fmtNum, gameName, t, tn } from './i18n.js';
import { INT32_MAX, itemName, state, who } from './state.js';
import { numberField, selectField, updateChangeUI } from './editor-core.js';
import { namesState, rebuildButton } from './rebuild.js';
import { h, icon, put, toast } from './ui.js';

const ICON_PX = 40; // shown size of an item icon; .item-icon in styles.css uses the same
const SUGGESTION_LIMIT = 8;
// Times a smith has enhanced a piece of equipment; one more step is dragonforging, which is only shown.
const ENHANCE_STEPS = 3;
const OWNERS = ['player', 'pawn', 'storage', 'other'];

// Item ids are grouped by kind in the game's data; these ranges were read off the name list.
function itemCategory(itemId) {
  if (itemId < 1000) return t('category.consumable');
  if (itemId < 3000) return t('category.weapon');
  if (itemId < 3500) return t('category.cloak');
  if (itemId < 4000) return t('category.ring');
  if (itemId < 5000) return t('category.head');
  if (itemId < 6000) return t('category.body');
  if (itemId < 7000) return t('category.legs');
  if (itemId >= 50000) return t('category.loot');
  return t('category.other');
}

const ownerName = (owner) => (owner === 'storage' || owner === 'other' ? t(`owner.${owner}`) : who(owner));
const enhanceLabel = (level) => (level ? tn('enhance.times', level) : t('enhance.none'));

/** The item's picture, cut from the sprite sheet built out of the game's own icon textures. */
function itemIcon(itemId) {
  const sheet = state.names.icons;
  const slot = sheet?.items[itemId];
  if (slot === undefined) return h('span', { class: 'item-icon is-empty', 'aria-hidden': 'true' });
  const x = (slot % sheet.columns) * ICON_PX;
  const y = Math.floor(slot / sheet.columns) * ICON_PX;
  return h('span', {
    class: 'item-icon', 'aria-hidden': 'true',
    style: `background-image:url(/icons.png?v=${encodeURIComponent(sheet.builtAt)});background-size:${sheet.columns * ICON_PX}px ${sheet.rows * ICON_PX}px;background-position:-${x}px -${y}px`,
  });
}

/** Cell showing an item by picture and name, with its id (and English name on hover) for reference. */
function itemCell(itemId) {
  const name = itemName(itemId);
  const text = name
    ? h('div', { class: 'who', title: state.names.items[itemId].en || null }, h('b', null, name), h('small', { class: 'num' }, `ID ${itemId}`))
    : h('div', { class: 'who' }, h('b', { class: 'num' }, `ID ${itemId}`), h('small', null, t('items.unnamed')));
  return h('div', { class: 'item' }, itemIcon(itemId), text);
}

/** Matches a search box entry against an item's id and its name in the current language and in English. */
function itemMatches(itemId, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const name = state.names.items[itemId];
  return String(itemId).includes(q) || Boolean(name && ((gameName(name) ?? '').toLowerCase().includes(q) || (name.en ?? '').toLowerCase().includes(q)));
}

/**
 * Text box that suggests items by name as you type, each with its picture. Names repeat
 * across ids, so picking one writes "name #id" and that id is what parseItemEntry reads.
 */
function itemPicker(placeholder) {
  const input = h('input', { type: 'text', placeholder, autocomplete: 'off', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false' });
  const list = h('ul', { class: 'suggest', role: 'listbox', hidden: true });
  let matches = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const pick = (id) => {
    input.value = `${itemName(id)} #${id}`;
    input.classList.remove('is-invalid');
    close();
  };
  const show = () => {
    put(list, matches.map((id, i) => {
      const row = h('li', { role: 'option', 'aria-selected': String(i === active) },
        itemIcon(id), h('span', null, itemName(id)), h('small', { class: 'num' }, `ID ${id}`));
      // mousedown, not click: the box must not lose focus (and close the list) first.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        pick(id);
      });
      return row;
    }));
    list.hidden = matches.length === 0;
    input.setAttribute('aria-expanded', String(matches.length > 0));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    const ids = query ? Object.keys(state.names.items).filter((id) => itemName(id) && itemMatches(id, query)) : [];
    // Names that start with what was typed come before names that merely contain it.
    const starts = (id) => (itemName(id).toLowerCase().startsWith(query) ? 0 : 1);
    matches = ids.sort((a, b) => starts(a) - starts(b) || a - b).slice(0, SUGGESTION_LIMIT);
    active = -1;
    show();
  });
  input.addEventListener('keydown', (event) => {
    if (list.hidden) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const first = step > 0 ? 0 : matches.length - 1;
      active = active < 0 ? first : (active + step + matches.length) % matches.length;
      show();
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      pick(matches[active]);
    } else if (event.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', close);
  return { root: h('div', { class: 'picker' }, input, list), input };
}

/** Reads "Lantern Oil #85", a bare id, or an exact name from the add-item box. */
function parseItemEntry(text) {
  const value = text.trim();
  const tagged = value.match(/#(\d+)$/) ?? value.match(/^(\d+)$/);
  if (tagged) return Number(tagged[1]);
  const wanted = value.toLowerCase();
  const exact = Object.entries(state.names.items).filter(([, name]) => (gameName(name) ?? '').toLowerCase() === wanted || (name.en ?? '').toLowerCase() === wanted);
  return exact.length === 1 ? Number(exact[0][0]) : null;
}

export function renderItems() {
  const section = document.getElementById('g-items');
  if (!section) return;
  const editor = state.editor;
  const { model, draft } = editor;
  const clearInvalid = () => { for (const id of [...draft.invalid]) if (id.startsWith('item-')) draft.invalid.delete(id); };
  clearInvalid();

  const owners = OWNERS.filter((o) => o !== 'other' || model.items.some((i) => i.owner === 'other'));
  const countOf = (owner) => model.items.filter((i) => i.owner === owner).length + draft.added.filter((a) => a.owner === owner).length;
  const tabs = h('div', { class: 'segmented', role: 'group', 'aria-label': t('items.owner') }, owners.map((owner) =>
    h('button', { 'aria-pressed': String(editor.owner === owner), onclick: () => { editor.owner = owner; renderItems(); updateChangeUI(); } },
      ownerName(owner), h('span', { class: 'n' }, String(countOf(owner))))));

  const search = h('input', { type: 'text', placeholder: t('items.search'), value: editor.filter, 'aria-label': t('items.search') });
  search.addEventListener('input', () => {
    editor.filter = search.value.trim();
    fillRows();
  });

  const tbody = h('tbody');
  const fillRows = () => {
    clearInvalid();
    const match = (itemId) => itemMatches(itemId, editor.filter);
    const rows = [];
    draft.added.forEach((added, n) => {
      if (added.owner !== editor.owner || !match(added.itemId)) return;
      rows.push(h('tr', { class: 'is-added' },
        h('td', null, itemCell(added.itemId)),
        h('td', null, itemCategory(added.itemId)),
        h('td', null),
        h('td', { class: 'right num' }, String(added.num)),
        h('td', null, h('span', { class: 'badge badge-accent' }, t('items.toAdd'))),
        h('td', { class: 'actions' }, h('button', { class: 'btn btn-ghost', onclick: () => { draft.added.splice(n, 1); renderItems(); updateChangeUI(); } }, icon('x'), t('action.cancel')))));
    });
    for (const item of model.items) {
      if (item.owner !== editor.owner || !match(item.itemId)) continue;
      const removed = draft.removed.has(item.index);
      const label = itemName(item.itemId) ?? `ID ${item.itemId}`;
      const num = removed
        ? h('span', { class: 'num' }, String(item.num))
        : numberField({
          id: `item-${item.index}`, label: t('items.countOf', { name: label }), bare: true, min: 1, max: 999,
          value: draft.itemNum.get(item.index) ?? item.num, original: item.num,
          onset: (v) => { if (v === item.num) draft.itemNum.delete(item.index); else draft.itemNum.set(item.index, v); },
        });
      // Smithing: weapons and armor only; a dragonforged piece is shown and left alone.
      let enhance = null;
      if (item.enhance !== null) {
        const dragonforged = item.enhance > ENHANCE_STEPS;
        enhance = removed || dragonforged
          ? h('span', { class: 'muted' }, dragonforged ? t('enhance.dragon') : enhanceLabel(item.enhance))
          : selectField({
            label: t('items.enhanceOf', { name: label }), bare: true, value: draft.enhance.get(item.index) ?? item.enhance, original: item.enhance,
            options: Array.from({ length: ENHANCE_STEPS + 1 }, (_, level) => [level, enhanceLabel(level)]),
            onset: (v) => { if (v === item.enhance) draft.enhance.delete(item.index); else draft.enhance.set(item.index, v); },
          });
      }
      const action = removed
        ? h('button', { class: 'btn btn-ghost', onclick: () => { draft.removed.delete(item.index); fillRows(); updateChangeUI(); } }, icon('undo'), t('items.keep'))
        : h('button', { class: 'btn btn-ghost btn-icon', disabled: item.equipped, 'aria-label': t('items.removeOf', { name: label }), title: t(item.equipped ? 'items.removeBlocked' : 'items.remove'),
          onclick: () => { draft.removed.add(item.index); fillRows(); updateChangeUI(); } }, icon('trash'));
      rows.push(h('tr', { class: removed ? 'is-removed' : null },
        h('td', null, itemCell(item.itemId)),
        h('td', null, itemCategory(item.itemId)),
        h('td', null, enhance),
        h('td', { class: 'right' }, num),
        h('td', null, removed ? h('span', { class: 'badge badge-warn' }, t('items.toRemove')) : item.equipped ? h('span', { class: 'badge' }, t('items.equipped')) : null),
        h('td', { class: 'actions' }, action)));
    }
    if (!rows.length) {
      rows.push(h('tr', null, h('td', { colspan: '6', class: 'muted' }, editor.filter ? t('items.noMatch') : t('items.emptyOwner', { owner: ownerName(editor.owner) }))));
    }
    put(tbody, ...rows);
  };
  fillRows();

  const addable = editor.owner === 'other' ? 'storage' : editor.owner;
  const owner = h('select', { 'aria-label': t('items.addTo') }, ['player', 'pawn', 'storage'].map((o) => h('option', { value: o, selected: o === addable }, ownerName(o))));
  const known = Object.keys(state.names.items).length > 0;
  const picker = itemPicker(t(known ? 'items.pickByName' : 'items.pickById'));
  const itemEntry = picker.input;
  const num = h('input', { type: 'number', min: '1', max: '999', step: '1', value: '1' });
  const add = h('form', {
    class: 'add-item',
    onsubmit: (event) => {
      event.preventDefault();
      const id = parseItemEntry(itemEntry.value);
      const n = Number(num.value);
      const idOk = id !== null && id >= 1 && id <= INT32_MAX;
      const numOk = Number.isInteger(n) && n >= 1 && n <= 999;
      itemEntry.classList.toggle('is-invalid', !idOk);
      num.classList.toggle('is-invalid', !numOk);
      if (!idOk || !numOk) return;
      if (model.itemSlots.free - draft.added.length <= 0) { toast(t('error.full'), 'error'); return; }
      draft.added.unshift({ owner: owner.value, itemId: id, num: n });
      editor.owner = owner.value;
      renderItems();
      updateChangeUI();
    },
  },
  h('label', { class: 'field field-owner' }, h('span', null, t('items.addTo')), owner),
  h('label', { class: 'field field-item' }, h('span', null, t('items.item')), picker.root),
  h('label', { class: 'field' }, h('span', null, t('items.count')), num),
  h('button', { class: 'btn', type: 'submit' }, icon('plus'), t('items.add')));

  const need = namesState();
  put(section,
    h('div', { class: 'panel-head' }, h('h3', null, t('items.title')),
      h('span', { class: 'meta num' }, t('items.free', { free: fmtNum(model.itemSlots.free - draft.added.length), total: fmtNum(model.itemSlots.total) }))),
    h('div', { class: 'panel-body' },
      h('div', { class: 'item-tools' }, tabs, search),
      h('div', { class: 'table-wrap table-scroll' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, t('items.item')), h('th', null, t('items.category')), h('th', null, t('items.enhance')),
          h('th', { class: 'right' }, t('items.count')), h('th', null, t('items.status')), h('th', null))),
        tbody)),
      h('div', { class: 'panel-part' },
        h('h4', null, t('items.addTitle')),
        add,
        h('p', { class: 'note' }, t('items.note')),
        h('p', { class: 'note' }, t('items.enhanceNote'))),
      h('div', { class: 'panel-part names-row' },
        h('p', { class: need ? 'note note-warn' : 'note' }, t(`names.state.${need ?? 'ok'}`)), rebuildButton())));
}
