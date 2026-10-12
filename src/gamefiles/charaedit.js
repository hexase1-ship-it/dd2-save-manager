// Reads how the game's character editor is laid out - its tabs, the parts under each tab, and
// every slider with its label and the number range shown on screen - so that appearance
// values from a save can be listed the way a player would type them into the editor.
//
//   gui data  tabs -> parts -> details (label id, stored range, displayed range, ...)
//             plus, per species and gender, the order of the style thumbnails
//   labels    ui070101 message files, by message id, in every language this program speaks
//   colours   the swatches offered for each area (skin, hair, ...), in list order

import fs from 'node:fs';
import path from 'node:path';
import { parseMsg, LANGUAGES } from './msg.js';
import { GameFiles } from './pak.js';
import { parseRsz } from './rsz.js';
import { loadDump } from './typedump.js';

const GUI_DATA = ['natives/stm/appsystem/gui/userdata/guicharaeditdata.user', 'natives/stm/appsystem/gui/userdata/exguicharaeditdata.user'];
const LABELS = ['natives/stm/message/ui/ui070101.msg', 'natives/stm/message/ui/ui070101_tu_end.msg'];
const PRESETS = 'natives/stm/appsystem/charaedit/ch000/useredit/preset';
const USER_VERSIONS = [3, 4, 2];
const MSG_VERSIONS = [24, 25, 26, 27, 28, 23, 22];

const EDIT_ENUM = 'app.guicharaedit.EditEnum';
const INTERFACE_ENUM = 'app.guicharaedit.InterfaceEnum';
const PARTS_ENUM = 'app.guicharaedit.PartsEnum';
const REGION_ENUMS = { tattoo: 'app.TattooRegion', scar: 'app.ScarRegion' };
const SPECIES_ENUM = 'app.Species';
// A part names the colour area it draws from with one flag set; colours carry the areas they
// are offered in with another. The two sets use the same names.
const PART_AREA_ENUM = 'app.charaedit.ch000.useredit.Define.AreaColorLicense';
const PART_AREA_PREFIX = 'Area00_';
const COLOR_AREA_ENUM = 'app.charaedit.ch000.useredit.Define.SimpleColorLicense';
// Parts that have colours but name no area.
const PART_AREAS = { Freckle: 'Freckles' };
// Low bits of a detail's Attribute say who gets to see it (the same flags the editor's own
// presets use): 1 human, 2 beastren, 4 male, 8 female.
const AUDIENCE_MASK = 0xf;

export class CharaEditError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function extractVersioned(files, base, versions) {
  for (const version of versions) {
    const data = files.extract(`${base}.${version}`);
    if (data) return data;
  }
  return null;
}

/** Numeric entries of an enum table: value -> name. */
function enumNames(enums, type) {
  const table = enums[type] ?? {};
  return Object.fromEntries(Object.entries(table).filter(([key]) => /^-?\d+$/.test(key)));
}

/** Data table from the game, or null when the game has no such file. */
function readTable(files, base, layouts) {
  const file = extractVersioned(files, base, USER_VERSIONS);
  if (!file) return null;
  const parsed = parseRsz(file, layouts);
  // A layout that no longer matches the game leaves data unread; values would be garbage.
  if (parsed.unread !== 0) throw new CharaEditError('editor-layout', 'The character editor data no longer matches the type dump.');
  return parsed;
}

const rootOf = (parsed) => parsed?.instances[parsed.roots[0]]?.fields;
const listed = (parsed, refs) => (refs ?? []).map((item) => parsed.instances[item.ref]?.fields).filter(Boolean);
const hexOf = (color) => Buffer.from(color).subarray(0, 3).toString('hex');
/** Colours referenced by id are packed as 0xAABBGGRR. */
const hexOfId = (id) => [id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff].map((c) => c.toString(16).padStart(2, '0')).join('');

/** Swatches per area and the dirt colour pairs, both in the game's list order. */
function readColors(files, layouts, enums) {
  const table = readTable(files, `${PRESETS}/simplecolorpresetdata.user`, layouts);
  const swatches = table ? listed(table, rootOf(table)?._Presets) : [];
  const palettes = {};
  for (const [bit, name] of Object.entries(enumNames(enums, COLOR_AREA_ENUM))) {
    if (!Number(bit)) continue;
    const colors = swatches.filter((s) => s._License & Number(bit)).map((s) => hexOf(s._Color));
    if (colors.length) palettes[name] = colors;
  }
  const dirt = readTable(files, `${PRESETS}/dirtcolorpresetdata.user`, layouts);
  const dirtColors = dirt ? listed(dirt, rootOf(dirt)?._Presets).map((p) => [hexOfId(p._Color1ID), hexOfId(p._Color2ID)]) : [];
  return { palettes, dirtColors };
}

/**
 * @param {import('./pak.js').GameFiles} files
 * @param {object} layouts  RSZ type dump
 * @param {object} enums    enum dump
 */
