import { useCallback, useRef, useState } from 'react';
import axios from 'axios';
import {
  CheckCircle,
  FolderOpen,
  Lock,
  LockOpen,
  Loader2,
  Shield,
  Upload,
} from 'lucide-react';
import apiClient from '../api/client';
import { Filename } from '../components/Filename';
import { PdfThumbnail } from '../components/PdfThumbnail';
import { addHistoryEntry } from '../utils/historyStore';
import { ChangeFileControls, PageHeader, PasswordField, Tabs } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { getFilenameFromHeaders, triggerBlobDownload } from '../utils/downloadHelper';
import { openOutputFolder } from '../utils/tauriDialog';
import { t } from '../i18n';

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
  const fileStem = file ? file.name.replace(/\.pdf$/i, '') : 'document';

  // Tab
  const [mode, setMode] = useState<TabMode>('add');
  
  // Form State
  const [userPw, setUserPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [ownerPw, setOwnerPw] = useState('');
  const [removePw, setRemovePw] = useState('');
  const [outputName, setOutputName] = useState('');
  
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
        showToast({ type: 'error', title: t('Invalid file'), message: t('Only PDF files are accepted.') });
        return;
      }
      setFile(f);
      setResult(null);

      // Reset form
      setUserPw('');
      setConfirmPw('');
      setOwnerPw('');
      setRemovePw('');
      setOutputName('');
      setAllowPrint(true);
      setAllowCopy(true);
      setAllowModify(true);
    },
    [setFile, showToast]
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
    if (!file) { showToast({ type: 'error', title: t('No file'), message: t('Please select a PDF file first.') }); return; }
    if (!userPw) { showToast({ type: 'error', title: t('No password'), message: t('User password is required to encrypt the document.') }); return; }
    if (userPw !== confirmPw) { showToast({ type: 'error', title: t('Passwords do not match'), message: t('Re-enter the password in both fields.') }); return; }
    
    setIsLoading(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('user_pw', userPw);
    formData.append('owner_pw', ownerPw);
    // The name typed here is used exactly; the default only applies to an empty field.
    formData.append('output_filename', outputName.trim() || `${fileStem}_protected`);
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
        title: t('PDF Protected!'),
        message: t('{name} — AES-256 encrypted', { name: filename }),
        action: { label: t('Open Folder'), onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : t('Unknown error');
      // Parse Axios error response
      if (axios.isAxiosError(err) && err.response?.data) {
        try {
          const responseData = err.response.data;
          if (responseData instanceof Blob) {
            const errData: unknown = JSON.parse(await responseData.text());
            if (typeof errData === 'object' && errData !== null && 'detail' in errData && typeof errData.detail === 'string') {
              msg = errData.detail;
            }
          }
        } catch { /* ignore parse errors */ }
      }
      showToast({ type: 'error', title: t('Protection failed'), message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  // ── Submit: Remove Password ─────────────────────────────────────────────────
  const handleRemovePassword = async () => {
    if (!file) { showToast({ type: 'error', title: t('No file'), message: t('Please select an encrypted PDF file.') }); return; }
    if (!removePw) { showToast({ type: 'error', title: t('No password'), message: t('Enter the current PDF password to remove it.') }); return; }

    setIsLoading(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('user_pw', removePw);
    formData.append('output_filename', `${fileStem}_unlocked`);

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
        title: t('Password Removed!'),
        message: t('{name} is now unprotected', { name: filename }),
        action: { label: t('Open Folder'), onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : t('Unknown error');
      if (axios.isAxiosError(err) && err.response?.data) {
        try {
          const responseData = err.response.data;
          if (responseData instanceof Blob) {
            const errData: unknown = JSON.parse(await responseData.text());
            if (typeof errData === 'object' && errData !== null && 'detail' in errData && typeof errData.detail === 'string') {
              msg = errData.detail;
            }
          }
        } catch { /* ignore */ }
      }
      showToast({ type: 'error', title: t('Password removal failed'), message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const clearFile = () => { setFile(null); setResult(null); };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="feature-page">
      <PageHeader
        icon={Shield}
        title={t('Protect PDF')}
        description={t('Add or remove AES-256 password protection from PDF files')}
      />

      <Tabs
        ariaLabel={t('Protect mode')}
        value={mode}
        onChange={(next) => { setMode(next); setResult(null); }}
        items={[
          { value: 'add', id: 'protect-tab-add', label: t('Add Password'), icon: <Lock size={15} aria-hidden="true" /> },
          { value: 'remove', id: 'protect-tab-remove', label: t('Remove Password'), icon: <LockOpen size={15} aria-hidden="true" /> },
        ]}
      />

      {/* Body */}
      <div className="page-body">
        <div className={`form-col${file ? '' : ' form-col--center'}`}>

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
                hidden
                onChange={handleFileInput}
              />
              <Upload className="drop-zone-icon" />
              <p className="drop-zone-title">
                {mode === 'add' ? t('Drop a PDF to encrypt') : t('Drop an encrypted PDF to unlock')}
              </p>
              <p className="drop-zone-sub">{t('or click to browse · Single PDF')}</p>
            </div>
          ) : (
            <div className="card file-card">
              <PdfThumbnail file={file} />
              <div className="grow">
                <Filename name={file.name} className="file-item-name" />
                <div className="file-item-meta file-card-meta">
                  <span>{formatBytes(file.size)}</span>
                </div>
              </div>
              <ChangeFileControls
                accept=".pdf"
                idPrefix="protect"
                onPick={loadFile}
                onClear={clearFile}
                disabled={isLoading}
              />
            </div>
          )}

          {/* ADD PASSWORD form */}
          {file && mode === 'add' && (
            <div className="card">
              <div className="card-title-row">
                <Lock size={16} color="var(--accent)" /> {t('Encryption Settings')}
              </div>
              
              <div className="stack-16">
                <PasswordField
                  id="protect-user-pw"
                  label={t('User Password (Required to Open)')}
                  value={userPw}
                  onChange={setUserPw}
                  placeholder={t('Password to open document')}
                />
                <PasswordField
                  id="protect-confirm-pw"
                  label={t('Confirm Password')}
                  value={confirmPw}
                  onChange={setConfirmPw}
                  placeholder={t('Re-enter the password')}
                  error={confirmPw && userPw !== confirmPw ? t('Passwords do not match.') : undefined}
                />
                <PasswordField
                  id="protect-owner-pw"
                  label={t('Owner Password (Optional, Required to Edit)')}
                  value={ownerPw}
                  onChange={setOwnerPw}
                  placeholder={t('Password to restrict permissions')}
                  autoComplete="new-password"
                />
                <div className="field-gap">
                  <label className="input-label">{t('Output Filename (optional)')}</label>
                  <input
                    className="input"
                    type="text"
                    value={outputName}
                    onChange={(e) => setOutputName(e.target.value)}
                    placeholder={`${fileStem}_protected`}
                  />
                </div>
                <div className="field-gap">
                  <label className="input-label input-label--spaced">{t('Permissions (require Owner Password to change)')}</label>
                  <div className="check-row-group">
                    <label className="check-row">
                      <input type="checkbox" checked={allowPrint} onChange={(e) => setAllowPrint(e.target.checked)} />
                      {t('Allow Printing')}
                    </label>
                    <label className="check-row">
                      <input type="checkbox" checked={allowCopy} onChange={(e) => setAllowCopy(e.target.checked)} />
                      {t('Allow Copying')}
                    </label>
                    <label className="check-row">
                      <input type="checkbox" checked={allowModify} onChange={(e) => setAllowModify(e.target.checked)} />
                      {t('Allow Modifying')}
                    </label>
                  </div>
                  <p className="text-muted text-body-sm hint-gap">
                    {t('If an owner password is not set, some PDF readers may ignore these restrictions.')}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* REMOVE PASSWORD form */}
          {file && mode === 'remove' && (
            <div className="card">
              <div className="card-title-row">
                <LockOpen size={16} color="var(--accent)" /> {t('Remove Encryption')}
              </div>
              <div className="stack-16">
                <PasswordField
                  id="protect-remove-pw"
                  label={t('Current Password (to verify and unlock)')}
                  value={removePw}
                  onChange={setRemovePw}
                  placeholder={t('Enter existing PDF password')}
                  autoComplete="current-password"
                />
              </div>
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="card result-card" role="status">
              <CheckCircle size={28} className="result-card-icon" />
              <div className="grow">
                <div className="result-card-title">
                  {result.mode === 'add' ? t('PDF encrypted and saved') : t('Password removed and saved')}
                </div>
                <div className="result-card-meta">
                  <Filename name={result.filename} />
                </div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => openOutputFolder()}
                title={t('Open folder')}
              >
                <FolderOpen size={14} />
                {t('Open Folder')}
              </button>
            </div>
          )}

          {/* Actions */}
          {file && (
            <div className="action-row">
              <button
                className="btn btn-secondary"
                onClick={clearFile}
                disabled={isLoading}
              >
                {t('Cancel')}
              </button>
              {mode === 'add' ? (
                <button
                  className="btn btn-primary"
                  onClick={handleProtect}
                  disabled={isLoading || !userPw || userPw !== confirmPw}
                  id="protect-add-btn"
                >
                  {isLoading ? (
                    <>
                      <Loader2 size={15} className="spin" />
                      {t('Encrypting…')}
                    </>
                  ) : (
                    <>
                      <Shield size={15} />
                      {t('Protect PDF')}
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
                      <Loader2 size={15} className="spin" />
                      {t('Removing…')}
                    </>
                  ) : (
                    <>
                      <LockOpen size={15} />
                      {t('Remove Password')}
                    </>
                  )}
                </button>
              )}
            </div>
          )}

        </div>
      </div>

      

    </div>
  );
}
