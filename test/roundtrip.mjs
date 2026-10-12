// Checks the save pipeline against real save files without ever writing to them.
//
//   node test/roundtrip.mjs <folder with data*.bin> <steam account id>
//
// For every file: decrypt -> parse -> serialize must reproduce the body exactly, and a file
// rebuilt by our writer must read back to the same body. Game saves are then edited in memory
// and reopened to confirm each edit landed and nothing else moved.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readSave, writeSave, sealSave, readHeader } from '../src/core/dsss.js';
import { hashName } from '../src/core/hash.js';
import { cloneNode, parseBody, serializeBody } from '../src/core/savetree.js';
import { SaveDoc, lookContexts } from '../src/core/gamedata.js';
import { buildLookSheet } from '../src/core/looksheet.js';

const [dir, steamId] = process.argv.slice(2);
if (!dir || !steamId) {
  console.error('usage: node test/roundtrip.mjs <save folder> <steam account id>');
  process.exit(2);
}

// The character editor's layout as read from the game (tools/extract-names.mjs); the sheet
// checks are skipped when it has not been built.
const layoutFile = new URL('../data/dd2/charaedit.json', import.meta.url);
const editorLayout = fs.existsSync(layoutFile) ? JSON.parse(fs.readFileSync(layoutFile, 'utf8')) : null;
// The game's own lists of skills and augments, from the same rebuild; without them those checks are skipped.
const namesFile = new URL('../data/dd2/names.json', import.meta.url);
const catalog = { skills: fs.existsSync(namesFile) ? JSON.parse(fs.readFileSync(namesFile, 'utf8')).skills : null };

const fieldNode = (cls, fieldName) => cls.fields.find((f) => f.hash === hashName(fieldName)).node;
const isType = (typeName) => (cls) => cls.hash === hashName(typeName);

function characterRecords(doc) {
  const root = doc.tree.roots.find((r) => isType('app.SaveDataManager.GameSaveData')(r.cls)).cls;
  const database = fieldNode(root, 'GameSaveDataList').items.find(isType('app.ContextDBMSSaveData'));
  return fieldNode(fieldNode(database, 'DBSaveData'), 'Records');
}

/** The Arisen's name as the main pawn's record keeps it. */
function masterName(doc) {
  const main = characterRecords(doc).items.find((r) => fieldNode(r, 'Contexts').items.some(isType('app.MainPawnDataContext')));
  return fieldNode(fieldNode(main, 'Contexts').items.find(isType('app.PawnOwnerContext')), '_Name').value;
}

/** Adds a copy of the main pawn's record to the save, stripped of what marks it as the main pawn. */
function addGuest(doc, guestName) {
  const records = characterRecords(doc);
  const main = records.items.find((r) => fieldNode(r, 'Contexts').items.some(isType('app.MainPawnDataContext')));
  const guest = cloneNode(main);
  const contexts = fieldNode(guest, 'Contexts');
  const keep = contexts.items.map((c) => !isType('app.MainPawnDataContext')(c));
  contexts.items = contexts.items.filter((_, i) => keep[i]);
  if (contexts.hashes) contexts.hashes = contexts.hashes.filter((_, i) => keep[i]);
  fieldNode(contexts.items.find(isType('app.PawnDataContext')), '_Name').value = guestName;
  records.items.push(guest);
  if (records.hashes) records.hashes.push(records.hashes.at(-1));
}

const files = fs.readdirSync(dir).filter((f) => /^data.*\.bin$/.test(f));
assert.ok(files.length > 0, 'no save files found');
const MODES = ['casual', 'normal', 'hard'];
// The game mode of each slot, which the system save keeps; filled in when that file comes by.
let slotModes = null;
const slotsSeen = [];

