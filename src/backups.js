// Snapshots of the whole save folder, kept under backups/<account>/<id>/.
//
// A snapshot is every data*.bin file as it was, plus meta.json. Nothing here deletes data:
// "removing" a snapshot moves it to backups/<account>/_trash/.

import fs from 'node:fs';
import path from 'node:path';
import { isSaveFileName, listSaveFiles } from './steam.js';

const ID_PATTERN = /^\d{8}-\d{6}(-\d+)?$/;
const TRASH = '_trash';
const META = 'meta.json';
const MEMO_MAX = 200;

export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function stamp(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Writes a file so that a crash mid-write cannot leave a half-written save behind. */
export function writeFileAtomic(target, data) {
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, target);
}

export class BackupStore {
  /**
   * @param {string} root      backups/<account>
   * @param {string} saveDir   live save folder
   * @param {(file: Buffer) => object | null} summarize  describes a save file for meta.json
   */
  constructor(root, saveDir, summarize) {
    this.root = root;
    this.saveDir = saveDir;
    this.summarize = summarize;
  }

  #dir(id) {
    if (!ID_PATTERN.test(id)) throw new BackupError('bad-id', 'Unknown backup.');
    const dir = path.join(this.root, id);
    if (!fs.existsSync(path.join(dir, META))) throw new BackupError('not-found', 'That backup no longer exists.');
    return dir;
  }

  #readMeta(dir) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8'));
    } catch {
      return null;
    }
  }

  list() {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root)
      .filter((id) => ID_PATTERN.test(id))
      .map((id) => this.#readMeta(path.join(this.root, id)))
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  filePath(id, name) {
    if (!isSaveFileName(name)) throw new BackupError('bad-file', 'Unknown save file.');
    const file = path.join(this.#dir(id), name);
    if (!fs.existsSync(file)) throw new BackupError('not-found', 'That backup does not contain this file.');
    return file;
  }

  /** @param {{kind: 'manual' | 'auto', memo?: string, reason?: string}} options */
  create({ kind, memo = '', reason = '' }) {
    const files = listSaveFiles(this.saveDir);
    if (!files.length) throw new BackupError('empty', 'There are no save files to back up.');

    const now = new Date();
    let id = stamp(now);
    for (let n = 2; fs.existsSync(path.join(this.root, id)); n++) id = `${stamp(now)}-${n}`;
    const dir = path.join(this.root, id);
    fs.mkdirSync(dir, { recursive: true });

    const summaries = {};
    for (const f of files) {
      const data = fs.readFileSync(path.join(this.saveDir, f.name));
      fs.writeFileSync(path.join(dir, f.name), data);
      fs.utimesSync(path.join(dir, f.name), new Date(f.mtimeMs), new Date(f.mtimeMs));
      summaries[f.name] = this.summarize(data);
    }
    const meta = {
      id,
      createdAt: now.toISOString(),
      kind,
      reason,
      memo: String(memo).slice(0, MEMO_MAX),
      files: files.map((f) => ({ ...f, summary: summaries[f.name] })),
    };
    fs.writeFileSync(path.join(dir, META), JSON.stringify(meta, null, 2));
    return meta;
  }

  setMemo(id, memo) {
    const dir = this.#dir(id);
    const meta = this.#readMeta(dir);
    if (!meta) throw new BackupError('not-found', 'That backup no longer exists.');
    meta.memo = String(memo).slice(0, MEMO_MAX);
    fs.writeFileSync(path.join(dir, META), JSON.stringify(meta, null, 2));
    return meta;
  }

  /**
   * Makes the live save folder match a snapshot. The current saves are snapshotted first, so
   * save files that the snapshot does not contain can be taken out of the live folder.
   */
  restore(id) {
    const dir = this.#dir(id);
    const names = fs.readdirSync(dir).filter(isSaveFileName);
    if (!names.length) throw new BackupError('empty', 'That backup contains no save files.');

    const safety = listSaveFiles(this.saveDir).length ? this.create({ kind: 'auto', reason: 'before-restore' }) : null;
    fs.mkdirSync(this.saveDir, { recursive: true });
    for (const name of names) writeFileAtomic(path.join(this.saveDir, name), fs.readFileSync(path.join(dir, name)));
    if (safety) {
      for (const f of listSaveFiles(this.saveDir)) {
        if (!names.includes(f.name)) fs.rmSync(path.join(this.saveDir, f.name));
      }
    }
    return { restored: names, safety };
  }

  trash(id) {
    const dir = this.#dir(id);
    const trashRoot = path.join(this.root, TRASH);
    fs.mkdirSync(trashRoot, { recursive: true });
    let target = path.join(trashRoot, id);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(trashRoot, `${id}-${n}`);
    fs.renameSync(dir, target);
  }
}
