// Builds the name dictionary from the installed game's own files, so names match the game
// version the player has, in every language this program speaks: items, vocations, what pawns
// are like, the permanent portcrystals, and the skills and augments of each vocation.
//
// Every name is kept as { en, ko, ja, zh, es, fr }.

import fs from 'node:fs';
import path from 'node:path';
import { LANGUAGES, parseMsg } from './msg.js';
import { GameFiles } from './pak.js';
import { parseRsz, RszError } from './rsz.js';
import { loadDump } from './typedump.js';

const UI = 'natives/stm/message/ui';
const ITEM_FILES = [`${UI}/itemname`, `${UI}/itemname_end`];
const JOB_FILE = `${UI}/job`;
const PERSONALITY_FILE = `${UI}/personality`;
const SUB_SKILL_FILES = [`${UI}/subskill`, `${UI}/subskill_tu_end`];
// Names that other names point at with <REF entry_name>.
const ITEM_REFERENCES = [`${UI}/appraisalitemname_tu_end`];
const AREA_FILES = [`${UI}/aiareaname`, `${UI}/aiareaname_end`, `${UI}/ailocalareaname`, `${UI}/ailocalareaname_end`];
const PORTCRYSTAL_FILES = [`${UI}/ui060201`, `${UI}/ui060201_end`, `${UI}/ui060201_tu_end`, `${UI}/casual_1_2`];
const DLC_SLOTS = 40;
const JOB_COUNT = 10;
// The number after ".msg." is the format version; it has gone up with game updates.
const MSG_VERSIONS = [24, 25, 26, 27, 28, 23, 22];
const USER_VERSIONS = [3, 4, 2];

// Tables behind the game's vocation menu and its map. "ex" files hold what later updates added.
const JOB_MENU = 'natives/stm/appsystem/gui/jobmenu';
const WEAPON_SKILL_TABLES = [`${JOB_MENU}/customskillinformationdata`, `${JOB_MENU}/excustomskillinformationdata`];
const CORE_SKILL_TABLES = [`${JOB_MENU}/normalskillinformationdata`, `${JOB_MENU}/exnormalskillinformationdata`];
const AUGMENT_TABLES = [`${JOB_MENU}/abilityinformationdata`, `${JOB_MENU}/exabilityinformationdata`, `${JOB_MENU}/contents0014abilityinformationdata`];
const PORTCRYSTAL_TABLE = 'natives/stm/appsystem/gui/userdata/foundationdata';

// A pawn's inclination as saves store it, in the order of the game's Personality_00.. entries.
const PERSONALITY_IDS = [1477799926, -477469187, 81586066, 1301972698];

export class NamesError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readVersioned(files, base, extension, versions) {
  for (const version of versions) {
    const data = files.extract(`${base}.${extension}.${version}`);
    if (data) return data;
  }
  return null;
}

/** Message entries of several files, findable by entry name and by id. */
class Messages {
  constructor(files, bases) {
    this.byName = new Map();
    this.byGuid = new Map();
    this.entries = [];
    for (const base of bases) {
      const data = readVersioned(files, base, 'msg', MSG_VERSIONS);
      if (!data) continue;
      for (const entry of parseMsg(data).entries) {
        this.entries.push(entry);
        this.byName.set(entry.name.toLowerCase(), entry);
        this.byGuid.set(entry.guid, entry);
      }
    }
  }

