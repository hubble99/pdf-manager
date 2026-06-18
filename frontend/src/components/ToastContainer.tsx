import React from 'react';
import { useToast } from '../hooks/useToast';
import { CheckCircle, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';

export const ToastContainer: React.FC = () => {
  const { toasts, dismissToast } = useToast();

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
            {t.action && (
              <button className="toast-action-btn" onClick={t.action.onClick}>
                {t.action.label}
              </button>
            )}
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
