// Backup view: the saves as they are now, and the copies kept of them.

import { fmtNum, fmtTime, t, tn } from './i18n.js';
import { api, briefCharacter, hooks, jobName, modeBadge, newestGameFile, slotLabel, state, who } from './state.js';
import { h, icon, put, toast, withBusy } from './ui.js';

const main = document.getElementById('main');

export function noSavesView() {
  return h('div', { class: 'empty' },
    h('p', null, t('empty.noSaves')),
    h('button', { class: 'btn', onclick: () => hooks.refresh() }, icon('refresh'), t('action.checkAgain')));
}

export function gameRunningNotice() {
  return h('div', { class: 'notice notice-warn' }, icon('alert'),
    h('p', null, h('strong', null, t('notice.gameRunning.title')), ' ', t('notice.gameRunning.text')));
}

export async function openFolder(which) {
  try {
    await api('POST', '/api/open-folder', { account: state.account, which });
  } catch (error) {
    toast(error.message, 'error');
  }
}

export function renderBackup() {
  const data = state.data;
  if (!data?.account) return put(main, h('div', { class: 'view' }, noSavesView()));

  const newest = newestGameFile(data.files);
  const fileRows = data.files.map((file) => {
    const s = file.summary ?? {};
    if (s.kind !== 'game') {
      return h('tr', { class: 'is-muted' },
        h('td', null, h('div', { class: 'who' }, h('b', null, s.kind === 'system' ? t('slot.system') : file.name), h('small', { class: 'filename' }, file.name))),
        h('td', { colspan: '4' }, t(s.kind === 'system' ? 'backup.systemFile' : 'backup.unreadable')),
        h('td', { class: 'num nowrap' }, fmtTime(file.mtimeMs)),
        h('td', { class: 'actions' }));
    }
    return h('tr', null,
      h('td', null, h('div', { class: 'who' },
        h('b', null, slotLabel(file), file === newest ? [' ', h('span', { class: 'badge badge-accent' }, t('badge.latest'))] : null, s.mode && s.mode !== 'normal' ? [' ', modeBadge(s.mode)] : null),
        h('small', { class: 'filename' }, file.name))),
      h('td', null, h('div', { class: 'who' }, h('b', null, briefCharacter(s.player)), h('small', null, s.player ? jobName(s.player.job) : ''))),
      h('td', null, h('div', { class: 'who' }, h('b', null, briefCharacter(s.pawn)), h('small', null, s.pawn ? jobName(s.pawn.job) : ''))),
      h('td', { class: 'right num' }, fmtNum(s.gold)),
      h('td', { class: 'right num' }, fmtNum(s.rim)),
      h('td', { class: 'num nowrap' }, fmtTime(file.mtimeMs)),
      h('td', { class: 'actions' }, h('button', { class: 'btn', onclick: () => hooks.openEditor(file.name) }, icon('edit'), t('action.edit'))));
  });

  const memo = h('input', { type: 'text', placeholder: t('backup.memoPlaceholder'), maxlength: '200', 'aria-label': t('backup.memoLabel') });
  const backupNow = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('archive'), t('backup.now'));
  const form = h('form', {
    class: 'backup-form',
    onsubmit: (event) => {
      event.preventDefault();
      withBusy(backupNow, async () => {
        await api('POST', '/api/backup', { account: state.account, memo: memo.value });
        memo.value = '';
        toast(t('backup.done'));
        await hooks.refresh();
      });
    },
  }, memo, backupNow);

  const visible = data.backups.filter((b) => !(state.hideAuto && b.kind === 'auto'));
  const autoCount = data.backups.filter((b) => b.kind === 'auto').length;

  put(main, h('div', { class: 'view' },
    h('div', { class: 'view-head' }, h('div', null, h('h2', null, t('backup.title')), h('p', null, t('backup.lede')))),
    h('div', { class: 'stack' },
      data.gameRunning ? gameRunningNotice() : null,
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', null, t('backup.current')),
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', onclick: () => openFolder('saves') }, icon('folder'), t('backup.openSaves')))),
        h('div', { class: 'panel-body' }, h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null,
            h('th', null, t('col.slot')), h('th', null, who('player')), h('th', null, who('pawn')),
            h('th', { class: 'right' }, t('money.gold')), h('th', { class: 'right' }, t('money.rim')), h('th', null, t('col.saved')), h('th', null))),
          h('tbody', null, fileRows))))),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', null, t('backup.list')), h('span', { class: 'meta num' }, tn('backup.count', data.backups.length)),
          h('div', { class: 'actions' },
            autoCount ? h('label', { class: 'check' },
              h('input', { type: 'checkbox', checked: state.hideAuto, onchange: (e) => { state.hideAuto = e.target.checked; renderBackup(); } }),
              t('backup.hideAuto', { n: fmtNum(autoCount) })) : null,
            h('button', { class: 'btn btn-ghost', onclick: () => openFolder('backups') }, icon('folder'), t('backup.openBackups')))),
        h('div', { class: 'panel-body' },
          form,
          visible.length ? backupTable(visible) : h('div', { class: 'empty' },
            h('p', null, t(data.backups.length ? 'backup.emptyHidden' : 'backup.empty'))))),
    )));
  return undefined;
}

