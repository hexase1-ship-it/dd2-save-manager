// Turns a character's appearance data into the list a player would follow in the game's
// character editor: the editor's own tabs, parts and labels, with each value converted to the
// number shown on screen.
//
// The editor layout (labels, ranges, style list order, who sees which entry) comes from the
// game files (gamefiles/charaedit.js). What this module adds is where each editor entry keeps
// its value in a save, which is not written down anywhere in the game data.

import { hashName } from './hash.js';

const hashes = new Map();
const H = (name) => {
  let h = hashes.get(name);
  if (h === undefined) hashes.set(name, (h = hashName(name)));
  return h;
};

/** Node reached by following field names from a class; undefined when any step is missing. */
function follow(cls, path) {
  let current = cls;
  for (const name of path) {
    current = current?.fields?.find((f) => f.hash === H(name))?.node;
    if (current === undefined) return undefined;
  }
  return current;
}

const detail = (...path) => ['bodyDetail', path];
const meta = (name) => ['meta', ['_Meta', name]];
const posture = (name) => ['pretender', [name]];

/** Entries that share a context: group('Hair', ['_Hair'], {Gloss: '_Gloss'}) -> HairGloss. */
function group(prefix, context, fields) {
  return Object.fromEntries(Object.entries(fields).map(([suffix, field]) => [prefix + suffix, detail(...context, field)]));
}

const eye = (prefix, side, scleraKey) => ({
  ...group(prefix, ['_Eyes', side], {
    IrisPrimaryColor: '_IrisColor1', IrisSecondaryColor: '_IrisColor2', IrisTertiaryColor: '_IrisColor3',
    IrisSize: '_IrisSize', PupilSize: '_PupilSize',
  }),
  [scleraKey]: detail('_Eyes', side, '_IrisColor4'),
});

