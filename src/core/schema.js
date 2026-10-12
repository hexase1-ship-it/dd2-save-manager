// Names for the hashes found in a save, taken from the RSZ type dump
// (data/dd2/rszdd2.json) and the enum dump (data/dd2/enumsdd2.json).
//
// A save stores a class with the fields of its whole inheritance chain, while the dump lists
// only the fields a type declares itself. Fields that are not found on the type are therefore
// looked up by name hash across every type.

import fs from 'node:fs';
import { hashName } from './hash.js';

export class Schema {
  /**
   * @param {Record<string, {name: string, fields: object[]}>} rsz
   * @param {Record<string, Record<string, string>>} enums
   */
  constructor(rsz, enums = {}) {
    this.rsz = rsz;
    this.enums = enums;
    this.byClass = new Map();
    this.global = null;
  }

  static load(rszPath, enumsPath) {
    const rsz = JSON.parse(fs.readFileSync(rszPath, 'utf8'));
    const enums = enumsPath && fs.existsSync(enumsPath) ? JSON.parse(fs.readFileSync(enumsPath, 'utf8')) : {};
    return new Schema(rsz, enums);
  }

  typeName(classHash) {
    return this.rsz[classHash.toString(16)]?.name;
  }

  #classFields(classHash) {
    let map = this.byClass.get(classHash);
    if (!map) {
      map = new Map();
      for (const f of this.rsz[classHash.toString(16)]?.fields ?? []) map.set(hashName(f.name), f);
      this.byClass.set(classHash, map);
    }
    return map;
  }

  #globalFields() {
    if (!this.global) {
      this.global = new Map();
      const hashes = new Map();
      for (const type of Object.values(this.rsz)) {
        for (const f of type.fields) {
          let h = hashes.get(f.name);
          if (h === undefined) hashes.set(f.name, (h = hashName(f.name)));
          let list = this.global.get(h);
          if (!list) this.global.set(h, (list = []));
          if (!list.some((g) => g.name === f.name && g.size === f.size && g.align === f.align && g.original_type === f.original_type)) {
            list.push(f);
          }
        }
      }
    }
    return this.global;
  }

  /** Field declared on the class itself, or undefined when it is inherited/unknown. */
  field(classHash, fieldHash) {
    return this.#classFields(classHash).get(fieldHash);
  }

  /** Every distinct declaration of a field with this name hash, anywhere in the dump. */
  candidates(fieldHash) {
    return this.#globalFields().get(fieldHash) ?? [];
  }

  fieldName(classHash, fieldHash) {
    return this.field(classHash, fieldHash)?.name ?? this.candidates(fieldHash)[0]?.name;
  }

  /** Declared type name of a field (e.g. an enum type), when it can be determined. */
  fieldType(classHash, fieldHash) {
    const own = this.field(classHash, fieldHash);
    if (own) return own.original_type;
    const types = new Set(this.candidates(fieldHash).map((f) => f.original_type));
    return types.size === 1 ? [...types][0] : undefined;
  }

  enumLabel(enumType, value) {
    return this.enums[enumType]?.[String(value)];
  }

  enumValues(enumType) {
    const table = this.enums[enumType];
    if (!table) return undefined;
    return Object.entries(table)
      .filter(([key]) => /^-?\d+$/.test(key))
      .map(([key, label]) => ({ value: Number(key), label }));
  }
}
