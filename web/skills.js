// Skills and augments of a character: what the vocation guild sells, by vocation, to unlock.
// Unlocking only goes up; a skill that is already learned stays as it is.

import { gameName, t } from './i18n.js';
import { JOB_COUNT, PAWN_JOBS, jobName, state } from './state.js';
import { selectField, updateChangeUI } from './editor-core.js';
import { rebuildButton } from './rebuild.js';
import { h, icon, put } from './ui.js';

const KINDS = ['custom', 'normal', 'abilities'];

/** How far each skill of a vocation is unlocked, counting what the draft is about to unlock. */
function progress(c, d, job) {
  const lists = state.names.skills;
  const out = {};
  for (const kind of KINDS) {
    const all = lists[kind].filter((skill) => skill.job === job && skill.id in c.skills[kind]);
    const have = all.filter((skill) => (kind === 'custom' ? (d.skills.custom.get(skill.id) ?? c.skills.custom[skill.id]) > 0 : c.skills[kind][skill.id] || d.skills[kind].has(skill.id)));
    out[kind] = { all, have: have.length };
  }
  return out;
}

function unlockJob(c, d, job) {
  const { custom, normal, abilities } = progress(c, d, job);
  for (const skill of custom.all) {
    if (c.skills.custom[skill.id] < skill.names.length) d.skills.custom.set(skill.id, skill.names.length);
  }
  for (const [kind, list] of [['normal', normal], ['abilities', abilities]]) {
    for (const skill of list.all) if (!c.skills[kind][skill.id]) d.skills[kind].add(skill.id);
  }
}

/** The "skills and augments" part of a character's panel. */
export function skillsPart(c, d) {
  const editor = state.editor;
  const root = h('div', { class: 'part-body' });
  if (!state.names.skills || !c.skills) {
    put(root, h('div', { class: 'notice' }, icon('alert'), h('p', null, t('skills.noData')), rebuildButton()));
    return root;
  }
  const jobs = Array.from({ length: c.who === 'pawn' ? PAWN_JOBS : JOB_COUNT }, (_, i) => i + 1);
  if (!jobs.includes(editor.skillJob[c.who])) editor.skillJob[c.who] = jobs.includes(d.job) ? d.job : 1;

  // Redrawing replaces the controls, so the one in use is found again by its place in the list.
  const draw = () => {
    const controls = () => [...root.querySelectorAll('select, input, button')];
    const focused = controls().indexOf(document.activeElement);
    render();
    if (focused >= 0) controls()[focused]?.focus();
  };
  const render = () => {
    const job = editor.skillJob[c.who];
    const lists = progress(c, d, job);
    const jobSelect = h('select', { 'aria-label': t('skills.job') }, jobs.map((j) => h('option', { value: String(j), selected: j === job }, jobName(j))));
    jobSelect.addEventListener('change', () => { editor.skillJob[c.who] = Number(jobSelect.value); draw(); });
    const bulk = (label, run) => h('button', { class: 'btn', onclick: () => { run(); draw(); updateChangeUI(); } }, icon('unlock'), label);

    const weaponRows = lists.custom.all.map((skill) => {
      const current = c.skills.custom[skill.id];
      const level = d.skills.custom.get(skill.id) ?? current;
      const options = [[0, t('skills.locked'), current > 0]];
      skill.names.forEach((name, i) => options.push([i + 1, skill.names.length > 1 ? gameName(name) : t('skills.learned'), i + 1 < current]));
      return h('div', { class: level ? 'skill-row' : 'skill-row is-off' },
        h('span', null, gameName(skill.names[0])),
        selectField({
          label: gameName(skill.names[0]), bare: true, value: level, original: current, options,
          onset: (v) => { if (v === current) d.skills.custom.delete(skill.id); else d.skills.custom.set(skill.id, v); draw(); },
        }));
    });
    const toggles = (kind) => lists[kind].all.map((skill) => {
      const had = Boolean(c.skills[kind][skill.id]);
      const box = h('input', { type: 'checkbox', checked: had || d.skills[kind].has(skill.id), disabled: had });
      box.addEventListener('change', () => {
        if (box.checked) d.skills[kind].add(skill.id);
        else d.skills[kind].delete(skill.id);
        draw();
        updateChangeUI();
      });
      return h('div', { class: box.checked ? 'skill-row' : 'skill-row is-off' }, h('label', { class: 'check' }, box, gameName(skill.name)));
    });
    const list = (title, { all, have }, rows) => (all.length ? h('div', { class: 'skill-list' },
      h('h4', null, title, h('small', null, `${have} / ${all.length}`)), rows) : null);

    put(root,
      h('div', { class: 'part-head' },
        jobSelect,
        h('div', { class: 'actions' },
          bulk(t('skills.unlockJob'), () => unlockJob(c, d, job)),
          bulk(t('skills.unlockAll'), () => { for (const j of jobs) unlockJob(c, d, j); }))),
      h('div', { class: 'skill-cols' },
        list(t('skills.weapon'), lists.custom, weaponRows),
        list(t('skills.core'), lists.normal, toggles('normal')),
        list(t('skills.augments'), lists.abilities, toggles('abilities'))),
      h('p', { class: 'note' }, t('skills.note')));
  };
  draw();
  return root;
}
