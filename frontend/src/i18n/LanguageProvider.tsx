import { useCallback, useMemo, type ReactNode } from 'react';
import { LanguageContext } from './LanguageContext.context';
import { applyLanguage, getLanguage, type Language } from './index';

/** Set just before a language reload so the Tauri splash screen is not shown again. */
export const SKIP_SPLASH_KEY = 'app_skip_splash_once';

/**
 * Exposes the active language. Text is translated where it is created, including module-level
 * constants, so a switch is applied by saving the choice and reloading the app once.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const language = getLanguage();

  const setLanguage = useCallback((next: Language) => {
    if (next === getLanguage()) return;
    applyLanguage(next);
    try {
      window.sessionStorage.setItem(SKIP_SPLASH_KEY, '1');
    } catch {
      // Without it the splash simply shows again.
    }
    window.location.reload();
  }, []);

  const value = useMemo(() => ({ language, setLanguage }), [language, setLanguage]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
