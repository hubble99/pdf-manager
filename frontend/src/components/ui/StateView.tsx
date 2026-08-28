import type { ReactNode } from 'react';
import { LoaderCircle, type LucideIcon } from 'lucide-react';

type StateTone = 'neutral' | 'danger';

interface StateViewProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: StateTone;
  compact?: boolean;
  loading?: boolean;
  className?: string;
}

export function StateView({
  icon: Icon,
  title,
  description,
  action,
  tone = 'neutral',
  compact = false,
  loading = false,
  className = '',
}: StateViewProps) {
  const role = tone === 'danger' ? 'alert' : 'status';
  const StateIcon = loading ? LoaderCircle : Icon;

  return (
    <div
      className={`state-view state-view--${tone}${compact ? ' state-view--compact' : ''}${loading ? ' state-view--loading' : ''} ${className}`.trim()}
      role={role}
      aria-live={tone === 'danger' ? 'assertive' : 'polite'}
      aria-busy={loading || undefined}
    >
      {StateIcon && (
        <div className="state-view-icon" aria-hidden="true">
          <StateIcon />
        </div>
      )}
      <div className="state-view-copy">
        <p className="state-view-title">{title}</p>
        {description && <p className="state-view-description">{description}</p>}
      </div>
      {action && <div className="state-view-action">{action}</div>}
    </div>
  );
}
