import React, { useState } from 'react';
import { useToast } from '../hooks/useToast';
import { CheckCircle, AlertCircle, Info, AlertTriangle, FolderCheck, FolderX, LoaderCircle, X } from 'lucide-react';

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
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span className="toast-icon">
            {t.type === 'success' && <CheckCircle size={20} />}
            {t.type === 'error' && <AlertCircle size={20} />}
            {t.type === 'info' && <Info size={20} />}
            {t.type === 'warning' && <AlertTriangle size={20} />}
          </span>
          <div className="toast-body">
            <div className="toast-title">{t.title}</div>
            {t.message && <div className="toast-message">{t.message}</div>}
            {t.action && (() => {
              const state = actionStates[t.id] ?? 'idle';
              const label = state === 'opening'
                ? 'Opening folder…'
                : state === 'opened'
                  ? 'Folder opened'
                  : state === 'failed'
                    ? 'Try again'
                    : t.action.label;

              return (
                <button
                  className={`toast-action-btn toast-action-${state}`}
                  onClick={() => void handleAction(t.id, t.action!.onClick)}
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
            onClick={() => dismissToast(t.id)}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
};
