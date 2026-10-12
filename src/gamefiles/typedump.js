// The type and enum dumps (data/dd2/rszdd2.json, enumsdd2.json) say how the game's data tables
// are laid out and what its enum values are called. They are large, and a rebuild only looks
// at a small part of them; a release ships just that part (tools/package.mjs).

import fs from 'node:fs';

/**
 * While `record` is a Map, every dump that is loaded notes which of its entries get looked at:
 * file -> Set of keys. The packaging tool turns this on to cut the dumps down to what is used.
 */
export const usage = { record: null };

/** Contents of a dump file. */
export function loadDump(file) {
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!usage.record) return dump;
  const seen = usage.record.get(file) ?? usage.record.set(file, new Set()).get(file);
  return new Proxy(dump, {
    get(target, key) {
      if (typeof key === 'string' && Object.hasOwn(target, key)) seen.add(key);
      return target[key];
    },
  });
}
