// Languages: this program's own text comes from lang/<code>.json, names of things in the game
// come from the game's files as { en, ko, ja, zh, es, fr } and are picked here.

export const LANGUAGES = [
  ['en', 'English'], ['ko', '한국어'], ['ja', '日本語'], ['zh', '简体中文'], ['es', 'Español'], ['fr', 'Français'],
];
const LOCALES = { en: 'en-US', ko: 'ko-KR', ja: 'ja-JP', zh: 'zh-CN', es: 'es-ES', fr: 'fr-FR' };
const FALLBACK = 'en';
const STORED = 'dd2sm.language';

let current = FALLBACK;
let strings = {};
let fallback = {};
let plural = new Intl.PluralRules(LOCALES[FALLBACK]);
let numbers = new Intl.NumberFormat(LOCALES[FALLBACK]);
let times = null;
const extra = []; // string tables of optional features: { [code]: { key: text } }

export const language = () => current;

/** The language chosen before, else the first of the system's languages that is supported. */
export function preferredLanguage() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORED);
  } catch {
    // Storage can be unavailable; the system language is used then.
  }
  const known = (code) => LANGUAGES.some(([c]) => c === code);
  if (known(stored)) return stored;
  for (const tag of navigator.languages ?? [navigator.language]) {
    const code = String(tag).slice(0, 2).toLowerCase();
    if (known(code)) return code;
  }
  return FALLBACK;
}

async function load(code) {
  const response = await fetch(`lang/${code}.json`);
  if (!response.ok) throw new Error(`language ${code}`);
  return response.json();
}

export async function setLanguage(code) {
  if (!Object.keys(fallback).length) fallback = await load(FALLBACK);
  strings = code === FALLBACK ? fallback : await load(code).catch(() => fallback);
  current = code;
  plural = new Intl.PluralRules(LOCALES[code]);
  numbers = new Intl.NumberFormat(LOCALES[code]);
  times = new Intl.DateTimeFormat(LOCALES[code], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  document.documentElement.lang = code;
  try {
    localStorage.setItem(STORED, code);
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/** Lets an optional feature bring its own text: { en: {key: text}, ko: {...}, ... }. */
export function addStrings(table) {
  extra.push(table);
}

function lookup(key) {
  if (key in strings) return strings[key];
  for (const table of extra) {
    const text = table[current]?.[key] ?? table[FALLBACK]?.[key];
    if (text !== undefined) return text;
  }
  return fallback[key];
}

/** Text for a key, with {name} places filled in. A missing key shows itself, so it gets noticed. */
export function t(key, params) {
  const text = lookup(key);
  if (text === undefined) return key;
  return params ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole)) : text;
}

/** Like t() for a count: uses "<key>.one" where the language has a singular and the count is one. */
export function tn(key, n, params) {
  const form = plural.select(n) === 'one' && lookup(`${key}.one`) !== undefined ? `${key}.one` : key;
  return t(form, { n: fmtNum(n), ...params });
}

/** A name read from the game files, in the current language. */
export function gameName(name) {
  if (!name) return null;
  return name[current] || name[FALLBACK] || name.ko || null;
}

export const fmtNum = (n) => (n === null || n === undefined ? '-' : numbers.format(n));
export const fmtTime = (ms) => times.format(new Date(ms));