// Editor entry (by its internal name) -> [context, field path]. Sliders that have an edit key
// are not listed: their values are looked up by that key instead.
const FIELDS = {
  FurStyle: meta('_FurStyle'),
  FurPattern: meta('_FurPattern'),
  ...group('FurPattern', ['_FurPattern'], {
    Color1: '_Color1', Color2: '_Color2', Color3: '_Color3', Color4: '_Color4',
    Color1_Override: '_Color1_Override', Color2_Override: '_Color2_Override', Color3_Override: '_Color3_Override', Color4_Override: '_Color4_Override',
  }),
  MuscleStyle: meta('_MuscleStyle'),
  MuscleStrength: detail('_Skin', '_MuscleStrength'),
  PretenderAge: posture('_Age'),
  PretenderSex: posture('_SexUpperBody'),
  PretenderLowerSex: posture('_SexLowerBody'),
  PretenderSpineBend: posture('_SpineBend'),
  HeadStyle: meta('_HeadStyle'),
  SkinStyle: meta('_SkinStyle'),
  ...group('Skin', ['_Skin'], { Color: '_Color', WrinkeStrength: '_WrinkeStrength', Roughness: '_Roughness' }),
  LeftEyeSquint: detail('_Eyes', '_LeftEyeSquintRate'),
  RightEyeSquint: detail('_Eyes', '_RightEyeSquintRate'),
  HairStyle: meta('_HairStyle'),
  ...group('Hair', ['_Hair'], { RootColor: '_RootColor', TipColor: '_TipColor', RootTipBlend: '_TipBlend', Sheen: '_Sheen', Gloss: '_Gloss' }),
  EyebrowStyle: meta('_EyebrowStyle'),
  ...group('Eyebrow', ['_Eyebrows'], { Color: '_Color', Density: '_Density' }),
  BeardStyle: meta('_BeardStyle'),
  ...group('Beard', ['_Beard'], { RootColor: '_RootColor', TipColor: '_TipColor', RootTipBlend: '_TipBlend', Sheen: '_Sheen', Gloss: '_Gloss' }),
  BodyHairStyle: meta('_BodyHairStyle'),
  ...group('BodyHair', ['_BodyHair'], { Color: '_Color', Density: '_Density' }),
  FurFaceStyle: meta('_FurFaceStyle'),
  FurForeheadStyle: meta('_FurForeheadStyle'),
  FurEyeStyle: meta('_FurEyeStyle'),
  FurCheekStyle: meta('_FurCheekStyle'),
  FurNoseStyle: meta('_FurNoseStyle'),
  FurFaceOpacity: detail('_FurFaceMask', '_Opacity'),
  FurForeheadOpacity: detail('_FurForehead', '_Opacity'),
  FurEyeOpacity: detail('_FurEyes', '_Opacity'),
  FurCheekOpacity: detail('_FurCheeks', '_Opacity'),
  FurNoseOpacity: detail('_FurNose', '_Opacity'),
  ...group('FurFace', ['_FurFacePattern'], { Color1: '_Color1', Color2: '_Color2', Color1Thickness: '_Color1_Override', Color2Thickness: '_Color2_Override' }),
  ...group('Nose', ['_Nose'], { Color: '_Color', Opacity: '_Opacity', Roughness: '_Roughness', Thickness: '_Thickness' }),
  EyeStyle: meta('_EyeStyle'),
  LeftEyeStyle: meta('_EyeLeftStyle'),
  RightEyeStyle: meta('_EyeRightStyle'),
  ...eye('Eyes', '_Common', 'EyesEyeScleraColor'),
  ...eye('LeftEyes', '_Left', 'LeftEyesEyeScleraColor'),
  ...eye('RightEyes', '_Right', 'RightEyesRightEyeScleraColor'),
  EyelashStyle: meta('_EyelashStyle'),
  ...group('Eyelash', ['_Eyelashes', '_Base'], { RootColor: '_RootColor', TipColor: '_TipColor', RootTipBlend: '_TipBlend', Length: '_Length', Density: '_Density' }),
  EyeshadowStyle: meta('_EyeshadowStyle'),
  ...group('Eyeshadow', ['_Eyeshadow', '_Common'], {
    Color1: '_Color1', Color2: '_Color2', Thickness: '_Thickness', Spread: '_Spread', Opacity: '_Opacity', Metallic: '_Metallic', Roughness: '_Roughness',
  }),
  EyelinerStyle: meta('_EyelinerStyle'),
  ...group('Eyeliner', ['_Eyeliner'], { Color: '_Color', Thickness: '_Thickness', Opacity: '_Opacity', Metallic: '_Metallic', Roughness: '_Roughness' }),
  FreckleStyle: meta('_FrecklesStyle'),
  ...group('Freckle', ['_Freckles'], { Color: '_Color', Opacity: '_Opacity' }),
  CheekStyle: meta('_CheekStyle'),
  ...group('Cheek', ['_Cheek'], { Color: '_Color', Opacity: '_Opacity', Metallic: '_Metallic', Roughness: '_Roughness' }),
  LipStyle: meta('_LipStyle'),
  ...group('Lip', ['_Lips', '_Common'], { Color1: '_Color1', Spread: '_Spread', Opacity: '_Opacity', Metallic: '_Metallic', Roughness: '_Roughness' }),
  TeethColor: detail('_Teeth', '_Color'),
  ClawsColor: detail('_Claws', '_Color'),
  DirtDirtPattern: detail('_Dirt', '_DirtPattern'),
  DirtColorPreset: detail('_Dirt', '_Color1'),
  DirtCoverage: detail('_Dirt', '_Coverage'),
  DirtOpacity: detail('_Dirt', '_Opacity'),
};

// Style thumbnails are listed per species and gender: [human male, human female, beastren male, beastren female].
const same = (name) => [name, name, name, name];
const bySpecies = (human, beastren) => [human, human, beastren, beastren];
const STYLE_LISTS = {
  HeadStyle: ['HMHeadStyles', 'HFHeadStyles', 'BMHeadStyles', 'BFHeadStyles'],
  SkinStyle: ['HMSkinStyles', 'HFSkinStyles', 'BMSkinStyles', 'BFSkinStyles'],
  MuscleStyle: ['HMMuscleStyles', 'HFMuscleStyles', 'HMMuscleStyles', 'HFMuscleStyles'],
  HairStyle: ['HairStyles', 'FHairStyles', 'BMHairStyles', 'BFHairStyles'],
  BeardStyle: bySpecies('BeardStyles', 'BBeardStyles'),
  BodyHairStyle: same('BodyHairStyles'),
  FurStyle: [null, null, 'BMFurStyles', 'BFFurStyles'],
  FurPattern: [null, null, 'BMFurPatterns', 'BFFurPatterns'],
  FurFaceStyle: same('FurFaceStyles'),
  FurForeheadStyle: same('FurForeheadStyles'),
  FurEyeStyle: same('FurEyeStyles'),
  FurCheekStyle: same('FurCheekStyles'),
  FurNoseStyle: same('FurNoseStyles'),
  EyeStyle: bySpecies('EyeStyles', 'BEyeStyles'),
  LeftEyeStyle: bySpecies('EyeStyles', 'BEyeStyles'),
  RightEyeStyle: bySpecies('EyeStyles', 'BEyeStyles'),
  EyebrowStyle: same('EyebrowStyles'),
  EyelashStyle: same('EyelashStyles'),
  EyelinerStyle: same('EyelinerStyles'),
  EyeshadowStyle: same('EyeshadowStyles'),
  CheekStyle: same('CheekStyles'),
  LipStyle: same('LipStyles'),
  FreckleStyle: bySpecies('FreckleStyles', 'BFreckleStyles'),
  DirtDirtPattern: same('DirtStyles'),
};
const SLOT_STYLE_LISTS = { tattoo: 'TattooStyles', scar: 'ScarStyles' };

