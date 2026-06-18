import { useEffect, useCallback, useRef, useState } from 'react';
import {
  CheckCircle,
  FolderOpen,
  Info,
  Loader2,
  Upload,
  X,
  Image as ImageIcon,
} from 'lucide-react';
import apiClient from '../api/client';
import { Filename } from '../components/Filename';
import { addHistoryEntry } from '../utils/historyStore';
import { PdfThumbnail } from '../components/PdfThumbnail';
import { PreviewPanel, ThumbnailStrip } from '../components/preview';
import { parsePageRange } from '../utils/pageRange';
import type { PdfInfoResult, PdfToImageResult } from '../types';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { getFilenameFromHeaders, triggerBlobDownload } from '../utils/downloadHelper';
import { openOutputFolder } from '../utils/tauriDialog';



// ── Types ─────────────────────────────────────────────────────────────────────


// ── Constants ─────────────────────────────────────────────────────────────────

const FORMAT_OPTIONS = [
  { value: 'PNG', label: 'PNG', desc: 'Lossless quality, larger size' },
  { value: 'JPEG', label: 'JPEG', desc: 'Lossy compression, smaller size' },
  { value: 'WEBP', label: 'WEBP', desc: 'Modern format, great size/quality ratio' },
];

const DPI_OPTIONS = [
  { value: 72, label: '72 DPI', desc: 'Screen preview' },
  { value: 96, label: '96 DPI', desc: 'Standard display' },
  { value: 150, label: '150 DPI', desc: 'Balanced quality' },
  { value: 300, label: '300 DPI', desc: 'Print quality' },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}


// ── Component ─────────────────────────────────────────────────────────────────

