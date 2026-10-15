import { useEffect, useCallback, useRef, useState } from 'react';
import {
  CheckCircle,
  FileText,
  FolderOpen,
  Loader2,
  Scissors,
  Upload,
} from 'lucide-react';
import apiClient from '../api/client';
import { Filename } from '../components/Filename';
import { addHistoryEntry } from '../utils/historyStore';
import { PageThumbGrid } from '../components/preview';
import { PageHeader } from '../components/ui';
import { parsePageRange } from '../utils/pageRange';
import { formatPageNumbers } from '../features/converter/pageSelection';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { getFilenameFromHeaders, triggerBlobDownload } from '../utils/downloadHelper';
import { openOutputFolder } from '../utils/tauriDialog';


// ── Types ─────────────────────────────────────────────────────────────────────

type OutputMode = 'combine' | 'separate_page' | 'separate_range' | 'split_all';

interface PdfInfo {
  filename: string;
  total_pages: number;
  file_size_bytes: number;
}


interface ExtractResult {
  filename: string;
  pagesExtracted: number;
  outputMode: OutputMode;
  isZip: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const OUTPUT_MODE_OPTIONS: { value: OutputMode; label: string; desc: string }[] = [
  { value: 'combine', label: 'Combine into one PDF', desc: 'All selected pages → single PDF' },
  { value: 'separate_page', label: 'Separate per page', desc: 'Each page → individual PDF (ZIP)' },
  { value: 'separate_range', label: 'Separate per range', desc: 'Each range group → individual PDF (ZIP)' },
  { value: 'split_all', label: 'Split all pages', desc: 'Every page → its own PDF (ZIP)' },
];

// ── Helpers ────────────────────────────────────────────────────────────────────



// ── Component ─────────────────────────────────────────────────────────────────

export function ExtractPage() {
  const { showToast } = useToast();
  const { fileData: file, setFileData: setFile } = useFeatureFile<File | null>('extract');
  const [pdfInfo, setPdfInfo] = useState<PdfInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [pageRanges, setPageRanges] = useState('');
  const [outputMode, setOutputMode] = useState<OutputMode>('combine');
  const [outputFilename, setOutputFilename] = useState('extracted');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);


