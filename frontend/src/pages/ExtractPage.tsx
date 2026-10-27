import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle,
  FileText,
  FolderOpen,
  Info,
  Loader2,
  Scissors,
  Upload,
} from 'lucide-react';
import { FEATURE_ICONS } from '../components/icons';
import { Filename } from '../components/Filename';
import { addHistoryEntry } from '../utils/historyStore';
import { PageThumbGrid } from '../components/preview';
import { PageHeader } from '../components/ui';
import { parsePageRange } from '../utils/pageRange';
import { formatPageNumbers } from '../features/converter/pageSelection';
import { extractErrorMessage } from '../features/merge/messages';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { useNativePaths } from '../hooks/useNativePaths';
import { isCoreCancelled, revealPath, type CoreProgress } from '../api/nativeCore';
import { getPdfInfo, type PdfInfo } from '../api/pdfRender';
import { extractPages, type ExtractMode } from '../api/pdfMerge';
import { baseName, stemOf } from '../utils/paths';
import { t, tn } from '../i18n';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExtractResult {
  outputPath: string;
  filename: string;
  pagesExtracted: number;
  files: number;
  isZip: boolean;
}

const PDF_FILTER = { name: 'PDF', extensions: ['pdf'] };

// ── Constants ─────────────────────────────────────────────────────────────────