export function PdfToImagePage() {
  const { showToast } = useToast();
  const { fileData: file, setFileData: setFile } = useFeatureFile<File | null>('pdftoimage');
  const [pdfInfo, setPdfInfo] = useState<PdfInfoResult | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [pageRanges, setPageRanges] = useState('');
  const [format, setFormat] = useState('PNG');
  const [dpi, setDpi] = useState(150);
  const [outputFilename, setOutputFilename] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<PdfToImageResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Preview State
  const [previewPage, setPreviewPage] = useState(1);
  const [zoom, setZoom] = useState(1.0);

  // Derived state
  const selectedPages = pdfInfo ? parsePageRange(pageRanges, pdfInfo.total_pages) : new Set<number>();


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
      setPageRanges(''); // Reset to all pages
      setOutputFilename(f.name.replace(/\.pdf$/i, ''));

      try {
        const form = new FormData();
        form.append('file', f);
        const resp = await apiClient.post<{ status: string; data: PdfInfoResult }>('/api/v1/pdf-info/', form);
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

  const handleTogglePage = (page: number) => {
    if (!pdfInfo) return;
    const newSet = new Set(selectedPages);
    if (newSet.has(page)) {
      newSet.delete(page);
    } else {
      newSet.add(page);
    }
    
    if (newSet.size === pdfInfo.total_pages) {
      setPageRanges(''); // equivalent to all pages
    } else {
      const sorted = Array.from(newSet).sort((a, b) => a - b);
      setPageRanges(sorted.join(', '));
    }
  };

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleConvert = async () => {
    if (!file) { showToast({ type: 'error', title: 'No file', message: 'Please select a PDF file first.' }); return; }
    
    setIsLoading(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('page_ranges', pageRanges); // empty is allowed (all pages)
    formData.append('format', format);
    formData.append('dpi', dpi.toString());
    formData.append('output_filename', outputFilename || file.name.replace(/\.pdf$/i, ''));

    try {
      const response = await apiClient.post('/api/v1/pdf-to-image/', formData, { responseType: 'blob' });

      const pagesExported = parseInt(response.headers['x-pages-exported'] || '1', 10);
      const resFormat = response.headers['x-format'] || format;
      const resDpi = parseInt(response.headers['x-dpi'] || dpi.toString(), 10);
      const isZip = pagesExported > 1;
      
      const mimeType = isZip ? 'application/zip' : `image/${resFormat.toLowerCase()}`;
      const blob = new Blob([response.data], { type: mimeType });
      const filename = getFilenameFromHeaders(response.headers, outputFilename || `exported.${isZip ? 'zip' : resFormat.toLowerCase()}`);

      // Auto-download immediately
      triggerBlobDownload(blob, filename);

      setResult({ filename, pagesExported, format: resFormat, dpi: resDpi, isZip });
      addHistoryEntry({ filename, action: 'PDF to Image', size: 0 });
      showToast({
        type: 'success',
        title: 'Conversion complete!',
        message: `${pagesExported} pages exported to ${resFormat}`,
        action: { label: 'Open Folder', onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      showToast({ type: 'error', title: 'Conversion failed', message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const clearFile = () => { setFile(null); setPdfInfo(null); setResult(null); setPreviewPage(1); setOutputFilename(''); };

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
            <ImageIcon size={20} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="page-title">PDF to Image</h1>
            <p className="page-subtitle">Convert PDF pages into high-quality images</p>
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
                id="pdf-to-image-drop-zone"
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
                  id="pdf-to-image-file-input"
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
                  id="pdf-to-image-remove-file"
                  style={{ color: 'var(--error)' }}
                >
                  <X size={15} />
                </button>
              </div>
            )}

            {/* Settings Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              {/* Format mode */}
              <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
                <label className="input-label">Image Format</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4, flex: 1 }}>
                  {FORMAT_OPTIONS.map((opt) => (
                    <label
                      key={opt.value}
                      htmlFor={`format-${opt.value}`}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 12,
                        padding: '10px 14px',
                        borderRadius: 'var(--radius-md)',
                        border: `1px solid ${format === opt.value ? 'var(--accent)' : 'var(--outline-variant)'}`,
                        background: format === opt.value ? 'var(--accent-dim)' : 'var(--surface-container)',
                        cursor: 'pointer',
                        transition: 'all var(--transition-fast)',
                        height: '100%',
                      }}
                    >
                      <div style={{ paddingTop: 1, flexShrink: 0 }}>
                        <input
                          id={`format-${opt.value}`}
                          type="radio"
                          name="format"
                          value={opt.value}
                          checked={format === opt.value}
                          onChange={() => setFormat(opt.value)}
                          style={{ margin: 0, accentColor: 'var(--accent)' }}
                        />
                      </div>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--on-surface)', lineHeight: 1.4 }}>{opt.label}</div>
                        <div style={{ fontSize: 12, color: 'var(--on-surface-variant)', marginTop: 2, lineHeight: 1.4 }}>{opt.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              
              {/* DPI Settings */}
              <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
                <label className="input-label">Resolution (DPI)</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4, flex: 1 }}>
                  {DPI_OPTIONS.map((opt) => (
                    <label
                      key={opt.value}
                      htmlFor={`dpi-${opt.value}`}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 12,
                        padding: '10px 14px',
                        borderRadius: 'var(--radius-md)',
                        border: `1px solid ${dpi === opt.value ? 'var(--accent)' : 'var(--outline-variant)'}`,
                        background: dpi === opt.value ? 'var(--accent-dim)' : 'var(--surface-container)',
                        cursor: 'pointer',
                        transition: 'all var(--transition-fast)',
                        height: '100%',
                      }}
                    >
                      <div style={{ paddingTop: 1, flexShrink: 0 }}>
                        <input
                          id={`dpi-${opt.value}`}
                          type="radio"
                          name="dpi"
                          value={opt.value}
                          checked={dpi === opt.value}
                          onChange={() => setDpi(opt.value)}
                          style={{ margin: 0, accentColor: 'var(--accent)' }}
                        />
                      </div>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--on-surface)', lineHeight: 1.4 }}>{opt.label}</div>
                        <div style={{ fontSize: 12, color: 'var(--on-surface-variant)', marginTop: 2, lineHeight: 1.4 }}>{opt.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* Page ranges input */}
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
                <label className="input-label" htmlFor="pdf-to-image-page-ranges" style={{ margin: 0 }}>
                  Page Ranges
                </label>
                {pdfInfo && (
                  <span className="badge badge-info">
                    <Info size={11} /> Total: {pdfInfo.total_pages} pages
                  </span>
                )}
              </div>
              <input
                id="pdf-to-image-page-ranges"
                className="input"
                type="text"
                value={pageRanges}
                onChange={(e) => setPageRanges(e.target.value)}
                placeholder="e.g. 1-3, 5 (Kosongkan untuk semua halaman)"
              />
              <p className="text-muted text-body-sm" style={{ marginTop: 6 }}>
                Selected: {selectedPages.size} pages
              </p>
            </div>

            {/* Output Filename */}
            {file && (
              <div className="card">
                <label className="input-label" htmlFor="pdf-to-image-output-name">Output Filename</label>
                <input
                  id="pdf-to-image-output-name"
                  className="input"
                  type="text"
                  value={outputFilename}
                  onChange={(e) => setOutputFilename(e.target.value)}
                  placeholder={file?.name.replace(/\.pdf$/i, '') || 'export'}
                />
                <p className="text-muted text-body-sm" style={{ marginTop: 6 }}>
                  Extension (.png/.jpg/.zip etc.) is added automatically.
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
                    <Filename name={result.filename} /> · {result.pagesExported} pages · {result.format} · {result.dpi} DPI
                    {result.isZip && ' (ZIP archive)'}
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  id="pdf-to-image-open-folder-btn"
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
                id="pdf-to-image-clear-btn"
                onClick={clearFile}
                disabled={!file || isLoading}
              >
                Clear
              </button>
              <button
                className="btn btn-primary"
                id="pdf-to-image-run-btn"
                onClick={handleConvert}
                disabled={!file || isLoading}
              >
                {isLoading ? (
                  <>
                    <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                    Exporting…
                  </>
                ) : (
                  <>
                    <ImageIcon size={15} />
                    Export & Download
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
              topSlot={
                file && pdfInfo ? (
                  <ThumbnailStrip
                    file={file}
                    totalPages={pdfInfo.total_pages}
                    currentPage={previewPage}
                    selectedPages={selectedPages}
                    onPageClick={setPreviewPage}
                    onTogglePage={handleTogglePage}
                  />
                ) : undefined
              }
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
