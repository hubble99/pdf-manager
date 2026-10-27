import type { ReactNode } from 'react';
import type { IconComponent } from '../icons';

interface PageHeaderProps {
  icon: IconComponent;
  title: string;
  description: string;
  actions?: ReactNode;
  /**
   * Small chip beside the title, e.g. the BETA marker on Edit Content. The
   * tooltip text is passed in so the wording stays with the caller's policy.
   */
  badge?: { label: string; title?: string };
}

export function PageHeader({ icon: Icon, title, description, actions, badge }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        <div className="page-header-icon" aria-hidden="true">
          <Icon size={20} strokeWidth={1.75} />
        </div>
        <div className="page-header-copy">
          <div className="page-header-title-row">
            <h1 className="page-title">{title}</h1>
            {badge && (
              <span className="page-header-badge" title={badge.title}>
                {badge.label}
              </span>
            )}
          </div>
          <p className="page-subtitle">{description}</p>
        </div>
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
