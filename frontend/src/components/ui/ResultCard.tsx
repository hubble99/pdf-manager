import type { ReactNode } from 'react';
import { CheckCircle, FolderOpen } from 'lucide-react';

interface ResultCardProps {
  title: string;
  /** File name, counts and sizes under the title. */
  detail?: ReactNode;
  /** Button on the right, normally "Open Downloads". */
  action?: { label: string; onClick: () => void; id?: string };
  id?: string;
  /** Puts the button under the text; for narrow side columns. */
  stacked?: boolean;
}

/** The green "your file is in Downloads" card every tool shows once its result is saved. */
export function ResultCard({ title, detail, action, id, stacked = false }: ResultCardProps) {
  return (
    <div className={`card status-card status-card--ok result-banner${stacked ? ' result-banner--stacked' : ''}`} role="status" id={id}>
      <CheckCircle size={22} aria-hidden="true" />
      <div className="status-card-copy">
        <b>{title}</b>
        {detail && <small>{detail}</small>}
      </div>
      {action && (
        <button type="button" className="btn btn-ghost btn-sm" id={action.id} onClick={action.onClick}>
          <FolderOpen size={14} aria-hidden="true" />
          {action.label}
        </button>
      )}
    </div>
  );
}
