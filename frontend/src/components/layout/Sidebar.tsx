import { Fragment, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronLeft, ChevronRight, FileText, Heart, Home, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { APP_NAME } from '../../config/app';
import { DONATION_ENTRY, HOME_ENTRY, featuresByGroup } from '../../config/features';
import type { NavItemId } from '../../types';

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
}

/**
 * One navigation row. Both the grouped feature list and the entries below it use
 * this, so the row markup exists once. `NavLink` marks the current item and sets
 * `aria-current` on its own.
 */
function NavEntry({ id, label, icon: Icon, path, collapsed, accent = false, end = false }: NavEntryProps) {
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
      <Icon className="nav-item-icon" size={20} strokeWidth={1.75} aria-hidden="true" />
      {!collapsed && <span className="nav-item-label">{label}</span>}
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
    <aside
      className={`sidebar ${collapsed ? 'collapsed' : 'expanded'}`}
      role="navigation"
      aria-label="Main navigation"
    >
      {/* ── Header / Logo ── */}
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon" aria-hidden="true">
            <FileText size={18} color="#fff" strokeWidth={2.5} />
          </div>
          {!collapsed && (
            <div>
              <div className="sidebar-logo-text">{APP_NAME}</div>
              <div className="sidebar-logo-sub">v1.6.0</div>
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
              />
            ))}
          </Fragment>
        ))}

        <div className="divider" style={{ margin: '12px 16px' }} />
        {!collapsed && <div className="sidebar-section-label">App</div>}

        {/* Pinned below the features so it stays reachable however long they get. */}
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
          label="Settings"
          icon={Settings}
          path="/settings"
          collapsed={collapsed}
        />
      </nav>

      {/* ── Collapse Toggle ── */}
      <button
        className="sidebar-collapse-btn"
        onClick={toggleCollapsed}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        id="sidebar-collapse-btn"
      >
        {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </button>

      {/* ── Footer ── */}
      {!collapsed && (
        <div className="sidebar-footer">
          <p className="text-mono text-muted" style={{ fontSize: '10px', lineHeight: '1.4' }}>
            {APP_NAME} v1.6.0<br />
            <span style={{ opacity: 0.6 }}>Offline · Local Processing</span>
          </p>
        </div>
      )}
    </aside>
  );
}
