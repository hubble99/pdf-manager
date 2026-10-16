import { useRef, useState } from 'react';
import {
  CheckCircle,
  FileImage,
  FileText,
  FolderOpen,
  Images,
  Loader2,
  RotateCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { Filename } from '../components/Filename';
import { PageThumbGrid } from '../components/preview';
import { SortableCardGrid } from '../components/sortable/SortableCardGrid';
import { PageHeader } from '../components/ui';
import { useConverterWorkflow } from '../features/converter/useConverterWorkflow';
import { ConverterThumbnail } from '../features/converter/ConverterThumbnail';
import { DPI_OPTIONS, FORMAT_OPTIONS, PAGE_SIZE_OPTIONS, formatBytes } from '../features/converter/options';
import { openOutputFolder } from '../utils/tauriDialog';

function FlipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20v-16M8 4L4 12l4 8M16 4l4 8-4 8" />
    </svg>
  );
}

type ConverterTab = 'pdf' | 'images';

const TAB_COPY: Record<ConverterTab, { label: string; description: string; accept: string }> = {
  pdf: {
    label: 'PDF to Images',
    description: 'Export the pages you choose from one PDF as images',
    accept: '.pdf',
  },
  images: {
    label: 'Images to PDF',
    description: 'Combine one or more images into a single PDF document',
    accept: '.jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff',
  },
};

