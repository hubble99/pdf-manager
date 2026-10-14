import { useEffect, useState } from 'react';
import {
  ExternalLink,
  FolderOpen,
  HardDrive,
  Heart,
  History,
  Info,
  Loader2,
  Palette,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import apiClient from '../api/client';
import { getHistory, clearHistory, removeHistoryEntry } from '../utils/historyStore';
import type { HistoryEntry } from '../utils/historyStore';
import { Filename } from '../components/Filename';
import { isTauri, openFilePicker, openOutputFolder } from '../utils/tauriDialog';
import { useToast } from '../hooks/useToast';
import { useTheme } from '../hooks/useTheme';
import { THEME_OPTIONS, THEME_SWATCH } from '../context/ThemeContext.context';
import { PageHeader } from '../components/ui';
import {
  APP_NAME, APP_PRIVACY_NOTE, APP_SOURCE_URL, APP_TECH_STACK, APP_VERSION,
} from '../config/app';

const OUTDIR_KEY = 'pdf_manager_outdir';
const DEFAULT_OUTDIR = 'Documents/PDF Manager';

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Short relative time for the session-only output list. */
function timeAgo(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function SettingsPage() {
  const { showToast } = useToast();
  const { theme, setTheme } = useTheme();
  const [outDir, setOutDir] = useState(() => localStorage.getItem(OUTDIR_KEY) || '');
  const [isClearing, setIsClearing] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    const updateHistory = () => setHistory(getHistory());
    updateHistory();
    window.addEventListener('history-updated', updateHistory);
    return () => window.removeEventListener('history-updated', updateHistory);
  }, []);

  const handleSaveOutDir = () => {
    localStorage.setItem(OUTDIR_KEY, outDir);
    showToast({ type: 'success', title: 'Settings saved', message: 'Default output folder updated.' });
  };

  const handleBrowseOutput = async () => {
    if (!isTauri()) {
      showToast({ type: 'info', title: 'Browser mode', message: 'Native folder picker is only available in the desktop app.' });
      return;
    }
    const paths = await openFilePicker({ multiple: false, title: 'Select output folder' });
    if (paths?.[0]) setOutDir(paths[0]);
  };

  const handleResetOutDir = () => {
    localStorage.removeItem(OUTDIR_KEY);
    setOutDir('');
    showToast({ type: 'success', title: 'Settings saved', message: 'Output folder reset to the default location.' });
  };

  const handleOpenOutDir = async () => {
    const opened = await openOutputFolder();
    if (!opened && !isTauri()) {
      showToast({ type: 'info', title: 'Browser mode', message: 'The output folder can only be opened in the desktop app.' });
    }
  };

  const handleClearTemp = async () => {
    setIsClearing(true);
    try {
      const resp = await apiClient.post('/api/v1/settings/clear-temp');
      const { files_deleted, bytes_freed } = resp.data.data;
      showToast({
        type: 'success',
        title: 'Temp files cleared',
        message: `Deleted ${files_deleted} files, freed ${formatBytes(bytes_freed)}.`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      showToast({ type: 'error', title: 'Clear failed', message: msg });
    } finally {
      setIsClearing(false);
    }
  };

  const handleRemoveHistory = (id: string) => {
    removeHistoryEntry(id);
  };

  const displayDir = outDir || DEFAULT_OUTDIR;

  return (
    <div className="feature-page">
      <PageHeader
        icon={Settings}
        title="Settings"
        description="Appearance, output folder, and app information"
      />

      <div className="page-body">
        <div className="settings-page">

          {/* Appearance */}
          <section className="card settings-card">
            <div className="settings-card-head">
              <Palette size={16} aria-hidden="true" />
              <h2>Appearance</h2>
            </div>
            <div className="settings-card-body">
              <div className="theme-grid" role="radiogroup" aria-label="Theme">
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
                {APP_NAME} starts in Light. Your choice is remembered on this device.
              </p>
            </div>
          </section>

          {/* Output folder */}
          <section className="card settings-card">
            <div className="settings-card-head">
              <FolderOpen size={16} aria-hidden="true" />
              <h2>Output folder</h2>
              <span className="settings-card-actions">
                {outDir && (
                  <button type="button" className="link-btn" onClick={handleResetOutDir}>
                    Reset to default
                  </button>
                )}
              </span>
            </div>
            <div className="settings-card-body">
              <div className="dir-box" title={displayDir}>
                <FolderOpen size={15} aria-hidden="true" />
                <input
                  type="text"
                  value={outDir}
                  onChange={(event) => setOutDir(event.target.value)}
                  placeholder={DEFAULT_OUTDIR}
                  aria-label="Output folder"
                  id="settings-output-path"
                  spellCheck={false}
                />
              </div>
              <div className="settings-actions-left">
                <button type="button" className="btn btn-secondary" onClick={handleBrowseOutput} id="settings-browse-output">
                  <FolderOpen size={14} /> Change folder
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleOpenOutDir} id="settings-open-output">
                  <ExternalLink size={14} /> Open folder
                </button>
                <button type="button" className="btn btn-primary" onClick={handleSaveOutDir} id="settings-save-output">
                  Save
                </button>
              </div>
              <p className="settings-hint">
                {isTauri()
                  ? 'Files created by every tool are saved here.'
                  : 'Running in browser mode — type a path and save it. The Browse button requires the desktop app.'}
              </p>
            </div>
          </section>

          {/* Temporary storage */}
          <section className="card settings-card">
            <div className="settings-card-head">
              <HardDrive size={16} aria-hidden="true" />
              <h2>Temporary storage</h2>
            </div>
            <div className="settings-card-body">
              <p className="settings-hint">
                Temporary files and generated outputs from backend operations can accumulate over time.
              </p>
              <div className="settings-actions-left">
                <button className="btn btn-secondary" onClick={handleClearTemp} disabled={isClearing}>
                  {isClearing ? <Loader2 size={15} className="converter-spin" /> : <Trash2 size={15} />}
                  Clear temp files
                </button>
              </div>
            </div>
          </section>

          {/* Recent output files */}
          <section className="card settings-card">
            <div className="settings-card-head">
              <History size={16} aria-hidden="true" />
              <h2>Recent output files</h2>
              <span className="settings-card-actions">
                {history.length > 0 && (
                  <button type="button" className="link-btn" onClick={clearHistory} id="settings-clear-history">
                    Clear list
                  </button>
                )}
              </span>
            </div>
            {history.length === 0 ? (
              <div className="settings-empty">Files you create will appear here.</div>
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
                        {entry.action} · {formatBytes(entry.size)} · {timeAgo(entry.timestamp)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => handleRemoveHistory(entry.id)}
                      aria-label={`Remove ${entry.filename} from the list`}
                      style={{ color: 'var(--error)' }}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="settings-card-foot">
              Shown for this session only. The list clears when you close the app.
            </div>
          </section>

          {/* Support */}
          <section className="card settings-support">
            <span className="settings-support-icon" aria-hidden="true">
              <Heart size={20} />
            </span>
            <span className="settings-support-copy">
              <strong>Support this app</strong>
              <p>{APP_NAME} is independent, private, and offline software. Donations help keep it going.</p>
            </span>
            <Link to="/donation" className="btn btn-primary" id="settings-donate">Donate</Link>
          </section>

          {/* About */}
          <section className="card settings-card">
            <div className="settings-card-head">
              <Info size={16} aria-hidden="true" />
              <h2>About</h2>
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
              Local document tools that keep your files on your device.
            </p>
            <dl className="about-rows">
              <div className="about-row">
                <dt>Version</dt>
                <dd>{APP_VERSION}</dd>
              </div>
              <div className="about-row">
                <dt>Built with</dt>
                <dd>{APP_TECH_STACK}</dd>
              </div>
              <div className="about-row">
                <dt>Source code</dt>
                <dd>
                  <a className="link-btn" href={APP_SOURCE_URL} target="_blank" rel="noreferrer">
                    github.com/hubble99/pdf-manager
                  </a>
                </dd>
              </div>
              <div className="about-row">
                <dt>Feedback</dt>
                <dd>
                  <a
                    className="link-btn"
                    href={`${APP_SOURCE_URL}/issues`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Report an issue
                  </a>
                </dd>
              </div>
              <div className="about-row">
                <dt>Privacy</dt>
                <dd>{APP_PRIVACY_NOTE}</dd>
              </div>
            </dl>
            <div className="settings-card-foot">
              Every tool runs locally. Nothing is uploaded and nothing is kept after you close the app.
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
