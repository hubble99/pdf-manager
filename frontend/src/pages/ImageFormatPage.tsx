import { useCallback, useEffect, useRef, useState } from 'react';
import { useLeaveGuard } from '../hooks/useLeaveGuard';
import {
  AlertTriangle,
  CheckCircle,
  FileImage,
  FolderOpen,
  ImageDown,
  Loader2,
  Plus,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { FEATURE_ICONS } from '../components/icons';
import {
  convertWebpImages,
  isCoreCancelled,
  revealPath,
  type ImageConvertReport,
  type ImageTargetFormat,
  NativeCoreError,
} from '../api/nativeCore';
import { Filename } from '../components/Filename';
import { PageHeader, RangeField, SegmentedControl } from '../components/ui';
import {
  DEFAULT_JPEG_QUALITY,
  baseName,
  convertErrorText,
  formatBytes,
  isJpegFormat,
  mergePaths,
} from '../features/image-format/helpers';
import { useToast } from '../hooks/useToast';
import { addHistoryEntry } from '../utils/historyStore';
import { chooseFolderDialog, isTauri } from '../utils/tauriDialog';
import { useNativePaths } from '../hooks/useNativePaths';
import { t, tn } from '../i18n';

const FORMAT_OPTIONS: { value: ImageTargetFormat; label: string }[] = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
  { value: 'jpeg', label: 'JPEG' },
];

const WEBP_FILTER = { name: 'WEBP', extensions: ['webp'] };

/**
 * WEBP to PNG, JPG or JPEG, run by the native Rust core.
 *
 * The page only handles paths: files are picked or dropped through Tauri, the
 * engine reads them from disk and writes the results into the output folder,
 * so no image bytes pass through the web view.
 */
