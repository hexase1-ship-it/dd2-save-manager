// What the editor knows about the contents of a Dragon's Dogma 2 save: where money, the
// Arisen and main pawn's growth, the item storage and the appearance data live in the tree.

import { readSave, writeSave } from './dsss.js';
import { hashName } from './hash.js';
import { T, parseBody, serializeBody, setScalar, cloneNode, classToJson, classFromJson } from './savetree.js';

export class GameDataError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const hashCache = new Map();
const H = (name) => {
  let h = hashCache.get(name);
  if (h === undefined) hashCache.set(name, (h = hashName(name)));
  return h;
};

const field = (cls, name) => cls?.fields.find((f) => f.hash === H(name));
const node = (cls, name) => field(cls, name)?.node;
const value = (cls, name) => node(cls, name)?.value;
const ofType = (array, typeName) => array?.items.find((c) => c.hash === H(typeName));

function requireField(cls, name) {
  const f = field(cls, name);
  if (!f) throw new GameDataError('layout', `This save has no "${name}" value; the game version may be unsupported.`);
  return f;
}

function set(cls, name, v) {
  const f = requireField(cls, name);
  setScalar(f.node, f.type, v);
}

const INT32_MAX = 0x7fffffff;
const STORAGE_OWNER = 65535;
const ITEM_STACK_MAX = 999;
const JOB_COUNT = 10;
const BASIC_JOBS = 4; // open to everyone, never flagged as unlocked
const PAWN_JOBS = 6; // pawns cannot take the last four vocations
const EDITABLE = ['player', 'pawn'];
// The game's own limit on names is not known; this stays well inside what its name entry takes.
const NAME_MAX = 12;
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f<>]/; // control characters, and the brackets the game reads as text tags

// A pawn's inclination, in the order the game lists them: kindhearted, calm, simple, straightforward.
const PERSONALITIES = [1477799926, -477469187, 81586066, 1301972698];
const VOICE_TONES = 5; // 1 very low .. 5 very high
const SUB_SKILLS = 9; // specializations, 0 = none; 7-9 came with the last title update
const AFFINITY_MAX = 999; // the real ceiling is not known

// Smithing is kept per item as four bytes: how many times it was enhanced, then the smithing
// style of each of the three ordinary steps. A fourth step is dragonforging, which is left alone.
const ENHANCE_STEPS = 3;
const isEquipment = (itemId) => (itemId >= 1000 && itemId < 3000) || (itemId >= 4000 && itemId < 7000);

// Permanent portcrystals of the main map, by the id the game's own table (app.FoundationData)
// gives them. The table was found by scanning the game archives for its record type; its path
// is not known, so the ids are kept here. The save lists the ones the player has found.
// Left out: the nine of the Norgan region (ids 6-14), whose place in a save has not been seen.
const PORTCRYSTALS = [0, 1, 2, 3, 4, 5, 15, 16, 17];
const GUEST_PREFIX = 'guest-';

// The game mode, as the game's own type table numbers app.PlayModeType (read from the type
// database inside DD2.exe; an older dump of it had Normal 0, Casual 1 and no Hard).
const PLAY_MODES = ['casual', 'normal', 'hard'];

