import { createContext } from 'react';
import { t } from '../i18n';

export type Theme = 'light' | 'dark' | 'dusty-rose' | 'steel-blue';

/** Light is the default; the other three are the palettes the app already shipped. */
export const DEFAULT_THEME: Theme = 'light';

/** Ordered for the Settings > Appearance picker. */
export const THEME_OPTIONS: { id: Theme; label: string }[] = [
  { id: 'light', label: t('Light') },
  { id: 'dark', label: t('Dark') },
  { id: 'dusty-rose', label: t('Dusty Rose') },
  { id: 'steel-blue', label: t('Steel Blue') },
];

/**
 * Decorative swatch colours for the theme cards. They restate each palette in
 * miniature so a card can preview a theme that is not currently active; the
 * live theme still comes from the CSS tokens, never from here.
 */
export const THEME_SWATCH: Record<Theme, { bg: string; surface: string; line: string; accent: string }> = {
  light: { bg: '#f6f8fe', surface: '#ffffff', line: '#d5dbe8', accent: '#0b4ea6' },
  dark: { bg: '#0f0f0f', surface: '#1c1b1b', line: '#414752', accent: '#4a9eff' },
  'dusty-rose': { bg: '#ffffff', surface: '#fff5f5', line: '#d4a8a8', accent: '#5c3333' },
  'steel-blue': { bg: '#ffffff', surface: '#f0f3fa', line: '#b1c9ef', accent: '#395886' },
};

export function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark' || value === 'dusty-rose' || value === 'steel-blue';
}

export interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
