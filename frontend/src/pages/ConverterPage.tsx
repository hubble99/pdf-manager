import { useRef, useState } from 'react';
import {
  CheckCircle,
  FileImage,
  FileText,
  FolderOpen,
  Images,
  Info,
  Loader2,
  RotateCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { Filename } from '../components/Filename';
import { PageThumbGrid } from '../components/preview';
import { SortableCardGrid } from '../components/sortable/SortableCardGrid';
import { PageHeader, RadioCardGroup, SegmentedControl, Tabs } from '../components/ui';
import { useConverterWorkflow } from '../features/converter/useConverterWorkflow';
import { ConverterThumbnail } from '../features/converter/ConverterThumbnail';
import { DPI_OPTIONS, FORMAT_OPTIONS, PAGE_SIZE_OPTIONS, formatBytes } from '../features/converter/options';
import { IMAGE_EXTENSIONS, baseName } from '../features/converter/batch';
import { useNativePaths } from '../hooks/useNativePaths';
import { revealPath } from '../api/nativeCore';
import { t, tn } from '../i18n';

function FlipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20v-16M8 4L4 12l4 8M16 4l4 8-4 8" />
    </svg>
  );
}

type ConverterTab = 'pdf' | 'images';

const PDF_FILTER = { name: 'PDF', extensions: ['pdf'] };
const IMAGE_FILTER = { name: 'Images', extensions: IMAGE_EXTENSIONS };

const TAB_COPY: Record<ConverterTab, { label: string; description: string }> = {
  pdf: {
    label: t('PDF to Images'),
    description: t('Export the pages you choose from one PDF as images'),
  },
  images: {
    label: t('Images to PDF'),
    description: t('Combine one or more images into a single PDF document'),
  },
};

