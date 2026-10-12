// Appearance presets exported from saves, kept as JSON files under looks/.

import fs from 'node:fs';
import path from 'node:path';

const ID_PATTERN = /^\d{8}-\d{6}(-\d+)?$/;
const TRASH = '_trash';
const LABEL_MAX = 60;

export class LookError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export class LookStore {
  constructor(root) {
    this.root = root;
  }

  #file(id) {
    if (!ID_PATTERN.test(id)) throw new LookError('bad-id', 'Unknown appearance preset.');
    const file = path.join(this.root, `${id}.json`);
    if (!fs.existsSync(file)) throw new LookError('not-found', 'That appearance preset no longer exists.');
    return file;
  }

  list() {
    if (!fs.existsSync(this.root)) return [];
    const looks = [];
    for (const name of fs.readdirSync(this.root)) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !ID_PATTERN.test(id)) continue;
      try {
        const { label, createdAt, from, gender } = JSON.parse(fs.readFileSync(path.join(this.root, name), 'utf8'));
        looks.push({ id, label, createdAt, from, gender });
      } catch {
        // A preset that cannot be read is simply not offered.
      }
    }
    return looks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  read(id) {
    return JSON.parse(fs.readFileSync(this.#file(id), 'utf8'));
  }

  save(look, label) {
    fs.mkdirSync(this.root, { recursive: true });
    const now = new Date();
    let id = stamp(now);
    for (let n = 2; fs.existsSync(path.join(this.root, `${id}.json`)); n++) id = `${stamp(now)}-${n}`;
    const entry = { ...look, label: String(label || look.from?.name || '').slice(0, LABEL_MAX), createdAt: now.toISOString() };
    fs.writeFileSync(path.join(this.root, `${id}.json`), JSON.stringify(entry));
    return { id, label: entry.label, createdAt: entry.createdAt, from: entry.from, gender: entry.gender };
  }

  trash(id) {
    const file = this.#file(id);
    const trashRoot = path.join(this.root, TRASH);
    fs.mkdirSync(trashRoot, { recursive: true });
    let target = path.join(trashRoot, `${id}.json`);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(trashRoot, `${id}-${n}.json`);
    fs.renameSync(file, target);
  }
}
