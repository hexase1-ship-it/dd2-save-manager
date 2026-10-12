// Small DOM helpers shared by every view.

const toasts = document.getElementById('toasts');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** Creates an element. Children may be nested lists; null and false are skipped. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

/** replaceChildren that, like h(), skips null/false children. */
export function put(parent, ...children) {
  parent?.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function toast(message, kind = 'ok') {
  const el = h('div', { class: 'toast', dataset: { kind } }, icon(kind === 'error' ? 'alert' : 'check'), h('p', null, message));
  toasts.append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 180);
  }, kind === 'error' ? 7000 : 4500);
}

/** Runs a task behind a button: the button shows it is busy, and a failure becomes a toast. */
export async function withBusy(button, task) {
  button.dataset.busy = 'true';
  try {
    return await task();
  } catch (error) {
    toast(error.message, 'error');
    return undefined;
  } finally {
    delete button.dataset.busy;
  }
}

/** Puts text on the clipboard; falls back to a selection copy where the clipboard API is refused. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No permission, or the window is not focused: try the older way below.
  }
  const area = h('textarea', { class: 'visually-hidden', readonly: true, 'aria-hidden': 'true' });
  area.value = text;
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  return copied;
}

/**
 * Swaps what is on screen with a short cross-fade, where the browser can do that and the user
 * has not asked for less motion. Used for changes of view, not for edits within one.
 */
export function swapView(render) {
  if (!document.startViewTransition || reducedMotion.matches) return render();
  document.startViewTransition(render);
  return undefined;
}

/** Lets the children of a freshly shown view arrive one after another, once. */
export function stagger(view) {
  [...view.children].forEach((child, i) => child.style.setProperty('--i', i));
  for (const stack of view.querySelectorAll(':scope > .stack')) {
    [...stack.children].forEach((child, i) => child.style.setProperty('--i', i + 1));
  }
  view.classList.add('is-entering');
  setTimeout(() => view.classList.remove('is-entering'), 700);
}

/** Replays a one-shot animation class on an element. */
export function replay(el, name) {
  el.classList.remove(name);
  void el.offsetWidth;
  el.classList.add(name);
}
