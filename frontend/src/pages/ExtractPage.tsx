import { useEffect, useCallback, useRef, useState } from 'react';
import {
  CheckCircle,
  FolderOpen,
  Info,
  Loader2,
  Scissors,
  Upload,
  X,
} from 'lucide-react';
import apiClient from '../api/client';
import { Filename } from '../components/Filename';
import { addHistoryEntry } from '../utils/historyStore';
import { PdfThumbnail } from '../components/PdfThumbnail';
import { PreviewPanel } from '../components/preview';
import { isPageInRange } from '../utils/pageRange';
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}


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

  // Preview State
  const [previewPage, setPreviewPage] = useState(1);
  const [zoom, setZoom] = useState(1.0);


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
      setPreviewPage(1);

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
    []
  );
  useEffect(() => {
    if (file && !pdfInfo && !infoLoading && !result) {
      loadFile(file);
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

  const clearFile = () => { setFile(null); setPdfInfo(null); setResult(null); setPreviewPage(1); setOutputFilename('extracted'); };

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
            <Scissors size={20} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="page-title">Split PDF</h1>
            <p className="page-subtitle">Split or extract pages from a PDF into separate files</p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="page-body">
        <div className="feature-split-layout">

          {/* Controls */}
          <div className="feature-controls">
            {!file ? (
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
                <p className="drop-zone-title">Drop a PDF file here</p>
                <p className="drop-zone-sub">or click to browse · Single PDF</p>
                <span className="badge badge-neutral">PDF</span>
              </div>
            ) : (
              /* File info card */
              <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <PdfThumbnail file={file} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Filename name={file.name} className="file-item-name" />
                  <div className="file-item-meta" style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 4 }}>
                    <span>{formatBytes(file.size)}</span>
                    {infoLoading && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />}
                    {pdfInfo && (
                      <span className="badge badge-info" style={{ fontSize: 11 }}>
                        {pdfInfo.total_pages} pages
                      </span>
                    )}
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={clearFile}
                  aria-label="Remove file"
                  id="extract-remove-file"
                  style={{ color: 'var(--error)' }}
                >
                  <X size={15} />
                </button>
              </div>
            )}

            {/* Page ranges input */}
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
                <label className="input-label" htmlFor="extract-page-ranges" style={{ margin: 0 }}>
                  Page Ranges
                </label>
                {pdfInfo && (
                  <span className="badge badge-info">
                    <Info size={11} /> Total: {pdfInfo.total_pages} pages
                  </span>
                )}
              </div>
              <input
                id="extract-page-ranges"
                className="input"
                type="text"
                value={pageRanges}
                onChange={(e) => setPageRanges(e.target.value)}
                placeholder="e.g. 1-3, 5, 7-9"
                disabled={outputMode === 'split_all'}
              />
              <p className="text-muted text-body-sm" style={{ marginTop: 6 }}>
                {outputMode === 'split_all'
                  ? '⚡ Split All mode will export every page individually.'
                  : 'Use commas to separate pages/ranges. Example: 1-3, 5, 7-9'}
              </p>
            </div>

            {/* Output mode */}
            <div className="card">
              <label className="input-label">Output Mode</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
                {OUTPUT_MODE_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    htmlFor={`extract-mode-${opt.value}`}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 12,
                      padding: '10px 14px',
                      borderRadius: 'var(--radius-md)',
                      border: `1px solid ${outputMode === opt.value ? 'var(--accent)' : 'var(--outline-variant)'}`,
                      background: outputMode === opt.value ? 'var(--accent-dim)' : 'var(--surface-container)',
                      cursor: 'pointer',
                      transition: 'all var(--transition-fast)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', paddingTop: 1 }}>
                      <input
                        id={`extract-mode-${opt.value}`}
                        type="radio"
                        name="output_mode"
                        value={opt.value}
                        checked={outputMode === opt.value}
                        onChange={() => setOutputMode(opt.value)}
                        style={{ margin: 0, accentColor: 'var(--accent)', cursor: 'pointer', width: 15, height: 15, flexShrink: 0 }}
                      />
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', textAlign: 'left', justifyContent: 'center' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--on-surface)', lineHeight: 1.3 }}>{opt.label}</div>
                      <div style={{ fontSize: 12, color: 'var(--on-surface-variant)', marginTop: 3, lineHeight: 1.4 }}>{opt.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Output Filename */}
            {file && (
              <div className="card">
                <label className="input-label" htmlFor="extract-output-name">Output Filename</label>
                <input
                  id="extract-output-name"
                  className="input"
                  type="text"
                  value={outputFilename}
                  onChange={(e) => setOutputFilename(e.target.value)}
                  placeholder="extracted"
                />
                <p className="text-muted text-body-sm" style={{ marginTop: 6 }}>
                  Extension (.pdf or .zip) is added automatically.
                </p>
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
                    Download started automatically
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--on-surface-variant)' }}>
                    <Filename name={result.filename} /> · {result.pagesExtracted} pages extracted
                    {result.isZip && ' · ZIP archive'}
                  </div>
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

            {/* Actions */}
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                className="btn btn-secondary"
                id="extract-clear-btn"
                onClick={clearFile}
                disabled={!file || isLoading}
              >
                Clear
              </button>
              <button
                className="btn btn-primary"
                id="extract-run-btn"
                onClick={handleExtract}
                disabled={!file || isLoading}
              >
                {isLoading ? (
                  <>
                    <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                    Extracting…
                  </>
                ) : (
                  <>
                    <Scissors size={15} />
                    Extract & Download
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Preview Panel */}
          <div className="feature-preview">
            <PreviewPanel
              pdfFile={file}
              totalPages={pdfInfo?.total_pages}
              currentPage={previewPage}
              onPageChange={setPreviewPage}
              zoom={zoom}
              onZoomChange={setZoom}
              isHighlighted={file && pdfInfo ? isPageInRange(previewPage, pageRanges, pdfInfo.total_pages) : false}
            />
          </div>

        </div>
      </div>

      

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