for (const name of files) {
  const file = fs.readFileSync(path.join(dir, name));
  const header = readHeader(file);
  assert.ok(header.signatureOk, `${name}: signature`);

  const { body, plain, flags } = readSave(file, steamId);
  const tree = parseBody(body);
  assert.equal(tree.tail.length, 0, `${name}: unparsed tail`);
  assert.ok(serializeBody(tree).equals(body), `${name}: tree round trip`);

  // Same plaintext through our cipher: the encrypted slices must match the game's bytes
  // everywhere except the unchecked tag, the slice padding and the random RSA block.
  const resealed = sealSave(plain, flags, steamId);
  assert.equal(resealed.length, file.length, `${name}: resealed size`);
  assert.ok(readSave(resealed, steamId).plain.equals(plain), `${name}: reseal reads back`);

  const rebuilt = writeSave(body, flags, steamId);
  assert.ok(readSave(rebuilt, steamId).body.equals(body), `${name}: rebuilt reads back`);
  assert.throws(() => readSave(file, BigInt(steamId) + 1n), { code: 'wrong-account' }, `${name}: other account rejected`);

  const doc = SaveDoc.open(file, steamId);
  assert.ok(doc.exact, `${name}: exact`);
  if (doc.kind !== 'game') {
    if (doc.kind === 'system') {
      slotModes = doc.summary().slotModes;
      assert.ok(slotModes && Object.values(slotModes).every((mode) => MODES.includes(mode)), `${name}: slot modes`);
    }
    console.log(`ok  ${name}  (${doc.kind} save, ${body.length} bytes${slotModes ? `, slot modes ${JSON.stringify(slotModes)}` : ''})`);
    continue;
  }

  const before = doc.model();
  assert.ok(MODES.includes(before.mode), `${name}: game mode`);
  assert.equal(doc.summary().mode, before.mode);
  slotsSeen.push([name, before.slot]);
  const player = before.characters.find((c) => c.who === 'player');
  const pawn = before.characters.find((c) => c.who === 'pawn');
  assert.ok(player && pawn, `${name}: both characters found`);
  const stackable = before.items.find((i) => !i.equipped && i.owner === 'storage');
  const pawnLook = doc.exportLook('pawn');

  // The appearance sheet must find a value for every editor entry these characters have, and
  // place every style and colour in the lists the editor offers.
  if (editorLayout) {
    for (const who of ['player', 'pawn']) {
      const sheet = buildLookSheet(lookContexts(doc.exportLook(who)), editorLayout);
      const rows = sheet.tabs.flatMap((tab) => tab.parts.flatMap((part) => part.rows));
      assert.deepEqual(sheet.unknown, [], `${name}: ${who} sheet reads every entry`);
      assert.ok(rows.length > 100, `${name}: ${who} sheet is filled in`);
      assert.ok(rows.every((row) => row.type !== 'style' || row.none || row.position), `${name}: ${who} styles are in the editor's lists`);
      assert.ok(rows.every((row) => row.type !== 'color' || row.position), `${name}: ${who} colours are the editor's swatches`);
      assert.ok(rows.every((row) => row.type !== 'number' || !row.outOfRange), `${name}: ${who} slider values are within reach`);
    }
  }

  const jobExp = player.jobExp.map((v, i) => (i === 0 ? v + 1234 : v));
  doc.apply({
    money: { gold: before.money.gold + 1000, rim: before.money.rim + 5 },
    characters: { player: { level: player.level + 1, dp: player.dp + 10, jobExp, jobBits: player.jobBits | 0b11, stats: { hp: player.stats.hp + 7 } } },
    items: { set: [{ index: stackable.index, num: 77 }], add: [{ owner: 'storage', itemId: 86, num: 3 }] },
    looks: { player: pawnLook },
  });

  const reopened = SaveDoc.open(doc.build(steamId), steamId);
  assert.ok(reopened.exact, `${name}: edited save is exact`);
  const after = reopened.model();
  const player2 = after.characters.find((c) => c.who === 'player');
  assert.equal(after.money.gold, before.money.gold + 1000);
  assert.equal(after.money.rim, before.money.rim + 5);
  assert.equal(player2.level, player.level + 1);
  assert.equal(player2.dp, player.dp + 10);
  assert.deepEqual(player2.jobExp, jobExp);
  assert.equal(player2.jobBits, player.jobBits | 0b11);
  assert.equal(player2.stats.hp, player.stats.hp + 7);
  assert.equal(player2.stats.stamina, player.stats.stamina);
  assert.equal(player2.gender, pawn.gender, 'look carries gender');
  assert.equal(after.items.find((i) => i.index === stackable.index).num, 77);
  assert.equal(after.items.length, before.items.length + 1);
  const added = after.items.find((i) => !before.items.some((b) => b.index === i.index));
  assert.deepEqual({ itemId: added.itemId, num: added.num, owner: added.owner }, { itemId: 86, num: 3, owner: 'storage' });
  assert.deepEqual(after.characters.find((c) => c.who === 'pawn'), pawn, 'pawn untouched');
  assert.deepEqual(reopened.exportLook('player').contexts.faceEdit, pawnLook.contexts.faceEdit);

  // Removing the item we added must leave the item list as it was.
  reopened.apply({ items: { remove: [added.index], set: [{ index: stackable.index, num: stackable.num }] } });
  assert.deepEqual(reopened.model().items, before.items);

  // A bad value must reject the whole edit and leave the document alone.
  assert.throws(() => reopened.apply({ money: { gold: 1 }, characters: { player: { level: 0 } } }), { code: 'range' });
  assert.equal(reopened.model().money.gold, before.money.gold + 1000);

  // Pawn ratings are the pawn's alone, and only editions that ship the feature edit them.
  if (pawn.reviews) {
    reopened.apply({ characters: { pawn: { reviews: { good: pawn.reviews.good + 3, like: pawn.reviews.like + 5 } } } });
    const rated = SaveDoc.open(reopened.build(steamId), steamId).model().characters.find((c) => c.who === 'pawn');
    assert.deepEqual(rated.reviews, { good: pawn.reviews.good + 3, like: pawn.reviews.like + 5 });
    assert.throws(() => reopened.apply({ characters: { player: { reviews: { good: 1 } } } }), { code: 'range' });
  } else {
    assert.throws(() => reopened.apply({ characters: { pawn: { reviews: { good: 1 } } } }), { code: 'unsupported' });
  }

  // Skills and augments: unlocked upward only, within what the game's own lists allow.
  if (catalog.skills) {
    const schooled = SaveDoc.open(file, steamId);
    const locked = (kind, who, test = () => true) => catalog.skills[kind].find((s) => !(who.skills[kind][s.id]) && test(s));
    const twoStep = locked('custom', player, (s) => s.names.length === 2);
    const core = locked('normal', player);
    const augment = locked('abilities', player);
    const arisenOnly = catalog.skills.custom.find((s) => s.job > 6);
    assert.ok(twoStep && core && augment && arisenOnly, `${name}: has skills left to unlock`);
    schooled.apply({ characters: { player: { skills: { custom: { [twoStep.id]: 2 }, normal: { [core.id]: true }, abilities: { [augment.id]: true } } } } }, catalog);
    const learned = SaveDoc.open(schooled.build(steamId), steamId);
    assert.ok(learned.exact, `${name}: save with new skills is exact`);
    const skilled = learned.model().characters.find((c) => c.who === 'player');
    assert.deepEqual([skilled.skills.custom[twoStep.id], skilled.skills.normal[core.id], skilled.skills.abilities[augment.id]], [2, true, true]);
    const untouched = (skills) => ({ ...skills, custom: { ...skills.custom, [twoStep.id]: 0 }, normal: { ...skills.normal, [core.id]: 0 }, abilities: { ...skills.abilities, [augment.id]: 0 } });
    assert.deepEqual(untouched(skilled.skills), untouched(player.skills), 'other skills untouched');
    assert.deepEqual({ ...skilled, skills: 0 }, { ...player, skills: 0 }, 'nothing else about the Arisen moved');
    assert.throws(() => learned.apply({ characters: { player: { skills: { custom: { [twoStep.id]: 1 } } } } }, catalog), { code: 'range' }, 'no locking again');
    assert.throws(() => learned.apply({ characters: { player: { skills: { custom: { [twoStep.id]: 3 } } } } }, catalog), { code: 'range' });
    assert.throws(() => learned.apply({ characters: { player: { skills: { normal: { [core.id]: false } } } } }, catalog), { code: 'range' });
    assert.throws(() => learned.apply({ characters: { pawn: { skills: { custom: { [arisenOnly.id]: 1 } } } } }, catalog), { code: 'range' }, 'pawns cannot learn Arisen-only skills');
    assert.throws(() => learned.apply({ characters: { player: { skills: { custom: { [twoStep.id]: 2 } } } } }), { code: 'no-skill-data' });
  }

  // Names, vocation, what a pawn is like, dragonsplague, affinity, game mode and smithing.
  const fresh = SaveDoc.open(file, steamId);
  const gear = before.items.find((i) => i.enhance !== null && i.enhance <= 3);
  const trinket = before.items.find((i) => i.enhance === null);
  assert.ok(gear && trinket, `${name}: has equipment and other items`);
  const newJob = player.job === 1 ? 2 : 1;
  const newLevel = (gear.enhance + 1) % 4;
  fresh.apply({
    characters: {
      player: { name: '새 이름', job: newJob },
      pawn: { name: 'Pawn Two', job: 3, nature: { personality: -477469187, voiceTone: 2, subSkill: 7 }, plagueReset: true, affinity: 123 },
    },
    items: { enhance: [{ index: gear.index, level: newLevel }] },
  });
  const natured = SaveDoc.open(fresh.build(steamId), steamId);
  assert.ok(natured.exact, `${name}: save with new names is exact`);
  const changed = natured.model();
  const player3 = changed.characters.find((c) => c.who === 'player');
  const pawn3 = changed.characters.find((c) => c.who === 'pawn');
  assert.equal(changed.mode, before.mode, `${name}: the game mode is left alone`);
  assert.deepEqual([player3.name, player3.job], ['새 이름', newJob]);
  assert.deepEqual([pawn3.name, pawn3.job, pawn3.affinity], ['Pawn Two', 3, 123]);
  assert.deepEqual(pawn3.nature, { personality: -477469187, voiceTone: 2, subSkill: 7 });
  assert.deepEqual(pawn3.plague, { level: 0, progress: 0 });
  assert.equal(masterName(natured), '새 이름', 'the main pawn knows its master by the new name');
  assert.equal(changed.items.find((i) => i.index === gear.index).enhance, newLevel);
  assert.deepEqual(changed.items.filter((i) => i.index !== gear.index), before.items.filter((i) => i.index !== gear.index), 'other items untouched');
  assert.deepEqual(changed.money, before.money);
  assert.deepEqual({ ...player3, name: 0, job: 0 }, { ...player, name: 0, job: 0 }, 'nothing else about the Arisen moved');
  // What must be refused.
  for (const bad of ['', '   ', 'a<b', 'x'.repeat(13), 'tab\there']) {
    assert.throws(() => natured.apply({ characters: { player: { name: bad } } }), { code: 'name' });
  }
  assert.throws(() => natured.apply({ characters: { pawn: { job: 7 } } }), { code: 'range' }, 'pawns cannot take Arisen-only vocations');
  assert.throws(() => natured.apply({ characters: { player: { nature: { subSkill: 1 } } } }), { code: 'range' });
  assert.throws(() => natured.apply({ characters: { player: { affinity: 5 } } }), { code: 'range' });
  assert.throws(() => natured.apply({ characters: { pawn: { nature: { personality: 12345 } } } }), { code: 'range' });
  assert.throws(() => natured.apply({ items: { enhance: [{ index: trinket.index, level: 1 }] } }), { code: 'range' });
  assert.throws(() => natured.apply({ items: { enhance: [{ index: gear.index, level: 4 }] } }), { code: 'range' });
  const locked = [5, 6, 7, 8, 9, 10].find((job) => !(player.jobBits & (1 << (job - 1))));
  if (locked) {
    assert.throws(() => natured.apply({ characters: { player: { job: locked } } }), { code: 'job-locked' });
    natured.apply({ characters: { player: { job: locked, jobBits: player.jobBits | (1 << (locked - 1)) } } });
    assert.equal(natured.model().characters.find((c) => c.who === 'player').job, locked, 'unlock and take in one edit');
  }

  // Portcrystals: the missing ones are added after those already found, and nothing else moves.
  const ported = SaveDoc.open(file, steamId);
  const crystals = before.portcrystals;
  assert.ok(crystals && crystals.found.every((id) => crystals.all.includes(id)), `${name}: found portcrystals are known ones`);
  ported.apply({ portcrystals: crystals.all });
  const travelled = SaveDoc.open(ported.build(steamId), steamId);
  assert.ok(travelled.exact, `${name}: save with every portcrystal is exact`);
  const missing = crystals.all.filter((id) => !crystals.found.includes(id));
  assert.deepEqual(travelled.model().portcrystals.found, [...crystals.found, ...missing]);
  assert.deepEqual({ ...travelled.model(), portcrystals: 0, mtimeMs: 0 }, { ...before, portcrystals: 0, mtimeMs: 0 }, 'only the portcrystal list changed');
  assert.throws(() => ported.apply({ portcrystals: [6] }), { code: 'range' }, 'Norgan portcrystals are not offered');
  assert.throws(() => ported.apply({ portcrystals: 'all' }), { code: 'range' });

  // A hired pawn is a record like the main pawn's, minus the main-pawn marker. None of the
  // sample saves has one in the party, so one is made from the main pawn here.
  const hosting = SaveDoc.open(file, steamId);
  addGuest(hosting, 'Guest');
  const hosted = SaveDoc.open(hosting.build(steamId), steamId);
  assert.ok(hosted.exact, `${name}: save with a guest is exact`);
  const guest = hosted.model().guests.at(-1);
  assert.equal(hosted.model().guests.length, before.guests.length + 1);
  assert.equal(guest.name, 'Guest');
  const guestLook = hosted.exportLook(guest.who);
  assert.equal(guestLook.from.who, 'guest');
  assert.deepEqual(guestLook.contexts, pawnLook.contexts);
  hosted.apply({ looks: { player: guestLook } });
  assert.deepEqual(hosted.exportLook('player').contexts.bodyDetail, pawnLook.contexts.bodyDetail);
  // Guests are a source of looks; the one edit they take is the dragonsplague cure.
  assert.throws(() => hosted.apply({ looks: { [guest.who]: pawnLook } }), { code: 'no-character' });
  assert.throws(() => hosted.apply({ characters: { guests: { level: 5 } } }), { code: 'no-character' });
  assert.throws(() => hosted.apply({ guests: { [guest.who]: { level: 5 } } }), { code: 'range' });
  assert.throws(() => hosted.apply({ guests: { 'guest-0': { plagueReset: true } } }), { code: 'no-character' });
  hosted.apply({ guests: { [guest.who]: { plagueReset: true } } });
  assert.deepEqual(SaveDoc.open(hosted.build(steamId), steamId).model().guests.at(-1).plague, { level: 0, progress: 0 });

  console.log(`ok  ${name}  (slot ${before.slot}, ${player.name} Lv.${player.level}, ${before.items.length} items, ${body.length} bytes)`);
}
if (slotModes) for (const [name, slot] of slotsSeen) assert.ok(MODES.includes(slotModes[slot]), `${name}: the system save knows the mode of slot ${slot}`);
console.log('all checks passed');
