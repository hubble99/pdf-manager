import { createContext } from 'react';

export type Theme = 'dark' | 'dusty-rose' | 'steel-blue';

export function isTheme(value: string | null): value is Theme {
  return value === 'dark' || value === 'dusty-rose' || value === 'steel-blue';
}

export interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