function backupKind(backup) {
  if (backup.kind !== 'auto') return h('span', { class: 'badge' }, t('backup.kind.manual'));
  return h('span', { class: 'badge badge-warn' }, t(backup.reason === 'before-restore' ? 'backup.kind.beforeRestore' : 'backup.kind.beforeEdit'));
}

function backupTable(backups) {
  const rows = backups.map((backup) => {
    const when = fmtTime(Date.parse(backup.createdAt));
    if (state.confirming?.id === backup.id) return confirmRow(backup, when);
    const s = newestGameFile(backup.files)?.summary;
    const files = tn('backup.files', backup.files.length);
    const memo = h('input', {
      class: 'memo-input', type: 'text', value: backup.memo, maxlength: '200', placeholder: t('backup.memoAdd'), 'aria-label': t('backup.memoOf', { when }),
      onchange: async (event) => {
        try {
          await api('POST', '/api/backup/memo', { account: state.account, id: backup.id, memo: event.target.value });
          await hooks.refresh({ quiet: true });
        } catch (error) {
          toast(error.message, 'error');
        }
      },
      onkeydown: (event) => { if (event.key === 'Enter') event.target.blur(); },
    });
    const confirm = (action) => () => { state.confirming = { id: backup.id, action }; renderBackup(); };
    return h('tr', null,
      h('td', { class: 'num nowrap' }, when),
      h('td', null, backupKind(backup)),
      h('td', null, memo),
      h('td', null, s
        ? h('div', { class: 'who' }, h('b', null, `${briefCharacter(s.player)} · ${jobName(s.player?.job)}`), h('small', { class: 'num' }, `${fmtNum(s.gold)} G · ${files}`))
        : h('span', { class: 'muted' }, files)),
      h('td', { class: 'actions' },
        h('button', { class: 'btn', disabled: state.data.gameRunning, title: state.data.gameRunning ? t('backup.restoreBlocked') : null, onclick: confirm('restore') }, icon('restore'), t('backup.restore')),
        h('button', { class: 'btn btn-ghost btn-icon', 'aria-label': t('backup.trashOf', { when }), title: t('backup.trash'), onclick: confirm('trash') }, icon('trash'))));
  });
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, h('th', null, t('col.when')), h('th', null, t('col.kind')), h('th', { style: 'width:32%' }, t('col.memo')), h('th', null, t('col.contents')), h('th', null))),
    h('tbody', null, rows)));
}

function confirmRow(backup, when) {
  const restoring = state.confirming.action === 'restore';
  const cancel = h('button', { class: 'btn', onclick: () => { state.confirming = null; renderBackup(); } }, t('action.cancel'));
  const go = h('button', { class: restoring ? 'btn btn-primary' : 'btn btn-danger' }, icon(restoring ? 'restore' : 'trash'), t(restoring ? 'backup.confirmRestore' : 'backup.confirmTrash'));
  go.addEventListener('click', () => withBusy(go, async () => {
    if (restoring) {
      await api('POST', '/api/backup/restore', { account: state.account, id: backup.id });
      toast(t('backup.restored', { when }));
    } else {
      await api('POST', '/api/backup/trash', { account: state.account, id: backup.id });
      toast(t('backup.trashed'));
    }
    state.confirming = null;
    state.dataKey = '';
    await hooks.refresh();
  }));
  const row = h('tr', { class: 'is-confirming' }, h('td', { colspan: '5' },
    h('div', { class: 'confirm' }, h('p', null, t(restoring ? 'backup.restoreText' : 'backup.trashText', { when })), cancel, go)));
  queueMicrotask(() => cancel.focus());
  return row;
}
