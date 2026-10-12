import { useRef } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle,
  FileImage,
  FolderOpen,
  Info,
  Loader2,
  RotateCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Filename } from '../components/Filename';
import { PdfThumbnail } from '../components/PdfThumbnail';
import { PreviewPanel, ThumbnailStrip } from '../components/preview';
import { PageHeader, StateView } from '../components/ui';
import { useConverterWorkflow } from '../features/converter/useConverterWorkflow';
import { ConverterThumbnail } from '../features/converter/ConverterThumbnail';
import { DPI_OPTIONS, FORMAT_OPTIONS, PAGE_SIZE_OPTIONS, formatBytes } from '../features/converter/options';
import { openOutputFolder } from '../utils/tauriDialog';
import type { QuarterTurn } from '../features/converter/batch';

function FlipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20v-16M8 4L4 12l4 8M16 4l4 8-4 8" />
    </svg>
  );
}

const HEADER_COPY = {
  empty: {
    title: 'PDF & Image',
    description: 'Add one PDF to export pages as images, or add images to build a PDF',
  },
  pdf: {
    title: 'PDF & Image',
    description: 'Export the pages you choose from one PDF as images',
  },
  images: {
    title: 'PDF & Image',
    description: 'Combine one or more images into a single PDF document',
  },
} as const;

