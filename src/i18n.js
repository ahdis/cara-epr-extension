// Tiny i18n helper. Languages are loaded from src/i18n/<lang>.json (flat keys).
const SUPPORTED = ['de', 'fr', 'it', 'en'];
const cache = {};
let active = 'en';
let strings = {};
let fallback = {};

export function mapLanguage(tag) {
  const t = String(tag ?? '').toLowerCase();
  if (t.startsWith('de')) return 'de';
  if (t.startsWith('fr')) return 'fr';
  if (t.startsWith('it')) return 'it';
  return 'en';
}

async function load(lang) {
  if (cache[lang]) return cache[lang];
  const url = new URL(`./i18n/${lang}.json`, import.meta.url);
  const r = await fetch(url);
  cache[lang] = r.ok ? await r.json() : {};
  return cache[lang];
}

export async function setLanguage(lang) {
  active = SUPPORTED.includes(lang) ? lang : 'en';
  fallback = await load('en');
  strings = active === 'en' ? fallback : await load(active);
  if (typeof document !== 'undefined') document.documentElement.lang = active;
  return active;
}

export function currentLanguage() { return active; }

export function t(key, params = {}) {
  let s = strings[key] ?? fallback[key] ?? key;
  for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

const localeMap = { de: 'de-CH', fr: 'fr-CH', it: 'it-CH', en: 'en-GB' };
export function locale() { return localeMap[active] ?? 'en-GB'; }

export function formatDate(iso, opts = { dateStyle: 'medium' }) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return new Intl.DateTimeFormat(locale(), opts).format(d);
}

export function formatDateTime(iso) {
  return formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatSize(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return '';
  const n = Number(bytes);
  const nf = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 });
  if (n < 1024) return `${nf.format(n)} B`;
  if (n < 1024 * 1024) return `${nf.format(n / 1024)} kB`;
  return `${nf.format(n / (1024 * 1024))} MB`;
}

export function formatDuration(ms) {
  if (ms == null) return '';
  const nf = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 });
  return ms < 1000 ? `${Math.round(ms)} ms` : `${nf.format(ms / 1000)} s`;
}

/** Apply data-i18n attributes: textContent, data-i18n-title → title attribute */
export function applyDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}