// Tattoos and scars: ten slots each, two per body region. An editor part covers one region;
// its entries before the "second" header describe the region's first slot, the rest its second.
const SLOT_PARTS = /^(Head|RArm|LArm|RLeg|LLeg)(Tattoo|Scar)$/;
const REGION_NAMES = { Head: 'Body_Head', RArm: 'RightArm', LArm: 'LeftArm', RLeg: 'RightLeg', LLeg: 'LeftLeg' };
const SLOT_FIELD = /(?:Tattoos|Scars)([A-Za-z0-9]+?)(?:_2)?$/;
const SECOND_SLOT_HEADER = 'SecondStyleHeader';
const SECOND_SLOT_SWITCH = /^EnableEdit2nd/;

// The eye colour part has one block for both eyes and one per eye; only the blocks in use
// are shown, depending on its "edit each eye separately" switch.
const EYE_PART = 'EyeMakeup';
const EYE_BLOCKS = { EyesHeader: false, LeftEyeHeader: true, RightEyeHeader: true }; // header -> needs the switch on
const EYE_SWITCH = 'EnableSeparatelyEyeEdit';
const EYE_CLOSED = 1;

// Parts where everything after the style means nothing once the style is "none".
const STYLE_LED_PARTS = new Set(['Hair', 'Eyebrow', 'Beard', 'BodyHair', 'Eyelash', 'Eyeshadow', 'Eyeliner', 'Freckle', 'Cheek', 'Lips']);
const NO_STYLE = 0;
const NO_STYLE_NAME = 'None';

const AUDIENCE = { human: 1, beastren: 2, male: 4, female: 8 };
const BEASTREN = 'Beastman';
const FEMALE = 1910070090;
const ALL_TEETH = 0xffff;
const STYLE_KINDS = new Set(['Preset', 'Thumbnail', 'DoubleThumbnail']);
// Entries that load a set of other values at once and store nothing themselves.
const SHORTCUT_KIND = 'ColorPreset';
const SHORTCUT_KEYS = new Set(['TattooPreset', 'ScarPreset', 'EarsEditPreset', 'FurFacePattern']);
const RANGE_SLACK = 1e-4;

function colorOf(node) {
  const raw = node?.raw;
  return raw?.length === 4 ? `#${raw.subarray(0, 3).toString('hex')}` : undefined;
}

/** The number the editor shows for a stored value. */
function shownNumber(entry, stored, beastren) {
  // A few sliders have a different range for beastren, shown as it is stored.
  const own = beastren && entry.beast && entry.beast.max !== entry.beast.min ? entry.beast : null;
  const [min, max] = own ? [own.min, own.max] : [entry.min, entry.max];
  const [viewMin, viewMax] = own ? [own.min, own.max] : [entry.viewMin, entry.viewMax];
  const steps = own ? own.steps : entry.steps;
  if (max === min) return null;
  let shown = viewMin + ((stored - min) / (max - min)) * (viewMax - viewMin);
  // A reversed slider counts from the other end: stored roughness is shown as gloss, and so on.
  if (entry.reverse) shown = viewMax + viewMin - shown;
  const step = steps > 0 ? (viewMax - viewMin) / steps : 1;
  shown = viewMin + Math.round((shown - viewMin) / step) * step;
  return {
    type: 'number',
    value: Number(shown.toFixed(2)),
    // Outside what the slider can reach, as happens with values set by mods.
    outOfRange: stored < Math.min(min, max) - RANGE_SLACK || stored > Math.max(min, max) + RANGE_SLACK,
  };
}