  // ── File handling ───────────────────────────────────────────────────────────
  const loadFile = useCallback(
    async (f: File) => {
      if (!f.name.toLowerCase().endsWith('.pdf')) {
        showToast({ type: 'error', title: 'Invalid file', message: 'Only PDF files are accepted.' });
        return;
      }
      setFile(f);
      setPdfInfo(null);
      setResult(null);
      setInfoLoading(true);

      try {
        const form = new FormData();
        form.append('file', f);
        const resp = await apiClient.post<{ status: string; data: PdfInfo }>('/api/v1/pdf-info/', form);
        setPdfInfo(resp.data.data);
      } catch {
        showToast({ type: 'info', title: 'PDF info unavailable', message: 'Could not read page count — backend may be offline.' });
      } finally {
        setInfoLoading(false);
      }
    },
    [setFile, showToast]
  );
  useEffect(() => {
    if (file && !pdfInfo && !infoLoading && !result) {
      const timer = window.setTimeout(() => void loadFile(file), 0);
      return () => window.clearTimeout(timer);
    }
  }, [file, pdfInfo, infoLoading, result, loadFile]);


  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
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

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleExtract = async () => {
    if (!file) { showToast({ type: 'error', title: 'No file', message: 'Please select a PDF file first.' }); return; }
    if (outputMode !== 'split_all' && !pageRanges.trim()) {
      showToast({ type: 'error', title: 'No pages specified', message: 'Enter page ranges, e.g. 1-3,5,7-9' });
      return;
    }
    setIsLoading(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('page_ranges', pageRanges || '1');
    formData.append('output_mode', outputMode);
    formData.append('output_filename', outputFilename || 'extracted');

    try {
      const response = await apiClient.post('/api/v1/extract/', formData, { responseType: 'blob' });

      const isZip = outputMode !== 'combine';
      const mimeType = isZip ? 'application/zip' : 'application/pdf';
      const blob = new Blob([response.data], { type: mimeType });
      const pagesExtracted = parseInt(response.headers['x-pages-extracted'] || '0', 10);
      const filename = getFilenameFromHeaders(response.headers, outputFilename || `extracted.${isZip ? 'zip' : 'pdf'}`);

      // Auto-download immediately
      triggerBlobDownload(blob, filename);

      setResult({ filename, pagesExtracted, outputMode, isZip });
      addHistoryEntry({ filename, action: 'Extracted Pages', size: 0 });
      showToast({
        type: 'success',
        title: 'Extraction complete!',
        message: `${pagesExtracted} pages extracted`,
        action: { label: 'Open Folder', onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      showToast({ type: 'error', title: 'Extraction failed', message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const clearFile = () => {
    setFile(null);
    setPdfInfo(null);
    setResult(null);
    setPageRanges('');
    setOutputFilename('extracted');
  };

  // The thumbnail grid and the page-range field edit the same value.
  const totalPages = pdfInfo?.total_pages ?? 0;
  const selectedPages: Set<number> = outputMode === 'split_all'
    ? new Set(Array.from({ length: totalPages }, (_, index) => index + 1))
    : pageRanges.trim() ? parsePageRange(pageRanges, totalPages) : new Set<number>();
  const gridEditable = outputMode !== 'split_all';

  const togglePage = (page: number) => {
    const next = new Set(selectedPages);
    if (next.has(page)) next.delete(page);
    else next.add(page);
    setPageRanges(formatPageNumbers(next));
  };
  const selectAllPages = () => setPageRanges(totalPages > 0 ? `1-${totalPages}` : '');
  const clearPages = () => setPageRanges('');

  // ── Render ──────────────────────────────────────────────────────────────────
  const selectionNote = outputMode === 'split_all'
    ? 'Every page becomes its own PDF'
    : `${selectedPages.size} of ${totalPages} page${totalPages === 1 ? '' : 's'} selected`;

  return (
    <div className="feature-page">
      <PageHeader
        icon={Scissors}
        title="Split PDF"
        description="Take out the pages or ranges you need as a new document"
      />

      <div className="page-body">
        {!file ? (
          <div className="form-col form-col--center">
            <div
              id="extract-drop-zone"
              className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={handleClick}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleClick()}
              aria-label="Drop a PDF file here or click to browse"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                style={{ display: 'none' }}
                onChange={handleFileInput}
                id="extract-file-input"
              />
              <Upload className="drop-zone-icon" />
              <p className="drop-zone-title">Drop a PDF here</p>
              <p className="drop-zone-sub">or click to browse · One file at a time</p>
              <span className="badge badge-neutral">PDF</span>
            </div>
            <p className="empty-hint">Every page will appear here so you can pick what to split.</p>
          </div>
        ) : (
          <div className="form-col form-col--split">
            {/* Pages */}
            <div className="card card--flush">
              <div className="card-head">
                <span className="card-head-title">
                  <FileText size={16} className="card-head-icon" aria-hidden="true" />
                  <Filename name={file.name} className="file-item-name" />
                  {pdfInfo && <span className="chip">{pdfInfo.total_pages} pages</span>}
                  {infoLoading && <Loader2 size={12} className="spin" aria-hidden="true" />}
                </span>
                <span className="card-head-actions">
                  {totalPages > 0 && <span>{selectionNote}</span>}
                  {gridEditable && totalPages > 0 && (
                    <>
                      <button type="button" className="link-btn" onClick={selectAllPages}>Select all</button>
                      <button type="button" className="link-btn" onClick={clearPages}>Clear</button>
                    </>
                  )}
                  <button
                    type="button"
                    className="link-btn"
                    id="extract-remove-file"
                    onClick={clearFile}
                    disabled={isLoading}
                  >
                    Change file
                  </button>
                </span>
              </div>
              {totalPages > 0 ? (
                <PageThumbGrid
                  file={file}
                  totalPages={totalPages}
                  selected={selectedPages}
                  interactive={gridEditable}
                  onToggle={togglePage}
                />
              ) : (
                <p className="empty-hint">
                  {infoLoading ? 'Reading the document…' : 'Pages are unavailable. You can still type the pages to split.'}
                </p>
              )}
            </div>

            <div className="col-stack">
              {/* Split mode */}
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <Scissors size={16} className="card-head-icon" aria-hidden="true" />
                    Split mode
                  </span>
                </div>
                <div role="radiogroup" aria-label="Output mode">
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
                    <label htmlFor="extract-page-ranges">Page Ranges</label>
                    <input
                      id="extract-page-ranges"
                      className="input"
                      type="text"
                      value={pageRanges}
                      onChange={(e) => setPageRanges(e.target.value)}
                      placeholder="e.g. 1-3, 5, 7-9"
                      disabled={outputMode === 'split_all'}
                    />
                    <small>
                      {outputMode === 'split_all'
                        ? 'Split all pages exports every page individually.'
                        : 'Click pages on the left, or type pages and ranges separated by commas.'}
                    </small>
                  </div>
                  <div className="field">
                    <label htmlFor="extract-output-name">Output Filename</label>
                    <input
                      id="extract-output-name"
                      className="input"
                      type="text"
                      value={outputFilename}
                      onChange={(e) => setOutputFilename(e.target.value)}
                      placeholder="extracted"
                    />
                    <small>Extension (.pdf or .zip) is added automatically.</small>
                  </div>
                </div>
              </div>

              {result && (
                <div className="card status-card status-card--ok">
                  <CheckCircle size={22} aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>Download started automatically</b>
                    <small>
                      <Filename name={result.filename} /> · {result.pagesExtracted} page{result.pagesExtracted !== 1 ? 's' : ''} extracted
                      {result.isZip ? ' · ZIP archive' : ''}
                    </small>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    id="extract-open-folder-btn"
                    onClick={() => openOutputFolder()}
                    title="Open download folder"
                  >
                    <FolderOpen size={14} />
                    Open Folder
                  </button>
                </div>
              )}

              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  id="extract-run-btn"
                  onClick={handleExtract}
                  disabled={!file || isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 size={15} className="spin" />
                      Splitting…
                    </>
                  ) : (
                    <>
                      <Scissors size={15} />
                      Split &amp; Download
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
