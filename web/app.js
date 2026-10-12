// DD2 Save Manager - browser side. Talks to src/server.js on the same origin.
// This file is the window itself: sidebar, title bar, language, and which view is on show.

import { renderBackup } from './backup.js';
import { collectEdits, updateApplybar, updateChangeUI } from './editor-core.js';
import { editorSections, onEditorStateChanged, openEditor, renderEdit } from './editor.js';
import { LANGUAGES, language, preferredLanguage, setLanguage, t } from './i18n.js';
import { buildOnFirstRun } from './rebuild.js';
import { api, hooks, loadNames, state } from './state.js';
import { h, icon, put, stagger, swapView } from './ui.js';

const REFRESH_MS = 5000;
const main = document.getElementById('main');
const nav = document.getElementById('nav');
// The frameless desktop window (launcher/Launcher.cs) hosts this page and takes window commands.
const host = window.chrome?.webview ?? null;
let version = '';

// ---------------------------------------------------------------------------------------
// data loading

async function refresh({ quiet = false } = {}) {
  try {
    const query = state.account ? `?account=${encodeURIComponent(state.account)}` : '';
    const data = await api('GET', `/api/state${query}`);
    const key = JSON.stringify(data);
    state.loadError = null;
    if (key === state.dataKey) return;
    state.data = data;
    state.dataKey = key;
    state.account = data.account?.id ?? null;
    renderChrome();
    if (state.view === 'backup') {
      // Do not rebuild the list under someone who is typing a memo.
      if (!(quiet && main.contains(document.activeElement) && document.activeElement.matches('input'))) renderBackup();
    } else {
      onEditorStateChanged();
    }
  } catch (error) {
    if (quiet) return;
    state.loadError = error.message;
    put(main, h('div', { class: 'view' }, h('div', { class: 'empty' },
      h('p', null, state.loadError),
      h('button', { class: 'btn', onclick: () => refresh() }, icon('refresh'), t('action.retry')))));
  }
}

// ---------------------------------------------------------------------------------------
// window chrome: title bar and sidebar

function renderChrome() {
  document.title = t('app.name');
  document.getElementById('brand-name').textContent = t('app.name');
  document.getElementById('lang-label').textContent = t('app.language');

  const chip = document.getElementById('game-state');
  const data = state.data;
  chip.hidden = !data?.account;
  if (data?.account) {
    chip.dataset.state = data.gameRunning ? 'busy' : 'ok';
    chip.textContent = t(data.gameRunning ? 'game.running' : 'game.closed');
  }

  const foot = document.getElementById('sidebar-foot');
  const accounts = data?.accounts ?? [];
  const select = accounts.length > 1 ? h('select', { 'aria-label': t('app.account'), onchange: (event) => {
    state.account = event.target.value;
    state.dataKey = '';
    state.editor = { ...state.editor, file: null, model: null, draft: null, sheet: null };
    refresh();
  } }, accounts.map((a) => h('option', { value: a.id, selected: a.id === data.account.id }, a.name ? `${a.name} (${a.id})` : a.id))) : null;
  put(foot, select, h('span', { class: 'version num' }, version ? `v${version}` : ''));

  for (const [act, key] of [['minimize', 'window.minimize'], ['maximize', 'window.maximize'], ['close', 'window.close']]) {
    const button = document.querySelector(`.winbtn[data-act="${act}"]`);
    button.title = t(key);
    button.setAttribute('aria-label', t(key));
  }
}

function placeMarker() {
  const marker = nav.querySelector('.nav-marker');
  const active = nav.querySelector('.nav-item[aria-current="page"]');
  if (!marker || !active) return;
  marker.style.setProperty('--y', `${active.offsetTop}px`);
  marker.classList.add('is-placed');
}

function renderNav() {
  const item = (view, glyph, label) => h('button', { class: 'nav-item', dataset: { view }, 'aria-current': state.view === view ? 'page' : null, onclick: () => setView(view) }, icon(glyph), label);
  // The marker is kept across redraws so that it slides instead of jumping.
  const marker = nav.querySelector('.nav-marker') ?? h('span', { class: 'nav-marker', 'aria-hidden': 'true' });
  put(nav, marker, item('backup', 'archive', t('nav.backup')), item('edit', 'edit', t('nav.edit')), h('div', { class: 'nav-sub', id: 'nav-sub', hidden: true }));
  renderSubNav();
  placeMarker();
}

