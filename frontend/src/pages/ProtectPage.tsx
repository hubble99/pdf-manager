import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle,
  FolderOpen,
  Info,
  Lock,
  LockOpen,
  Loader2,
  Shield,
  Upload,
} from 'lucide-react';
import { FEATURE_ICONS } from '../components/icons';
import { Filename } from '../components/Filename';
import { PdfThumbnail } from '../components/PdfThumbnail';
import { addHistoryEntry } from '../utils/historyStore';
import { PageHeader, PasswordField, Tabs } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { useNativePaths } from '../hooks/useNativePaths';
import { isCoreCancelled, revealPath, type CoreProgress } from '../api/nativeCore';
import { getPdfInfo, type PdfInfo } from '../api/pdfRender';
import { protectPdf, unprotectPdf } from '../api/pdfProtect';
import { protectErrorMessage } from '../features/protect/messages';
import { baseName, stemOf } from '../utils/paths';
import { t, tn } from '../i18n';

// ── Types ─────────────────────────────────────────────────────────────────────

type TabMode = 'add' | 'remove';

interface ProtectResult {
  outputPath: string;
  filename: string;
  mode: TabMode;
  pages: number;
}

const PDF_FILTER = { name: 'PDF', extensions: ['pdf'] };

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ProtectPage() {
  const { showToast } = useToast();
  const { fileData: path, setFileData: setPath } = useFeatureFile<string | null>('protect');
  const [pdfInfo, setPdfInfo] = useState<PdfInfo | null>(null);
  const [infoFailed, setInfoFailed] = useState(false);

  // Tab
  const [mode, setMode] = useState<TabMode>('add');

  // Form State
  const [userPw, setUserPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [removePw, setRemovePw] = useState('');
  const [outputName, setOutputName] = useState('');

  const [allowPrint, setAllowPrint] = useState(true);
  const [allowCopy, setAllowCopy] = useState(true);
  const [allowModify, setAllowModify] = useState(true);

  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<CoreProgress | null>(null);
  const [result, setResult] = useState<ProtectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const resetForm = () => {
    setUserPw('');
    setConfirmPw('');
    setRemovePw('');
    setOutputName('');
    setAllowPrint(true);
    setAllowCopy(true);
    setAllowModify(true);
    setResult(null);
    setError(null);
  };

  // ── File handling ───────────────────────────────────────────────────────────
  const loadPath = (next: string) => {
    setPath(next);
    setPdfInfo(null);
    setInfoFailed(false);
    resetForm();
  };

  const { desktop, isDragOver, pick } = useNativePaths({
    filter: PDF_FILTER,
    multiple: false,
    pickerTitle: t('Choose a PDF'),
    disabled: isLoading,
    onPaths: (accepted, rejected) => {
      if (accepted.length > 0) loadPath(accepted[0]);
      else if (rejected > 0) {
        showToast({ type: 'error', title: t('Invalid file'), message: t('Only PDF files are accepted.') });
      }
    },
  });

  // Size, page count and protection of the loaded PDF.
  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    getPdfInfo(path)
      .then((info) => { if (!cancelled) setPdfInfo(info); })
      .catch(() => { if (!cancelled) setInfoFailed(true); });
    return () => { cancelled = true; };
  }, [path]);

  const infoLoading = Boolean(path) && !pdfInfo && !infoFailed;
  const isEncrypted = Boolean(pdfInfo?.encrypted);
  const fileStem = path ? stemOf(path) : 'document';

  // ── Running a job ───────────────────────────────────────────────────────────
  const run = async (
    action: TabMode,
    start: (signal: AbortSignal, onProgress: (p: CoreProgress) => void) => ReturnType<typeof protectPdf>,
  ) => {
    setIsLoading(true);
    setProgress(null);
    setResult(null);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const report = await start(controller.signal, (p) => { if (mountedRef.current) setProgress(p); });
      if (!mountedRef.current) return;
      const filename = baseName(report.outputPath);
      setResult({ outputPath: report.outputPath, filename, mode: action, pages: report.pages });
      // The passwords are not needed any more.
      setUserPw('');
      setConfirmPw('');
        setRemovePw('');
      addHistoryEntry({
        filename,
        action: action === 'add' ? 'Protected PDF' : 'Removed Password',
        size: report.outputSizeBytes,
      });
      showToast({
        type: 'success',
        title: action === 'add' ? t('PDF Protected!') : t('Password Removed!'),
        message: action === 'add'
          ? t('{name} — AES-256 encrypted', { name: filename })
          : t('{name} is now unprotected', { name: filename }),
        action: { label: t('Show in folder'), onClick: () => { void revealPath(report.outputPath).catch(() => undefined); } },
        duration: 8000,
      });
    } catch (err: unknown) {
      if (!mountedRef.current || isCoreCancelled(err)) return;
      setError(protectErrorMessage(err));
    } finally {
      abortRef.current = null;
      if (mountedRef.current) {
        setIsLoading(false);
        setProgress(null);
      }
    }
  };

  const handleProtect = () => {
    if (!path) { showToast({ type: 'error', title: t('No file'), message: t('Please select a PDF file first.') }); return; }
    if (!userPw) { showToast({ type: 'error', title: t('No password'), message: t('User password is required to encrypt the document.') }); return; }
    if (userPw !== confirmPw) { showToast({ type: 'error', title: t('Passwords do not match'), message: t('Re-enter the password in both fields.') }); return; }
    void run('add', (signal, onProgress) => protectPdf(
      path,
      { userPassword: userPw, allowPrint, allowCopy, allowModify, outputName },
      { signal, onProgress },
    ));
  };

  const handleRemovePassword = () => {
    if (!path) { showToast({ type: 'error', title: t('No file'), message: t('Please select an encrypted PDF file.') }); return; }
    if (!removePw) { showToast({ type: 'error', title: t('No password'), message: t('Enter the current PDF password to remove it.') }); return; }
    void run('remove', (signal, onProgress) => unprotectPdf(path, { password: removePw }, { signal, onProgress }));
  };

  const clearFile = () => {
    setPath(null);
    setPdfInfo(null);
    setInfoFailed(false);
    resetForm();
  };

  const openPicker = () => {
    if (isLoading) return;
    void pick();
  };

  const percent = progress?.total ? Math.round((progress.done / progress.total) * 100) : null;
  const progressTitle = progress?.stage === 'checking'
    ? t('Checking the new file…')
    : mode === 'add' ? t('Protecting the PDF…') : t('Removing the password…');

  // A protected PDF cannot be protected again; a plain one has nothing to remove.
  const addBlocked = isEncrypted;
  const removeBlocked = Boolean(pdfInfo) && !isEncrypted;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="feature-page">
      <PageHeader
        icon={FEATURE_ICONS['protect']}
        title={t('Protect PDF')}
        description={t('Add or remove AES-256 password protection from PDF files')}
      />

      <Tabs
        ariaLabel={t('Protect mode')}
        value={mode}
        onChange={(next) => { setMode(next); setResult(null); setError(null); }}
        items={[
          { value: 'add', id: 'protect-tab-add', label: t('Add Password'), icon: <Lock size={15} aria-hidden="true" /> },
          { value: 'remove', id: 'protect-tab-remove', label: t('Remove Password'), icon: <LockOpen size={15} aria-hidden="true" /> },
        ]}
      />

      {/* Body */}
      <div className="page-body">
        {!desktop && (
          <div className="card status-card" role="note">
            <Info size={20} aria-hidden="true" />
            <div className="status-card-copy">
              <b>{t('Protect PDF runs in the Dokuwu desktop app')}</b>
              <small>{t('It works on the files directly on your computer, which the browser preview cannot do.')}</small>
            </div>
          </div>
        )}

        {desktop && (
          <div className={`form-col${path ? '' : ' form-col--center'}`}>

            {/* Drop zone */}
            {!path ? (
              <div
                id="protect-drop-zone"
                className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
                onClick={() => openPicker()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && openPicker()}
                aria-label={t('Drop a PDF file here or click to browse')}
              >
                <Upload className="drop-zone-icon" />
                <p className="drop-zone-title">
                  {mode === 'add' ? t('Drop a PDF to encrypt') : t('Drop an encrypted PDF to unlock')}
                </p>
                <p className="drop-zone-sub">{t('or click to browse · Single PDF')}</p>
              </div>
            ) : (
              <div className="card file-card">
                <PdfThumbnail file={path} />
                <div className="grow">
                  <Filename name={baseName(path)} className="file-item-name" />
                  <div className="file-item-meta file-card-meta">
                    {pdfInfo && <span>{formatBytes(pdfInfo.sizeBytes)}</span>}
                    {pdfInfo && !isEncrypted && <span>{tn(pdfInfo.pages, '{n} page', '{n} pages')}</span>}
                    {isEncrypted && <span className="badge badge-error">{t('Password protected')}</span>}
                    {infoLoading && <Loader2 size={12} className="spin" aria-hidden="true" />}
                  </div>
                </div>
                <span className="card-head-actions">
                  <button
                    type="button"
                    className="link-btn"
                    id="protect-replace-file"
                    onClick={openPicker}
                    disabled={isLoading}
                  >
                    {t('Replace')}
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    id="protect-remove-file"
                    onClick={clearFile}
                    disabled={isLoading}
                    aria-label={t('Remove PDF')}
                  >
                    {t('Remove')}
                  </button>
                </span>
              </div>
            )}

            {/* ADD PASSWORD form */}
            {path && mode === 'add' && (
              <div className="card">
                <div className="card-title-row">
                  <Lock size={16} color="var(--accent)" /> {t('Encryption Settings')}
                </div>

                {addBlocked && (
                  <p className="text-muted text-body-sm" role="note" id="protect-already-note">
                    {t('This PDF already has a password. Use Remove Password first.')}
                  </p>
                )}

                <div className="stack-16">
                  <PasswordField
                    id="protect-user-pw"
                    label={t('User Password (Required to Open)')}
                    value={userPw}
                    onChange={setUserPw}
                    placeholder={t('Password to open document')}
                    autoComplete="new-password"
                  />
                  <PasswordField
                    id="protect-confirm-pw"
                    label={t('Confirm Password')}
                    value={confirmPw}
                    onChange={setConfirmPw}
                    placeholder={t('Re-enter the password')}
                    error={confirmPw && userPw !== confirmPw ? t('Passwords do not match.') : undefined}
                    autoComplete="new-password"
                  />
                  <div className="field-gap">
                    <label className="input-label" htmlFor="protect-output-name">{t('Output Filename (optional)')}</label>
                    <input
                      id="protect-output-name"
                      className="input"
                      type="text"
                      value={outputName}
                      onChange={(e) => setOutputName(e.target.value)}
                      placeholder={`${fileStem}_protected`}
                      disabled={isLoading}
                    />
                  </div>
                  <div className="field-gap">
                    <label className="input-label input-label--spaced">{t('Permissions')}</label>
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
                      {t('Some PDF readers may ignore these restrictions.')}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* REMOVE PASSWORD form */}
            {path && mode === 'remove' && (
              <div className="card">
                <div className="card-title-row">
                  <LockOpen size={16} color="var(--accent)" /> {t('Remove Encryption')}
                </div>
                {removeBlocked && (
                  <p className="text-muted text-body-sm" role="note" id="protect-plain-note">
                    {t('This PDF has no password to remove.')}
                  </p>
                )}
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

            {error && (
              <div className="converter-message converter-message--error" role="alert">
                <span>{error}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
                  {t('Dismiss')}
                </button>
              </div>
            )}

            {isLoading && (
              <div className="card status-card" role="status" aria-live="polite" id="protect-progress">
                <Loader2 size={20} className="spin" aria-hidden="true" />
                <div className="status-card-copy">
                  <b>{progressTitle}</b>
                  <div className={`size-bar size-bar--spaced${percent === null ? ' size-bar--busy' : ''}`}>
                    <i style={{ width: `${percent ?? 0}%` }} />
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  id="protect-cancel-btn"
                  onClick={() => abortRef.current?.abort()}
                >
                  {t('Cancel')}
                </button>
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
                    <Filename name={result.filename} /> · {t('Saved to your Downloads folder')}
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  id="protect-open-folder-btn"
                  onClick={() => { void revealPath(result.outputPath).catch(() => undefined); }}
                  title={t('Show in folder')}
                >
                  <FolderOpen size={14} />
                  {t('Show in folder')}
                </button>
              </div>
            )}

            {/* Actions */}
            {path && (
              <div className="action-row">
                <button
                  className="btn btn-secondary"
                  onClick={clearFile}
                  disabled={isLoading}
                >
                  {t('Clear')}
                </button>
                {mode === 'add' ? (
                  <button
                    className="btn btn-primary"
                    onClick={handleProtect}
                    disabled={isLoading || addBlocked || !userPw || userPw !== confirmPw}
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
                    disabled={isLoading || removeBlocked || !removePw}
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
        )}
      </div>
    </div>
  );
}
