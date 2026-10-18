import React, { useState } from 'react';
import { useToast } from '../hooks/useToast';
import { CheckCircle, AlertCircle, Info, AlertTriangle, FolderCheck, FolderX, LoaderCircle, X } from 'lucide-react';
import { t } from '../i18n';

type ActionState = 'idle' | 'opening' | 'opened' | 'failed';

export const ToastContainer: React.FC = () => {
  const { toasts, dismissToast } = useToast();
  const [actionStates, setActionStates] = useState<Record<string, ActionState>>({});

  const handleAction = async (toastId: string, onClick: () => void | boolean | Promise<void | boolean>) => {
    setActionStates((current) => ({ ...current, [toastId]: 'opening' }));
    try {
      const result = await onClick();
      setActionStates((current) => ({ ...current, [toastId]: result === false ? 'failed' : 'opened' }));
    } catch {
      setActionStates((current) => ({ ...current, [toastId]: 'failed' }));
    }
  };

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.type}`}>
          <span className="toast-icon">
            {toast.type === 'success' && <CheckCircle size={20} />}
            {toast.type === 'error' && <AlertCircle size={20} />}
            {toast.type === 'info' && <Info size={20} />}
            {toast.type === 'warning' && <AlertTriangle size={20} />}
          </span>
          <div className="toast-body">
            <div className="toast-title">{toast.title}</div>
            {toast.message && <div className="toast-message">{toast.message}</div>}
            {toast.action && (() => {
              const state = actionStates[toast.id] ?? 'idle';
              const label = state === 'opening'
                ? t('Opening folder…')
                : state === 'opened'
                  ? t('Folder opened')
                  : state === 'failed'
                    ? t('Try again')
                    : toast.action.label;

              return (
                <button
                  className={`toast-action-btn toast-action-${state}`}
                  onClick={() => void handleAction(toast.id, toast.action!.onClick)}
                  disabled={state === 'opening' || state === 'opened'}
                  aria-live="polite"
                >
                  {state === 'opening' && <LoaderCircle size={14} className="toast-action-spinner" />}
                  {state === 'opened' && <FolderCheck size={14} />}
                  {state === 'failed' && <FolderX size={14} />}
                  {label}
                </button>
              );
            })()}
          </div>
          <button
            className="toast-close"
            onClick={() => dismissToast(toast.id)}
            aria-label={t('Close')}
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
};