// Features that an edition of the program may leave out. Each lives in its own file under
// ../features; in an edition without it the file is simply not there.
async function optionalFeature(name) {
  try {
    return await import(`../features/${name}.js`);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}
const ratings = await optionalFeature('ratings');

// What the vocation guild sells: weapon skills have a level (0 not learned, 1 learned,
// 2 the upgraded form), core skills and augments are simply on or off.
const SKILL_LISTS = {
  custom: ['app.HumanSkillContext', 'EnabledCustomSkills', 'CustomSkillID', 'Level'],
  normal: ['app.HumanSkillContext', 'EnableNormalSkills', 'NormalSkillID', 'IsEnable'],
  abilities: ['app.AbilityContext', 'EnableAbilities', 'AbilityID', 'IsEnable'],
};

const STATS = [
  ['hp', '_HitPoint'],
  ['stamina', '_Stamina'],
  ['attack', '_Attack'],
  ['defence', '_Defence'],
  ['magicAttack', '_MagicAttack'],
  ['magicDefence', '_MagicDefence'],
  ['weight', '_Weight'],
  ['blow', '_Blow'],
];

// Appearance lives in five contexts of a character record. The meta context also carries the
// styles of the equipment currently worn, which stay with the character they belong to.
const LOOK_CONTEXTS = {
  meta: 'app.PartSwapHumanContext',
  bodyEdit: 'app.BodyEditContext',
  pretender: 'app.PretenderContext',
  bodyDetail: 'app.BodyDetailContext',
  faceEdit: 'app.FaceEditContext',
};
const EQUIPMENT_STYLES = ['_TopsStyle', '_PantsStyle', '_HelmStyle', '_MantleStyle', '_BackpackStyle', '_FacewearStyle'];
const GENDERS = { 1910070090: 'female', [-1518430841]: 'male' };

/** Enhancement bytes of an item slot, or null for slots and items that have none. */
function enhanceOf(slot) {
  const raw = node(slot, '_Enhance')?.raw;
  return raw?.length === 4 && isEquipment(value(slot, '_ItemId')) ? raw : null;
}

/** Entries of one of the skill lists of a character, by skill id. */
function skillEntries(contexts, kind) {
  const [context, listName, idName] = SKILL_LISTS[kind];
  const entries = new Map();
  for (const entry of node(ofType(contexts, context), listName)?.items ?? []) entries.set(value(entry, idName), entry);
  return entries;
}

function skillsOf(contexts) {
  const out = {};
  for (const [kind, [, , , valueName]] of Object.entries(SKILL_LISTS)) {
    const entries = skillEntries(contexts, kind);
    if (!entries.size) return null;
    out[kind] = Object.fromEntries([...entries].map(([id, entry]) => [id, value(entry, valueName)]));
  }
  return out;
}

/**
 * The game mode a record carries, or null when it carries none. PlayMode came with Hard Mode;
 * records from before that only say whether the game is casual.
 */
function modeOf(record) {
  const mode = PLAY_MODES[value(record, 'PlayMode')];
  if (mode) return mode;
  const casual = value(record, 'IsCasualMode');
  return casual === undefined ? null : casual ? 'casual' : 'normal';
}

function plagueOf(pawnData) {
  return { level: value(pawnData, '_PossessionLv') ?? null, progress: value(pawnData, '_PossessionProgressPoint') ?? null };
}

function setText(cls, name, text) {
  const f = requireField(cls, name);
  if (f.type !== T.STRING) throw new GameDataError('layout', `"${name}" is not text in this save.`);
  f.node = { value: text };
}

function checkName(text) {
  const name = typeof text === 'string' ? text.trim() : '';
  if (!name || [...name].length > NAME_MAX || NAME_FORBIDDEN.test(name)) {
    throw new GameDataError('name', `A name must be 1 to ${NAME_MAX} characters, without < or >.`);
  }
  return name;
}

function checkInt(label, v, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new GameDataError('range', `${label} must be a whole number between ${min} and ${max}.`);
  }
  return v;
}

export class SaveDoc {
  /** @param {Buffer} file @param {number|bigint|string} steamId */
  static open(file, steamId) {
    const { flags, body } = readSave(file, steamId);
    const tree = parseBody(body);
    const doc = new SaveDoc(flags, tree);
    // Only a tree that writes back byte for byte is trusted for editing.
    doc.exact = tree.tail.length === 0 && serializeBody(tree).equals(body);
    return doc;
  }

  constructor(flags, tree) {
    this.flags = flags;
    this.tree = tree;
    this.exact = false;
  }

