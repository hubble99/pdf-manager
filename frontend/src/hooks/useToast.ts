import { useContext } from 'react';
import { ToastContext } from '../context/ToastContext.context';
import type { ToastContextValue } from '../context/ToastContext.types';

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
};