  /**
   * Plain text of an entry in every language, or null when it has none. <REF x> pulls in
   * another entry; other tags (such as <EQABI ...>, a prefix the game picks per item) have no
   * fixed text; unused entries are marked #Rejected#.
   */
  name(entry, references = this) {
    if (!entry) return null;
    const out = {};
    for (const [code, language] of Object.entries(LANGUAGES)) {
      const text = entry.text[language];
      out[code] = !text || text.includes('#Rejected#') ? '' : text
        .replace(/<REF ([^>]+)>/gi, (_, name) => references.byName.get(name.toLowerCase())?.text[language] ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    return out.en || out.ko ? out : null;
  }

  /** The name an entry points at with its first <REF x>, when it has one. */
  referenced(entry, references) {
    const target = entry?.text[LANGUAGES.en]?.match(/<REF ([^>]+)>/i)?.[1];
    return target ? references.name(references.byName.get(target.toLowerCase())) : null;
  }
}

/** Records of one type from a data table, with the table's root; empty when the game lacks the file. */
function readTable(files, base, layouts, type) {
  const data = readVersioned(files, base, 'user', USER_VERSIONS);
  if (!data) return [];
  const parsed = parseRsz(data, layouts);
  if (parsed.unread !== 0) throw new RszError(`${base}: the table no longer matches the type dump.`);
  // Each table groups its records in sets, one per vocation.
  const rows = [];
  for (const set of parsed.instances) {
    if (!set || !Array.isArray(set.fields._Params) || set.fields._Job === undefined) continue;
    for (const item of set.fields._Params) {
      const record = parsed.instances[item.ref];
      if (record?.type === type) rows.push({ job: set.fields._Job, ...record.fields });
    }
  }
  return rows;
}

/** Weapon skills, core skills and augments by vocation, as the vocation menu lists them. */
function readSkills(files, layouts) {
  const acts = [];
  for (let job = 1; job <= JOB_COUNT; job++) {
    const base = `${UI}/job${String(job).padStart(2, '0')}act`;
    acts.push(base, `${base}_tu_end`);
  }
  const messages = new Messages(files, acts);
  const nameOf = (guid) => messages.name(messages.byGuid.get(guid));

  // A weapon skill has a row per level. Later tables add an "EX" form of some skills as extra
  // rows under a level that is already there; the first row of a level is the level itself.
  const weapon = new Map();
  for (const base of WEAPON_SKILL_TABLES) {
    const known = new Set(weapon.keys());
    for (const row of readTable(files, base, layouts, 'app.CustomSkillInformationParam')) {
      if (!row._SkillID || known.has(row._SkillID)) continue;
      const skill = weapon.get(row._SkillID) ?? weapon.set(row._SkillID, { id: row._SkillID, job: row.job, levels: [] }).get(row._SkillID);
      if (row._Level >= 1 && !skill.levels[row._Level - 1]) skill.levels[row._Level - 1] = { guid: row._SkillName, name: nameOf(row._SkillName) };
    }
  }
  const custom = [];
  for (const skill of weapon.values()) {
    // A skill that cannot be upgraded repeats its own name on the second level.
    const names = skill.levels.filter((level, i) => level?.name && (i === 0 || level.guid !== skill.levels[0]?.guid)).map((level) => level.name);
    if (names.length) custom.push({ id: skill.id, job: skill.job, names });
  }

  const single = (bases, type, idField, nameField) => {
    const out = new Map();
    for (const base of bases) {
      for (const row of readTable(files, base, layouts, type)) {
        const name = nameOf(row[nameField]);
        if (row[idField] && name && !out.has(row[idField])) out.set(row[idField], { id: row[idField], job: row.job, name });
      }
    }
    return [...out.values()];
  };
  return {
    custom,
    normal: single(CORE_SKILL_TABLES, 'app.NormalSkillInformationParam', '_SkillID', '_SkillName'),
    abilities: single(AUGMENT_TABLES, 'app.AbilityInformationParam', '_AbilityID', '_AbilityName'),
  };
}

/** Permanent portcrystals of the main map, in the game's order, named after where they stand. */
function readPortcrystals(files, layouts) {
  const data = readVersioned(files, PORTCRYSTAL_TABLE, 'user', USER_VERSIONS);
  if (!data) return [];
  const parsed = parseRsz(data, layouts);
  if (parsed.unread !== 0) throw new RszError('The portcrystal table no longer matches the type dump.');
  const labels = new Messages(files, PORTCRYSTAL_FILES);
  const areas = new Messages(files, AREA_FILES);
  return parsed.instances.filter((i) => i?.type === 'app.FoundationParam').map(({ fields }) => {
    const entry = labels.byGuid.get(fields._NameId);
    return { id: fields._FoundationId, name: labels.referenced(entry, areas) ?? labels.name(entry, areas) };
  }).filter((crystal) => crystal.name);
}

/**
 * @param {string} gameDir
 * @param {string} layoutsPath  the RSZ type dump, for the game's data tables
 */
export function extractNames(gameDir, layoutsPath) {
  if (!fs.existsSync(path.join(gameDir, 're_chunk_000.pak'))) {
    throw new NamesError('no-game', 'The game files were not found.');
  }
  const files = new GameFiles(gameDir);
  try {
    const dlc = Array.from({ length: DLC_SLOTS }, (_, i) => {
      const id = String(i + 1).padStart(4, '0');
      return `natives/stm/appdata/extracontents/contents_${id}/itemname_contents_${id}`;
    });
    const itemMessages = new Messages(files, [...ITEM_FILES, ...dlc]);
    const itemReferences = new Messages(files, ITEM_REFERENCES);
    const numbered = (messages, pattern, references = messages, key = Number) => {
      const out = {};
      for (const entry of messages.entries) {
        const id = entry.name.match(pattern)?.[1];
        const name = id && messages.name(entry, references);
        if (name) out[key(id)] = name;
      }
      return out;
    };

    const items = numbered(itemMessages, /^item_name_(\d+)$/i, itemReferences);
    if (!Object.keys(items).length) throw new NamesError('no-names', 'No item names were found in the game files.');
    const names = {
      items,
      jobs: numbered(new Messages(files, [JOB_FILE]), /^job_name_(\d+)$/i),
      personalities: numbered(new Messages(files, [PERSONALITY_FILE]), /^Personality_(\d+)$/i, undefined, (n) => PERSONALITY_IDS[Number(n)]),
      // Specialization n of a save is the game's Subskill_(n-1).
      subSkills: numbered(new Messages(files, SUB_SKILL_FILES), /^Subskill_(\d+)_00$/i, undefined, (n) => Number(n) + 1),
      portcrystals: null,
      skills: null,
    };
    // The tables need the type dump and may stop fitting after a game update; names matter
    // more, so they are kept either way.
    try {
      const layouts = loadDump(layoutsPath);
      names.portcrystals = readPortcrystals(files, layouts);
      names.skills = readSkills(files, layouts);
    } catch (error) {
      if (!(error instanceof RszError) && error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return names;
  } finally {
    files.close();
  }
}

/** Dictionary kept on disk, with where it came from. */
export class NameStore {
  constructor(file, layoutsPath) {
    this.file = file;
    this.layoutsPath = layoutsPath;
    this.cache = null;
  }

  read() {
    if (!this.cache) {
      try {
        this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        this.cache = { builtAt: null, buildId: null, items: {}, jobs: {}, personalities: {}, subSkills: {}, portcrystals: null, skills: null };
      }
    }
    return this.cache;
  }

  rebuild(game) {
    const names = extractNames(game.dir, this.layoutsPath);
    this.cache = { builtAt: new Date().toISOString(), buildId: game.buildId, languages: Object.keys(LANGUAGES), ...names };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache));
    return this.cache;
  }
}
