import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle,
  FileText,
  FolderOpen,
  Info,
  Loader2,
  Minimize2,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react';
import { FEATURE_ICONS } from '../components/icons';
import { Filename } from '../components/Filename';
import { PageHeader, RangeField, SegmentedControl, SizeCompareCard } from '../components/ui';
import { addHistoryEntry } from '../utils/historyStore';
import { useToast } from '../hooks/useToast';
import { openOutputFolder } from '../utils/tauriDialog';
import { useNativePaths } from '../hooks/useNativePaths';
import { NativeCoreError, isCoreCancelled, type CoreProgress } from '../api/nativeCore';
import {
  MAX_COMPRESS_QUALITY,
  MIN_COMPRESS_QUALITY,
  compressPdf,
  probePdf,
  type PdfCompressReport,
  type PdfProbe,
} from '../api/pdfCompress';
import { baseName, compressErrorMessage, formatBytes, stemOf } from '../utils/compressPdf';
import { t, tn } from '../i18n';

// ── Helpers ────────────────────────────────────────────────────────────────────

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

const PDF_FILTER = { name: 'PDF', extensions: ['pdf'] };

// ── Component ─────────────────────────────────────────────────────────────────

export function CompressPage() {
  const { showToast } = useToast();
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [probe, setProbe] = useState<PdfProbe | null>(null);
  const [quality, setQuality] = useState(70);
  const [outputName, setOutputName] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<CoreProgress | null>(null);
  const [result, setResult] = useState<PdfCompressReport | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── File handling ───────────────────────────────────────────────────────────
  const loadPath = useCallback(async (path: string) => {
    try {
      const info = await probePdf(path);
      if (info.encrypted) {
        showToast({ type: 'error', title: t('Compression failed'), message: compressErrorMessage(new NativeCoreError('password_required', '')) });
        return;
      }
      setProbe(info);
      setInputPath(path);
      setResult(null);
      setOutputName(`compressed_${stemOf(path)}`);
    } catch (err) {
      showToast({ type: 'error', title: t('Invalid file'), message: compressErrorMessage(err) });
    }
  }, [showToast]);

  const { desktop, isDragOver, pick: pickFile } = useNativePaths({
    filter: PDF_FILTER,
    pickerTitle: t('Choose a PDF to compress'),
    disabled: running,
    onPaths: (accepted, rejected) => {
      if (accepted[0]) void loadPath(accepted[0]);
      else if (rejected > 0) showToast({ type: 'error', title: t('Invalid file'), message: t('Only PDF files are accepted.') });
    },
  });

  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Compress — the result is saved to the Downloads folder ─────────────────
  const handleCompress = async () => {
    if (!inputPath) { showToast({ type: 'error', title: t('No file'), message: t('Please select a PDF file first.') }); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setResult(null);
    setProgress(null);
    try {
      const report = await compressPdf(inputPath, quality, outputName, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      setResult(report);
      addHistoryEntry({ filename: baseName(report.outputPath), action: 'Compressed PDF', size: report.sizeAfter });
      showToast({
        type: 'success',
        title: t('Compression complete!'),
        message: report.keptOriginal
          ? t('This PDF is already as small as it gets.')
          : tn(report.imagesRecompressed, 'Reduced by {pct}% — {n} image re-encoded', 'Reduced by {pct}% — {n} images re-encoded', { pct: report.reductionPct }),
        action: { label: t('Open Folder'), onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (err) {
      if (isCoreCancelled(err)) {
        showToast({ type: 'info', title: t('Compression cancelled'), message: t('Nothing was saved.') });
      } else {
        showToast({ type: 'error', title: t('Compression failed'), message: compressErrorMessage(err) });
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      setProgress(null);
    }
  };

  const clearFile = () => { setInputPath(null); setProbe(null); setResult(null); setOutputName(''); };

  const imagePercent = progress?.stage === 'images' && progress.total
    ? Math.round((progress.done / progress.total) * 100)
    : null;
  const progressTitle = progress?.stage === 'saving'
    ? t('Saving the compressed PDF…')
    : progress?.stage === 'images' && progress.total
      ? t('Compressing picture {done} of {total}…', { done: Math.min(progress.done + 1, progress.total), total: progress.total })
      : progress?.stage === 'deduplicating'
        ? t('Merging repeated pictures and fonts…')
        : t('Reading the PDF…');
  const sizeBefore = probe?.sizeBytes ?? 0;

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
        icon={FEATURE_ICONS['compress']}
        title={t('Compress PDF')}
        description={t('Reduce file size while keeping the document readable')}
      />

      <div className="page-body">
        <div className={`form-col${inputPath ? '' : ' form-col--center'}`}>

          {!desktop ? (
            <div className="card status-card" role="note">
              <Info size={20} aria-hidden="true" />
              <div className="status-card-copy">
                <b>{t('Compress PDF runs in the Dokuwu desktop app')}</b>
                <small>{t('It works on the file directly on your computer, which the browser preview cannot do.')}</small>
              </div>
            </div>
          ) : !inputPath ? (
            <>
              <div
                id="compress-drop-zone"
                className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
                onClick={() => void pickFile()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && void pickFile()}
                aria-label={t('Drop a PDF file here or click to browse')}
              >
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
                    <Filename name={baseName(inputPath)} className="file-item-name" />
                    <span className="chip">{formatBytes(sizeBefore)}</span>
                  </span>
                  <span className="card-head-actions">
                    <button type="button" className="link-btn" id="compress-change-file" onClick={() => void pickFile()} disabled={running}>
                      {t('Change file')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm converter-danger"
                      id="compress-remove-file"
                      onClick={clearFile}
                      disabled={running}
                      aria-label={t('Remove file')}
                      title={t('Remove file')}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
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
                    min={MIN_COMPRESS_QUALITY}
                    max={MAX_COMPRESS_QUALITY}
                    step={5}
                    value={quality}
                    disabled={running}
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
                    disabled={running}
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

              <SizeCompareCard sizeBefore={sizeBefore} result={result} />

              {/* Output filename */}
              <div className="card card--flush">
                <div className="card-body">
                  <div className="field">
                    <label htmlFor="compress-output-name">{t('Output Filename')}</label>
                    <div className="input-suffix-wrap">
                      <input
                        id="compress-output-name"
                        className="input"
                        type="text"
                        value={outputName}
                        disabled={running}
                        onChange={(e) => setOutputName(e.target.value)}
                        placeholder={`compressed_${stemOf(inputPath)}`}
                      />
                      <span className="input-suffix">.pdf</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Result — the file is already in the Downloads folder */}
              {result && (
                <div className="card status-card status-card--ok">
                  <CheckCircle size={22} aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>{result.keptOriginal ? t('Already as small as it gets') : t('Saved to your Downloads folder')}</b>
                    <small>
                      <Filename name={baseName(result.outputPath)} />
                      {result.keptOriginal
                        ? <> · {t('Nothing could be made smaller, so the file was saved unchanged.')}</>
                        : <> · {tn(result.imagesRecompressed, '{n} image re-encoded', '{n} images re-encoded')} · {t('saved')} {formatBytes(result.sizeBefore - result.sizeAfter)}</>}
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
              {running && (
                <div className="card status-card" role="status" aria-live="polite">
                  <Loader2 size={20} className="spin" aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>{progressTitle}</b>
                    {imagePercent !== null && (
                      <div className="size-bar size-bar--spaced">
                        <i style={{ width: `${imagePercent}%` }} />
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    id="compress-cancel-btn"
                    onClick={() => abortRef.current?.abort()}
                  >
                    {t('Cancel')}
                  </button>
                </div>
              )}

              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  id="compress-run-btn"
                  onClick={() => void handleCompress()}
                  disabled={running}
                >
                  {running ? (
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