  #root(typeName) {
    return this.tree.roots.find((r) => r.cls.hash === H(typeName))?.cls;
  }

  get kind() {
    if (this.#root('app.SaveDataManager.GameSaveData')) return 'game';
    if (this.#root('app.SaveDataManager.SystemSaveData')) return 'system';
    return 'unknown';
  }

  get detail() {
    const d = this.#root('via.storage.saveService.SaveFileDetail');
    return { title: value(d, 'Title') ?? '', detail: value(d, 'Detail') ?? '', slot: value(d, 'Slot') ?? null };
  }

  #section(typeName) {
    return ofType(node(this.#root('app.SaveDataManager.GameSaveData'), 'GameSaveDataList'), typeName);
  }

  #itemManager() {
    return this.#section('app.ItemManager.GameSaveData');
  }

  /** The list of permanent portcrystals ("foundations") the player has found, kept with the map data. */
  #portcrystals() {
    return node(this.#section('app.GuiManager.GameSaveData'), 'FoundationIdList');
  }

  #money() {
    return node(this.#itemManager(), 'MoneySave');
  }

  /**
   * Character records by role. A record is the list of contexts of one character. Support
   * pawns hired from other players are kept the same way while they are in the party; they
   * are "guests" here: readable, never edited.
   */
  #records() {
    const db = node(this.#section('app.ContextDBMSSaveData'), 'DBSaveData');
    const found = { player: null, pawn: null, guests: [] };
    (node(db, 'Records')?.items ?? []).forEach((record, index) => {
      const contexts = node(record, 'Contexts');
      const hasStatus = Boolean(ofType(contexts, 'app.HumanStatusContext'));
      if (ofType(contexts, 'app.PlayerPersonalDataContext')) {
        if (hasStatus) found.player ??= contexts;
      } else if (ofType(contexts, 'app.MainPawnDataContext')) {
        if (hasStatus) found.pawn ??= contexts;
      } else if (ofType(contexts, 'app.PawnDataContext')) {
        found.guests.push({ who: `${GUEST_PREFIX}${index}`, contexts });
      }
    });
    return found;
  }

  /** Contexts of the Arisen or the main pawn, the only characters that are edited. */
  #editable(records, who) {
    const contexts = EDITABLE.includes(who) ? records[who] : null;
    if (!contexts) throw new GameDataError('no-character', `This save has no ${who} record.`);
    return contexts;
  }

  #character(who, contexts) {
    const status = ofType(contexts, 'app.HumanStatusContext');
    const growth = node(status, '_IncreaseParams');
    const job = ofType(contexts, 'app.JobContext');
    const personal = ofType(contexts, 'app.PlayerPersonalDataContext');
    const pawnData = ofType(contexts, 'app.PawnDataContext');
    const mainPawn = ofType(contexts, 'app.MainPawnDataContext');
    const meta = node(ofType(contexts, LOOK_CONTEXTS.meta), '_Meta');
    const charaId = value(ofType(contexts, 'app.CharacterIDContext'), 'CharacterID');
    return {
      who,
      name: (personal ? value(personal, 'Name') : value(pawnData, '_Name')) ?? '',
      charaId: charaId === undefined ? null : charaId >>> 0,
      gender: GENDERS[value(meta, '_Gender')] ?? null,
      level: value(status, '_Level') ?? null,
      exp: value(status, '_Exp') ?? null,
      stats: Object.fromEntries(STATS.map(([key, name]) => [key, value(growth, name) ?? null])),
      job: value(job, 'CurrentJob') ?? null,
      dp: value(job, 'ConsumableExp') ?? null,
      jobExp: node(job, 'CulmativeExp')?.items.map((i) => i.value) ?? [],
      jobBits: value(job, 'QualifiedJobBits') ?? null,
      // Ratings other players left when they sent the pawn back; pawns only.
      reviews: ratings && pawnData ? ratings.read(pawnData, { value }) : null,
      // Unlock state of every weapon skill, core skill and augment, by the game's id for each.
      skills: skillsOf(contexts),
      // What makes a pawn the pawn it is, and how far the dragonsplague has taken hold; pawns only.
      nature: pawnData ? {
        personality: value(pawnData, '_Personality') ?? null,
        voiceTone: value(pawnData, '_VoiceToneType') ?? null,
        subSkill: value(pawnData, '_SubSkill') ?? null,
      } : null,
      plague: pawnData ? plagueOf(pawnData) : null,
      affinity: mainPawn ? value(mainPawn, '_FavorabilityRating') ?? null : null,
      hasLook: Object.values(LOOK_CONTEXTS).every((name) => ofType(contexts, name)),
    };
  }

  #guest({ who, contexts }) {
    const { name, gender, level, job, hasLook, plague } = this.#character(who, contexts);
    return { who, name, owner: value(ofType(contexts, 'app.PawnOwnerContext'), '_Name') ?? '', gender, level, job, hasLook, plague };
  }

  #items() {
    return node(this.#itemManager(), 'ItemStorageSaves')?.items ?? [];
  }

  /**
   * The game mode of each save slot, by slot number, as the system save keeps it. This is the
   * record that follows the mode the player chose: with Hard Mode chosen, the system save says
   * Hard for the slot (and for the playthrough, in PlayModeList) while the save's own PlayMode
   * still says Normal.
   */
  #slotModes() {
    const sections = node(this.#root('app.SaveDataManager.SystemSaveData'), 'SystemSaveDataList')?.items ?? [];
    const modes = {};
    // The section is app.GameSystem.SaveData_02; its number has gone up with the game, so it is found by content.
    (node(sections.find((section) => field(section, 'unitInfoDatas')), 'unitInfoDatas')?.items ?? []).forEach((info, slot) => {
      const mode = modeOf(info);
      if (mode) modes[slot] = mode;
    });
    return modes;
  }

  /** Short description used in save and backup lists. */
  summary() {
    if (this.kind === 'system') return { kind: this.kind, ...this.detail, slotModes: this.#slotModes() };
    if (this.kind !== 'game') return { kind: this.kind, ...this.detail };
    const records = this.#records();
    const brief = (who) => {
      if (!records[who]) return null;
      const c = this.#character(who, records[who]);
      return { name: c.name, level: c.level, job: c.job };
    };
    const money = this.#money();
    return {
      kind: 'game',
      ...this.detail,
      player: brief('player'),
      pawn: brief('pawn'),
      gold: value(money, '_Gold') ?? null,
      rim: value(money, '_Rim') ?? null,
      inGameSeconds: value(this.#section('app.TimeManager.TimeSaveData'), 'InGameElapsedSeconds') ?? null,
      // What the save itself says; the system save's word for the slot is the better one (see #slotModes).
      mode: modeOf(this.#section('app.GameSystem.GameSaveData')),
    };
  }

  /** Everything the editor shows. */
  model() {
    if (this.kind !== 'game') throw new GameDataError('not-game', 'Only game saves can be edited, not the system save.');
    const records = this.#records();
    const owners = {};
    const characters = [];
    for (const who of ['player', 'pawn']) {
      if (!records[who]) continue;
      const c = this.#character(who, records[who]);
      characters.push(c);
      if (c.charaId !== null) owners[c.charaId] = who;
    }
    owners[STORAGE_OWNER] = 'storage';

    const slots = this.#items();
    const items = [];
    slots.forEach((slot, index) => {
      const itemId = value(slot, '_ItemId');
      if (!itemId) return;
      const charaId = value(slot, '_CharaId');
      items.push({
        index,
        itemId,
        num: value(slot, '_Num'),
        owner: owners[charaId] ?? 'other',
        charaId,
        equipped: value(slot, '_IsEquipped') === true,
        // Times enhanced by a smith (4 = dragonforged); null for things that cannot be enhanced.
        enhance: enhanceOf(slot)?.[0] ?? null,
      });
    });
    const money = this.#money();
    const found = this.#portcrystals();
    return {
      ...this.detail,
      exact: this.exact,
      // 'casual', 'normal' or 'hard' as the save itself says. Shown, never edited: the mode of a
      // playthrough is also kept in the system save, and which record the game follows is not known.
      mode: modeOf(this.#section('app.GameSystem.GameSaveData')),
      // Ids of the permanent portcrystals found so far, out of `all`; null when the save has no such list.
      portcrystals: found ? { all: PORTCRYSTALS, found: found.items.map((item) => item.value) } : null,
      money: { gold: value(money, '_Gold') ?? null, rim: value(money, '_Rim') ?? null },
      characters,
      guests: records.guests.map((guest) => this.#guest(guest)),
      items,
      itemSlots: { total: slots.length, free: slots.length - items.length },
    };
  }

  /**
   * Applies a set of changes. Throws without touching the tree when a value is out of range.
   * @param {object} edits  { portcrystals: [id], money, characters: {player, pawn}, guests: {[who]: {plagueReset}},
   *                          items: {set, enhance, remove, add}, looks: {player, pawn} }
   * @param {object} [catalog]  what the game's own tables say, for the edits that depend on them:
   *                            { portcrystals: [id], skills: {custom: [{id, job, names}], normal: [{id, job}], abilities: [{id, job}]} }
   */
  apply(edits, catalog = {}) {
    if (this.kind !== 'game') throw new GameDataError('not-game', 'Only game saves can be edited, not the system save.');
    if (!this.exact) throw new GameDataError('inexact', 'This save has a layout the editor does not fully understand, so it is read-only.');
    // Work on a copy so a rejected edit leaves the document as it was.
    const draft = new SaveDoc(this.flags, cloneNode(this.tree));
    draft.exact = true;
    draft.#applyTo(edits ?? {}, catalog);
    this.tree = draft.tree;
  }

  #applyTo(edits, catalog) {
    if (edits.money) {
      const money = this.#money();
      if (edits.money.gold !== undefined) set(money, '_Gold', checkInt('Gold', edits.money.gold, 0, 999_999_999));
      if (edits.money.rim !== undefined) set(money, '_Rim', checkInt('Rift crystals', edits.money.rim, 0, 999_999_999));
    }

    // Portcrystals are only ever added, in the order asked for, the way the game appends them as they are found.
    if (edits.portcrystals !== undefined && !Array.isArray(edits.portcrystals)) throw new GameDataError('range', 'Portcrystals are given as a list of ids.');
    for (const id of edits.portcrystals ?? []) {
      if (!(catalog.portcrystals ?? PORTCRYSTALS).includes(id)) throw new GameDataError('range', 'Unknown portcrystal.');
      const list = this.#portcrystals();
      if (!list || list.memberType !== T.U32) throw new GameDataError('layout', 'This save has no list of found portcrystals.');
      if (list.items.some((item) => item.value === id)) continue;
      const raw = Buffer.alloc(list.memberSize);
      raw.writeUInt32LE(id);
      list.items.push({ value: id, raw });
    }

    const records = this.#records();
    for (const [who, change] of Object.entries(edits.characters ?? {})) {
      this.#applyCharacter(this.#editable(records, who), change);
      if (change.name !== undefined) this.#rename(records, who, checkName(change.name));
      if (change.skills) applySkills(this.#editable(records, who), change.skills, catalog.skills, who === 'pawn');
    }
    // Hired pawns belong to other players; the one thing done to them is curing the dragonsplague.
    for (const [who, change] of Object.entries(edits.guests ?? {})) {
      const guest = records.guests.find((g) => g.who === who);
      if (!guest) throw new GameDataError('no-character', `This save has no ${who} record.`);
      if (Object.keys(change).some((key) => key !== 'plagueReset')) throw new GameDataError('range', 'A hired pawn can only be cured of the dragonsplague.');
      if (change.plagueReset) clearPlague(ofType(guest.contexts, 'app.PawnDataContext'));
    }
    for (const [who, look] of Object.entries(edits.looks ?? {})) {
      applyLook(this.#editable(records, who), look);
    }
    if (edits.items) this.#applyItems(edits.items, records);
  }

  /** The Arisen's name is also kept on the main pawn, as the name of its master. */
  #rename(records, who, name) {
    if (who === 'player') {
      setText(ofType(records.player, 'app.PlayerPersonalDataContext'), 'Name', name);
      const master = ofType(records.pawn, 'app.PawnOwnerContext');
      if (master) setText(master, '_Name', name);
    } else {
      setText(ofType(records.pawn, 'app.PawnDataContext'), '_Name', name);
    }
  }

  #applyCharacter(contexts, change) {
    const status = ofType(contexts, 'app.HumanStatusContext');
    const job = ofType(contexts, 'app.JobContext');
    const pawnData = ofType(contexts, 'app.PawnDataContext');
    if (!pawnData && (change.reviews || change.nature || change.plagueReset !== undefined || change.affinity !== undefined)) {
      throw new GameDataError('range', 'Only pawns have ratings, an inclination, the dragonsplague and affinity.');
    }
    if (change.nature) {
      const { personality, voiceTone, subSkill } = change.nature;
      if (personality !== undefined) {
        if (!PERSONALITIES.includes(personality)) throw new GameDataError('range', 'Unknown inclination.');
        set(pawnData, '_Personality', personality);
      }
      if (voiceTone !== undefined) set(pawnData, '_VoiceToneType', checkInt('Voice pitch', voiceTone, 1, VOICE_TONES));
      if (subSkill !== undefined) set(pawnData, '_SubSkill', checkInt('Specialization', subSkill, 0, SUB_SKILLS));
    }
    if (change.plagueReset) clearPlague(pawnData);
    if (change.affinity !== undefined) {
      const mainPawn = ofType(contexts, 'app.MainPawnDataContext');
      if (!mainPawn) throw new GameDataError('range', 'Only the main pawn has affinity.');
      set(mainPawn, '_FavorabilityRating', checkInt('Affinity', change.affinity, 0, AFFINITY_MAX));
    }
    if (change.reviews) {
      if (!ratings) throw new GameDataError('unsupported', 'This edition does not edit pawn ratings.');
      ratings.apply(pawnData, change.reviews, { set, checkInt });
    }
    if (change.level !== undefined) set(status, '_Level', checkInt('Level', change.level, 1, 999));
    if (change.exp !== undefined) set(status, '_Exp', checkInt('Experience', change.exp, 0, INT32_MAX));
    if (change.stats) {
      const growth = node(status, '_IncreaseParams');
      for (const [key, name] of STATS) {
        if (change.stats[key] !== undefined) set(growth, name, checkInt(key, change.stats[key], 0, INT32_MAX));
      }
    }
    if (change.dp !== undefined) set(job, 'ConsumableExp', checkInt('Discipline points', change.dp, 0, INT32_MAX));
    if (change.jobBits !== undefined) {
      set(job, 'QualifiedJobBits', checkInt('Unlocked vocations', change.jobBits, 0, (1 << JOB_COUNT) - 1));
    }
    if (change.jobExp) {
      const list = requireField(job, 'CulmativeExp').node;
      if (!Array.isArray(change.jobExp) || change.jobExp.length !== list.items.length) {
        throw new GameDataError('range', 'Vocation experience list has the wrong length.');
      }
      change.jobExp.forEach((v, i) => setScalar(list.items[i], list.memberType, checkInt('Vocation experience', v, 0, INT32_MAX)));
    }
    // After the unlock flags, so a vocation can be unlocked and taken in one go. Only the
    // vocation changes: equipment stays as it is, to be swapped in the game.
    if (change.job !== undefined) {
      const jobId = checkInt('Vocation', change.job, 1, pawnData ? PAWN_JOBS : JOB_COUNT);
      const bit = 1 << (jobId - 1);
      if (jobId > BASIC_JOBS && !(value(job, 'QualifiedJobBits') & bit)) {
        throw new GameDataError('job-locked', 'That vocation is not unlocked for this character.');
      }
      set(job, 'CurrentJob', jobId);
      // The game marks every vocation a character has been.
      set(job, 'ChangedJobBits', ((value(job, 'ChangedJobBits') ?? 0) | bit) >>> 0);
    }
  }

  #applyItems(change, records) {
    const manager = this.#itemManager();
    const slots = this.#items();
    const slotAt = (index) => {
      const slot = slots[index];
      if (!Number.isInteger(index) || !slot || !value(slot, '_ItemId')) {
        throw new GameDataError('range', `There is no item in storage slot ${index}.`);
      }
      return slot;
    };

    for (const { index, num } of change.set ?? []) {
      set(slotAt(index), '_Num', checkInt('Item count', num, 1, ITEM_STACK_MAX));
    }

    for (const { index, level } of change.enhance ?? []) {
      const slot = slotAt(index);
      const current = enhanceOf(slot);
      if (!current) throw new GameDataError('range', 'Only weapons and armor can be enhanced.');
      if (current[0] > ENHANCE_STEPS) throw new GameDataError('range', 'Dragonforged equipment is left as it is.');
      checkInt('Enhancement', level, 0, ENHANCE_STEPS);
      const raw = Buffer.from(current);
      raw[0] = level;
      // Steps that are no longer there have no smithing style either.
      raw.fill(0, 1 + level);
      requireField(slot, '_Enhance').node = { value: undefined, raw };
    }

    // An emptied slot must look exactly like the game's own empty slots.
    const blank = slots.find((s) => !value(s, '_ItemId'));
    for (const index of change.remove ?? []) {
      const slot = slotAt(index);
      if (value(slot, '_IsEquipped')) throw new GameDataError('equipped', 'Unequip an item in the game before removing it.');
      if (!blank) throw new GameDataError('layout', 'This save has no empty item slot to copy.');
      slot.fields = cloneNode(blank.fields);
    }

    if (!change.add?.length) return;
    const ownerIds = { storage: STORAGE_OWNER };
    for (const who of ['player', 'pawn']) {
      const id = value(ofType(records[who], 'app.CharacterIDContext'), 'CharacterID');
      if (id !== undefined) ownerIds[who] = id >>> 0;
    }
    let storageId = value(manager, 'StorageId');
    let updateIndex = slots.reduce((max, s) => Math.max(max, value(s, '_UpdateIndex') ?? 0), 0);
    for (const { owner, itemId, num } of change.add) {
      if (!(owner in ownerIds)) throw new GameDataError('range', 'Unknown item owner.');
      checkInt('Item ID', itemId, 1, INT32_MAX);
      checkInt('Item count', num, 1, ITEM_STACK_MAX);
      const slot = slots.find((s) => !value(s, '_ItemId'));
      if (!slot) throw new GameDataError('full', 'The item storage is full.');
      set(slot, '_StorageId', ++storageId);
      set(slot, '_UpdateIndex', ++updateIndex);
      set(slot, '_CharaId', ownerIds[owner]);
      set(slot, '_ItemId', itemId);
      set(slot, '_Num', num);
      set(slot, '_IsNew', true);
    }
    set(manager, 'StorageId', storageId);
  }

  /** Appearance of a character as a self-contained preset. */
  exportLook(who) {
    const records = this.#records();
    const guest = records.guests.find((g) => g.who === who);
    const contexts = guest ? guest.contexts : this.#editable(records, who);
    const out = {};
    for (const [key, typeName] of Object.entries(LOOK_CONTEXTS)) {
      const ctx = ofType(contexts, typeName);
      if (!ctx) throw new GameDataError('layout', 'This character has no appearance data.');
      out[key] = classToJson(ctx);
    }
    const c = this.#character(who, contexts);
    const from = guest ? { who: 'guest', name: c.name, owner: this.#guest(guest).owner } : { who, name: c.name };
    return { format: 'dd2-look', version: 1, from, gender: c.gender, contexts: out };
  }

  /** Encrypted save file for the given Steam account. */
  build(steamId) {
    const body = serializeBody(this.tree);
    const file = writeSave(body, this.flags, steamId);
    // Read our own output back before anyone relies on it.
    const check = readSave(file, steamId);
    if (!check.body.equals(body)) throw new GameDataError('verify', 'The rebuilt save did not read back correctly; nothing was written.');
    return file;
  }
}

/**
 * Unlocks skills and augments. Only ever upward: a skill that is locked again could still be
 * sitting in one of the character's skill slots.
 * @param {object} change   { custom: {id: level}, normal: {id: true}, abilities: {id: true} }
 * @param {object} known    the game's own lists, which say what exists and how far a skill goes
 */
function applySkills(contexts, change, known, isPawn) {
  if (!known) throw new GameDataError('no-skill-data', 'The skill lists have not been read from the game files yet.');
  for (const [kind, wanted] of Object.entries(change)) {
    if (!(kind in SKILL_LISTS)) throw new GameDataError('range', 'Unknown kind of skill.');
    const entries = skillEntries(contexts, kind);
    const valueName = SKILL_LISTS[kind][3];
    for (const [key, target] of Object.entries(wanted)) {
      const id = Number(key);
      const info = known[kind]?.find((skill) => skill.id === id);
      const entry = entries.get(id);
      if (!info || !entry || (isPawn && info.job > PAWN_JOBS)) throw new GameDataError('range', 'This character cannot learn that skill.');
      const current = value(entry, valueName);
      if (kind === 'custom') {
        checkInt('Skill level', target, 1, info.names.length);
        if (target < current) throw new GameDataError('range', 'Skills can be unlocked, not locked again.');
      } else if (target !== true) {
        throw new GameDataError('range', 'Skills can be unlocked, not locked again.');
      }
      set(entry, valueName, target);
    }
  }
}

function clearPlague(pawnData) {
  set(pawnData, '_PossessionLv', 0);
  set(pawnData, '_PossessionProgressPoint', 0);
}

/** The appearance contexts of a preset as tree nodes, by the keys of LOOK_CONTEXTS. */
export function lookContexts(look) {
  if (look?.format !== 'dd2-look' || look.version !== 1 || !look.contexts) {
    throw new GameDataError('look', 'This is not an appearance preset made by this program.');
  }
  try {
    return Object.fromEntries(Object.keys(LOOK_CONTEXTS).map((key) => [key, classFromJson(look.contexts[key])]));
  } catch (error) {
    throw new GameDataError('look', `The appearance preset is damaged: ${error.message}`);
  }
}

function applyLook(contexts, look) {
  const from = lookContexts(look);
  const sources = {};
  for (const [key, typeName] of Object.entries(LOOK_CONTEXTS)) {
    const source = from[key];
    const target = ofType(contexts, typeName);
    if (!target || source.hash !== target.hash) throw new GameDataError('look', 'The appearance preset does not fit this save.');
    sources[key] = { source, target };
  }

  const keep = new Set(EQUIPMENT_STYLES.map(H));
  const sourceMeta = node(sources.meta.source, '_Meta');
  const targetMeta = node(sources.meta.target, '_Meta');
  if (!sourceMeta || !targetMeta) throw new GameDataError('look', 'The appearance preset does not fit this save.');
  for (const f of targetMeta.fields) {
    if (keep.has(f.hash)) continue;
    const from = sourceMeta.fields.find((s) => s.hash === f.hash && s.type === f.type);
    if (from && f.type !== T.CLASS && f.type !== T.ARRAY) f.node = cloneNode(from.node);
  }
  for (const key of ['bodyEdit', 'pretender', 'bodyDetail', 'faceEdit']) {
    sources[key].target.fields = cloneNode(sources[key].source.fields);
  }
}
