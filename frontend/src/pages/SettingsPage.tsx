import { useEffect, useState } from 'react';
import {
  FolderOpen,
  HardDrive,
  Heart,
  History,
  Info,
  Languages,
  Loader2,
  Palette,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { clearTempFiles } from '../api/housekeeping';
import { NativeCoreError } from '../api/nativeCore';
import { getHistory, clearHistory, removeHistoryEntry } from '../utils/historyStore';
import type { HistoryEntry } from '../utils/historyStore';
import { Filename } from '../components/Filename';
import { useToast } from '../hooks/useToast';
import { useTheme } from '../hooks/useTheme';
import { THEME_OPTIONS, THEME_SWATCH } from '../context/ThemeContext.context';
import { PageHeader, SegmentedControl } from '../components/ui';
import { useLanguage } from '../i18n/useLanguage';
import {
  APP_NAME, APP_PRIVACY_NOTE, APP_SOURCE_URL, APP_TECH_STACK, APP_VERSION,
} from '../config/app';
import { LANGUAGE_OPTIONS, t, tn } from '../i18n';

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Short relative time for the session-only output list. */
function timeAgo(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return t('Just now');
  if (minutes < 60) return t('{n} min ago', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('{n} h ago', { n: hours });
  return t('{n} d ago', { n: Math.round(hours / 24) });
}

// ── Component ─────────────────────────────────────────────────────────────────
export function SettingsPage() {
  const { showToast } = useToast();
  const { theme, setTheme } = useTheme();
  const { language, setLanguage } = useLanguage();
  const [isClearing, setIsClearing] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    const updateHistory = () => setHistory(getHistory());
    updateHistory();
    window.addEventListener('history-updated', updateHistory);
    return () => window.removeEventListener('history-updated', updateHistory);
  }, []);

  const handleClearTemp = async () => {
    setIsClearing(true);
    try {
      const { filesDeleted, bytesFreed } = await clearTempFiles();
      showToast({
        type: 'success',
        title: t('Temp files cleared'),
        message: tn(filesDeleted, 'Deleted {n} file, freed {size}.', 'Deleted {n} files, freed {size}.', { size: formatBytes(bytesFreed) }),
      });
    } catch (err: unknown) {
      const msg = err instanceof NativeCoreError && err.code === 'busy'
        ? t('A job is still running. Wait for it to finish, then try again.')
        : err instanceof Error ? err.message : t('Unknown error');
      showToast({ type: 'error', title: t('Clear failed'), message: msg });
    } finally {
      setIsClearing(false);
    }
  };

  const handleRemoveHistory = (id: string) => {
    removeHistoryEntry(id);
  };

  return (
    <div className="feature-page">
      <PageHeader
        icon={Settings}
        title={t('Settings')}
        description={t('Appearance, language, and app information')}
      />

      <div className="page-body">
        <div className="settings-page">

          {/* Appearance */}
          <section className="card settings-card">
            <div className="settings-card-head">
              <Palette size={16} aria-hidden="true" />
              <h2>{t('Appearance')}</h2>
            </div>
            <div className="settings-card-body">
              <div className="theme-grid" role="radiogroup" aria-label={t('Theme')}>
                {THEME_OPTIONS.map((option) => {
                  const swatch = THEME_SWATCH[option.id];
                  const selected = theme === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`theme-card${selected ? ' theme-card--selected' : ''}`}
                      onClick={() => setTheme(option.id)}
                      id={`theme-${option.id}`}
                    >
                      <span
                        className="theme-preview"
                        aria-hidden="true"
                        style={{
                          background: swatch.bg,
                          borderColor: swatch.line,
                        }}
                      >
                        <span className="theme-preview-side" style={{ background: swatch.surface }} />
                        <span className="theme-preview-line" style={{ background: swatch.line }} />
                        <span className="theme-preview-line theme-preview-line--short" style={{ background: swatch.line }} />
                        <span className="theme-preview-button" style={{ background: swatch.accent }} />
                      </span>
                      <span className="theme-card-label">
                        <span className="theme-card-radio" aria-hidden="true" />
                        <span className="theme-card-name">{option.label}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="settings-hint">
                {t('{app} starts in Light. Your choice is remembered on this device.', { app: APP_NAME })}
              </p>
            </div>
          </section>

          {/* Language */}
          <section className="card settings-card">
            <div className="settings-card-head">
              <Languages size={16} aria-hidden="true" />
              <h2>{t('Language')}</h2>
            </div>
            <div className="settings-card-body">
              <SegmentedControl
                equal
                ariaLabel={t('Language')}
                idPrefix="settings-language"
                value={language}
                onChange={setLanguage}
                options={LANGUAGE_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
              />
              <p className="settings-hint">{t('The app restarts its screens when you switch. Your choice is remembered on this device.')}</p>
            </div>
          </section>

          {/* Temporary storage */}
          <section className="card settings-card">
            <div className="settings-card-head">
              <HardDrive size={16} aria-hidden="true" />
              <h2>{t('Temporary storage')}</h2>
            </div>
            <div className="settings-card-body">
              <p className="settings-hint">
                {t('Temporary files and generated outputs can accumulate over time.')}
              </p>
              <div className="settings-actions-left">
                <button className="btn btn-secondary" onClick={handleClearTemp} disabled={isClearing}>
                  {isClearing ? <Loader2 size={15} className="converter-spin" /> : <Trash2 size={15} />}
                  {t('Clear temp files')}
                </button>
              </div>
            </div>
          </section>

          {/* Recent output files */}
          <section className="card settings-card">
            <div className="settings-card-head">
              <History size={16} aria-hidden="true" />
              <h2>{t('Recent output files')}</h2>
              <span className="settings-card-actions">
                {history.length > 0 && (
                  <button type="button" className="link-btn" onClick={clearHistory} id="settings-clear-history">
                    {t('Clear list')}
                  </button>
                )}
              </span>
            </div>
            {history.length === 0 ? (
              <div className="settings-empty">{t('Files you create will appear here.')}</div>
            ) : (
              <ul className="settings-file-list">
                {history.map((entry) => (
                  <li key={entry.id} className="settings-file-row">
                    <span className="settings-file-ext" aria-hidden="true">
                      {(entry.filename.split('.').pop() || 'file').slice(0, 4).toUpperCase()}
                    </span>
                    <span className="settings-file-copy">
                      <Filename name={entry.filename} className="settings-file-name" />
                      <span className="settings-file-meta">
                        {t(entry.action)} · {formatBytes(entry.size)} · {timeAgo(entry.timestamp)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm text-error"
                      onClick={() => handleRemoveHistory(entry.id)}
                      aria-label={t('Remove {name} from the list', { name: entry.filename })}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="settings-card-foot">
              {t('Shown for this session only. The list clears when you close the app.')}
            </div>
          </section>

          {/* Support */}
          <section className="card settings-support">
            <span className="settings-support-icon" aria-hidden="true">
              <Heart size={20} />
            </span>
            <span className="settings-support-copy">
              <strong>{t('Support this app')}</strong>
              <p>{t('{app} is independent, private, and offline software. Donations help keep it going.', { app: APP_NAME })}</p>
            </span>
            <Link to="/donation" className="btn btn-primary" id="settings-donate">{t('Donate')}</Link>
          </section>

          {/* About */}
          <section className="card settings-card">
            <div className="settings-card-head">
              <Info size={16} aria-hidden="true" />
              <h2>{t('About')}</h2>
            </div>
            <div className="about-head">
              <span className="about-logo" aria-hidden="true">
                <FolderOpen size={18} />
              </span>
              <span className="about-copy">
                <strong>{APP_NAME}</strong>
                <span className="about-version">v{APP_VERSION}</span>
              </span>
            </div>
            <p className="about-description">
              {t('Local document tools that keep your files on your device.')}
            </p>
            <dl className="about-rows">
              <div className="about-row">
                <dt>{t('Version')}</dt>
                <dd>{APP_VERSION}</dd>
              </div>
              <div className="about-row">
                <dt>{t('Built with')}</dt>
                <dd>{APP_TECH_STACK}</dd>
              </div>
              <div className="about-row">
                <dt>{t('Source code')}</dt>
                <dd>
                  <a className="link-btn" href={APP_SOURCE_URL} target="_blank" rel="noreferrer">
                    github.com/hubble99/pdf-manager
                  </a>
                </dd>
              </div>
              <div className="about-row">
                <dt>{t('Feedback')}</dt>
                <dd>
                  <a
                    className="link-btn"
                    href={`${APP_SOURCE_URL}/issues`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('Report an issue')}
                  </a>
                </dd>
              </div>
              <div className="about-row">
                <dt>{t('Privacy')}</dt>
                <dd>{APP_PRIVACY_NOTE}</dd>
              </div>
            </dl>
            <div className="settings-card-foot">
              {t('Every tool runs locally. Nothing is uploaded and nothing is kept after you close the app.')}
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
