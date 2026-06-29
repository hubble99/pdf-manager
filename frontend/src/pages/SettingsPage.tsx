import { useEffect, useState } from 'react';
import {
  FolderOpen,
  HardDrive,
  History,
  Info,
  Moon,
  Palette,
  Settings,
  Trash2,
  Loader2,
  Waves,
} from 'lucide-react';
import apiClient from '../api/client';
import { getHistory, clearHistory } from '../utils/historyStore';
import type { HistoryEntry } from '../utils/historyStore';
import { Filename } from '../components/Filename';
import { isTauri, openFilePicker } from '../utils/tauriDialog';
import { useToast } from '../hooks/useToast';
import { useTheme } from '../context/ThemeContext';


// ── Types ─────────────────────────────────────────────────────────────────────

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}


// ── Component ─────────────────────────────────────────────────────────────────
export function SettingsPage() {
  const { showToast } = useToast();
  const { theme, setTheme } = useTheme();
  const [outDir, setOutDir] = useState('');
  const [isClearing, setIsClearing] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem('pdf_manager_outdir');
    if (saved) setOutDir(saved);

    const updateHistory = () => setHistory(getHistory());
    updateHistory();
    window.addEventListener('history-updated', updateHistory);
    return () => window.removeEventListener('history-updated', updateHistory);
  }, []);


  const handleSaveOutDir = () => {
    localStorage.setItem('pdf_manager_outdir', outDir);
    showToast({ type: 'success', title: 'Settings Saved', message: 'Default output directory updated.' });
  };

  const handleBrowseOutput = async () => {
    if (!isTauri()) {
      showToast({ type: 'info', title: 'Browser Mode', message: 'Native folder picker is only available in the Tauri desktop app.' });
      return;
    }
    const paths = await openFilePicker({ multiple: false, title: 'Select Output Folder' });
    if (paths?.[0]) {
      setOutDir(paths[0]);
    }
  };

  const handleClearTemp = async () => {
    setIsClearing(true);
    try {
      const resp = await apiClient.post('/api/v1/settings/clear-temp');
      const { files_deleted, bytes_freed } = resp.data.data;
      showToast({
        type: 'success', 
        title: 'Temp Files Cleared', 
        message: `Deleted ${files_deleted} files, freed ${formatBytes(bytes_freed)}.`
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      showToast({ type: 'error', title: 'Clear Failed', message: msg });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: 36, height: 36, borderRadius: 'var(--radius-md)',
            background: 'var(--accent-dim)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: 'var(--accent)',
          }}>
            <Settings size={20} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="page-title">Settings</h1>
            <p className="page-subtitle">Configure application preferences</p>
          </div>
        </div>
      </div>

      <div className="page-body">
        <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
          
          {/* Appearance */}
          <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Palette size={18} color="var(--accent)" /> Appearance
            </h2>
            <div style={{ display: 'flex', gap: 12 }}>
              <div 
                onClick={() => setTheme('dark')}
                style={{ 
                  flex: 1, 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: 12, 
                  padding: 16, 
                  borderRadius: 'var(--radius-md)', 
                  cursor: 'pointer',
                  border: theme === 'dark' ? '2px solid var(--accent)' : '1px solid var(--border, var(--outline-variant))',
                  background: theme === 'dark' ? 'var(--accent-dim, var(--accent-muted))' : 'var(--surface-container)'
                }}
              >
                <Moon size={24} color={theme === 'dark' ? 'var(--accent)' : 'var(--on-surface-variant)'} />
                <span style={{ fontWeight: 500, color: theme === 'dark' ? 'var(--on-surface)' : 'var(--on-surface-variant)' }}>Dark</span>
              </div>
              <div 
                onClick={() => setTheme('dusty-rose')}
                style={{ 
                  flex: 1, 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: 12, 
                  padding: 16, 
                  borderRadius: 'var(--radius-md)', 
                  cursor: 'pointer',
                  border: theme === 'dusty-rose' ? '2px solid var(--accent)' : '1px solid var(--border, var(--outline-variant))',
                  background: theme === 'dusty-rose' ? 'var(--accent-dim, var(--accent-muted))' : 'var(--surface-container)'
                }}
              >
                <Palette size={24} color={theme === 'dusty-rose' ? 'var(--accent)' : 'var(--on-surface-variant)'} />
                <span style={{ fontWeight: 500, color: theme === 'dusty-rose' ? 'var(--on-surface)' : 'var(--on-surface-variant)' }}>Dusty Rose</span>
              </div>
              <div 
                onClick={() => setTheme('steel-blue')}
                style={{ 
                  flex: 1, 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: 12, 
                  padding: 16, 
                  borderRadius: 'var(--radius-md)', 
                  cursor: 'pointer',
                  border: theme === 'steel-blue' ? '2px solid var(--accent)' : '1px solid var(--border, var(--outline-variant))',
                  background: theme === 'steel-blue' ? 'var(--accent-dim, var(--accent-muted))' : 'var(--surface-container)'
                }}
              >
                <Waves size={24} color={theme === 'steel-blue' ? 'var(--accent)' : 'var(--on-surface-variant)'} />
                <span style={{ fontWeight: 500, color: theme === 'steel-blue' ? 'var(--on-surface)' : 'var(--on-surface-variant)' }}>Steel Blue</span>
              </div>
            </div>
          </section>

          {/* Output Directory */}
          <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <FolderOpen size={18} color="var(--accent)" /> Output Directory
            </h2>
            <div style={{ display: 'flex', gap: 12 }}>
              <input 
                type="text" 
                className="input" 
                style={{ flex: 1 }}
                value={outDir}
                onChange={(e) => setOutDir(e.target.value)}
                placeholder="C:\Users\Name\Downloads"
              />
              <button 
                className="btn btn-secondary" 
                onClick={handleBrowseOutput}
                title={isTauri() ? 'Browse for folder' : 'Only available in desktop app'}
              >
                <FolderOpen size={14} />
                Browse...
              </button>
              <button className="btn btn-primary" onClick={handleSaveOutDir}>Save</button>
            </div>
            <p className="text-muted text-body-sm">
              {isTauri()
                ? 'Click Browse to select a folder using the native file dialog.'
                : 'Running in browser mode — paste the directory path manually. The Browse button requires the Tauri desktop app.'}
            </p>
          </section>

          {/* Temp Files */}
          <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <HardDrive size={18} color="var(--accent)" /> Temporary Storage
            </h2>
            <p className="text-body-sm" style={{ color: 'var(--on-surface-variant)' }}>
              Temporary files and generated outputs from backend operations can accumulate over time.
            </p>
            <div>
              <button className="btn btn-secondary" onClick={handleClearTemp} disabled={isClearing}>
                {isClearing ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={15} />}
                Clear Temp Files
              </button>
            </div>
          </section>

          {/* Recent Files */}
          <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <History size={18} color="var(--accent)" /> Recent Output Files
            </h2>
            {history.length === 0 ? (
              <p className="text-body-sm" style={{ color: 'var(--on-surface-variant)' }}>
                No recent files found. Generated files will appear here.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ maxHeight: '300px', overflowY: 'auto', paddingRight: '8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {history.map((h) => (
                    <div key={h.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px', background: 'var(--surface-container-high)', borderRadius: 'var(--radius-md)' }}>
                      <div>
                        <Filename name={h.filename} />
                        <div style={{ fontSize: 12, color: 'var(--on-surface-variant)', marginTop: 4 }}>
                          {new Date(h.timestamp).toLocaleString()} · {h.action} · {formatBytes(h.size)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div>
                  <button className="btn btn-ghost btn-sm" onClick={clearHistory} style={{ color: 'var(--error)' }}>
                    <Trash2 size={14} /> Clear History
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* About */}
          <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Info size={18} color="var(--accent)" /> About
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, fontSize: 13 }}>
              <div style={{ color: 'var(--on-surface-variant)' }}>App Name</div>
              <div style={{ fontWeight: 500 }}>PDF Manager V2</div>
              <div style={{ color: 'var(--on-surface-variant)' }}>Version</div>
              <div style={{ fontWeight: 500 }}>1.0.0 (Production Candidate)</div>
              <div style={{ color: 'var(--on-surface-variant)' }}>Tech Stack</div>
              <div style={{ fontWeight: 500 }}>Tauri 2.11, React 19, Vite 6, FastAPI, PyMuPDF</div>
              <div style={{ color: 'var(--on-surface-variant)' }}>Features</div>
              <div style={{ fontWeight: 500 }}>Merge, Extract, Compress, Image Tools, QR, Insert, Protect</div>
              <div style={{ color: 'var(--on-surface-variant)' }}>Theme</div>
              <div style={{ fontWeight: 500 }}>Pro-Level Dark (Electric Blue #4A9EFF)</div>
            </div>
          </section>

        </div>
      </div>

      
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
