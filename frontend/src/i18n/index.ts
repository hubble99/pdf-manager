/**
 * Minimal in-app translation.
 *
 * The English text is the key: `t('Merge PDF')` returns the English text as written, or the
 * Indonesian entry from `id.ts` when that language is active. A missing entry falls back to the
 * English text, so a string can never disappear. `{name}` placeholders are filled from `vars`.
 *
 * `t` reads the active language when it is called, including from module-level constants, so
 * changing the language saves it and reloads the app (see `LanguageProvider`).
 */
import { ID } from './id';

export type Language = 'en' | 'id';

export const LANGUAGE_KEY = 'app_language';
export const DEFAULT_LANGUAGE: Language = 'en';

export const LANGUAGE_OPTIONS: { id: Language; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'id', label: 'Bahasa Indonesia' },
];

export function isLanguage(value: string | null | undefined): value is Language {
  return value === 'en' || value === 'id';
}

function readStoredLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    // Storage can be unavailable; fall back to the default.
  }
  return DEFAULT_LANGUAGE;
}

let current: Language = typeof window === 'undefined' ? DEFAULT_LANGUAGE : readStoredLanguage();
if (typeof document !== 'undefined') document.documentElement.lang = current;

export function getLanguage(): Language {
  return current;
}

/** Switches the active language and remembers it. The provider re-renders the app afterwards. */
export function applyLanguage(language: Language): void {
  current = language;
  try {
    window.localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // The choice then only lasts for this session.
  }
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

export type TranslateVars = Record<string, string | number>;

function fill(text: string, vars?: TranslateVars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** Translate `text` (the English source) into the active language. */
export function t(text: string, vars?: TranslateVars): string {
  const translated = current === 'id' ? ID[text] : undefined;
  return fill(translated ?? text, vars);
}

/**
 * Counted text: `tn(n, '{n} page', '{n} pages')` picks the English form by count, then translates
 * it like `t`. Indonesian has no plural, so both forms usually map to the same wording.
 */
export function tn(count: number, one: string, other: string, vars?: TranslateVars): string {
  return t(count === 1 ? one : other, { n: count, ...vars });
}