export function ConverterPage() {
  const converter = useConverterWorkflow();
  const {
    kind, pdfPath, images, imageSizes, batchError, error, skippedNotice, result, isConverting, progress,
    pdfInfoState, selection, selectionMode, selectionDraft, pdfBlockReason,
    format, dpi, pdfOutputName, pageSize, imageOutputName,
  } = converter;

  // The tab chooses the direction while nothing is loaded; loaded files decide it after that.
  const [chosenTab, setChosenTab] = useState<ConverterTab>('pdf');
  const activeTab: ConverterTab = kind === 'empty' ? chosenTab : kind;

  const replaceIntentRef = useRef(false);

  // Each tab takes its own kind of file: the system dialog and window drops are
  // routed to the hook of the active tab only.
  const handlePaths = (tab: ConverterTab) => (accepted: string[], rejected: number) => {
    if (accepted.length === 0) {
      if (rejected > 0) {
        converter.reportBatchError(tab === 'pdf'
          ? t('This tab takes one PDF. To combine images into a PDF, use the Images to PDF tab.')
          : t('This tab takes images. To export PDF pages as images, use the PDF to Images tab.'));
      }
      return;
    }
    if (rejected > 0) {
      // A drop is taken whole or not at all.
      replaceIntentRef.current = false;
      converter.reportBatchError(t('PDFs and images cannot share a batch. Choose one PDF or only images.'));
      return;
    }
    if (replaceIntentRef.current) {
      replaceIntentRef.current = false;
      converter.replacePaths(accepted);
    } else {
      converter.addPaths(accepted, tab);
    }
  };
  const pdfPicker = useNativePaths({
    filter: PDF_FILTER,
    multiple: true,
    pickerTitle: t('Choose a PDF'),
    disabled: isConverting || activeTab !== 'pdf',
    onPaths: handlePaths('pdf'),
  });
  const imagePicker = useNativePaths({
    filter: IMAGE_FILTER,
    multiple: true,
    pickerTitle: t('Choose images'),
    disabled: isConverting || activeTab !== 'images',
    onPaths: handlePaths('images'),
  });
  const { desktop } = pdfPicker;
  const picker = activeTab === 'pdf' ? pdfPicker : imagePicker;

  const openPicker = (intent: 'add' | 'replace' = 'add') => {
    if (isConverting) return;
    replaceIntentRef.current = intent === 'replace';
    void picker.pick();
  };

  const selectionEditable = selectionMode === 'selected' && pdfInfoState === 'ready' && !isConverting;
  const selectionInvalid = selectionMode === 'selected' && !selection.valid;
  const showSelectionError = selectionInvalid && Boolean(selection.error);
  const canConvertPdf = kind === 'pdf' && pdfInfoState === 'ready' && selection.valid && selection.pages.size > 0 && !isConverting;
  const canConvertImages = kind === 'images' && images.length > 0 && !isConverting;
  const canConvert = kind === 'pdf' ? canConvertPdf : canConvertImages;
  const totalPages = converter.pdfInfo?.pages ?? 0;
  const formatOption = FORMAT_OPTIONS.find((option) => option.value === format);
  const dpiOption = DPI_OPTIONS.find((option) => option.value === dpi);

  const dropProps = {
    role: 'button' as const,
    tabIndex: 0,
    onClick: () => openPicker(),
    onKeyDown: (event: React.KeyboardEvent) => event.key === 'Enter' && openPicker(),
  };

  const percent = progress?.total ? Math.round((progress.done / progress.total) * 100) : null;
  const progressTitle = kind === 'pdf'
    ? (progress?.total
      ? t('Exporting page {done} of {total}…', { done: Math.min(progress.done + 1, progress.total), total: progress.total })
      : t('Reading the PDF…'))
    : (progress?.total
      ? t('Adding image {done} of {total}…', { done: Math.min(progress.done + 1, progress.total), total: progress.total })
      : t('Preparing the images…'));

  const outcome = (
    <>
      {batchError && (
        <p className="converter-message converter-message--error" role="alert">{batchError}</p>
      )}

      {error && (
        <div className="converter-message converter-message--error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={converter.dismissError}>
            {t('Dismiss')}
          </button>
        </div>
      )}

      {skippedNotice && (
        <p className="converter-message converter-message--error" role="status">{skippedNotice}</p>
      )}

      {isConverting && (
        <div className="card status-card" role="status" aria-live="polite">
          <Loader2 size={20} className="converter-spin" aria-hidden="true" />
          <div className="status-card-copy">
            <b>{progressTitle}</b>
            <div className={`size-bar size-bar--spaced${percent === null || progress?.done === 0 ? ' size-bar--busy' : ''}`}>
              <i style={{ width: `${percent ?? 0}%` }} />
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" id="converter-cancel" onClick={converter.cancel}>
            {t('Cancel')}
          </button>
        </div>
      )}

      {result && (
        <div className="card status-card status-card--ok">
          <CheckCircle size={22} aria-hidden="true" />
          <div className="status-card-copy">
            <b>{t('Saved to your Downloads folder')}</b>
            <small><Filename name={result.filename} /> · {result.detail}</small>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            id="converter-open-folder"
            onClick={() => { void revealPath(result.outputPath).catch(() => undefined); }}
            title={t('Show in folder')}
          >
            <FolderOpen size={14} aria-hidden="true" />
            {t('Show in folder')}
          </button>
        </div>
      )}
    </>
  );

  const actions = kind !== 'empty' && (
    <div className="form-actions">
      <button
        type="button"
        className="btn btn-secondary"
        id="converter-clear"
        onClick={converter.clear}
        disabled={isConverting}
      >
        {kind === 'images' ? <Trash2 size={15} aria-hidden="true" /> : null}
        {kind === 'images' ? t('Clear All') : t('Clear')}
      </button>
      <button
        type="button"
        className="btn btn-primary"
        id="converter-run"
        onClick={converter.convert}
        disabled={!canConvert}
        title={canConvert ? undefined : pdfBlockReason ?? t('Add files to convert')}
      >
        {isConverting ? (
          <>
            <Loader2 size={15} className="converter-spin" aria-hidden="true" />
            {kind === 'pdf' ? t('Exporting…') : t('Converting…')}
          </>
        ) : (
          <>
            <FileImage size={15} aria-hidden="true" />
            {kind === 'pdf' ? t('Export Images') : t('Create PDF')}
          </>
        )}
      </button>
    </div>
  );

  return (
    <div className="feature-page">
      <PageHeader
        icon={FileImage}
        title={t('PDF & Image')}
        description={TAB_COPY[activeTab].description}
      />

      <Tabs
        ariaLabel={t('Conversion direction')}
        value={activeTab}
        onChange={(tab) => { converter.dismissBatchError(); setChosenTab(tab); }}
        items={(['pdf', 'images'] as const).map((tab) => {
          const locked = kind !== 'empty' && kind !== tab;
          return {
            value: tab,
            id: `converter-tab-${tab}`,
            label: TAB_COPY[tab].label,
            disabled: locked || isConverting,
            title: locked ? t('Clear the current files to switch direction') : undefined,
          };
        })}
      />

      <div className="page-body">
        {!desktop && (
          <div className="card status-card" role="note">
            <Info size={20} aria-hidden="true" />
            <div className="status-card-copy">
              <b>{t('PDF & Image runs in the Dokuwu desktop app')}</b>
              <small>{t('It works on the files directly on your computer, which the browser preview cannot do.')}</small>
            </div>
          </div>
        )}

        {/* ── Nothing added yet: each tab has its own uploader ──────────────── */}
        {desktop && kind === 'empty' && (
          <div className="form-col form-col--center">
            <div
              id="converter-drop-zone"
              className={`drop-zone${picker.isDragOver ? ' drag-over' : ''}`}
              aria-label={activeTab === 'pdf'
                ? t('Drop a PDF here, or press Enter to browse')
                : t('Drop images here, or press Enter to browse')}
              {...dropProps}
            >
              <Upload className="drop-zone-icon" aria-hidden="true" />
              {activeTab === 'pdf' ? (
                <>
                  <p className="drop-zone-title">{t('Drop a PDF here')}</p>
                  <p className="drop-zone-sub">{t('or click to browse · One file at a time')}</p>
                  <span className="badge badge-neutral">PDF</span>
                </>
              ) : (
                <>
                  <p className="drop-zone-title">{t('Drop images here')}</p>
                  <p className="drop-zone-sub">{t('or click to browse · Multiple files supported')}</p>
                  <div className="converter-badges">
                    <span className="badge badge-neutral">PNG</span>
                    <span className="badge badge-neutral">JPG</span>
                    <span className="badge badge-neutral">WebP</span>
                  </div>
                </>
              )}
            </div>
            {batchError && (
              <p className="converter-message converter-message--error" role="alert">{batchError}</p>
            )}
            <p className="empty-hint">
              {activeTab === 'pdf'
                ? t('Every page will appear here so you can choose which ones to convert.')
                : t('Add images, put them in order, and save them as one PDF.')}
            </p>
          </div>
        )}

        {/* ── One PDF: pick pages, set the output ───────────────────────────── */}
        {desktop && kind === 'pdf' && pdfPath && (
          <div className="form-col form-col--split">
            <div className="card card--flush">
              <div className="card-head">
                <span className="card-head-title">
                  <FileText size={16} className="card-head-icon" aria-hidden="true" />
                  <Filename name={baseName(pdfPath)} className="file-item-name" />
                  {converter.pdfInfo && <span className="chip">{formatBytes(converter.pdfInfo.sizeBytes)}</span>}
                  {pdfInfoState === 'loading' && (
                    <Loader2 size={12} className="converter-spin" aria-hidden="true" />
                  )}
                  {pdfInfoState === 'ready' && (
                    <span className="chip">{t('Total:')} {totalPages} {t('pages')}</span>
                  )}
                  {pdfInfoState === 'error' && <span className="badge badge-error">{t('Page count unavailable')}</span>}
                  {pdfInfoState === 'protected' && <span className="badge badge-error">{t('Password protected')}</span>}
                </span>
                <span className="card-head-actions">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => openPicker('replace')}
                    disabled={isConverting}
                    id="converter-replace-file"
                  >
                    {t('Replace')}
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={converter.clear}
                    disabled={isConverting}
                    aria-label={t('Remove PDF')}
                    id="converter-remove-file"
                  >
                    {t('Remove')}
                  </button>
                </span>
              </div>
              {pdfInfoState === 'ready' && totalPages > 0 ? (
                <PageThumbGrid
                  file={pdfPath}
                  totalPages={totalPages}
                  selected={selection.pages}
                  interactive={selectionEditable}
                  onToggle={converter.togglePageSelection}
                />
              ) : (
                <p className="empty-hint">
                  {pdfInfoState === 'loading' ? t('Reading the document…') : t('Pages are unavailable for this file.')}
                </p>
              )}
            </div>

            <div className="col-stack">
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title" id="converter-pages-label">{t('Pages')}</span>
                  <span className="card-head-actions">
                    {pdfInfoState === 'ready' && <span>{selection.pages.size} {t('of')} {totalPages} {t('selected')}</span>}
                  </span>
                </div>
                <div role="radiogroup" aria-labelledby="converter-pages-label">
                  {(['all', 'selected'] as const).map((mode) => (
                    <label
                      key={mode}
                      htmlFor={`converter-pages-${mode}`}
                      className={`mode-row${selectionMode === mode ? ' active' : ''}`}
                    >
                      <input
                        id={`converter-pages-${mode}`}
                        type="radio"
                        name="converter-page-mode"
                        value={mode}
                        checked={selectionMode === mode}
                        onChange={() => converter.setSelectionMode(mode)}
                        disabled={pdfInfoState !== 'ready' || isConverting}
                      />
                      <span className="radio-copy">
                        <span className="radio-title">{mode === 'all' ? t('All pages') : t('Selected pages')}</span>
                        <span className="radio-desc">
                          {mode === 'all' ? t('Export every page') : t('Choose pages or ranges')}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="card-body">
                  <div className="field">
                    <label htmlFor="converter-page-ranges">{t('Selected pages')}</label>
                    <input
                      id="converter-page-ranges"
                      className="input"
                      type="text"
                      value={selectionDraft}
                      onChange={(event) => converter.setSelectionDraft(event.target.value)}
                      placeholder="e.g. 2, 4-7"
                      disabled={!selectionEditable}
                      aria-invalid={showSelectionError || undefined}
                      aria-describedby="converter-page-help"
                      inputMode="text"
                      autoComplete="off"
                    />
                    <small
                      id="converter-page-help"
                      className={showSelectionError ? 'error' : undefined}
                      role={showSelectionError ? 'alert' : undefined}
                    >
                      {showSelectionError
                        ? selection.error
                        : selectionMode === 'all'
                          ? t('All {total} pages will be exported.', { total: totalPages })
                          : t('Selected: {count} of {total} pages', { count: selection.pages.size, total: totalPages })}
                    </small>
                  </div>
                </div>
              </div>

              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <Images size={16} className="card-head-icon" aria-hidden="true" />
                    {t('Output settings')}
                  </span>
                </div>
                <div className="card-body">
                  <div className="setting-row">
                    <span className="setting-label" id="converter-format-label">{t('Format')}</span>
                    <SegmentedControl
                      ariaLabelledBy="converter-format-label"
                      idPrefix="converter-format"
                      options={FORMAT_OPTIONS}
                      value={format}
                      disabled={isConverting}
                      onChange={converter.setFormat}
                    />
                  </div>
                  <div className="setting-row">
                    <span className="setting-label" id="converter-dpi-label">{t('Resolution')}</span>
                    <SegmentedControl
                      ariaLabelledBy="converter-dpi-label"
                      idPrefix="converter-dpi"
                      options={DPI_OPTIONS.map((option) => ({ value: option.value, label: option.value }))}
                      value={dpi}
                      disabled={isConverting}
                      onChange={converter.setDpi}
                    />
                    <span className="setting-unit">DPI</span>
                  </div>
                  <small className="hint">
                    {dpiOption?.desc}. {formatOption?.desc}.
                  </small>
                </div>
              </div>

              <div className="card card--flush">
                <div className="card-body">
                  <div className="field">
                    <label htmlFor="converter-pdf-output">{t('Output Filename')}</label>
                    <input
                      id="converter-pdf-output"
                      className="input"
                      type="text"
                      value={pdfOutputName}
                      onChange={(event) => converter.setPdfOutputName(event.target.value)}
                      placeholder="export"
                      disabled={isConverting}
                    />
                    <small>{t('The .png, .jpg or .zip extension is added automatically.')}</small>
                  </div>
                </div>
              </div>

              {outcome}
              {actions}
            </div>
          </div>
        )}

        {/* ── Images: previews on the left, page size and output on the right ── */}
        {desktop && kind === 'images' && (
          <div className="form-col form-col--split">
            <div className="card card--flush">
              <div className="card-head">
                <span className="card-head-title">
                  <Images size={16} className="card-head-icon" aria-hidden="true" />
                  <span id="converter-images-label">{t('Images to Convert')}</span>
                  <span className="chip">
                    {tn(images.length, '{n} file', '{n} files')}
                  </span>
                </span>
                <span className="card-head-actions">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => openPicker('add')}
                    disabled={isConverting}
                    id="converter-add-images"
                  >
                    {t('Add images')}
                  </button>
                </span>
              </div>
              <div className={`converter-image-drop${imagePicker.isDragOver ? ' drag-over' : ''}`}>
                <SortableCardGrid
                  idPrefix="converter"
                  ariaLabel={t('Images to Convert')}
                  disabled={isConverting}
                  onReorder={converter.reorderImages}
                  onRemove={converter.removeImage}
                  cards={images.map((entry) => ({
                    id: entry.id,
                    title: baseName(entry.path),
                    thumbnail: (
                      <ConverterThumbnail path={entry.path} rotation={entry.rotation} flipH={entry.flipH} />
                    ),
                    meta: imageSizes[entry.id] != null ? <span>{formatBytes(imageSizes[entry.id] as number)}</span> : undefined,
                    actions: (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => converter.rotateImage(entry.id)}
                          disabled={isConverting}
                          aria-label={t('Rotate {name} 90 degrees', { name: baseName(entry.path) })}
                          title={t('Rotate 90°')}
                        >
                          <RotateCw size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => converter.flipImage(entry.id)}
                          disabled={isConverting}
                          aria-label={t('Mirror {name} horizontally', { name: baseName(entry.path) })}
                          title={t('Mirror horizontally')}
                        >
                          <FlipIcon />
                        </button>
                      </>
                    ),
                  }))}
                />
              </div>
            </div>

            <div className="col-stack">
            <div className="card card--flush">
              <div className="card-head">
                <span className="card-head-title" id="converter-page-size-label">
                  <FileText size={16} className="card-head-icon" aria-hidden="true" />
                  {t('Page Size · applies to all images')}
                </span>
              </div>
              <div className="card-body">
                <RadioCardGroup
                  labelledBy="converter-page-size-label"
                  name="converter-page-size"
                  idPrefix="converter-size"
                  options={PAGE_SIZE_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                    desc: option.desc,
                    wide: option.value === 'match_image',
                  }))}
                  value={pageSize}
                  disabled={isConverting}
                  onChange={converter.setPageSize}
                />
                <div className="field">
                  <label htmlFor="converter-image-output">{t('Output Filename')}</label>
                  <input
                    id="converter-image-output"
                    className="input"
                    type="text"
                    value={imageOutputName}
                    onChange={(event) => converter.setImageOutputName(event.target.value)}
                    placeholder="output.pdf"
                    disabled={isConverting}
                  />
                  <small>{t('The .pdf extension is added automatically if omitted.')}</small>
                </div>
              </div>
            </div>

            {outcome}
            {actions}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
