import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Merge,
  Scissors,
  Minimize2,
  Image,
  FileImage,
  QrCode,
  FilePlus,
  Settings,
  FileText,
  Layers,
  Tag,
  Shield,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { NavItemId } from '../../types';

interface NavItemDef {
  id: NavItemId;
  label: string;
  icon: LucideIcon;
  path: string;
  badge?: string;
}

const NAV_ITEMS: NavItemDef[] = [
  { id: 'merge',         label: 'Merge PDF',       icon: Merge,      path: '/merge' },
  { id: 'extract',       label: 'Split PDF',       icon: Scissors,   path: '/extract' },
  { id: 'organize',      label: 'Organize Pages',  icon: Layers,     path: '/organize' },
  { id: 'metadata',      label: 'Edit Metadata',   icon: Tag,        path: '/metadata' },
  { id: 'protect',       label: 'Protect PDF',     icon: Shield,     path: '/protect' },
  { id: 'compress',      label: 'Compress PDF',    icon: Minimize2,  path: '/compress' },
  { id: 'pdf-to-image',  label: 'PDF to Image',    icon: Image,      path: '/pdf-to-image' },
  { id: 'image-to-pdf',  label: 'Image to PDF',    icon: FileImage,  path: '/image-to-pdf' },
  { id: 'qr-barcode',    label: 'QR & Barcode',    icon: QrCode,     path: '/qr-barcode' },
  { id: 'insert',        label: 'Insert Content',  icon: FilePlus,   path: '/insert', badge: 'ADV' },
];

export function Sidebar() {
  const location = useLocation();

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
              <div className="sidebar-logo-text">PDF Manager</div>
              <div className="sidebar-logo-sub">v2.0</div>
            </div>
          )}
        </div>
      </div>

      {/* ── Navigation ── */}
      <nav className="sidebar-nav">
        {!collapsed && <div className="sidebar-section-label">Tools</div>}

        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.path ||
            (item.path !== '/' && location.pathname.startsWith(item.path));

          return (
            <NavLink
              key={item.id}
              to={item.path}
              className={`nav-item ${isActive ? 'active' : ''} ${collapsed ? 'nav-item-collapsed' : ''}`}
              id={`nav-${item.id}`}
              aria-current={isActive ? 'page' : undefined}
              title={collapsed ? item.label : undefined}
            >
              <Icon
                className="nav-item-icon"
                size={20}
                strokeWidth={1.75}
                aria-hidden="true"
              />
              {!collapsed && (
                <>
                  <span className="nav-item-label">{item.label}</span>
                  {item.badge && (
                    <span className="nav-item-badge" aria-label={`${item.badge} feature`}>
                      {item.badge}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          );
        })}

        <div className="divider" style={{ margin: '12px 16px' }} />
        {!collapsed && <div className="sidebar-section-label">App</div>}

        <NavLink
          to="/settings"
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''} ${collapsed ? 'nav-item-collapsed' : ''}`}
          id="nav-settings"
          title={collapsed ? 'Settings' : undefined}
        >
          <Settings className="nav-item-icon" size={20} strokeWidth={1.75} aria-hidden="true" />
          {!collapsed && <span className="nav-item-label">Settings</span>}
        </NavLink>
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
            PDF Manager v2.0<br />
            <span style={{ opacity: 0.6 }}>Offline · Local Processing</span>
          </p>
        </div>
      )}
    </aside>
  );
}
