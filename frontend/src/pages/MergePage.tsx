import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle,
  FileText,
  FolderOpen,
  Info,
  Loader2,
  Merge,
  Trash2,
  Upload,
} from 'lucide-react';
import { Filename } from '../components/Filename';
import { addHistoryEntry } from '../utils/historyStore';
import { PdfThumbnail } from '../components/PdfThumbnail';
import { PageHeader, Tabs } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { useNativePaths } from '../hooks/useNativePaths';
import { SortableCardGrid } from '../components/sortable/SortableCardGrid';
import { FolderWorkspace } from '../features/merge/FolderWorkspace';
import { mergeErrorMessage } from '../features/merge/messages';
import { formatBytes } from '../features/converter/options';
import { isCoreCancelled, revealPath, type CoreProgress } from '../api/nativeCore';
import { describePdfs, mergePdfs, type FileDescription } from '../api/pdfMerge';
import { baseName } from '../utils/paths';
import { t, tn } from '../i18n';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FileEntry {
  id: string;
  /** Where the PDF is on disk. */
  path: string;
}

interface MergeResult {
  outputPath: string;
  filename: string;
  totalPages: number;
  sizeBytes: number;
}

const PDF_FILTER = { name: 'PDF', extensions: ['pdf'] };

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Paths that spell the same file on Windows: the separator and letter case do not count. */
const pathKey = (path: string) => path.replace(/\//g, '\\').toLowerCase();

// ── Component ─────────────────────────────────────────────────────────────────

export function MergePage() {
  const { showToast } = useToast();
  const { fileData: _files, setFileData: setFiles } = useFeatureFile<FileEntry[]>('merge');
  const files = useMemo(() => _files || [], [_files]);
  const [outputName, setOutputName] = useState('merged_output.pdf');
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<CoreProgress | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Size and page count by entry id, filled in as the core reads each file. */
  const [info, setInfo] = useState<Record<string, FileDescription>>({});
  // Quick and Folder keep their own state; toggling never clears either side.
  const [mode, setMode] = useState<'quick' | 'folder'>('quick');
  const abortRef = useRef<AbortController | null>(null);
  const requestedRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // ── File handling ───────────────────────────────────────────────────────────
  const addPaths = useCallback((accepted: string[], rejected: number) => {
    if (rejected > 0) {
      showToast({ type: 'error', title: t('Invalid files'), message: t('Only PDF files are accepted.') });
    }
    if (accepted.length === 0) return;
    setFiles((prev) => [
      ...(prev || []),
      ...accepted.map((path) => ({ id: generateId(), path })),
    ]);
    setResult(null);
    setError(null);
  }, [setFiles, showToast]);

  const { desktop, isDragOver, pick } = useNativePaths({
    filter: PDF_FILTER,
    multiple: true,
    pickerTitle: t('Choose PDF files'),
    disabled: isLoading || mode !== 'quick',
    onPaths: addPaths,
  });

  // Sizes and page counts of newly added files.
  useEffect(() => {
    const missing = files.filter((entry) => !requestedRef.current.has(entry.id));
    if (missing.length === 0) return;
    missing.forEach((entry) => requestedRef.current.add(entry.id));
    describePdfs(missing.map((entry) => entry.path))
      .then((described) => {
        if (!mountedRef.current) return;
        setInfo((previous) => {
          const next = { ...previous };
          missing.forEach((entry, index) => { if (described[index]) next[entry.id] = described[index]; });
          return next;
        });
      })
      .catch(() => {
        // Sizes are a convenience; a later change retries them.
        missing.forEach((entry) => requestedRef.current.delete(entry.id));
      });
  }, [files]);

  const removeFile = (id: string) => {
    setFiles((prev) => prev ? prev.filter((f) => f.id !== id) : []);
    setResult(null);
  };

  /** Moves a file to a new position; used by dragging, the arrow buttons, and Alt+Arrow. */
  const reorderFiles = useCallback((from: number, to: number) => {
    setFiles((prev) => {
      if (!prev) return [];
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length || from === to) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, [setFiles]);

  /** A file added twice is marked, not blocked. */
  const duplicateOf = new Map<string, number>();
  {
    const firstSeen = new Map<string, number>();
    files.forEach((entry, idx) => {
      const key = pathKey(entry.path);
      const first = firstSeen.get(key);
      if (first === undefined) firstSeen.set(key, idx);
      else duplicateOf.set(entry.id, first);
    });
  }

  // ── Merge ───────────────────────────────────────────────────────────────────
  const handleMerge = async () => {
    if (files.length < 2) {
      showToast({ type: 'error', title: t('Not enough files'), message: t('Add at least 2 PDF files to merge.') });
      return;
    }
    setIsLoading(true);
    setProgress(null);
    setResult(null);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const report = await mergePdfs(
        files.map((entry) => entry.path),
        { skipInvalid: false, outputName },
        { signal: controller.signal, onProgress: (p) => { if (mountedRef.current) setProgress(p); } },
      );
      if (!mountedRef.current) return;
      const filename = baseName(report.outputPath);
      setResult({
        outputPath: report.outputPath,
        filename,
        totalPages: report.totalPages,
        sizeBytes: report.outputSizeBytes,
      });
      addHistoryEntry({ filename, action: 'Merged PDF', size: report.outputSizeBytes });
      showToast({
        type: 'success',
        title: t('Merge complete!'),
        message: `${filename} — ${tn(report.totalPages, '{n} page', '{n} pages')}, ${formatBytes(report.outputSizeBytes)}`,
        action: { label: t('Show in folder'), onClick: () => { void revealPath(report.outputPath).catch(() => undefined); } },
        duration: 8000,
      });
    } catch (err: unknown) {
      if (!mountedRef.current || isCoreCancelled(err)) return;
      setError(mergeErrorMessage(err));
    } finally {
      abortRef.current = null;
      if (mountedRef.current) {
        setIsLoading(false);
        setProgress(null);
      }
    }
  };

  const clearAll = () => {
    setFiles([]);
    setResult(null);
    setError(null);
    setInfo({});
    requestedRef.current = new Set();
  };

  const percent = progress?.total ? Math.round((progress.done / progress.total) * 100) : null;
  const progressTitle = progress?.stage === 'saving'
    ? t('Saving the merged PDF…')
    : progress?.total
      ? t('Merging file {done} of {total}…', { done: Math.min(progress.done + 1, progress.total), total: progress.total })
      : t('Preparing the files…');

  const dropZoneProps = {
    role: 'button' as const,
    tabIndex: 0,
    onClick: () => { void pick(); },
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') void pick(); },
    'aria-label': t('Drop PDF files here or click to browse'),
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="feature-page">
      <PageHeader
        icon={Merge}
        title={t('Merge PDF')}
        description={t('Combine multiple PDF files into one document')}
      />

      <Tabs
        ariaLabel={t('Merge mode')}
        value={mode}
        onChange={setMode}
        items={[
          { value: 'quick', id: 'merge-mode-quick', label: t('Quick') },
          {
            value: 'folder',
            id: 'merge-mode-folder',
            label: t('Folder'),
            disabled: !desktop,
            title: desktop ? undefined : t('Folder mode requires the desktop app'),
          },
        ]}
      >
        {!desktop && (
          <span className="organize-help">{t('Folder mode requires the desktop app')}</span>
        )}
      </Tabs>

      {mode === 'folder' && <FolderWorkspace />}

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="page-body" hidden={mode === 'folder'}>
        {!desktop && (
          <div className="card status-card" role="note">
            <Info size={20} aria-hidden="true" />
            <div className="status-card-copy">
              <b>{t('Merge PDF runs in the Dokuwu desktop app')}</b>
              <small>{t('It works on the files directly on your computer, which the browser preview cannot do.')}</small>
            </div>
          </div>
        )}

        {desktop && files.length === 0 && (
          <div className="form-col form-col--center">
            <div
              id="merge-drop-zone"
              className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
              {...dropZoneProps}
            >
              <Upload className="drop-zone-icon" />
              <p className="drop-zone-title">{t('Drop PDF files here')}</p>
              <p className="drop-zone-sub">{t('or click to browse · Multiple files supported')}</p>
              <div className="badge-row">
                <span className="badge badge-neutral">PDF</span>
                <span className="badge badge-neutral">{t('Multiple files')}</span>
              </div>
            </div>
          </div>
        )}

        {desktop && files.length > 0 && (
          <div className="merge-quick-split">
            {/* Left: previews in merge order */}
            <div className="card merge-quick-files">
              <div className="card-title-row card-title-row--wrap">
                <FileText size={16} color="var(--accent)" />
                <span className="card-title-text">{t('Files to Merge')}</span>
                <span className="badge badge-info">{tn(files.length, '{n} file', '{n} files')}</span>
                {duplicateOf.size > 0 && (
                  <span className="badge badge-warning" id="merge-duplicate-note">
                    {tn(duplicateOf.size, '{n} duplicate added', '{n} duplicates added')}
                  </span>
                )}
                <span className="grow-spacer" />
                <span className="text-muted card-title-note">{t('Drag the previews to reorder')}</span>
              </div>
              <SortableCardGrid
                idPrefix="merge"
                compact
                ariaLabel={t('Files to merge, in merge order')}
                disabled={isLoading}
                onReorder={reorderFiles}
                onRemove={removeFile}
                cards={files.map((entry) => {
                  const first = duplicateOf.get(entry.id);
                  const details = info[entry.id];
                  const warnings = [
                    first === undefined
                      ? null
                      : t('This is the same file as #{n}. It is still included in the merge.', { n: first + 1 }),
                    details && details.pages === null
                      ? t('This file cannot be read. It may be damaged or password protected.')
                      : null,
                  ].filter(Boolean);
                  return {
                    id: entry.id,
                    title: baseName(entry.path),
                    thumbnail: (
                      <PdfThumbnail
                        file={entry.path}
                        className="sort-card-thumb"
                      />
                    ),
                    meta: (
                      <>
                        {details && <span>{formatBytes(details.sizeBytes)}</span>}
                        {details && details.pages !== null && <span>{tn(details.pages, '{n} page', '{n} pages')}</span>}
                      </>
                    ),
                    warning: warnings.length ? warnings.join(' ') : undefined,
                  };
                })}
              />
            </div>

            {/* Right: add more, output name, actions */}
            <div className="col-stack merge-quick-side">
              <div
                id="merge-drop-zone"
                className={`drop-zone drop-zone--compact${isDragOver ? ' drag-over' : ''}`}
                {...dropZoneProps}
              >
                <Upload className="drop-zone-icon" />
                <p className="drop-zone-title">{t('Add more PDFs')}</p>
                <p className="drop-zone-sub">{t('Drop here or click to browse')}</p>
              </div>

              <div className="card">
                <label className="input-label" htmlFor="merge-output-name">{t('Output Filename')}</label>
                <input
                  id="merge-output-name"
                  className="input"
                  type="text"
                  value={outputName}
                  onChange={(e) => setOutputName(e.target.value)}
                  placeholder="merged_output.pdf"
                  disabled={isLoading}
                />
                <p className="text-muted text-body-sm hint-gap-sm">
                  {t('The .pdf extension will be added automatically if omitted.')}
                </p>
              </div>

              {error && (
                <div className="converter-message converter-message--error" role="alert">
                  <span>{error}</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
                    {t('Dismiss')}
                  </button>
                </div>
              )}

              {isLoading && (
                <div className="card status-card" role="status" aria-live="polite" id="merge-progress">
                  <Loader2 size={20} className="spin" aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>{progressTitle}</b>
                    <div className={`size-bar size-bar--spaced${percent === null || progress?.done === 0 ? ' size-bar--busy' : ''}`}>
                      <i style={{ width: `${percent ?? 0}%` }} />
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    id="merge-cancel-btn"
                    onClick={() => abortRef.current?.abort()}
                  >
                    {t('Cancel')}
                  </button>
                </div>
              )}

              {result && (
                <div className="card result-card" role="status">
                  <CheckCircle size={24} className="result-card-icon" />
                  <div className="grow">
                    <div className="result-card-title">
                      {t('Saved to your Downloads folder')}
                    </div>
                    <div className="result-card-meta">
                      <Filename name={result.filename} /> · {tn(result.totalPages, '{n} page', '{n} pages')} · {formatBytes(result.sizeBytes)}
                    </div>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    id="merge-open-folder-btn"
                    onClick={() => { void revealPath(result.outputPath).catch(() => undefined); }}
                    title={t('Show in folder')}
                  >
                    <FolderOpen size={14} />
                    {t('Show in folder')}
                  </button>
                </div>
              )}

              <div className="action-row">
                <button
                  className="btn btn-secondary"
                  id="merge-clear-btn"
                  onClick={clearAll}
                  disabled={isLoading}
                >
                  <Trash2 size={15} />
                  {t('Clear All')}
                </button>
                <button
                  className="btn btn-primary"
                  id="merge-run-btn"
                  onClick={handleMerge}
                  disabled={files.length < 2 || isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 size={15} className="spin" />
                      {t('Merging…')}
                    </>
                  ) : (
                    <>
                      <Merge size={15} />
                      {t('Merge PDF')}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
