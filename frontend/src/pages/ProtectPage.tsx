import { useCallback, useRef, useState } from 'react';
import {
  CheckCircle,
  Eye,
  EyeOff,
  FolderOpen,
  Lock,
  LockOpen,
  Loader2,
  Shield,
  Upload,
  X,
} from 'lucide-react';
import apiClient from '../api/client';
import { Filename } from '../components/Filename';
import { PdfThumbnail } from '../components/PdfThumbnail';
import { addHistoryEntry } from '../utils/historyStore';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { getFilenameFromHeaders, triggerBlobDownload } from '../utils/downloadHelper';
import { openOutputFolder } from '../utils/tauriDialog';

// ── Types ─────────────────────────────────────────────────────────────────────

type TabMode = 'add' | 'remove';

interface ProtectResult {
  filename: string;
  mode: TabMode;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}


// ── Component ─────────────────────────────────────────────────────────────────

export function ProtectPage() {
  const { showToast } = useToast();
  const { fileData: file, setFileData: setFile } = useFeatureFile<File | null>('protect');

  // Tab
  const [mode, setMode] = useState<TabMode>('add');
  
  // Form State
  const [userPw, setUserPw] = useState('');
  const [ownerPw, setOwnerPw] = useState('');
  const [removePw, setRemovePw] = useState('');
  const [outputName, setOutputName] = useState('');
  
  const [showUserPw, setShowUserPw] = useState(false);
  const [showOwnerPw, setShowOwnerPw] = useState(false);
  const [showRemovePw, setShowRemovePw] = useState(false);

  const [allowPrint, setAllowPrint] = useState(true);
  const [allowCopy, setAllowCopy] = useState(true);
  const [allowModify, setAllowModify] = useState(true);

  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<ProtectResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);


  // ── File handling ───────────────────────────────────────────────────────────
  const loadFile = useCallback(
    (f: File) => {
      if (!f.name.toLowerCase().endsWith('.pdf')) {
        showToast({ type: 'error', title: 'Invalid file', message: 'Only PDF files are accepted.' });
        return;
      }
      setFile(f);
      setResult(null);

      // Reset form
      setUserPw('');
      setOwnerPw('');
      setRemovePw('');
      setOutputName(f.name.replace(/\.pdf$/i, ''));
      setAllowPrint(true);
      setAllowCopy(true);
      setAllowModify(true);
    },
    []
  );

  const handleDragOverFile = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); };
  const handleDragLeaveFile = () => setIsDragOver(false);
  const handleDropFile = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) loadFile(dropped);
  };
  const handleClick = () => fileInputRef.current?.click();
  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  };

  // ── Submit: Add Password ────────────────────────────────────────────────────
  const handleProtect = async () => {
    if (!file) { showToast({ type: 'error', title: 'No file', message: 'Please select a PDF file first.' }); return; }
    if (!userPw) { showToast({ type: 'error', title: 'No password', message: 'User password is required to encrypt the document.' }); return; }
    
    setIsLoading(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('user_pw', userPw);
    formData.append('owner_pw', ownerPw);
    formData.append('output_filename', outputName ? `${outputName}_protected.pdf` : `protected_${file.name}`);
    formData.append('allow_print', String(allowPrint));
    formData.append('allow_copy', String(allowCopy));
    formData.append('allow_modify', String(allowModify));

    try {
      const response = await apiClient.post('/api/v1/protect/', formData, { responseType: 'blob' });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const filename = getFilenameFromHeaders(response.headers, `protected_${file.name}`);

      // Auto-download
      triggerBlobDownload(blob, filename);

      setResult({ filename, mode: 'add' });
      addHistoryEntry({ filename, action: 'Protected PDF', size: blob.size });
      showToast({
        type: 'success',
        title: 'PDF Protected!',
        message: `${filename} — AES-256 encrypted`,
        action: { label: 'Open Folder', onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : 'Unknown error';
      // Parse Axios error response
      if ((err as any)?.response?.data) {
        try {
          const errData = JSON.parse(await (err as any).response.data.text());
          msg = errData?.detail || msg;
        } catch { /* ignore parse errors */ }
      }
      showToast({ type: 'error', title: 'Protection failed', message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  // ── Submit: Remove Password ─────────────────────────────────────────────────
  const handleRemovePassword = async () => {
    if (!file) { showToast({ type: 'error', title: 'No file', message: 'Please select an encrypted PDF file.' }); return; }
    if (!removePw) { showToast({ type: 'error', title: 'No password', message: 'Enter the current PDF password to remove it.' }); return; }

    setIsLoading(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('user_pw', removePw);
    formData.append('output_filename', outputName ? `${outputName}_unlocked.pdf` : `unlocked_${file.name}`);

    try {
      const response = await apiClient.post('/api/v1/protect/remove', formData, { responseType: 'blob' });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const filename = getFilenameFromHeaders(response.headers, `unlocked_${file.name}`);

      // Auto-download
      triggerBlobDownload(blob, filename);

      setResult({ filename, mode: 'remove' });
      addHistoryEntry({ filename, action: 'Removed Password', size: blob.size });
      showToast({
        type: 'success',
        title: 'Password Removed!',
        message: `${filename} is now unprotected`,
        action: { label: 'Open Folder', onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : 'Unknown error';
      if ((err as any)?.response?.data) {
        try {
          const errData = JSON.parse(await (err as any).response.data.text());
          msg = errData?.detail || msg;
        } catch { /* ignore */ }
      }
      showToast({ type: 'error', title: 'Password removal failed', message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const clearFile = () => { setFile(null); setResult(null); };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: 36, height: 36, borderRadius: 'var(--radius-md)',
            background: 'var(--accent-dim)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: 'var(--accent)',
          }}>
            <Shield size={20} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="page-title">Protect PDF</h1>
            <p className="page-subtitle">Add or remove AES-256 password protection from PDF files</p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="page-body">
        <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Mode tabs */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={`btn ${mode === 'add' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setMode('add'); setResult(null); }}
              id="protect-tab-add"
            >
              <Lock size={15} />
              Add Password
            </button>
            <button
              className={`btn ${mode === 'remove' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setMode('remove'); setResult(null); }}
              id="protect-tab-remove"
            >
              <LockOpen size={15} />
              Remove Password
            </button>
          </div>

          {/* Drop zone */}
          {!file ? (
            <div
              id="protect-drop-zone"
              className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
              onDragOver={handleDragOverFile}
              onDragLeave={handleDragLeaveFile}
              onDrop={handleDropFile}
              onClick={handleClick}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleClick()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                style={{ display: 'none' }}
                onChange={handleFileInput}
              />
              <Upload className="drop-zone-icon" />
              <p className="drop-zone-title">
                {mode === 'add' ? 'Drop a PDF to encrypt' : 'Drop an encrypted PDF to unlock'}
              </p>
              <p className="drop-zone-sub">or click to browse · Single PDF</p>
            </div>
          ) : (
            <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <PdfThumbnail file={file} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Filename name={file.name} className="file-item-name" />
                <div className="file-item-meta" style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 4 }}>
                  <span>{formatBytes(file.size)}</span>
                </div>
              </div>
              <button
                className="btn btn-ghost btn-icon btn-sm"
                onClick={clearFile}
                style={{ color: 'var(--error)' }}
              >
                <X size={15} />
              </button>
            </div>
          )}

          {/* ADD PASSWORD form */}
          {file && mode === 'add' && (
            <div className="card">
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Lock size={16} color="var(--accent)" /> Encryption Settings
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <label className="input-label">User Password (Required to Open)</label>
                  <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                    <input
                      className="input"
                      type={showUserPw ? 'text' : 'password'}
                      value={userPw}
                      onChange={(e) => setUserPw(e.target.value)}
                      placeholder="Password to open document"
                      style={{ paddingRight: 40 }}
                    />
                    <button 
                      onClick={() => setShowUserPw(!showUserPw)}
                      style={{ position: 'absolute', right: 10, background: 'none', border: 'none', color: 'var(--on-surface-variant)', cursor: 'pointer' }}
                    >
                      {showUserPw ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="input-label">Owner Password (Optional, Required to Edit)</label>
                  <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                    <input
                      className="input"
                      type={showOwnerPw ? 'text' : 'password'}
                      value={ownerPw}
                      onChange={(e) => setOwnerPw(e.target.value)}
                      placeholder="Password to restrict permissions"
                      style={{ paddingRight: 40 }}
                    />
                    <button 
                      onClick={() => setShowOwnerPw(!showOwnerPw)}
                      style={{ position: 'absolute', right: 10, background: 'none', border: 'none', color: 'var(--on-surface-variant)', cursor: 'pointer' }}
                    >
                      {showOwnerPw ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <div style={{ marginTop: 8 }}>
                  <label className="input-label">Output Filename (optional)</label>
                  <input
                    className="input"
                    type="text"
                    value={outputName}
                    onChange={(e) => setOutputName(e.target.value)}
                    placeholder="e.g. my_document (protected_ prefix added automatically)"
                  />
                </div>
                <div style={{ marginTop: 8 }}>
                  <label className="input-label" style={{ marginBottom: 12 }}>Permissions (require Owner Password to change)</label>
                  <div style={{ display: 'flex', gap: 24 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--on-surface)' }}>
                      <input type="checkbox" checked={allowPrint} onChange={(e) => setAllowPrint(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                      Allow Printing
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--on-surface)' }}>
                      <input type="checkbox" checked={allowCopy} onChange={(e) => setAllowCopy(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                      Allow Copying
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--on-surface)' }}>
                      <input type="checkbox" checked={allowModify} onChange={(e) => setAllowModify(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                      Allow Modifying
                    </label>
                  </div>
                  <p className="text-muted text-body-sm" style={{ marginTop: 10 }}>
                    If an owner password is not set, some PDF readers may ignore these restrictions.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* REMOVE PASSWORD form */}
          {file && mode === 'remove' && (
            <div className="card">
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <LockOpen size={16} color="var(--accent)" /> Remove Encryption
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <label className="input-label">Current Password (to verify and unlock)</label>
                  <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                    <input
                      className="input"
                      type={showRemovePw ? 'text' : 'password'}
                      value={removePw}
                      onChange={(e) => setRemovePw(e.target.value)}
                      placeholder="Enter existing PDF password"
                      style={{ paddingRight: 40 }}
                    />
                    <button 
                      onClick={() => setShowRemovePw(!showRemovePw)}
                      style={{ position: 'absolute', right: 10, background: 'none', border: 'none', color: 'var(--on-surface-variant)', cursor: 'pointer' }}
                    >
                      {showRemovePw ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Result */}
          {result && (
            <div
              className="card"
              style={{
                background: 'var(--success-container)',
                border: '1px solid var(--success)',
                display: 'flex', alignItems: 'center', gap: 16,
              }}
            >
              <CheckCircle size={28} color="var(--success)" style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--success)', marginBottom: 4 }}>
                  {result.mode === 'add' ? 'Download started — PDF encrypted' : 'Download started — Password removed'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--on-surface-variant)' }}>
                  <Filename name={result.filename} />
                </div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => openOutputFolder()}
                title="Open download folder"
              >
                <FolderOpen size={14} />
                Open Folder
              </button>
            </div>
          )}

          {/* Actions */}
          {file && (
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                className="btn btn-secondary"
                onClick={clearFile}
                disabled={isLoading}
              >
                Cancel
              </button>
              {mode === 'add' ? (
                <button
                  className="btn btn-primary"
                  onClick={handleProtect}
                  disabled={isLoading || !userPw}
                  id="protect-add-btn"
                >
                  {isLoading ? (
                    <>
                      <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                      Encrypting…
                    </>
                  ) : (
                    <>
                      <Shield size={15} />
                      Protect & Download
                    </>
                  )}
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={handleRemovePassword}
                  disabled={isLoading || !removePw}
                  id="protect-remove-btn"
                >
                  {isLoading ? (
                    <>
                      <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                      Removing…
                    </>
                  ) : (
                    <>
                      <LockOpen size={15} />
                      Remove & Download
                    </>
                  )}
                </button>
              )}
            </div>
          )}

        </div>
      </div>

      

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
