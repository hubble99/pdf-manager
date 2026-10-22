import { Fragment, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Heart, Home, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { APP_NAME, APP_VERSION } from '../../config/app';
import { BrandLogo } from '../BrandLogo';
import { BETA_TOOLTIP, DONATION_ENTRY, HOME_ENTRY, featuresByGroup } from '../../config/features';
import type { NavItemId } from '../../types';
import { t } from '../../i18n';

interface NavEntryProps {
  id: NavItemId;
  label: string;
  icon: LucideIcon;
  path: string;
  collapsed: boolean;
  /** The donation entry carries its own accent colour. */
  accent?: boolean;
  /** Home must match the root path exactly. */
  end?: boolean;
  /** Renders the BETA chip and its tooltip beside the label. */
  beta?: boolean;
}

/**
 * One navigation row. Both the grouped feature list and the entries below it use
 * this, so the row markup exists once. `NavLink` marks the current item and sets
 * `aria-current` on its own.
 */
function NavEntry({
  id, label, icon: Icon, path, collapsed, accent = false, end = false, beta = false,
}: NavEntryProps) {
  return (
    <NavLink
      to={path}
      end={end}
      className={({ isActive }) => [
        'nav-item',
        isActive ? 'active' : '',
        collapsed ? 'nav-item-collapsed' : '',
        accent ? 'nav-item--accent' : '',
      ].filter(Boolean).join(' ')}
      id={`nav-${id}`}
      title={collapsed ? label : undefined}
    >
      <Icon className="nav-item-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
      {!collapsed && (
        <>
          <span className="nav-item-label">{label}</span>
          {beta && (
            <span className="nav-item-badge" title={BETA_TOOLTIP} id={`nav-beta-${id}`}>
              BETA
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

export function Sidebar() {
  // Persist collapse state to localStorage
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('sidebar_collapsed') === 'true';
  });

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem('sidebar_collapsed', String(next));
      return next;
    });
  };

  return (
    <nav
      className={`sidebar ${collapsed ? 'collapsed' : 'expanded'}`}
      aria-label={t('Main navigation')}
    >
      {/* ── Header / Logo ── */}
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon sidebar-logo-icon--brand" aria-hidden="true">
            <BrandLogo variant="mark" size={32} />
          </div>
          {!collapsed && (
            <div className="sidebar-brand">
              <span className="sidebar-logo-text">{APP_NAME}</span>
              <span className="sidebar-logo-sub">v{APP_VERSION}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Navigation ── */}
      <nav className="sidebar-nav">
        <NavEntry
          id={HOME_ENTRY.id}
          label={HOME_ENTRY.name}
          icon={Home}
          path={HOME_ENTRY.route}
          collapsed={collapsed}
          end
        />

        {featuresByGroup().map((group) => (
          <Fragment key={group.id}>
            {!collapsed && <div className="sidebar-section-label">{group.label}</div>}
            {group.features.map((feature) => (
              <NavEntry
                key={feature.id}
                id={feature.id}
                label={feature.name}
                icon={feature.icon}
                path={feature.route}
                collapsed={collapsed}
                beta={feature.beta}
              />
            ))}
          </Fragment>
        ))}
      </nav>

      {/* ── Footer: the two entries that are not features ── */}
      <div className="sidebar-foot">
        <NavEntry
          id={DONATION_ENTRY.id}
          label={DONATION_ENTRY.name}
          icon={Heart}
          path={DONATION_ENTRY.route}
          collapsed={collapsed}
          accent
        />
        <NavEntry
          id="settings"
          label={t('Settings')}
          icon={Settings}
          path="/settings"
          collapsed={collapsed}
        />
      </div>

      {/* ── Collapse Toggle ── */}
      <button
        className="sidebar-collapse-btn"
        onClick={toggleCollapsed}
        title={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
        aria-label={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
        id="sidebar-collapse-btn"
      >
        {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </button>
    </nav>
  );
}
