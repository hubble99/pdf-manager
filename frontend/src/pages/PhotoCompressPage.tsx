import { useCallback, useEffect, useRef, useState } from 'react';
import { useLeaveGuard } from '../hooks/useLeaveGuard';
import {
  AlertTriangle,
  CheckCircle,
  FileImage,
  FolderOpen,
  ImageMinus,
  Loader2,
  Plus,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { FEATURE_ICONS } from '../components/icons';
import {
  compressPhotos,
  fileSizes,
  isCoreCancelled,
  revealPath,
  type PhotoCompressReport,
  type PhotoOutputFormat,
  NativeCoreError,
} from '../api/nativeCore';
import { Filename } from '../components/Filename';
import { PageHeader, RangeField, SegmentedControl, SizeCompareCard } from '../components/ui';
import { baseName, formatBytes, mergePaths } from '../features/image-format/helpers';
import {
  DEFAULT_LEVEL,
  LEVELS,
  MAX_SIDE_CHOICES,
  compressErrorText,
  savedPercent,
  type CompressLevel,
} from '../features/photo-compress/helpers';
import { useToast } from '../hooks/useToast';
import { addHistoryEntry } from '../utils/historyStore';
import { isTauri } from '../utils/tauriDialog';
import { useNativePaths } from '../hooks/useNativePaths';
import { t, tn } from '../i18n';

const PHOTO_FILTER = { name: 'JPEG, PNG', extensions: ['jpg', 'jpeg', 'jfif', 'png'] };

/**
 * Compress JPEG and PNG photos, run by the native Rust core.
 *
 * The page only handles paths: photos are picked or dropped through Tauri, the
 * engine reads them from disk and writes the results into the output folder,
 * so no image bytes pass through the web view and memory use does not depend
 * on how large the photos are.
 */
export function PhotoCompressPage() {
  const { showToast } = useToast();
  const desktop = isTauri();
  const [paths, setPaths] = useState<string[]>([]);
  useLeaveGuard(paths.length > 0);
  const [level, setLevel] = useState<CompressLevel>(DEFAULT_LEVEL);
  const [quality, setQuality] = useState(LEVELS[DEFAULT_LEVEL].quality);
  const [maxSide, setMaxSide] = useState<number | null>(LEVELS[DEFAULT_LEVEL].maxSide);
  const [format, setFormat] = useState<PhotoOutputFormat>('keep');
  // Results always go to Downloads, like the other tools; there is no folder choice.
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<PhotoCompressReport | null>(null);
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

  // Sizes of the picked photos, so the "Before" size shows before compressing.
  useEffect(() => {
    if (!desktop) return;
    const missing = paths.filter((path) => !(path in sizes));
    if (missing.length === 0) return;
    let active = true;
    fileSizes(missing)
      .then((found) => {
        if (!active) return;
        setSizes((current) => {
          const next = { ...current };
          missing.forEach((path, i) => { next[path] = found[i] ?? 0; });
          return next;
        });
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [desktop, paths, sizes]);

  // Stop a running job when the user leaves the page.
  useEffect(() => () => abortRef.current?.abort(), []);

  const addPaths = useCallback((photos: string[], rejected: number) => {
    if (rejected > 0) {
      showToast({
        type: 'warning',
        title: t('Some files were skipped'),
        message: tn(rejected, '{n} file is not a JPEG or PNG photo.', '{n} files are not JPEG or PNG photos.'),
      });
    }
    if (photos.length === 0) return;
    setPaths((current) => mergePaths(current, photos).paths);
    setReport(null);
  }, [showToast]);

  const { isDragOver, pick: pickFiles } = useNativePaths({
    filter: PHOTO_FILTER,
    multiple: true,
    pickerTitle: t('Choose photos'),
    disabled: running,
    onPaths: addPaths,
  });

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

  const chooseLevel = (next: CompressLevel) => {
    setLevel(next);
    if (next !== 'custom') {
      setQuality(LEVELS[next].quality);
      setMaxSide(LEVELS[next].maxSide);
    }
  };

  const handleCompress = async () => {
    if (running || paths.length === 0 || !outputDir) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setReport(null);
    setProgress({ done: 0, total: paths.length });
    try {
      const result = await compressPhotos(
        paths,
        { quality, maxSide, format, outputDir },
        {
          signal: controller.signal,
          onProgress: (p) => setProgress({ done: p.done, total: p.total ?? paths.length }),
        },
      );
      setReport(result);
      for (const file of result.files) {
        if (file.output) {
          addHistoryEntry({ filename: baseName(file.output), action: 'Compressed photo', size: file.outputBytes ?? 0 });
        }
      }
    } catch (err) {
      if (isCoreCancelled(err)) {
        showToast({
          type: 'info',
          title: t('Compression cancelled'),
          message: t('Photos already compressed stay in the output folder.'),
        });
      } else {
        const message = err instanceof NativeCoreError && err.code === 'not_found'
          ? t('The output folder no longer exists. Choose another folder.')
          : err instanceof Error ? err.message : t('Unknown error');
        showToast({ type: 'error', title: t('Compression failed'), message });
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
  const progressTitle = progress && progress.done > 0
    ? t('Compressing… {pct}%', { pct: percent })
    : t('Compressing…');
  const doneFiles = report?.files.filter((f) => f.output) ?? [];
  const failedFiles = report?.files.filter((f) => f.error) ?? [];
  const saved = report ? savedPercent(report.originalBytes, report.outputBytes) : 0;
  const sizeBefore = report ? report.originalBytes : paths.reduce((sum, path) => sum + (sizes[path] ?? 0), 0);
  const canCompress = paths.length > 0 && Boolean(outputDir) && !running;

  const levelOptions: { value: CompressLevel; label: string; title?: string }[] = [
    { value: 'light', label: t('Light'), title: t('Small loss of quality, original size') },
    { value: 'balanced', label: t('Balanced'), title: t('Good for sharing, up to 2560 px') },
    { value: 'strong', label: t('Strong'), title: t('Smallest files, up to 1600 px') },
    { value: 'custom', label: t('Custom') },
  ];
  const formatOptions: { value: PhotoOutputFormat; label: string }[] = [
    { value: 'keep', label: t('Keep format') },
    { value: 'jpeg', label: t('Convert all to JPG') },
  ];

  return (
    <div className="feature-page">
      <PageHeader
        icon={FEATURE_ICONS['photo-compress']}
        title={t('Compress Photos')}
        description={t('Make JPEG and PNG photos smaller, one or many at once')}
      />

      <div className="page-body">
        <div className={`form-col${paths.length > 0 ? ' form-col--balanced' : ' form-col--center'}`}>
          {!desktop ? (
            <p className="empty-hint" role="status">{t('This tool is available in the desktop app.')}</p>
          ) : paths.length === 0 ? (
            <>
              <div
                id="photo-compress-drop-zone"
                className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
                onClick={pickFiles}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && pickFiles()}
                aria-label={t('Drop photos here or click to browse')}
              >
                <Upload className="drop-zone-icon" />
                <p className="drop-zone-title">{t('Drop photos here')}</p>
                <p className="drop-zone-sub">{t('or click to browse · Several files at once')}</p>
                <div className="badge-row badge-row--center">
                  <span className="badge badge-neutral">JPG</span>
                  <span className="badge badge-neutral">PNG</span>
                </div>
              </div>
              <p className="empty-hint">{t('Compressed copies are saved to your Downloads folder. The originals are not changed.')}</p>
            </>
          ) : (
            <>
              <div className="col-stack">
              {/* Files */}
              <div className={`card card--flush photo-files-card${isDragOver ? ' drag-over' : ''}`}>
                <div className="card-head">
                  <span className="card-head-title">
                    <FileImage size={16} className="card-head-icon" aria-hidden="true" />
                    {tn(paths.length, '{n} photo', '{n} photos')}
                  </span>
                  <span className="card-head-actions">
                    <button type="button" className="btn btn-ghost btn-sm" id="photo-compress-add-btn" onClick={pickFiles} disabled={running}>
                      <Plus size={14} aria-hidden="true" /> {t('Add photos')}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" id="photo-compress-clear-btn" onClick={clearAll} disabled={running} title={t('Remove all')}>
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

              </div>

              <div className="col-stack">
              {/* Level, size and format */}
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <SlidersHorizontal size={16} className="card-head-icon" aria-hidden="true" />
                    {t('Compression level')}
                  </span>
                </div>
                <div className="card-body">
                  <SegmentedControl
                    equal
                    idPrefix="photo-compress-level"
                    ariaLabel={t('Compression level')}
                    options={levelOptions}
                    value={level}
                    disabled={running}
                    onChange={chooseLevel}
                  />
                  <small className="hint">
                    {t('JPEG quality {quality}', { quality })}
                    {' · '}
                    {maxSide ? t('longest side up to {px} px', { px: maxSide }) : t('original size')}
                  </small>
                  {level === 'custom' && (
                    <>
                      <div className="field">
                        <label htmlFor="photo-compress-quality">{t('Quality')}: <b>{quality}</b></label>
                        <RangeField
                          id="photo-compress-quality"
                          min={30}
                          max={95}
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
                      <div className="field">
                        <label htmlFor="photo-compress-max-side">{t('Longest side')}</label>
                        <select
                          id="photo-compress-max-side"
                          className="input"
                          value={maxSide ?? ''}
                          disabled={running}
                          onChange={(event) => setMaxSide(event.target.value ? Number(event.target.value) : null)}
                        >
                          <option value="">{t('Keep the original size')}</option>
                          {MAX_SIDE_CHOICES.map((px) => (
                            <option key={px} value={px}>{t('Up to {px} px', { px })}</option>
                          ))}
                        </select>
                        <small className="hint">{t('Smaller photos are never enlarged.')}</small>
                      </div>
                    </>
                  )}
                  <div className="field">
                    <label id="photo-compress-format-label">{t('Output format')}</label>
                    <SegmentedControl
                      equal
                      idPrefix="photo-compress-format"
                      ariaLabelledBy="photo-compress-format-label"
                      options={formatOptions}
                      value={format}
                      disabled={running}
                      onChange={setFormat}
                    />
                    <small className="hint">
                      {format === 'keep'
                        ? t('PNG stays lossless, so it shrinks less than JPEG. Photos that cannot get smaller are copied as they are.')
                        : t('Photos shrink most as JPG. Transparent areas of PNG files become white.')}
                    </small>
                  </div>
                </div>
              </div>

              <SizeCompareCard
                sizeBefore={sizeBefore}
                result={report && report.succeeded > 0 ? { sizeAfter: report.outputBytes, reductionPct: saved } : null}
              />

              {/* Progress */}
              {running && progress && (
                <div className="card status-card" role="status" aria-live="polite">
                  <Loader2 size={20} className="spin" aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>{progressTitle}</b>
                    <small>{t('{done} of {total} photos', { done: progress.done, total: progress.total })}</small>
                    <div className={`size-bar size-bar--spaced${progress.done === 0 ? ' size-bar--busy' : ''}`}>
                      <i style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" id="photo-compress-cancel-btn" onClick={() => abortRef.current?.abort()}>
                    {t('Cancel')}
                  </button>
                </div>
              )}

              <div className="form-actions">
                <button className="btn btn-primary" id="photo-compress-run-btn" onClick={handleCompress} disabled={!canCompress}>
                  {running ? (
                    <><Loader2 size={15} className="spin" /> {t('Compressing…')}</>
                  ) : (
                    <><ImageMinus size={15} /> {tn(paths.length, 'Compress {n} photo', 'Compress {n} photos')}</>
                  )}
                </button>
              </div>
              </div>

              {/* Result */}
              {report && report.succeeded > 0 && (
                <div className="card card--flush result-wide">
                  <div className="card-head card-head--success">
                    <span className="card-head-title">
                      <CheckCircle size={16} className="card-head-icon" aria-hidden="true" />
                      {tn(report.succeeded, '{n} photo compressed', '{n} photos compressed')}
                    </span>
                    <span className="card-head-actions">
                      <button type="button" className="btn btn-ghost btn-sm" id="photo-compress-open-folder-btn" onClick={openResultFolder}>
                        <FolderOpen size={14} aria-hidden="true" /> {t('Open Folder')}
                      </button>
                    </span>
                  </div>
                  <p className="card-body photo-compress-total">
                    <small className="hint">{t('Saved to your Downloads folder')}</small>
                  </p>
                  <ul className="image-format-list">
                    {doneFiles.map((file) => (
                      <li key={file.source} className="image-format-row">
                        <Filename name={baseName(file.output ?? file.source)} className="file-item-name" />
                        <small className="file-item-meta photo-compress-size">
                          {file.keptOriginal
                            ? t('Already as small as possible')
                            : `${formatBytes(file.originalBytes ?? 0)} → ${formatBytes(file.outputBytes ?? 0)}`}
                        </small>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {failedFiles.length > 0 && (
                <div className="card card--flush result-wide" role="alert">
                  <div className="card-head">
                    <span className="card-head-title">
                      <AlertTriangle size={16} className="card-head-icon image-format-warn" aria-hidden="true" />
                      {tn(failedFiles.length, '{n} photo was not compressed', '{n} photos were not compressed')}
                    </span>
                  </div>
                  <ul className="image-format-list">
                    {failedFiles.map((file) => (
                      <li key={file.source} className="image-format-row image-format-row--failed">
                        <Filename name={baseName(file.source)} className="file-item-name" />
                        <small className="file-item-meta" title={file.error?.message}>{compressErrorText(file.error?.code)}</small>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
