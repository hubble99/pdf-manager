import { createContext } from 'react';
import type { ToastContextValue } from './ToastContext.types';

export const ToastContext = createContext<ToastContextValue | null>(null);