const OUTPUT_MODE_OPTIONS: { value: ExtractMode; label: string; desc: string }[] = [
  { value: 'combine', label: t('Combine into one PDF'), desc: t('All selected pages → single PDF') },
  { value: 'separate_page', label: t('Separate per page'), desc: t('Each page → individual PDF (ZIP)') },
  { value: 'separate_range', label: t('Separate per range'), desc: t('Each range group → individual PDF (ZIP)') },
  { value: 'split_all', label: t('Split all pages'), desc: t('Every page → its own PDF (ZIP)') },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function ExtractPage() {
  const { showToast } = useToast();
  const { fileData: path, setFileData: setPath } = useFeatureFile<string | null>('extract');
  const [pdfInfo, setPdfInfo] = useState<PdfInfo | null>(null);
  const [infoFailed, setInfoFailed] = useState(false);
  const [pageRanges, setPageRanges] = useState('');
  const [outputMode, setOutputMode] = useState<ExtractMode>('combine');
  const [outputFilename, setOutputFilename] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<CoreProgress | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);
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

  // ── File handling ───────────────────────────────────────────────────────────
  /** A new file starts clean: no page selection or name from the previous one. */
  const loadPath = (next: string) => {
    setPath(next);
    setPdfInfo(null);
    setInfoFailed(false);
    setResult(null);
    setError(null);
    setPageRanges('');
    setOutputFilename('');
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

  // Page count and protection of the loaded PDF.
  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    getPdfInfo(path)
      .then((info) => { if (!cancelled) setPdfInfo(info); })
      .catch(() => { if (!cancelled) setInfoFailed(true); });
    return () => { cancelled = true; };
  }, [path]);

  const infoLoading = Boolean(path) && !pdfInfo && !infoFailed;
  const isProtected = Boolean(pdfInfo?.encrypted);

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleExtract = async () => {
    if (!path) { showToast({ type: 'error', title: t('No file'), message: t('Please select a PDF file first.') }); return; }
    if (outputMode !== 'split_all' && !pageRanges.trim()) {
      showToast({ type: 'error', title: t('No pages specified'), message: t('Enter page ranges, e.g. 1-3,5,7-9') });
      return;
    }
    setIsLoading(true);
    setProgress(null);
    setResult(null);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const report = await extractPages(
        path,
        { mode: outputMode, pageRanges, outputName: outputFilename },
        { signal: controller.signal, onProgress: (p) => { if (mountedRef.current) setProgress(p); } },
      );
      if (!mountedRef.current) return;
      const filename = baseName(report.outputPath);
      setResult({
        outputPath: report.outputPath,
        filename,
        pagesExtracted: report.pagesExtracted,
        files: report.files,
        isZip: report.isZip,
      });
      addHistoryEntry({ filename, action: 'Extracted Pages', size: report.outputSizeBytes });
      showToast({
        type: 'success',
        title: t('Extraction complete!'),
        message: tn(report.pagesExtracted, '{n} page extracted', '{n} pages extracted'),
        action: { label: t('Show in folder'), onClick: () => { void revealPath(report.outputPath).catch(() => undefined); } },
        duration: 8000,
      });
    } catch (err: unknown) {
      if (!mountedRef.current || isCoreCancelled(err)) return;
      setError(extractErrorMessage(err));
    } finally {
      abortRef.current = null;
      if (mountedRef.current) {
        setIsLoading(false);
        setProgress(null);
      }
    }
  };

  const clearFile = () => {
    setPath(null);
    setPdfInfo(null);
    setInfoFailed(false);
    setResult(null);
    setError(null);
    setPageRanges('');
    setOutputFilename('');
  };

  const openPicker = () => {
    if (isLoading) return;
    void pick();
  };

  // The thumbnail grid and the page-range field edit the same value.
  const totalPages = pdfInfo?.pages ?? 0;
  const selectedPages: Set<number> = outputMode === 'split_all'
    ? new Set(Array.from({ length: totalPages }, (_, index) => index + 1))
    : pageRanges.trim() ? parsePageRange(pageRanges, totalPages) : new Set<number>();
  const gridEditable = outputMode !== 'split_all' && !isLoading;

  const togglePage = (page: number) => {
    const next = new Set(selectedPages);
    if (next.has(page)) next.delete(page);
    else next.add(page);
    setPageRanges(formatPageNumbers(next));
  };
  /** Shift + click on the grid: the range between the two clicks is set in one go. */
  const selectRange = (from: number, to: number, select: boolean) => {
    const next = new Set(selectedPages);
    for (let page = from; page <= to; page += 1) {
      if (select) next.add(page);
      else next.delete(page);
    }
    setPageRanges(formatPageNumbers(next));
  };
  const selectAllPages = () => setPageRanges(totalPages > 0 ? `1-${totalPages}` : '');
  const clearPages = () => setPageRanges('');

  const percent = progress?.total ? Math.round((progress.done / progress.total) * 100) : null;
  const progressTitle = progress?.stage === 'saving'
    ? t('Saving the new PDF…')
    : progress?.total
      ? (outputMode === 'combine'
        ? t('Copying page {done} of {total}…', { done: Math.min(progress.done + 1, progress.total), total: progress.total })
        : t('Writing file {done} of {total}…', { done: Math.min(progress.done + 1, progress.total), total: progress.total }))
      : t('Reading the PDF…');

  // ── Render ──────────────────────────────────────────────────────────────────
  const selectionNote = outputMode === 'split_all'
    ? t('Every page becomes its own PDF')
    : tn(totalPages, '{count} of {n} page selected', '{count} of {n} pages selected', { count: selectedPages.size });

  return (
    <div className="feature-page">
      <PageHeader
        icon={FEATURE_ICONS['extract']}
        title={t('Split PDF')}
        description={t('Take out the pages or ranges you need as a new document')}
      />

      <div className="page-body">
        {!desktop && (
          <div className="card status-card" role="note">
            <Info size={20} aria-hidden="true" />
            <div className="status-card-copy">
              <b>{t('Split PDF runs in the Dokuwu desktop app')}</b>
              <small>{t('It works on the files directly on your computer, which the browser preview cannot do.')}</small>
            </div>
          </div>
        )}

        {desktop && !path && (
          <div className="form-col form-col--center">
            <div
              id="extract-drop-zone"
              className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
              onClick={() => openPicker()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && openPicker()}
              aria-label={t('Drop a PDF file here or click to browse')}
            >
              <Upload className="drop-zone-icon" />
              <p className="drop-zone-title">{t('Drop a PDF here')}</p>
              <p className="drop-zone-sub">{t('or click to browse · One file at a time')}</p>
              <span className="badge badge-neutral">PDF</span>
            </div>
            <p className="empty-hint">{t('Every page will appear here so you can pick what to split.')}</p>
          </div>
        )}

        {desktop && path && (
          <div className="form-col form-col--split">
            {/* Pages */}
            <div className="card card--flush">
              <div className="card-head">
                <span className="card-head-title">
                  <FileText size={16} className="card-head-icon" aria-hidden="true" />
                  <Filename name={baseName(path)} className="file-item-name" />
                  {pdfInfo && !isProtected && <span className="chip">{pdfInfo.pages} {t('pages')}</span>}
                  {infoLoading && <Loader2 size={12} className="spin" aria-hidden="true" />}
                  {isProtected && <span className="badge badge-error">{t('Password protected')}</span>}
                </span>
                <span className="card-head-actions">
                  {totalPages > 0 && <span>{selectionNote}</span>}
                  {gridEditable && totalPages > 0 && (
                    <>
                      <button type="button" className="link-btn" onClick={selectAllPages}>{t('Select all')}</button>
                      <button type="button" className="link-btn" onClick={clearPages}>{t('Clear')}</button>
                    </>
                  )}
                  <button
                    type="button"
                    className="link-btn"
                    id="extract-replace-file"
                    onClick={openPicker}
                    disabled={isLoading}
                  >
                    {t('Replace')}
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    id="extract-remove-file"
                    onClick={clearFile}
                    disabled={isLoading}
                    aria-label={t('Remove PDF')}
                  >
                    {t('Remove')}
                  </button>
                </span>
              </div>
              {totalPages > 0 ? (
                <>
                  <PageThumbGrid
                    file={path}
                    totalPages={totalPages}
                    selected={selectedPages}
                    interactive={gridEditable}
                    onToggle={togglePage}
                    onSelectRange={selectRange}
                  />
                  {gridEditable && totalPages > 1 && (
                    <p className="empty-hint" id="extract-shift-hint">
                      {t('Tip: hold Shift and click to select a range of pages.')}
                    </p>
                  )}
                </>
              ) : (
                <p className="empty-hint">
                  {infoLoading
                    ? t('Reading the document…')
                    : isProtected
                      ? t('This PDF is protected. Remove the protection first, then split its pages.')
                      : t('Pages are unavailable. You can still type the pages to split.')}
                </p>
              )}
            </div>

            <div className="col-stack">
              {/* Split mode */}
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <Scissors size={16} className="card-head-icon" aria-hidden="true" />
                    {t('Split mode')}
                  </span>
                </div>
                <div role="radiogroup" aria-label={t('Output mode')}>
                  {OUTPUT_MODE_OPTIONS.map((opt) => (
                    <label
                      key={opt.value}
                      htmlFor={`extract-mode-${opt.value}`}
                      className={`mode-row${outputMode === opt.value ? ' active' : ''}`}
                    >
                      <input
                        id={`extract-mode-${opt.value}`}
                        type="radio"
                        name="output_mode"
                        value={opt.value}
                        checked={outputMode === opt.value}
                        onChange={() => setOutputMode(opt.value)}
                        disabled={isLoading}
                      />
                      <span className="radio-copy">
                        <span className="radio-title">{opt.label}</span>
                        <span className="radio-desc">{opt.desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Pages + output name */}
              <div className="card card--flush">
                <div className="card-body">
                  <div className="field">
                    <label htmlFor="extract-page-ranges">{t('Page Ranges')}</label>
                    <input
                      id="extract-page-ranges"
                      className="input"
                      type="text"
                      value={pageRanges}
                      onChange={(e) => setPageRanges(e.target.value)}
                      placeholder="e.g. 1-3, 5, 7-9"
                      disabled={outputMode === 'split_all' || isLoading}
                    />
                    <small>
                      {outputMode === 'split_all'
                        ? t('Split all pages exports every page individually.')
                        : t('Click pages on the left, or type pages and ranges separated by commas.')}
                    </small>
                  </div>
                  <div className="field">
                    <label htmlFor="extract-output-name">{t('Output Filename')}</label>
                    <input
                      id="extract-output-name"
                      className="input"
                      type="text"
                      value={outputFilename}
                      onChange={(e) => setOutputFilename(e.target.value)}
                      placeholder={`extracted_${stemOf(path)}`}
                      disabled={isLoading}
                    />
                    <small>{t('Extension (.pdf or .zip) is added automatically.')}</small>
                  </div>
                </div>
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
                <div className="card status-card" role="status" aria-live="polite" id="extract-progress">
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
                    id="extract-cancel-btn"
                    onClick={() => abortRef.current?.abort()}
                  >
                    {t('Cancel')}
                  </button>
                </div>
              )}

              {result && (
                <div className="card status-card status-card--ok">
                  <CheckCircle size={22} aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>{t('Saved to your Downloads folder')}</b>
                    <small>
                      <Filename name={result.filename} /> · {tn(result.pagesExtracted, '{n} page extracted', '{n} pages extracted')}
                      {result.isZip ? t(' · ZIP archive') : ''}
                    </small>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    id="extract-open-folder-btn"
                    onClick={() => { void revealPath(result.outputPath).catch(() => undefined); }}
                    title={t('Show in folder')}
                  >
                    <FolderOpen size={14} />
                    {t('Show in folder')}
                  </button>
                </div>
              )}

              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  id="extract-run-btn"
                  onClick={handleExtract}
                  disabled={!path || isLoading || isProtected}
                  title={isProtected ? t('This PDF is protected. Remove the protection first, then split its pages.') : undefined}
                >
                  {isLoading ? (
                    <>
                      <Loader2 size={15} className="spin" />
                      {t('Splitting…')}
                    </>
                  ) : (
                    <>
                      <Scissors size={15} />
                      {t('Split PDF')}
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
