import { useState } from 'react';
import type { ReactNode } from 'react';
import { ToastContext } from './ToastContext.context';
import type { Toast } from './ToastContext.types';

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = (toast: Omit<Toast, 'id'>) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { ...toast, id }]);
    if (toast.duration !== 0) {
      setTimeout(() => dismissToast(id), toast.duration ?? 5000);
    }
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
      {children}
    </ToastContext.Provider>
  );
};