export function ConverterPage() {
  const converter = useConverterWorkflow();
  const {
    kind, pdfFile, images, batchError, error, result, isConverting,
    pdfInfoState, selection, selectionMode, selectionDraft, pdfBlockReason,
    format, dpi, pdfOutputName, pageSize, imageOutputName,
  } = converter;

  // The tab chooses the direction while nothing is loaded; loaded files decide it after that.
  const [chosenTab, setChosenTab] = useState<ConverterTab>('pdf');
  const activeTab: ConverterTab = kind === 'empty' ? chosenTab : kind;
  const accept = TAB_COPY[activeTab].accept;

  const inputRef = useRef<HTMLInputElement>(null);
  const replaceIntentRef = useRef(false);

  const openPicker = (intent: 'add' | 'replace' = 'add') => {
    if (isConverting) return;
    replaceIntentRef.current = intent === 'replace';
    inputRef.current?.click();
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (incoming.length === 0) return;
    if (replaceIntentRef.current) {
      replaceIntentRef.current = false;
      converter.replaceFiles(incoming);
      return;
    }
    converter.addFiles(incoming, activeTab);
  };

  const selectionEditable = selectionMode === 'selected' && pdfInfoState === 'ready' && !isConverting;
  const selectionInvalid = selectionMode === 'selected' && !selection.valid;
  const showSelectionError = selectionInvalid && Boolean(selection.error);
  const canConvertPdf = kind === 'pdf' && pdfInfoState === 'ready' && selection.valid && selection.pages.size > 0 && !isConverting;
  const canConvertImages = kind === 'images' && images.length > 0 && !isConverting;
  const canConvert = kind === 'pdf' ? canConvertPdf : canConvertImages;
  const totalPages = converter.pdfInfo?.total_pages ?? 0;
  const formatOption = FORMAT_OPTIONS.find((option) => option.value === format);
  const dpiOption = DPI_OPTIONS.find((option) => option.value === dpi);

  const dropProps = {
    role: 'button' as const,
    tabIndex: 0,
    onClick: () => openPicker(),
    onKeyDown: (event: React.KeyboardEvent) => event.key === 'Enter' && openPicker(),
    onDragOver: (event: React.DragEvent) => event.preventDefault(),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      converter.addFiles(Array.from(event.dataTransfer.files), activeTab);
    },
  };

  const fileInput = (
    <input
      ref={inputRef}
      id="converter-file-input"
      type="file"
      accept={accept}
      multiple
      className="converter-file-input"
      onChange={handleInputChange}
      tabIndex={-1}
      aria-hidden="true"
    />
  );

  const outcome = (
    <>
      {batchError && (
        <p className="converter-message converter-message--error" role="alert">{batchError}</p>
      )}

      {error && (
        <div className="converter-message converter-message--error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={converter.dismissError}>
            Dismiss
          </button>
        </div>
      )}

      {result && (
        <div className="card status-card status-card--ok">
          <CheckCircle size={22} aria-hidden="true" />
          <div className="status-card-copy">
            <b>Download started automatically</b>
            <small><Filename name={result.filename} /> · {result.detail}</small>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            id="converter-open-folder"
            onClick={() => openOutputFolder()}
            title="Open download folder"
          >
            <FolderOpen size={14} aria-hidden="true" />
            Open Folder
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
        {kind === 'images' ? 'Clear All' : 'Clear'}
      </button>
      <button
        type="button"
        className="btn btn-primary"
        id="converter-run"
        onClick={converter.convert}
        disabled={!canConvert}
        title={canConvert ? undefined : pdfBlockReason ?? 'Add files to convert'}
      >
        {isConverting ? (
          <>
            <Loader2 size={15} className="converter-spin" aria-hidden="true" />
            {kind === 'pdf' ? 'Exporting…' : 'Converting…'}
          </>
        ) : (
          <>
            <FileImage size={15} aria-hidden="true" />
            {kind === 'pdf' ? 'Export & Download' : 'Convert & Download'}
          </>
        )}
      </button>
    </div>
  );

  return (
    <div className="feature-page">
      <PageHeader
        icon={FileImage}
        title="PDF & Image"
        description={TAB_COPY[activeTab].description}
      />

      <div className="tabs" role="tablist" aria-label="Conversion direction">
        {(['pdf', 'images'] as const).map((tab) => {
          const locked = kind !== 'empty' && kind !== tab;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`converter-tab-${tab}`}
              aria-selected={activeTab === tab}
              className={`tab${activeTab === tab ? ' active' : ''}`}
              onClick={() => { converter.dismissBatchError(); setChosenTab(tab); }}
              disabled={locked || isConverting}
              title={locked ? 'Clear the current files to switch direction' : undefined}
            >
              {TAB_COPY[tab].label}
            </button>
          );
        })}
      </div>

      <div className="page-body">
        {fileInput}

        {/* ── Nothing added yet: each tab has its own uploader ──────────────── */}
        {kind === 'empty' && (
          <div className="form-col form-col--center">
            <div
              id="converter-drop-zone"
              className="drop-zone"
              aria-label={activeTab === 'pdf'
                ? 'Drop a PDF here, or press Enter to browse'
                : 'Drop images here, or press Enter to browse'}
              {...dropProps}
            >
              <Upload className="drop-zone-icon" aria-hidden="true" />
              {activeTab === 'pdf' ? (
                <>
                  <p className="drop-zone-title">Drop a PDF here</p>
                  <p className="drop-zone-sub">or click to browse · One file at a time</p>
                  <span className="badge badge-neutral">PDF</span>
                </>
              ) : (
                <>
                  <p className="drop-zone-title">Drop images here</p>
                  <p className="drop-zone-sub">or click to browse · Multiple files supported</p>
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
                ? 'Every page will appear here so you can choose which ones to convert.'
                : 'Add images, put them in order, and save them as one PDF.'}
            </p>
          </div>
        )}

        {/* ── One PDF: pick pages, set the output ───────────────────────────── */}
        {kind === 'pdf' && pdfFile && (
          <div className="form-col form-col--split">
            <div className="card card--flush">
              <div className="card-head">
                <span className="card-head-title">
                  <FileText size={16} className="card-head-icon" aria-hidden="true" />
                  <Filename name={pdfFile.name} className="file-item-name" />
                  <span className="chip">{formatBytes(pdfFile.size)}</span>
                  {pdfInfoState === 'loading' && (
                    <Loader2 size={12} className="converter-spin" aria-hidden="true" />
                  )}
                  {pdfInfoState === 'ready' && (
                    <span className="chip">Total: {totalPages} pages</span>
                  )}
                  {pdfInfoState === 'error' && <span className="badge badge-error">Page count unavailable</span>}
                </span>
                <span className="card-head-actions">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => openPicker('replace')}
                    disabled={isConverting}
                    id="converter-replace-file"
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={converter.clear}
                    disabled={isConverting}
                    aria-label="Remove PDF"
                    id="converter-remove-file"
                  >
                    Remove
                  </button>
                </span>
              </div>
              {pdfInfoState === 'ready' && totalPages > 0 ? (
                <PageThumbGrid
                  file={pdfFile}
                  totalPages={totalPages}
                  selected={selection.pages}
                  interactive={selectionEditable}
                  onToggle={converter.togglePageSelection}
                />
              ) : (
                <p className="empty-hint">
                  {pdfInfoState === 'loading' ? 'Reading the document…' : 'Pages are unavailable for this file.'}
                </p>
              )}
            </div>

            <div className="col-stack">
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title" id="converter-pages-label">Pages</span>
                  <span className="card-head-actions">
                    {pdfInfoState === 'ready' && <span>{selection.pages.size} of {totalPages} selected</span>}
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
                        <span className="radio-title">{mode === 'all' ? 'All pages' : 'Selected pages'}</span>
                        <span className="radio-desc">
                          {mode === 'all' ? 'Export every page' : 'Choose pages or ranges'}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="card-body">
                  <div className="field">
                    <label htmlFor="converter-page-ranges">Selected pages</label>
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
                          ? `All ${totalPages} pages will be exported.`
                          : `Selected: ${selection.pages.size} of ${totalPages} pages`}
                    </small>
                  </div>
                </div>
              </div>

              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <Images size={16} className="card-head-icon" aria-hidden="true" />
                    Output settings
                  </span>
                </div>
                <div className="card-body">
                  <div className="setting-row">
                    <span className="setting-label" id="converter-format-label">Format</span>
                    <div className="seg" role="group" aria-labelledby="converter-format-label">
                      {FORMAT_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          id={`converter-format-${option.value}`}
                          aria-pressed={format === option.value}
                          className={format === option.value ? 'active' : ''}
                          disabled={isConverting}
                          onClick={() => converter.setFormat(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="setting-row">
                    <span className="setting-label" id="converter-dpi-label">Resolution</span>
                    <div className="seg" role="group" aria-labelledby="converter-dpi-label">
                      {DPI_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          id={`converter-dpi-${option.value}`}
                          aria-pressed={dpi === option.value}
                          className={dpi === option.value ? 'active' : ''}
                          disabled={isConverting}
                          onClick={() => converter.setDpi(option.value)}
                        >
                          {option.value}
                        </button>
                      ))}
                    </div>
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
                    <label htmlFor="converter-pdf-output">Output Filename</label>
                    <input
                      id="converter-pdf-output"
                      className="input"
                      type="text"
                      value={pdfOutputName}
                      onChange={(event) => converter.setPdfOutputName(event.target.value)}
                      placeholder="export"
                      disabled={isConverting}
                    />
                    <small>The .png, .jpg or .zip extension is added automatically.</small>
                  </div>
                </div>
              </div>

              {outcome}
              {actions}
            </div>
          </div>
        )}

        {/* ── Images: previews on the left, page size and output on the right ── */}
        {kind === 'images' && (
          <div className="form-col form-col--split">
            <div className="card card--flush">
              <div className="card-head">
                <span className="card-head-title">
                  <Images size={16} className="card-head-icon" aria-hidden="true" />
                  <span id="converter-images-label">Images to Convert</span>
                  <span className="chip">
                    {images.length} file{images.length === 1 ? '' : 's'}
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
                    Add images
                  </button>
                </span>
              </div>
              <div
                className="converter-image-drop"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  converter.addFiles(Array.from(event.dataTransfer.files), activeTab);
                }}
              >
                <SortableCardGrid
                  idPrefix="converter"
                  ariaLabel="Images to Convert"
                  disabled={isConverting}
                  onReorder={converter.reorderImages}
                  onRemove={converter.removeImage}
                  cards={images.map((entry) => ({
                    id: entry.id,
                    title: entry.file.name,
                    thumbnail: (
                      <ConverterThumbnail file={entry.file} rotation={entry.rotation} flipH={entry.flipH} />
                    ),
                    meta: <span>{formatBytes(entry.file.size)}</span>,
                    actions: (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => converter.rotateImage(entry.id)}
                          disabled={isConverting}
                          aria-label={`Rotate ${entry.file.name} 90 degrees`}
                          title="Rotate 90°"
                        >
                          <RotateCw size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => converter.flipImage(entry.id)}
                          disabled={isConverting}
                          aria-label={`Mirror ${entry.file.name} horizontally`}
                          title="Mirror horizontally"
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
                  Page Size · applies to all images
                </span>
              </div>
              <div className="card-body">
                <div className="opt-grid" role="radiogroup" aria-labelledby="converter-page-size-label">
                  {PAGE_SIZE_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      htmlFor={`converter-size-${option.value}`}
                      className={`radio-card${pageSize === option.value ? ' active' : ''}${option.value === 'match_image' ? ' radio-card--wide' : ''}`}
                    >
                      <input
                        id={`converter-size-${option.value}`}
                        type="radio"
                        name="converter-page-size"
                        value={option.value}
                        checked={pageSize === option.value}
                        onChange={() => converter.setPageSize(option.value)}
                        disabled={isConverting}
                      />
                      <span className="radio-copy">
                        <span className="radio-title">{option.label}</span>
                        <span className="radio-desc">{option.desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="field">
                  <label htmlFor="converter-image-output">Output Filename</label>
                  <input
                    id="converter-image-output"
                    className="input"
                    type="text"
                    value={imageOutputName}
                    onChange={(event) => converter.setImageOutputName(event.target.value)}
                    placeholder="output.pdf"
                    disabled={isConverting}
                  />
                  <small>The .pdf extension is added automatically if omitted.</small>
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
