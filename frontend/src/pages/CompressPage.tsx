import { useCallback, useRef, useState } from 'react';
import {
  CheckCircle,
  FolderOpen,
  Loader2,
  Minimize2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import apiClient from '../api/client';
import { API_BASE_URL } from '../api/config';
import { Filename } from '../components/Filename';
import { PdfThumbnail } from '../components/PdfThumbnail';
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
  }, []);

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
            <Minimize2 size={20} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="page-title">Compress PDF</h1>
            <p className="page-subtitle">Reduce PDF file size by re-encoding embedded images</p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="page-body">
        <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Drop zone */}
          {!file ? (
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
              <p className="drop-zone-title">Drop a PDF file here</p>
              <p className="drop-zone-sub">or click to browse · Single PDF</p>
              <span className="badge badge-neutral">PDF</span>
            </div>
          ) : (
            <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <PdfThumbnail file={file} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Filename name={file.name} className="file-item-name" />
                <div className="file-item-meta">{formatBytes(file.size)}</div>
              </div>
              <button
                className="btn btn-ghost btn-icon btn-sm"
                onClick={clearFile}
                aria-label="Remove file"
                id="compress-remove-file"
                style={{ color: 'var(--error)' }}
              >
                <X size={15} />
              </button>
            </div>
          )}

          {/* Quality slider */}
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <label className="input-label" htmlFor="compress-quality-slider" style={{ margin: 0 }}>
                Image Quality
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: qualityColor(quality),
                  fontFamily: 'JetBrains Mono, monospace',
                  transition: 'color var(--transition-fast)',
                }}>
                  {quality}
                </span>
                <span className="badge" style={{ background: qualityColor(quality) + '22', color: qualityColor(quality), border: 'none' }}>
                  {qualityLabel(quality)}
                </span>
              </div>
            </div>

            <input
              id="compress-quality-slider"
              type="range"
              min={10}
              max={95}
              step={5}
              value={quality}
              onChange={(e) => setQuality(Number(e.target.value))}
              style={{
                width: '100%',
                accentColor: qualityColor(quality),
                cursor: 'pointer',
                height: 6,
              }}
            />

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <span className="text-muted text-body-sm">10 — Max compression</span>
              <span className="text-muted text-body-sm">95 — Best quality</span>
            </div>

            <div style={{
              marginTop: 12,
              padding: '8px 12px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-container)',
              fontSize: 12,
              color: 'var(--on-surface-variant)',
              borderLeft: `3px solid ${qualityColor(quality)}`,
            }}>
              <Zap size={12} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
              {quality < 50
                ? 'Aggressive compression. Best for reducing size significantly, some image quality loss expected.'
                : quality < 75
                ? 'Balanced compression. Good size reduction with acceptable quality.'
                : 'Conservative compression. Minimal quality loss, smaller size reduction.'}
            </div>
          </div>

          {/* Before / After cards */}
          <div className="grid-2">
            <div className="card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--on-surface-variant)', marginBottom: 8 }}>
                BEFORE
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--on-surface)', fontFamily: 'JetBrains Mono, monospace' }}>
                {file ? formatBytes(file.size) : '—'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--on-surface-variant)', marginTop: 4 }}>Original size</div>
            </div>

            <div className="card" style={{
              textAlign: 'center',
              borderColor: result ? 'var(--success)' : 'var(--outline-variant)',
              background: result ? 'var(--success-container)' : undefined,
              transition: 'all var(--transition-normal)',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: result ? 'var(--success)' : 'var(--on-surface-variant)', marginBottom: 8 }}>
                AFTER
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, color: result ? 'var(--success)' : 'var(--on-surface)', fontFamily: 'JetBrains Mono, monospace' }}>
                {result ? formatBytes(result.sizeAfter) : '—'}
              </div>
              <div style={{ fontSize: 12, color: result ? 'var(--success)' : 'var(--on-surface-variant)', marginTop: 4 }}>
                {result ? `↓ ${result.reductionPct}% reduction` : 'After compression'}
              </div>
            </div>
          </div>

          {/* Output Filename */}
          {file && (
            <div className="card">
              <label className="input-label" htmlFor="compress-output-name">Output Filename</label>
              <input
                id="compress-output-name"
                className="input"
                type="text"
                value={outputFilename}
                onChange={(e) => setOutputFilename(e.target.value)}
                placeholder={`compressed_${file?.name || 'output.pdf'}`}
              />
            </div>
          )}

          {/* Result card — download was triggered automatically */}
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
                  <Filename name={result.filename} /> · {result.imagesProcessed} image{result.imagesProcessed !== 1 ? 's' : ''} re-encoded
                  · saved {formatBytes(result.sizeBefore - result.sizeAfter)}
                </div>
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

          {/* Progress Bar */}
          {isLoading && progress && (
            <div className="card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 13 }}>
                <span style={{ fontWeight: 500, color: 'var(--on-surface)' }}>Compressing pages...</span>
                <span className="text-muted text-body-sm">{progress.percent}% ({progress.page}/{progress.total})</span>
              </div>
              <div style={{ width: '100%', height: 6, background: 'var(--surface-container-highest)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ 
                  height: '100%', 
                  width: `${progress.percent}%`, 
                  background: 'var(--primary)', 
                  transition: 'width 200ms ease-out' 
                }} />
              </div>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button
              className="btn btn-secondary"
              id="compress-clear-btn"
              onClick={clearFile}
              disabled={!file || isLoading}
            >
              Clear
            </button>
            <button
              className="btn btn-primary"
              id="compress-run-btn"
              onClick={handleCompress}
              disabled={!file || isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                  Compressing…
                </>
              ) : (
                <>
                  <Minimize2 size={15} />
                  Compress & Download
                </>
              )}
            </button>
          </div>

        </div>
      </div>

      

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