/** Under "Edit": the sections of the open save, each with its count of pending changes. */
function renderSubNav() {
  const sub = document.getElementById('nav-sub');
  if (!sub) return;
  const sections = editorSections();
  sub.hidden = sections.length === 0;
  put(sub, sections.map(([key, label]) => h('a', { href: `#g-${key}`, dataset: { section: key }, onclick: (event) => {
    event.preventDefault();
    document.getElementById(`g-${key}`)?.scrollIntoView({ block: 'start' });
  } }, h('span', null, label), h('span', { class: 'count', dataset: { count: key }, hidden: true }))));
  watchSections();
  updateChangeUI();
}

// Marks the section being read in the sidebar as the page scrolls.
let spy = null;
function watchSections() {
  spy?.disconnect();
  const panels = [...main.querySelectorAll('.panel[id^="g-"]')];
  if (!panels.length) return;
  const seen = new Map();
  spy = new IntersectionObserver((entries) => {
    for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting);
    const here = panels.find((panel) => seen.get(panel.id))?.id.slice(2);
    for (const link of document.querySelectorAll('#nav-sub a')) link.classList.toggle('is-here', link.dataset.section === here);
  }, { root: main, rootMargin: '-10% 0px -60% 0px' });
  for (const panel of panels) spy.observe(panel);
}
document.addEventListener('editor-drawn', renderSubNav);

function renderView({ entering = false } = {}) {
  if (!state.data) return;
  if (state.view === 'backup') {
    renderBackup();
    if (entering && main.firstElementChild) stagger(main.firstElementChild);
  } else {
    renderEdit({ entering });
  }
  renderSubNav();
  updateApplybar();
}

function setView(view) {
  if (view === state.view) return;
  state.view = view;
  state.confirming = null;
  for (const item of nav.querySelectorAll('.nav-item')) {
    if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  placeMarker();
  swapView(() => {
    renderView({ entering: true });
    main.scrollTo({ top: 0, behavior: 'instant' });
  });
}

// ---------------------------------------------------------------------------------------
// language

async function changeLanguage(code) {
  await setLanguage(code);
  // The sheet's labels come from the server in one language; it is asked for again when reopened.
  state.editor.sheet = null;
  renderChrome();
  renderNav();
  renderView();
}

function setupLanguageMenu() {
  const select = document.getElementById('lang-select');
  put(select, LANGUAGES.map(([code, name]) => h('option', { value: code, selected: code === language() }, name)));
  select.addEventListener('change', () => changeLanguage(select.value));
}

// ---------------------------------------------------------------------------------------
// the desktop window

const unsaved = () => Boolean(state.editor.model && collectEdits().total > 0);

function setupWindow() {
  if (!host) return;
  document.documentElement.dataset.hosted = 'true';
  document.getElementById('winbtns').hidden = false;
  document.getElementById('edge-top').hidden = false;
  const send = (action) => host.postMessage({ type: 'window', action });
  for (const button of document.querySelectorAll('.winbtn')) {
    button.addEventListener('click', () => {
      if (button.dataset.act === 'close' && unsaved() && !confirm(t('edit.discardOnClose'))) return;
      send(button.dataset.act);
    });
  }
  document.getElementById('edge-top').addEventListener('mousedown', (event) => {
    if (event.button === 0) send('resize-top');
  });
  host.addEventListener('message', (event) => {
    if (event.data?.type !== 'window-state') return;
    const maximized = Boolean(event.data.maximized);
    document.documentElement.dataset.maximized = String(maximized);
    document.getElementById('edge-top').hidden = maximized;
    document.querySelector('.winbtn[data-act="maximize"] use').setAttribute('href', maximized ? '#i-unmax' : '#i-max');
  });
  send('ready');
}

window.addEventListener('beforeunload', (event) => {
  if (unsaved()) event.preventDefault();
});
window.addEventListener('resize', placeMarker);

// ---------------------------------------------------------------------------------------

hooks.refresh = refresh;
hooks.render = () => renderView();
hooks.openEditor = (fileName) => {
  openEditor(fileName);
  setView('edit');
};

await setLanguage(preferredLanguage());
state.features.ratings = await import('./features/ratings.js').catch(() => null);
setupLanguageMenu();
setupWindow();
renderChrome();
renderNav();
version = await fetch('/version').then((r) => r.json()).then((v) => v.version).catch(() => '');
await loadNames();
await refresh();
if (state.data) {
  renderChrome();
  if (main.firstElementChild) stagger(main.firstElementChild);
  buildOnFirstRun();
}
setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh({ quiet: true }); });
