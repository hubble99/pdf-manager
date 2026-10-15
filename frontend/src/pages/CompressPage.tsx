import { useCallback, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle,
  FileText,
  FolderOpen,
  Loader2,
  Minimize2,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import apiClient from '../api/client';
import { API_BASE_URL } from '../api/config';
import { Filename } from '../components/Filename';
import { PageHeader } from '../components/ui';
import { addHistoryEntry } from '../utils/historyStore';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { triggerBlobDownload } from '../utils/downloadHelper';
import { openOutputFolder } from '../utils/tauriDialog';

// ── Types ─────────────────────────────────────────────────────────────────────


interface CompressResult {
  filename: string;
  sizeBefore: number;
  sizeAfter: number;
  reductionPct: number;
  imagesProcessed: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}


function qualityLabel(q: number): string {
  if (q >= 85) return 'High Quality';
  if (q >= 65) return 'Balanced';
  if (q >= 40) return 'Compact';
  return 'Maximum Compression';
}

function qualityColor(q: number): string {
  if (q >= 85) return 'var(--success)';
  if (q >= 65) return 'var(--info)';
  if (q >= 40) return 'var(--warning)';
  return 'var(--error)';
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CompressPage() {
  const { showToast } = useToast();
  const { fileData: file, setFileData: setFile } = useFeatureFile<File | null>('compress');
  const [quality, setQuality] = useState(70);
  const [outputFilename, setOutputFilename] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<{ page: number, total: number, percent: number } | null>(null);
  const [result, setResult] = useState<CompressResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);


  // ── File handling ───────────────────────────────────────────────────────────
  const loadFile = useCallback((f: File) => {
    if (!f.name.toLowerCase().endsWith('.pdf')) {
      showToast({ type: 'error', title: 'Invalid file', message: 'Only PDF files are accepted.' });
      return;
    }
    setFile(f);
    setResult(null);
    setOutputFilename(`compressed_${f.name}`);
  }, [setFile, showToast]);

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

  // ── Submit — single-step: compress & auto-download ─────────────────────────
  const handleCompress = async () => {
    if (!file) { showToast({ type: 'error', title: 'No file', message: 'Please select a PDF file first.' }); return; }
    setIsLoading(true);
    setResult(null);
    setProgress(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('quality', String(quality));
    formData.append('output_filename', outputFilename || `compressed_${file.name}`);

    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/compress/stream`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Stream reader not available');

      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || ''; // Keep the incomplete chunk in the buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.substring(6);
            try {
              const data = JSON.parse(dataStr);
              if (data.type === 'progress') {
                setProgress({ page: data.page, total: data.total, percent: data.percent });
              } else if (data.type === 'complete') {
                // Fetch the actual file
                const downloadRes = await apiClient.get(`/api/v1/compress/download/${data.download_id}`, {
                  responseType: 'blob'
                });
                const blob = new Blob([downloadRes.data], { type: 'application/pdf' });
                
                triggerBlobDownload(blob, data.filename);
                
                setResult({
                  filename: data.filename,
                  sizeBefore: data.size_before,
                  sizeAfter: data.size_after,
                  reductionPct: data.reduction_pct,
                  imagesProcessed: data.images_processed
                });
                
                addHistoryEntry({ filename: data.filename, action: 'Compressed PDF', size: data.size_after });
                showToast({
                  type: 'success',
                  title: 'Compression complete!',
                  message: `Reduced by ${data.reduction_pct}% — ${data.images_processed} image${data.images_processed !== 1 ? 's' : ''} re-encoded`,
                  action: { label: 'Open Folder', onClick: () => openOutputFolder() },
                  duration: 8000,
                });
              } else if (data.type === 'error') {
                throw new Error(data.message);
              }
            } catch (err) {
              if (err instanceof Error) throw err;
            }
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      showToast({ type: 'error', title: 'Compression failed', message: msg });
    } finally {
      setIsLoading(false);
      setProgress(null);
    }
  };

  const clearFile = () => { setFile(null); setResult(null); setOutputFilename(''); };

  // ── Render ──────────────────────────────────────────────────────────────────
  const preset = [
    { value: 25, label: 'Maximum' },
    { value: 55, label: 'Balanced' },
    { value: 80, label: 'High quality' },
  ];

  return (
    <div className="feature-page">
      <PageHeader
        icon={Minimize2}
        title="Compress PDF"
        description="Reduce file size while keeping the document readable"
      />

      <div className="page-body">
        <div className={`form-col${file ? '' : ' form-col--center'}`}>

          {!file ? (
            <>
              <div
                id="compress-drop-zone"
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
                  id="compress-file-input"
                />
                <Upload className="drop-zone-icon" />
                <p className="drop-zone-title">Drop a PDF here</p>
                <p className="drop-zone-sub">or click to browse · One file at a time</p>
                <span className="badge badge-neutral">PDF</span>
              </div>
              <p className="empty-hint">You will see the file size before and after compressing.</p>
            </>
          ) : (
            <>
              {/* File */}
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <FileText size={16} className="card-head-icon" aria-hidden="true" />
                    <Filename name={file.name} className="file-item-name" />
                    <span className="chip">{formatBytes(file.size)}</span>
                  </span>
                  <span className="card-head-actions">
                    <button
                      type="button"
                      className="link-btn"
                      id="compress-remove-file"
                      onClick={clearFile}
                      disabled={isLoading}
                    >
                      Change file
                    </button>
                  </span>
                </div>
              </div>

              {/* Quality */}
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <SlidersHorizontal size={16} className="card-head-icon" aria-hidden="true" />
                    <label htmlFor="compress-quality-slider">Quality</label>
                  </span>
                  <span className="card-head-actions">
                    <b className="card-head-value" style={{ color: qualityColor(quality) }}>
                      {qualityLabel(quality)}
                    </b>
                  </span>
                </div>
                <div className="card-body">
                  <input
                    id="compress-quality-slider"
                    className="range"
                    type="range"
                    min={10}
                    max={95}
                    step={5}
                    value={quality}
                    disabled={isLoading}
                    onChange={(e) => setQuality(Number(e.target.value))}
                  />
                  <div className="range-scale">
                    <span>Smaller file</span>
                    <b>{quality}</b>
                    <span>Better quality</span>
                  </div>
                  <div className="seg" role="group" aria-label="Quality preset">
                    {preset.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        aria-pressed={quality === item.value}
                        className={quality === item.value ? 'active' : ''}
                        disabled={isLoading}
                        onClick={() => setQuality(item.value)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <small className="hint">
                    {quality < 50
                      ? 'Aggressive compression. Smallest file, some image quality loss expected.'
                      : quality < 75
                      ? 'Balanced compression. Good size reduction with acceptable quality.'
                      : 'Conservative compression. Minimal quality loss, smaller size reduction.'}
                  </small>
                </div>
              </div>

              {/* Size */}
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <Minimize2 size={16} className="card-head-icon" aria-hidden="true" />
                    Size
                  </span>
                  {result && (
                    <span className="card-head-actions status-ok">
                      <CheckCircle size={14} aria-hidden="true" /> Compression complete
                    </span>
                  )}
                </div>
                <div className="card-body">
                  <div className="size-compare">
                    <div className="size-box">
                      <small>Before</small>
                      <b>{formatBytes(file.size)}</b>
                      <div className="size-bar"><i style={{ width: '100%' }} /></div>
                    </div>
                    <ArrowRight size={16} className="size-arrow" aria-hidden="true" />
                    <div className={`size-box${result ? ' ok' : ''}`}>
                      <small>After</small>
                      <b>{result ? formatBytes(result.sizeAfter) : '—'}</b>
                      <div className="size-bar">
                        <i style={{ width: result ? `${Math.max(2, Math.min(100, (result.sizeAfter / Math.max(1, result.sizeBefore)) * 100))}%` : '0%' }} />
                      </div>
                      {result && <span className="size-saved">−{result.reductionPct}%</span>}
                    </div>
                  </div>
                </div>
              </div>

              {/* Output filename */}
              <div className="card card--flush">
                <div className="card-body">
                  <div className="field">
                    <label htmlFor="compress-output-name">Output Filename</label>
                    <input
                      id="compress-output-name"
                      className="input"
                      type="text"
                      value={outputFilename}
                      disabled={isLoading}
                      onChange={(e) => setOutputFilename(e.target.value)}
                      placeholder={`compressed_${file.name}`}
                    />
                  </div>
                </div>
              </div>

              {/* Result — the download was triggered automatically */}
              {result && (
                <div className="card status-card status-card--ok">
                  <CheckCircle size={22} aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>Download started automatically</b>
                    <small>
                      <Filename name={result.filename} /> · {result.imagesProcessed} image{result.imagesProcessed !== 1 ? 's' : ''} re-encoded
                      · saved {formatBytes(result.sizeBefore - result.sizeAfter)}
                    </small>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    id="compress-open-folder-btn"
                    onClick={() => openOutputFolder()}
                    title="Open download folder"
                  >
                    <FolderOpen size={14} />
                    Open Folder
                  </button>
                </div>
              )}

              {/* Progress */}
              {isLoading && progress && (
                <div className="card status-card" role="status" aria-live="polite">
                  <Loader2 size={20} className="spin" aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>Compressing… {progress.percent}%</b>
                    <small>Page {progress.page} of {progress.total}</small>
                    <div className="size-bar" style={{ marginTop: 8 }}>
                      <i style={{ width: `${progress.percent}%` }} />
                    </div>
                  </div>
                </div>
              )}

              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  id="compress-run-btn"
                  onClick={handleCompress}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 size={15} className="spin" />
                      Compressing…
                    </>
                  ) : (
                    <>
                      <Minimize2 size={15} />
                      Compress &amp; Download
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