export function ImageFormatPage() {
  const { showToast } = useToast();
  const desktop = isTauri();
  const [paths, setPaths] = useState<string[]>([]);
  useLeaveGuard(paths.length > 0);
  const [format, setFormat] = useState<ImageTargetFormat>('png');
  const [quality, setQuality] = useState(DEFAULT_JPEG_QUALITY);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<ImageConvertReport | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Default output folder: Downloads, where every other tool saves too.
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    import('@tauri-apps/api/path')
      .then(({ downloadDir }) => downloadDir())
      .then((dir) => { if (active) setOutputDir((current) => current ?? dir); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [desktop]);

  // Stop a running job when the user leaves the page.
  useEffect(() => () => abortRef.current?.abort(), []);

  const addPaths = useCallback((webp: string[], rejected: number) => {
    if (rejected > 0) {
      showToast({
        type: 'warning',
        title: t('Some files were skipped'),
        message: tn(rejected, '{n} file is not a .webp image.', '{n} files are not .webp images.'),
      });
    }
    if (webp.length === 0) return;
    setPaths((current) => mergePaths(current, webp).paths);
    setReport(null);
  }, [showToast]);

  const { isDragOver, pick: pickFiles } = useNativePaths({
    filter: WEBP_FILTER,
    multiple: true,
    pickerTitle: t('Choose WEBP images'),
    disabled: running,
    onPaths: addPaths,
  });

  const pickFolder = async () => {
    if (running) return;
    const dir = await chooseFolderDialog({ title: t('Choose the output folder') });
    if (dir) setOutputDir(dir);
  };

  const removePath = (path: string) => {
    if (running) return;
    setPaths((current) => current.filter((p) => p !== path));
    setReport(null);
  };

  const clearAll = () => {
    if (running) return;
    setPaths([]);
    setReport(null);
  };

  const handleConvert = async () => {
    if (running || paths.length === 0 || !outputDir) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setReport(null);
    setProgress({ done: 0, total: paths.length });
    try {
      const result = await convertWebpImages(
        paths,
        { format, quality, outputDir },
        {
          signal: controller.signal,
          onProgress: (p) => setProgress({ done: p.done, total: p.total ?? paths.length }),
        },
      );
      setReport(result);
      for (const file of result.files) {
        if (file.output) {
          addHistoryEntry({ filename: baseName(file.output), action: 'Converted WEBP', size: file.outputBytes ?? 0 });
        }
      }
      if (result.failed === 0) {
        showToast({
          type: 'success',
          title: t('Conversion complete'),
          message: tn(result.succeeded, '{n} image converted.', '{n} images converted.'),
        });
      } else {
        showToast({
          type: result.succeeded > 0 ? 'warning' : 'error',
          title: result.succeeded > 0 ? t('Some images were not converted') : t('Conversion failed'),
          message: t('{done} converted, {failed} failed.', { done: result.succeeded, failed: result.failed }),
        });
      }
    } catch (err) {
      if (isCoreCancelled(err)) {
        showToast({
          type: 'info',
          title: t('Conversion cancelled'),
          message: t('Images already converted stay in the output folder.'),
        });
      } else {
        const message = err instanceof NativeCoreError && err.code === 'not_found'
          ? t('The output folder no longer exists. Choose another folder.')
          : err instanceof Error ? err.message : t('Unknown error');
        showToast({ type: 'error', title: t('Conversion failed'), message });
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      setProgress(null);
    }
  };

  const openResultFolder = async () => {
    const target = report?.files.find((f) => f.output)?.output ?? outputDir;
    if (!target) return;
    try {
      await revealPath(target);
    } catch {
      showToast({ type: 'error', title: t('Cannot open the folder'), message: outputDir ?? '' });
    }
  };

  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const failedFiles = report?.files.filter((f) => f.error) ?? [];
  const animatedCount = report?.files.filter((f) => f.output && f.animated).length ?? 0;
  const canConvert = paths.length > 0 && Boolean(outputDir) && !running;

  return (
    <div className="feature-page">
      <PageHeader
        icon={FEATURE_ICONS['image-format']}
        title={t('WEBP to PNG/JPG')}
        description={t('Convert WEBP images to PNG, JPG, or JPEG, one or many at once')}
      />

      <div className="page-body">
        <div className={`form-col${paths.length > 0 ? '' : ' form-col--center'}`}>
          {!desktop ? (
            <p className="empty-hint" role="status">{t('This tool is available in the desktop app.')}</p>
          ) : paths.length === 0 ? (
            <>
              <div
                id="image-format-drop-zone"
                className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
                onClick={pickFiles}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && pickFiles()}
                aria-label={t('Drop WEBP images here or click to browse')}
              >
                <Upload className="drop-zone-icon" />
                <p className="drop-zone-title">{t('Drop WEBP images here')}</p>
                <p className="drop-zone-sub">{t('or click to browse · Several files at once')}</p>
                <span className="badge badge-neutral">WEBP</span>
              </div>
              <p className="empty-hint">{t('Converted copies are saved to a folder you choose. The originals are not changed.')}</p>
            </>
          ) : (
            <>
              {/* Files */}
              <div className={`card card--flush${isDragOver ? ' drag-over' : ''}`}>
                <div className="card-head">
                  <span className="card-head-title">
                    <FileImage size={16} className="card-head-icon" aria-hidden="true" />
                    {tn(paths.length, '{n} image', '{n} images')}
                  </span>
                  <span className="card-head-actions">
                    <button type="button" className="btn btn-ghost btn-sm" id="image-format-add-btn" onClick={pickFiles} disabled={running}>
                      <Plus size={14} aria-hidden="true" /> {t('Add images')}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" id="image-format-clear-btn" onClick={clearAll} disabled={running} title={t('Remove all')}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </span>
                </div>
                <ul className="image-format-list">
                  {paths.map((path) => (
                    <li key={path} className="image-format-row">
                      <Filename name={baseName(path)} className="file-item-name" />
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm"
                        onClick={() => removePath(path)}
                        disabled={running}
                        aria-label={t('Remove {name}', { name: baseName(path) })}
                        title={t('Remove')}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Format and quality */}
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <SlidersHorizontal size={16} className="card-head-icon" aria-hidden="true" />
                    {t('Convert to')}
                  </span>
                </div>
                <div className="card-body">
                  <SegmentedControl
                    equal
                    idPrefix="image-format-target"
                    ariaLabel={t('Output format')}
                    options={FORMAT_OPTIONS}
                    value={format}
                    disabled={running}
                    onChange={setFormat}
                  />
                  <small className="hint">
                    {isJpegFormat(format)
                      ? t('JPG and JPEG are the same format with a different extension. Transparent areas become white.')
                      : t('PNG keeps transparency and loses no quality. Files are usually larger.')}
                  </small>
                  {isJpegFormat(format) && (
                    <div className="field">
                      <label htmlFor="image-format-quality">{t('Quality')}: <b>{quality}</b></label>
                      <RangeField
                        id="image-format-quality"
                        min={50}
                        max={100}
                        step={5}
                        value={quality}
                        disabled={running}
                        valueText={String(quality)}
                        onChange={setQuality}
                        scale={(
                          <>
                            <span>{t('Smaller file')}</span>
                            <b>{quality}</b>
                            <span>{t('Better quality')}</span>
                          </>
                        )}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Output folder */}
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <FolderOpen size={16} className="card-head-icon" aria-hidden="true" />
                    {t('Output folder')}
                  </span>
                  <span className="card-head-actions">
                    <button type="button" className="btn btn-ghost btn-sm" id="image-format-folder-btn" onClick={pickFolder} disabled={running}>
                      {t('Change')}
                    </button>
                  </span>
                </div>
                <div className="card-body">
                  <Filename name={outputDir ?? t('Choose a folder')} className="file-item-meta" />
                  <small className="hint">{t('Existing files are never overwritten; a number is added to the new name instead.')}</small>
                </div>
              </div>

              {/* Progress */}
              {running && progress && (
                <div className="card status-card" role="status" aria-live="polite">
                  <Loader2 size={20} className="spin" aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>{t('Converting…')} {percent}%</b>
                    <small>{t('{done} of {total} images', { done: progress.done, total: progress.total })}</small>
                    <div className="size-bar size-bar--spaced"><i style={{ width: `${percent}%` }} /></div>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" id="image-format-cancel-btn" onClick={() => abortRef.current?.abort()}>
                    {t('Cancel')}
                  </button>
                </div>
              )}

              {/* Result */}
              {report && report.succeeded > 0 && (
                <div className="card status-card status-card--ok">
                  <CheckCircle size={22} aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>{tn(report.succeeded, '{n} image converted', '{n} images converted')}</b>
                    <small>
                      <Filename name={outputDir ?? ''} />
                      {animatedCount > 0 && <> · {tn(animatedCount, '{n} animated image kept only its first frame', '{n} animated images kept only their first frame')}</>}
                    </small>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" id="image-format-open-folder-btn" onClick={openResultFolder}>
                    <FolderOpen size={14} aria-hidden="true" /> {t('Open Folder')}
                  </button>
                </div>
              )}
              {failedFiles.length > 0 && (
                <div className="card card--flush" role="alert">
                  <div className="card-head">
                    <span className="card-head-title">
                      <AlertTriangle size={16} className="card-head-icon image-format-warn" aria-hidden="true" />
                      {tn(failedFiles.length, '{n} image was not converted', '{n} images were not converted')}
                    </span>
                  </div>
                  <ul className="image-format-list">
                    {failedFiles.map((file) => (
                      <li key={file.source} className="image-format-row image-format-row--failed">
                        <Filename name={baseName(file.source)} className="file-item-name" />
                        <small className="file-item-meta" title={file.error?.message}>{convertErrorText(file.error?.code)}</small>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="form-actions">
                <button className="btn btn-primary" id="image-format-run-btn" onClick={handleConvert} disabled={!canConvert}>
                  {running ? (
                    <><Loader2 size={15} className="spin" /> {t('Converting…')}</>
                  ) : (
                    <><ImageDown size={15} /> {tn(paths.length, 'Convert {n} image', 'Convert {n} images')}</>
                  )}
                </button>
              </div>
              {report && report.files.some((f) => f.outputBytes) && (
                <p className="empty-hint">
                  {t('Total size: {size}', { size: formatBytes(report.files.reduce((sum, f) => sum + (f.outputBytes ?? 0), 0)) })}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
