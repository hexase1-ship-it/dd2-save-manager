// Reading names, icons and tables out of the installed game. The program ships without any of
// the game's own content; it is all read from the player's copy, once, and again after updates.

import { buildIconSheet } from './icons.js';
import { fmtNum, t } from './i18n.js';
import { api, hooks, loadNames, request, state } from './state.js';
import { h, icon, toast, withBusy } from './ui.js';

let running = null;

/** Builds the name dictionary, the editor layout and the item icons. Calls made meanwhile join in. */
export function rebuildFromGame() {
  running ??= (async () => {
    try {
      const built = await api('POST', '/api/names/rebuild');
      // Names are the part that matters; a PC that cannot build icons still gets those.
      let icons = null;
      try {
        icons = await buildIconSheet(api, request);
      } catch (error) {
        toast(error.message, 'error');
      }
      await loadNames();
      toast(icons === null ? t('names.built', { items: fmtNum(built.items) }) : t('names.builtWithIcons', { items: fmtNum(built.items), icons: fmtNum(icons) }));
      state.dataKey = '';
      await hooks.refresh({ quiet: true });
      hooks.render();
    } finally {
      running = null;
    }
  })();
  return running;
}

export function rebuildButton() {
  const button = h('button', { class: 'btn btn-ghost' }, icon('refresh'), t('names.rebuild'));
  button.addEventListener('click', () => withBusy(button, rebuildFromGame));
  return button;
}

/** What the name dictionary needs from the player, if anything: 'missing', 'outdated', 'no-icons' or null. */
export function namesState() {
  const info = state.data?.names ?? {};
  if (!info.builtAt) return 'missing';
  if (info.buildId && info.gameBuildId && info.buildId !== info.gameBuildId) return 'outdated';
  if (!state.names.icons) return 'no-icons';
  return null;
}

/** On a fresh install, reads the game files without being asked, once the game has been found. */
export async function buildOnFirstRun() {
  const info = state.data?.names;
  if (!info || info.builtAt || !info.gameBuildId) return;
  toast(t('names.firstRun'));
  try {
    await rebuildFromGame();
  } catch (error) {
    toast(error.message, 'error');
  }
}