export function extractEditorLayout(files, layouts, enums) {
  const [main, extra] = GUI_DATA.map((base) => readTable(files, base, layouts));
  const labelFiles = LABELS.map((base) => extractVersioned(files, base, MSG_VERSIONS)).filter(Boolean);
  if (!main || !labelFiles.length) throw new CharaEditError('no-editor', 'The character editor data was not found in the game files.');
  // Each label as { en, ko, ... }; an entry without text in a language falls back to English when shown.
  const labels = new Map();
  for (const file of labelFiles) {
    for (const entry of parseMsg(file).entries) {
      labels.set(entry.guid, Object.fromEntries(Object.entries(LANGUAGES).map(([code, language]) => [code, entry.text[language]?.trim() ?? ''])));
    }
  }
  const labelOf = (guid) => { const label = labels.get(guid); return label && (label.en || label.ko) ? label : null; };

  const editNames = enumNames(enums, EDIT_ENUM);
  const interfaceNames = enumNames(enums, INTERFACE_ENUM);
  const partNames = enumNames(enums, PARTS_ENUM);
  const partAreas = Object.entries(enumNames(enums, PART_AREA_ENUM)).filter(([bit]) => Number(bit));
  const root = rootOf(main);
  if (!root?.EditTabParams || !root.EditPartsParams || !root.EditDetailParams) {
    throw new CharaEditError('editor-layout', 'The character editor data has an unexpected shape.');
  }

  // The root's own lists, not every record of the type: each part also carries a private
  // detail record that would otherwise shadow a real one.
  const details = new Map();
  for (const d of listed(main, root.EditDetailParams)) if (!details.has(d.EditType)) details.set(d.EditType, d);
  const parts = new Map(listed(main, root.EditPartsParams).map((p) => [p.PartsType, p]));
  const human = new Set(root.EditPartsHuman ?? []);
  const beastren = new Set(root.EditPartsBeastman ?? []);
  const areaOf = (part, key) => {
    const flagged = partAreas.find(([bit]) => part.NeedCheckAreaColor & Number(bit))?.[1];
    return flagged ? flagged.replace(PART_AREA_PREFIX, '') : (PART_AREAS[key] ?? null);
  };

  const tabs = listed(main, root.EditTabParams).map((tab) => ({
    label: labelOf(tab.MsgId),
    parts: tab.DetailTypes.map((partType) => parts.get(partType)).filter(Boolean).map((part) => {
      const key = partNames[part.PartsType] ?? String(part.PartsType);
      return {
        key,
        label: labelOf(part.MsgId),
        human: human.has(part.PartsType),
        beastren: beastren.has(part.PartsType),
        area: areaOf(part, key),
        details: part.DetailTypes.map((type) => details.get(type)).filter(Boolean).map((d) => ({
          key: editNames[d.EditType] ?? String(d.EditType),
          label: labelOf(d.MsgId),
          kind: interfaceNames[d.InterfaceType] ?? String(d.InterfaceType),
          audience: d.Attribute & AUDIENCE_MASK,
          editId: d.EditId,
          min: d.MinVal,
          max: d.MaxVal,
          viewMin: d.ViewMinVal,
          viewMax: d.ViewMaxVal,
          steps: d.ValStep,
          reverse: d.IsReverseGauge,
          header: d.IsHeader,
          indent: d.IndentLevel,
          beast: d.SeparateValueBySpecies ? { min: d.BeastMin, max: d.BeastMax, steps: d.BeastValStep } : null,
        })),
      };
    }),
  }));

  // Style thumbnails: the root object holds one list per species/gender, in on-screen order.
  // The expansion's file adds entries to the end of some of them.
  const styleLists = {};
  for (const parsed of [main, extra]) {
    for (const [name, value] of Object.entries(rootOf(parsed) ?? {})) {
      if (!Array.isArray(value) || !value.length) continue;
      const first = parsed.instances[value[0]?.ref];
      const enumType = first?.type.match(/PatternParam`2<([^,]+),/)?.[1];
      if (!enumType) continue;
      const names = enumNames(enums, enumType);
      const list = (styleLists[name] ??= []);
      for (const item of value) {
        const style = parsed.instances[item.ref].fields.Style | 0;
        if (!list.some(([known]) => known === style)) list.push([style, names[style] ?? String(style)]);
      }
    }
  }

  return {
    tabs,
    styleLists,
    ...readColors(files, layouts, enums),
    regions: Object.fromEntries(Object.entries(REGION_ENUMS).map(([key, type]) => [key, enumNames(enums, type)])),
    species: enumNames(enums, SPECIES_ENUM),
  };
}

/** Editor layout kept on disk, with where it came from. */
export class EditorLayoutStore {
  /** @param {string} file  where the layout is kept  @param {string} layoutsPath  RSZ type dump  @param {string} enumsPath  enum dump */
  constructor(file, layoutsPath, enumsPath) {
    this.file = file;
    this.layoutsPath = layoutsPath;
    this.enumsPath = enumsPath;
    this.cache = null;
  }

  /** The stored layout, or null when none has been built yet. */
  read() {
    if (!this.cache) {
      try {
        this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        return null;
      }
    }
    return this.cache;
  }

  rebuild(game) {
    const files = new GameFiles(game.dir);
    try {
      const dumps = [this.layoutsPath, this.enumsPath].map(loadDump);
      this.cache = { builtAt: new Date().toISOString(), buildId: game.buildId, ...extractEditorLayout(files, ...dumps) };
    } finally {
      files.close();
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache));
    return this.cache;
  }
}
