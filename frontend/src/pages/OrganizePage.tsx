import { useRef, useState } from 'react';
import {
  ArrowDownUp, CheckCircle, FileImage, FilePlus2, FileText, FolderOpen, Layers, ListTree, Loader2,
  RotateCw, Save, Trash2, Undo2, Redo2, RotateCcw, FlipHorizontal2, Upload, X,
} from 'lucide-react';
import { PageHeader } from '../components/ui';
import { Filename } from '../components/Filename';
import { PageGrid } from '../features/organize/PageGrid';
import { DeletePagesPanel, InsertPanel, SourcesPanel } from '../features/organize/panels';
import { useOrganizeWorkspace } from '../features/organize/useOrganizeWorkspace';
import { checkFileKind } from '../features/organize/fileKind';
import { IMAGE_ACCEPT, PDF_ACCEPT } from '../features/organize/types';
import { useToast } from '../hooks/useToast';
import { openOutputFolder } from '../utils/tauriDialog';
import { t, tn } from '../i18n';

export function OrganizePage() {
  const workspace = useOrganizeWorkspace();
  const { showToast } = useToast();
  const mainInputRef = useRef<HTMLInputElement>(null);
  const insertInputRef = useRef<HTMLInputElement>(null);
  const outputNameRef = useRef<HTMLInputElement>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);

  // The dialog is filtered per action, and the file is checked again afterwards
  // because the picker can be switched to "All files".
  const openInsertPicker = (accept: string) => {
    const input = insertInputRef.current;
    if (!input) return;
    input.accept = accept;
    input.click();
  };

  const insertFile = async (file: File, expected: 'pdf' | 'image') => {
    const verdict = await checkFileKind(file, expected);
    if (!verdict.ok) {
      showToast({ type: 'error', title: t('File not added'), message: verdict.error ?? t('Unsupported file.') });
      return;
    }
    await workspace.beginInsertFile(file);
  };

  const mainSource = workspace.sources.find((source) => source.id === workspace.mainSourceId) ?? null;
  const progress = workspace.thumbnailsTotal > 0 && workspace.thumbnailsLoaded < workspace.thumbnailsTotal;
  const highlighted = workspace.panel === 'delete'
    ? new Set(workspace.deletePreview.positions)
    : new Set<number>();

  return (
    <div className="feature-page">
      <PageHeader
        icon={Layers}
        title={t('Organize PDF')}
        description={t('Reorder, rotate, mirror, delete, and insert pages in one workspace')}
      />

      <div className="page-body page-body--workspace">
        <input
          ref={mainInputRef}
          id="organize-main-input"
          type="file"
          accept=".pdf"
          className="converter-file-input"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void workspace.openFile(file);
          }}
        />
        <input
          ref={insertInputRef}
          id="organize-insert-input"
          type="file"
          className="converter-file-input"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            const accept = event.target.accept;
            event.target.value = '';
            if (file) void insertFile(file, accept === PDF_ACCEPT ? 'pdf' : 'image');
          }}
        />

        {!workspace.hasDocument ? (
          <div className="form-col form-col--center">
            <div
              id="organize-drop-zone"
              className="drop-zone"
              role="button"
              tabIndex={0}
              onClick={() => !workspace.isBusy && mainInputRef.current?.click()}
              onKeyDown={(event) => event.key === 'Enter' && mainInputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (file) void workspace.openFile(file);
              }}
              aria-label={t('Drop a PDF here or press Enter to browse')}
            >
              <Upload className="drop-zone-icon" aria-hidden="true" />
              <p className="drop-zone-title">{t('Drop a PDF here')}</p>
              <p className="drop-zone-sub">{t('or click to browse · One file at a time')}</p>
              <span className="badge badge-neutral">PDF</span>
              {workspace.isBusy && (
                <p className="organize-help">
                  <Loader2 size={12} className="converter-spin" aria-hidden="true" /> {t('Adding the document…')}
                </p>
              )}
            </div>
            <p className="empty-hint">
              {t('Then insert pages from other PDFs or images, and arrange them in the grid.')}
            </p>
          </div>
        ) : (
          <div className="organize-workspace">
            {mainSource && (
              <div className="organize-document-bar" aria-label={t('Main PDF')}>
                <FileText size={16} aria-hidden="true" />
                <Filename name={mainSource.name} className="file-item-name" />
                <span className="chip">{tn(mainSource.pageCount, '{n} page', '{n} pages')}</span>
                <span className="organize-document-bar-spacer" />
                {confirmingClose ? (
                  <span className="organize-source-confirm" role="alert">
                    <span className="organize-help">{t('Close this PDF and discard your changes?')}</span>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      id="organize-close-confirm"
                      onClick={() => { setConfirmingClose(false); workspace.closeDocument(); }}
                    >
                      {t('Close PDF')}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingClose(false)}>
                      {t('Keep')}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm organize-danger"
                    id="organize-close-document"
                    onClick={() => {
                      if (workspace.canUndo || workspace.sources.length > 1) setConfirmingClose(true);
                      else workspace.closeDocument();
                    }}
                    disabled={workspace.isBusy}
                    aria-label={t('Close PDF')}
                    title={t('Close this PDF and everything inserted into it')}
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}

            <div className="organize-toolbar" role="toolbar" aria-label={t('Document actions')}>
              <div className="organize-toolbar-group">
                <button type="button" className="btn btn-secondary btn-sm" id="organize-insert-pdf" onClick={() => openInsertPicker(PDF_ACCEPT)} disabled={workspace.isBusy}>
                  <FilePlus2 size={14} aria-hidden="true" /> {t('Insert PDF')}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" id="organize-insert-image" onClick={() => openInsertPicker(IMAGE_ACCEPT)} disabled={workspace.isBusy}>
                  <FileImage size={14} aria-hidden="true" /> {t('Insert Image')}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => workspace.openPanel('delete')} disabled={workspace.isBusy}>
                  <Trash2 size={14} aria-hidden="true" /> {t('Delete pages')}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => workspace.openPanel('sources')} disabled={workspace.isBusy}>
                  <ListTree size={14} aria-hidden="true" /> {t('Sources')}
                  <span className="organize-count">{Math.max(0, workspace.sources.length - 1)}</span>
                </button>
              </div>

              <div className="organize-toolbar-group">
                <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.undo} disabled={!workspace.canUndo || workspace.isBusy} title={t('Undo')}>
                  <Undo2 size={14} aria-hidden="true" /> {t('Undo')}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.redo} disabled={!workspace.canRedo || workspace.isBusy} title={t('Redo')}>
                  <Redo2 size={14} aria-hidden="true" /> {t('Redo')}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.reset} disabled={workspace.isBusy} title={t('Back to the initial document')}>
                  <RotateCcw size={14} aria-hidden="true" /> {t('Reset')}
                </button>
              </div>

              <div className="organize-toolbar-group">
                {progress && (
                  <span className="organize-progress" role="status" aria-live="polite">
                    <Loader2 size={12} className="converter-spin" aria-hidden="true" />
                    {t('Loading')} {workspace.thumbnailsLoaded}/{workspace.thumbnailsTotal}
                  </span>
                )}
                <input
                  ref={outputNameRef}
                  className="input organize-output-name"
                  type="text"
                  defaultValue="organized.pdf"
                  aria-label={t('Output filename')}
                  disabled={workspace.isBusy}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  id="organize-save"
                  onClick={() => void workspace.save(outputNameRef.current?.value || 'organized.pdf')}
                  disabled={workspace.isBusy || !workspace.hasDocument}
                >
                  {workspace.isBusy ? (
                    <><Loader2 size={14} className="converter-spin" aria-hidden="true" /> {t('Saving…')}</>
                  ) : (
                    <><Save size={14} aria-hidden="true" /> {t('Save')}</>
                  )}
                </button>
              </div>
            </div>

            {workspace.selection.size > 0 && (
              <div className="organize-selection-bar" role="toolbar" aria-label={t('Selected pages')}>
                <span className="organize-selection-count">
                  {workspace.selection.size} {t('selected')}
                </span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => workspace.rotateSelection(90)} disabled={workspace.isBusy}>
                  <RotateCw size={13} aria-hidden="true" /> {t('Rotate')}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={workspace.flipSelection} disabled={workspace.isBusy}>
                  <FlipHorizontal2 size={13} aria-hidden="true" /> {t('Flip')}
                </button>
                <button type="button" className="btn btn-danger btn-sm" onClick={workspace.deleteSelection} disabled={workspace.isBusy}>
                  <Trash2 size={13} aria-hidden="true" /> {t('Delete')}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.clearSelection} disabled={workspace.isBusy}>
                  {t('Clear')}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.selectAll} disabled={workspace.isBusy}>
                  {t('Select all')}
                </button>
              </div>
            )}

            {workspace.panel === 'insert' && (
              <InsertPanel
                source={workspace.insertDraft.source}
                mode={workspace.insertDraft.mode}
                pagesInput={workspace.insertDraft.pagesInput}
                position={workspace.insertDraft.position}
                reference={workspace.insertDraft.reference}
                total={workspace.pages.length}
                preview={workspace.insertPreview}
                disabled={workspace.isBusy}
                onModeChange={workspace.setInsertMode}
                onPagesInputChange={workspace.setInsertPagesInput}
                onPositionChange={workspace.setInsertPosition}
                onReferenceChange={workspace.setInsertReference}
                onConfirm={workspace.confirmInsert}
                onCancel={workspace.closePanel}
              />
            )}

            {workspace.panel === 'delete' && (
              <DeletePagesPanel
                value={workspace.deleteInput}
                total={workspace.pages.length}
                preview={workspace.deletePreview}
                disabled={workspace.isBusy}
                onChange={workspace.setDeleteInput}
                onConfirm={workspace.confirmDelete}
                onCancel={workspace.closePanel}
              />
            )}

            {workspace.panel === 'sources' && (
              <SourcesPanel
                sources={workspace.sources}
                mainSourceId={workspace.mainSourceId}
                disabled={workspace.isBusy}
                onReinsert={workspace.beginInsertFromSource}
                onRemove={workspace.removeSource}
                onClose={workspace.closePanel}
              />
            )}

            {workspace.error && (
              <div className="converter-message converter-message--error" role="alert">
                <span>{workspace.error}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.dismissError}>
                  {t('Dismiss')}
                </button>
              </div>
            )}

            {workspace.result && (
              <div className="card converter-result">
                <CheckCircle size={26} aria-hidden="true" />
                <div className="converter-result-copy">
                  <p className="converter-result-title">{t('Saved')}</p>
                  <p className="converter-result-detail">
                    <Filename name={workspace.result.filename} /> · {workspace.result.detail}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => openOutputFolder()}
                  title={t('Open folder')}
                >
                  <FolderOpen size={14} aria-hidden="true" /> {t('Open Folder')}
                </button>
              </div>
            )}

            <div className="organize-grid-area">
              <div className="organize-grid-head">
                <span className="organize-help">
                  <ArrowDownUp size={12} aria-hidden="true" /> {tn(workspace.pages.length, '{n} page', '{n} pages')} · {t('click to select, Ctrl/Cmd-click to toggle, Shift-click for a range')}
                </span>
                {workspace.selection.size > 0 && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.clearSelection}>
                    <X size={12} aria-hidden="true" /> {t('Clear selection')}
                  </button>
                )}
              </div>
              <PageGrid
                pages={workspace.pages}
                sources={workspace.sources}
                thumbnails={workspace.thumbnails}
                selection={workspace.selection}
                highlighted={highlighted}
                markerIndex={workspace.panel === 'insert' && !workspace.insertPreview.referenceError
                  ? workspace.insertPreview.reference - 1
                  : null}
                markerSide={workspace.insertDraft.position}
                disabled={workspace.isBusy}
                onSelect={workspace.selectAt}
                onRotate={workspace.rotateAt}
                onFlip={workspace.flipAt}
                onDuplicate={workspace.duplicateAt}
                onRemove={workspace.removeAt}
                onReorder={workspace.movePage}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
