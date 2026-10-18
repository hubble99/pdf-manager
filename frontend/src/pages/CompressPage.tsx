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
import { ChangeFileControls, PageHeader, RangeField, SegmentedControl } from '../components/ui';
import { addHistoryEntry } from '../utils/historyStore';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { triggerBlobDownload } from '../utils/downloadHelper';
import { openOutputFolder } from '../utils/tauriDialog';
import { t, tn } from '../i18n';

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
  if (q >= 75) return t('High quality');
  if (q >= 50) return t('Balanced');
  if (q >= 35) return t('Low quality');
  return t('Maximum compression');
}

function qualityColor(q: number): string {
  if (q >= 75) return 'var(--success)';
  if (q >= 50) return 'var(--info)';
  if (q >= 35) return 'var(--warning)';
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
      showToast({ type: 'error', title: t('Invalid file'), message: t('Only PDF files are accepted.') });
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
    if (!file) { showToast({ type: 'error', title: t('No file'), message: t('Please select a PDF file first.') }); return; }
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
                  title: t('Compression complete!'),
                  message: tn(data.images_processed, 'Reduced by {pct}% — {n} image re-encoded', 'Reduced by {pct}% — {n} images re-encoded', { pct: data.reduction_pct }),
                  action: { label: t('Open Folder'), onClick: () => openOutputFolder() },
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
      const msg = err instanceof Error ? err.message : t('Unknown error');
      showToast({ type: 'error', title: t('Compression failed'), message: msg });
    } finally {
      setIsLoading(false);
      setProgress(null);
    }
  };

  const clearFile = () => { setFile(null); setResult(null); setOutputFilename(''); };

  // ── Render ──────────────────────────────────────────────────────────────────
  const preset = [
    { value: 25, label: t('Maximum') },
    { value: 40, label: t('Low quality') },
    { value: 55, label: t('Balanced') },
    { value: 80, label: t('High quality') },
  ];

  return (
    <div className="feature-page">
      <PageHeader
        icon={Minimize2}
        title={t('Compress PDF')}
        description={t('Reduce file size while keeping the document readable')}
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
                aria-label={t('Drop a PDF file here or click to browse')}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  hidden
                  onChange={handleFileInput}
                  id="compress-file-input"
                />
                <Upload className="drop-zone-icon" />
                <p className="drop-zone-title">{t('Drop a PDF here')}</p>
                <p className="drop-zone-sub">{t('or click to browse · One file at a time')}</p>
                <span className="badge badge-neutral">PDF</span>
              </div>
              <p className="empty-hint">{t('You will see the file size before and after compressing.')}</p>
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
                    <ChangeFileControls
                      accept=".pdf"
                      idPrefix="compress"
                      onPick={loadFile}
                      onClear={clearFile}
                      disabled={isLoading}
                    />
                  </span>
                </div>
              </div>

              {/* Quality */}
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <SlidersHorizontal size={16} className="card-head-icon" aria-hidden="true" />
                    <label htmlFor="compress-quality-slider">{t('Quality')}</label>
                  </span>
                  <span className="card-head-actions">
                    <b className="card-head-value" style={{ color: qualityColor(quality) }}>
                      {qualityLabel(quality)}
                    </b>
                  </span>
                </div>
                <div className="card-body">
                  <RangeField
                    id="compress-quality-slider"
                    min={10}
                    max={95}
                    step={5}
                    value={quality}
                    disabled={isLoading}
                    valueText={`${qualityLabel(quality)}, ${quality}`}
                    onChange={setQuality}
                    scale={(
                      <>
                        <span>{t('Smaller file')}</span>
                        <b>{quality}</b>
                        <span>{t('Better quality')}</span>
                      </>
                    )}
                  />
                  <SegmentedControl
                    equal
                    ariaLabel={t('Quality preset')}
                    options={preset}
                    value={quality}
                    disabled={isLoading}
                    onChange={setQuality}
                  />
                  <small className="hint">
                    {quality < 50
                      ? t('Aggressive compression. Smallest file, some image quality loss expected.')
                      : quality < 75
                      ? t('Balanced compression. Good size reduction with acceptable quality.')
                      : t('Conservative compression. Minimal quality loss, smaller size reduction.')}
                  </small>
                </div>
              </div>

              {/* Size */}
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <Minimize2 size={16} className="card-head-icon" aria-hidden="true" />
                    {t('Size')}
                  </span>
                  {result && (
                    <span className="card-head-actions status-ok">
                      <CheckCircle size={14} aria-hidden="true" /> {t('Compression complete')}
                    </span>
                  )}
                </div>
                <div className="card-body">
                  <div className="size-compare">
                    <div className="size-box">
                      <small>{t('Before')}</small>
                      <b>{formatBytes(file.size)}</b>
                      <div className="size-bar"><i style={{ width: '100%' }} /></div>
                    </div>
                    <ArrowRight size={16} className="size-arrow" aria-hidden="true" />
                    <div className={`size-box${result ? ' ok' : ''}`}>
                      <small>{t('After')}</small>
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
                    <label htmlFor="compress-output-name">{t('Output Filename')}</label>
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
                    <b>{t('Saved to your Downloads folder')}</b>
                    <small>
                      <Filename name={result.filename} /> · {tn(result.imagesProcessed, '{n} image re-encoded', '{n} images re-encoded')} · {t('saved')} {formatBytes(result.sizeBefore - result.sizeAfter)}
                    </small>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    id="compress-open-folder-btn"
                    onClick={() => openOutputFolder()}
                    title={t('Open folder')}
                  >
                    <FolderOpen size={14} />
                    {t('Open Folder')}
                  </button>
                </div>
              )}

              {/* Progress */}
              {isLoading && progress && (
                <div className="card status-card" role="status" aria-live="polite">
                  <Loader2 size={20} className="spin" aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>{t('Compressing…')} {progress.percent}%</b>
                    <small>{t('Page')} {progress.page} {t('of')} {progress.total}</small>
                    <div className="size-bar size-bar--spaced">
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
                      {t('Compressing…')}
                    </>
                  ) : (
                    <>
                      <Minimize2 size={15} />
                      {t('Compress PDF')}
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
