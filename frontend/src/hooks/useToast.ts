import { useContext } from 'react';
import { ToastContext } from '../context/ToastContext';
import type { ToastContextValue } from '../context/ToastContext';

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
};