/** A colour with its place among the swatches the editor offers for that area, when it is one of them. */
function colorRow(node, palette) {
  const color = colorOf(node);
  if (!color) return null;
  const index = palette ? palette.indexOf(color.slice(1)) : -1;
  return { type: 'color', color, position: index >= 0 ? index + 1 : null, total: palette?.length ?? null };
}

function styleRow(list, value) {
  const index = list ? list.findIndex(([style]) => style === value) : -1;
  // Zero is "none" for styles that have names; lists that simply number their entries start at zero.
  const none = value === NO_STYLE && (index < 0 || list[index][1] === NO_STYLE_NAME);
  return { type: 'style', none, position: index >= 0 ? index + 1 : null, total: list?.length ?? null };
}

/**
 * @param {{meta: object, bodyEdit: object, pretender: object, bodyDetail: object, faceEdit: object}} contexts  class nodes
 * @param {object} layout  from gamefiles/charaedit.js
 * @param {string} [language]  which language the labels come in
 * @returns {{species: 'human'|'beastren', female: boolean, tabs: {label: string, parts: {label: string, rows: object[]}[]}[], unknown: string[]}}
 *          unknown: labels of editor entries whose value could not be read
 */
export function buildLookSheet(contexts, layout, language = 'en') {
  // Labels come as { en, ko, ... }; layouts built by older versions have plain text.
  const say = (label) => (typeof label === 'string' ? label : label?.[language] || label?.en || '');
  const beastren = layout.species[follow(contexts.meta, ['_Meta', '_Species'])?.value] === BEASTREN;
  const female = follow(contexts.meta, ['_Meta', '_Gender'])?.value === FEMALE;
  const variant = (beastren ? 2 : 0) + (female ? 1 : 0);
  const speciesBit = beastren ? AUDIENCE.beastren : AUDIENCE.human;
  const genderBit = female ? AUDIENCE.female : AUDIENCE.male;
  const visible = (entry) => (entry.audience & speciesBit) !== 0 && (entry.audience & genderBit) !== 0;

  const edits = new Map();
  for (const key of ['bodyEdit', 'faceEdit']) {
    for (const item of follow(contexts[key], ['_EditValues'])?.items ?? []) {
      edits.set(follow(item, ['_EditKeyHash'])?.value >>> 0, follow(item, ['_Value'])?.value);
    }
  }
  const slotsOf = (kind, regionName) => {
    const list = follow(contexts.bodyDetail, [kind === 'tattoo' ? '_Tattoos' : '_Scars', '_SlotDatas'])?.items ?? [];
    const region = Object.entries(layout.regions[kind] ?? {}).find(([, name]) => name === regionName)?.[0];
    return list.filter((slot) => String(follow(slot, ['_Region'])?.value) === region);
  };
  const eyes = (name) => follow(contexts.bodyDetail, ['_Eyes', ...name]);
  const eachEye = Boolean(eyes(['_Left', '_Enabled'])?.value || eyes(['_Right', '_Enabled'])?.value);

  // The editor offers dirt colours only as ready-made pairs.
  const dirtRow = () => {
    const [color, color2] = ['_Color1', '_Color2'].map((name) => colorOf(follow(contexts.bodyDetail, ['_Dirt', name])));
    if (!color) return null;
    const pairs = layout.dirtColors ?? [];
    const index = pairs.findIndex(([a, b]) => `#${a}` === color && `#${b}` === color2);
    return { type: 'color', color, color2, position: index >= 0 ? index + 1 : null, total: pairs.length || null };
  };

  const unknown = [];
  const fromNode = (entry, node, styleList, area) => {
    if (node === undefined) return null;
    if (STYLE_KINDS.has(entry.kind)) return styleRow(layout.styleLists[styleList], node.value);
    if (entry.kind === SHORTCUT_KIND) return dirtRow();
    if (entry.kind === 'Color') return colorRow(node, layout.palettes?.[area]);
    if (entry.kind === 'Check') return { type: 'check', value: Boolean(node.value) };
    return typeof node.value === 'number' ? shownNumber(entry, node.value, beastren) : null;
  };

  const partRows = (part) => {
    const slotPart = part.key.match(SLOT_PARTS);
    const kind = slotPart?.[2].toLowerCase();
    const slots = slotPart ? slotsOf(kind, REGION_NAMES[slotPart[1]]) : null;
    const secondInUse = slots ? (follow(slots[1], ['_Style'])?.value ?? NO_STYLE) !== NO_STYLE : false;
    const rows = [];
    let slot = 0;
    let hidden = false; // inside a block that is switched off, or after a style of "none"
    for (const entry of part.details) {
      if (!visible(entry)) continue;
      if (entry.header) {
        hidden = false;
        if (entry.key === SECOND_SLOT_HEADER) {
          slot = 1;
          hidden = !secondInUse;
        }
        if (part.key === EYE_PART && entry.key in EYE_BLOCKS) hidden = EYE_BLOCKS[entry.key] !== eachEye;
        if (!hidden) rows.push({ type: 'header', label: say(entry.label) });
        continue;
      }
      if (hidden) continue;
      const known = Object.hasOwn(FIELDS, entry.key);
      if (SHORTCUT_KEYS.has(entry.key) || (entry.kind === SHORTCUT_KIND && !known)) continue;
      // The base head is picked from thumbnails that carry no caption of their own.
      const label = say(entry.label) || (STYLE_KINDS.has(entry.kind) ? say(part.label) : '');
      if (!label) continue;

      let row = null;
      if (entry.editId) {
        const stored = edits.get(entry.editId >>> 0);
        if (typeof stored === 'number') row = shownNumber(entry, stored, beastren);
      } else if (slots) {
        if (SECOND_SLOT_SWITCH.test(entry.key)) {
          row = { type: 'check', value: secondInUse };
        } else {
          const fieldName = entry.key.match(SLOT_FIELD)?.[1];
          row = fieldName ? fromNode(entry, follow(slots[slot], [`_${fieldName}`]), SLOT_STYLE_LISTS[kind], part.area) : null;
        }
      } else if (entry.key === 'CloseLeftEye' || entry.key === 'CloseRightEye') {
        const state = eyes([entry.key === 'CloseLeftEye' ? '_LeftEyeState' : '_RightEyeState'])?.value;
        row = state === undefined ? null : { type: 'check', value: state === EYE_CLOSED };
      } else if (entry.key === EYE_SWITCH) {
        row = { type: 'check', value: eachEye };
      } else if (entry.kind === 'Teeth') {
        // One bit per tooth; which bit is which tooth is not known, so only "all" is certain.
        const teeth = follow(contexts.bodyDetail, ['_Teeth', '_TeethEnable'])?.value;
        row = teeth === undefined ? null : { type: 'teeth', all: teeth === ALL_TEETH };
      } else if (known) {
        const [context, path] = FIELDS[entry.key];
        row = fromNode(entry, follow(contexts[context], path), STYLE_LISTS[entry.key]?.[variant], part.area);
      }
      if (!row) {
        unknown.push(label);
        continue;
      }
      rows.push({ label, indent: entry.indent, ...row });
      if (row.type === 'style' && row.none && (slots || STYLE_LED_PARTS.has(part.key))) hidden = true;
    }

    // Headers with nothing under them say nothing, and neither does a "first / second" split
    // when only the first is left.
    let kept = rows.filter((row, i) => row.type !== 'header' || (rows[i + 1] && rows[i + 1].type !== 'header'));
    if (slots && kept.filter((row) => row.type === 'header').length < 2) kept = kept.filter((row) => row.type !== 'header');
    // A region with no tattoo or scar at all comes down to the one line saying so.
    if (slots && kept.every((row) => (row.type === 'check' && !row.value) || (row.type === 'style' && row.none))) {
      kept = kept.filter((row) => row.type === 'style');
    }
    const base = Math.min(...kept.filter((row) => row.type !== 'header').map((row) => row.indent));
    for (const row of kept) if (row.type !== 'header') row.indent -= base;
    return kept;
  };

  const tabs = layout.tabs.map((tab) => ({
    label: say(tab.label),
    parts: tab.parts
      .filter((part) => (beastren ? part.beastren : part.human))
      .map((part) => ({ label: say(part.label), rows: partRows(part) }))
      .filter((part) => part.rows.some((row) => row.type !== 'header')),
  })).filter((tab) => tab.parts.length);

  return { species: beastren ? 'beastren' : 'human', female, tabs, unknown };
}