export function ConverterPage() {
  const converter = useConverterWorkflow();
  const {
    kind, pdfFile, images, batchError, error, result, isConverting,
    pdfInfoState, selection, selectionMode, selectionDraft, pdfBlockReason,
    format, dpi, pdfOutputName, pageSize, imageOutputName,
    previewPage, activeImage, zoom, accept,
  } = converter;

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
    converter.addFiles(incoming);
  };

  const selectionEditable = selectionMode === 'selected' && pdfInfoState === 'ready' && !isConverting;
  const selectionInvalid = selectionMode === 'selected' && !selection.valid;
  const showSelectionError = selectionInvalid && Boolean(selection.error);
  const canConvertPdf = kind === 'pdf' && pdfInfoState === 'ready' && selection.valid && selection.pages.size > 0 && !isConverting;
  const canConvertImages = kind === 'images' && images.length > 0 && !isConverting;
  const canConvert = kind === 'pdf' ? canConvertPdf : canConvertImages;

  return (
    <div className="feature-page">
      <PageHeader
        icon={FileImage}
        title={HEADER_COPY[kind].title}
        description={HEADER_COPY[kind].description}
      />

      <div className="page-body page-body--workspace">
        <div className="feature-split-layout">
          <section className="feature-controls">
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

            {kind === 'empty' && (
              <div
                id="converter-drop-zone"
                className="drop-zone drop-zone--compact"
                role="button"
                tabIndex={0}
                onClick={() => openPicker()}
                onKeyDown={(event) => event.key === 'Enter' && openPicker()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  converter.addFiles(Array.from(event.dataTransfer.files));
                }}
                aria-label="Drop one PDF or image files here, or press Enter to browse"
              >
                <Upload className="drop-zone-icon" aria-hidden="true" />
                <p className="drop-zone-title">Drop a PDF or images here</p>
                <p className="drop-zone-sub">or click to browse · One PDF, or JPG / PNG / WEBP images</p>
                <div className="converter-badges">
                  <span className="badge badge-neutral">PDF → Images</span>
                  <span className="badge badge-neutral">Images → PDF</span>
                </div>
              </div>
            )}

            {kind === 'images' && (
              <div
                id="converter-drop-zone"
                className="drop-zone drop-zone--compact"
                role="button"
                tabIndex={0}
                onClick={() => openPicker()}
                onKeyDown={(event) => event.key === 'Enter' && openPicker()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  converter.addFiles(Array.from(event.dataTransfer.files));
                }}
                aria-label="Add more images, or press Enter to browse"
              >
                <Upload className="drop-zone-icon" aria-hidden="true" />
                <p className="drop-zone-title">Add more images</p>
                <p className="drop-zone-sub">JPG, JPEG, PNG, WEBP, BMP and TIFF can be mixed</p>
              </div>
            )}

            {kind === 'pdf' && pdfFile && (
              <div className="card converter-file">
                <PdfThumbnail file={pdfFile} />
                <div className="converter-file-copy">
                  <Filename name={pdfFile.name} className="file-item-name" />
                  <div className="file-item-meta converter-file-meta">
                    <span>{formatBytes(pdfFile.size)}</span>
                    {pdfInfoState === 'loading' && (
                      <Loader2 size={12} className="converter-spin" aria-hidden="true" />
                    )}
                    {pdfInfoState === 'ready' && (
                      <span className="badge badge-info">
                        <Info size={11} aria-hidden="true" /> {converter.pdfInfo?.total_pages} pages
                      </span>
                    )}
                    {pdfInfoState === 'error' && <span className="badge badge-error">Page count unavailable</span>}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => openPicker('replace')}
                  disabled={isConverting}
                  id="converter-replace-file"
                >
                  Replace
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm converter-danger"
                  onClick={converter.clear}
                  disabled={isConverting}
                  aria-label="Remove PDF"
                  id="converter-remove-file"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            )}

            {batchError && (
              <p className="converter-message converter-message--error" role="alert">{batchError}</p>
            )}

            {kind === 'empty' && (
              <StateView
                icon={FileImage}
                title="No files yet"
                description="The conversion direction is detected from what you add."
                compact
              />
            )}

            {kind === 'pdf' && (
              <>
                <div className="card">
                  <div className="converter-card-head">
                    <span className="input-label" id="converter-pages-label">Pages</span>
                    {pdfInfoState === 'ready' && (
                      <span className="badge badge-info">
                        <Info size={11} aria-hidden="true" /> Total: {converter.pdfInfo?.total_pages} pages
                      </span>
                    )}
                  </div>
                  <div
                    className="option-grid option-grid--two"
                    role="radiogroup"
                    aria-labelledby="converter-pages-label"
                  >
                    {(['all', 'selected'] as const).map((mode) => (
                      <label
                        key={mode}
                        htmlFor={`converter-pages-${mode}`}
                        className={`option-card${selectionMode === mode ? ' option-card--selected' : ''}`}
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
                        <span className="option-card-copy">
                          <span className="option-card-label">{mode === 'all' ? 'All pages' : 'Selected pages'}</span>
                          <span className="option-card-desc">
                            {mode === 'all' ? 'Export every page' : 'Choose pages or ranges'}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>

                  <div className="converter-selection">
                    <label className="input-label" htmlFor="converter-page-ranges">Selected pages</label>
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
                    <p
                      id="converter-page-help"
                      className={`converter-help${showSelectionError ? ' converter-help--error' : ''}`}
                      role={showSelectionError ? 'alert' : undefined}
                    >
                      {showSelectionError
                        ? selection.error
                        : selectionMode === 'all'
                          ? `All ${converter.pdfInfo?.total_pages ?? 0} pages will be exported.`
                          : `Selected: ${selection.pages.size} of ${converter.pdfInfo?.total_pages ?? 0} pages`}
                    </p>
                  </div>
                </div>

                <div className="option-grid option-grid--two option-grid--cards">
                  <div className="card">
                    <span className="input-label">Image Format</span>
                    <div className="option-stack">
                      {FORMAT_OPTIONS.map((option) => (
                        <label
                          key={option.value}
                          htmlFor={`converter-format-${option.value}`}
                          className={`option-card${format === option.value ? ' option-card--selected' : ''}`}
                        >
                          <input
                            id={`converter-format-${option.value}`}
                            type="radio"
                            name="converter-format"
                            value={option.value}
                            checked={format === option.value}
                            onChange={() => converter.setFormat(option.value)}
                            disabled={isConverting}
                          />
                          <span className="option-card-copy">
                            <span className="option-card-label">{option.label}</span>
                            <span className="option-card-desc">{option.desc}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="card">
                    <span className="input-label">Resolution (DPI)</span>
                    <div className="option-stack">
                      {DPI_OPTIONS.map((option) => (
                        <label
                          key={option.value}
                          htmlFor={`converter-dpi-${option.value}`}
                          className={`option-card${dpi === option.value ? ' option-card--selected' : ''}`}
                        >
                          <input
                            id={`converter-dpi-${option.value}`}
                            type="radio"
                            name="converter-dpi"
                            value={option.value}
                            checked={dpi === option.value}
                            onChange={() => converter.setDpi(option.value)}
                            disabled={isConverting}
                          />
                          <span className="option-card-copy">
                            <span className="option-card-label">{option.label}</span>
                            <span className="option-card-desc">{option.desc}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="card">
                  <label className="input-label" htmlFor="converter-pdf-output">Output Filename</label>
                  <input
                    id="converter-pdf-output"
                    className="input"
                    type="text"
                    value={pdfOutputName}
                    onChange={(event) => converter.setPdfOutputName(event.target.value)}
                    placeholder="export"
                    disabled={isConverting}
                  />
                  <p className="converter-help">The .png, .jpg or .zip extension is added automatically.</p>
                </div>
              </>
            )}

            {kind === 'images' && (
              <>
                <div className="card">
                  <div className="converter-card-head">
                    <span className="input-label" id="converter-images-label">Images to Convert</span>
                    <span className="badge badge-info">
                      {images.length} file{images.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="file-list" aria-labelledby="converter-images-label">
                    {images.map((entry, index) => (
                      <div
                        key={entry.id}
                        className={`file-item${activeImage?.id === entry.id ? ' file-item--active' : ''}`}
                      >
                        <button
                          type="button"
                          className="converter-image-pick"
                          onClick={() => converter.setActiveImageId(entry.id)}
                          aria-label={`Preview ${entry.file.name}`}
                        >
                          <ConverterThumbnail
                            file={entry.file}
                            rotation={entry.rotation}
                            flipH={entry.flipH}
                          />
                          <span className="badge badge-neutral converter-image-index">#{index + 1}</span>
                        </button>
                        <div className="file-item-info">
                          <Filename name={entry.file.name} className="file-item-name" />
                          <div className="file-item-meta">{formatBytes(entry.file.size)}</div>
                        </div>
                        <div className="file-item-actions">
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
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-sm"
                            onClick={() => converter.moveImage(entry.id, 'up')}
                            disabled={isConverting || index === 0}
                            aria-label={`Move ${entry.file.name} up`}
                            id={`converter-move-up-${index}`}
                          >
                            <ArrowUp size={14} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-sm"
                            onClick={() => converter.moveImage(entry.id, 'down')}
                            disabled={isConverting || index === images.length - 1}
                            aria-label={`Move ${entry.file.name} down`}
                            id={`converter-move-down-${index}`}
                          >
                            <ArrowDown size={14} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-sm converter-danger"
                            onClick={() => converter.removeImage(entry.id)}
                            disabled={isConverting}
                            aria-label={`Remove ${entry.file.name}`}
                            id={`converter-remove-${index}`}
                          >
                            <X size={14} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="card">
                  <span className="input-label" id="converter-page-size-label">Page Size · applies to all images</span>
                  <div
                    className="option-grid option-grid--two"
                    role="radiogroup"
                    aria-labelledby="converter-page-size-label"
                  >
                    {PAGE_SIZE_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        htmlFor={`converter-size-${option.value}`}
                        className={`option-card${pageSize === option.value ? ' option-card--selected' : ''}${option.value === 'match_image' ? ' option-card--wide' : ''}`}
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
                        <span className="option-card-copy">
                          <span className="option-card-label">{option.label}</span>
                          <span className="option-card-desc">{option.desc}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="card">
                  <label className="input-label" htmlFor="converter-image-output">Output Filename</label>
                  <input
                    id="converter-image-output"
                    className="input"
                    type="text"
                    value={imageOutputName}
                    onChange={(event) => converter.setImageOutputName(event.target.value)}
                    placeholder="output.pdf"
                    disabled={isConverting}
                  />
                  <p className="converter-help">The .pdf extension is added automatically if omitted.</p>
                </div>
              </>
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
              <div className="card converter-result">
                <CheckCircle size={26} aria-hidden="true" />
                <div className="converter-result-copy">
                  <p className="converter-result-title">Download started automatically</p>
                  <p className="converter-result-detail">
                    <Filename name={result.filename} /> · {result.detail}
                  </p>
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

            {kind !== 'empty' && (
              <div className="converter-actions">
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
            )}
          </section>

          <section className="feature-preview">
            {kind === 'pdf' && pdfFile ? (
              <PreviewPanel
                pdfFile={pdfFile}
                totalPages={pdfInfoState === 'ready' ? converter.pdfInfo?.total_pages : undefined}
                currentPage={previewPage}
                onPageChange={converter.setPreviewPage}
                zoom={zoom}
                onZoomChange={converter.setZoom}
                topSlot={pdfInfoState === 'ready' ? (
                  <ThumbnailStrip
                    file={pdfFile}
                    totalPages={converter.pdfInfo?.total_pages ?? 0}
                    currentPage={previewPage}
                    selectedPages={selection.pages}
                    selectionDisabled={!selectionEditable}
                    onPageClick={converter.setPreviewPage}
                    onTogglePage={converter.togglePageSelection}
                  />
                ) : undefined}
              />
            ) : kind === 'images' && activeImage ? (
              <PreviewPanel
                imageFile={activeImage.file}
                currentPage={1}
                onPageChange={() => {}}
                zoom={zoom}
                onZoomChange={converter.setZoom}
                showRotation
                rotation={activeImage.rotation as QuarterTurn}
                flipH={activeImage.flipH}
                onRotationChange={() => converter.rotateImage(activeImage.id)}
                onFlipChange={() => converter.flipImage(activeImage.id)}
              />
            ) : (
              <PreviewPanel
                currentPage={1}
                onPageChange={() => {}}
                zoom={zoom}
                onZoomChange={converter.setZoom}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
