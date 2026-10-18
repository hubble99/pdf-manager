import { useContext } from 'react';
import { LanguageContext, type LanguageContextType } from './LanguageContext.context';

export function useLanguage(): LanguageContextType {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used inside LanguageProvider');
  return context;
}
