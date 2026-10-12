import { useRef } from 'react';
import {
  ArrowDownUp, CheckCircle, FileImage, FilePlus2, FolderOpen, Layers, ListTree, Loader2,
  RotateCw, Save, Trash2, Undo2, Redo2, RotateCcw, FlipHorizontal2, Upload, X,
} from 'lucide-react';
import { PageHeader, StateView } from '../components/ui';
import { Filename } from '../components/Filename';
import { PageGrid } from '../features/organize/PageGrid';
import { DeletePagesPanel, InsertPanel, SourcesPanel } from '../features/organize/panels';
import { useOrganizeWorkspace } from '../features/organize/useOrganizeWorkspace';
import { openOutputFolder } from '../utils/tauriDialog';

export function OrganizePage() {
  const workspace = useOrganizeWorkspace();
  const mainInputRef = useRef<HTMLInputElement>(null);
  const insertInputRef = useRef<HTMLInputElement>(null);
  const insertAcceptRef = useRef('.pdf');
  const outputNameRef = useRef<HTMLInputElement>(null);

  const openInsertPicker = (accept: string) => {
    insertAcceptRef.current = accept;
    insertInputRef.current?.click();
  };

  const progress = workspace.thumbnailsTotal > 0 && workspace.thumbnailsLoaded < workspace.thumbnailsTotal;
  const highlighted = workspace.panel === 'delete'
    ? new Set(workspace.deletePreview.positions)
    : new Set<number>();

  return (
    <div className="feature-page">
      <PageHeader
        icon={Layers}
        title="Organize PDF"
        description="Reorder, rotate, mirror, delete, and insert pages in one workspace"
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
            event.target.value = '';
            if (file) void workspace.beginInsertFile(file);
          }}
        />

        {!workspace.hasDocument ? (
          <div className="feature-split-layout">
            <section className="feature-controls">
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
                aria-label="Drop a PDF here or press Enter to browse"
              >
                <Upload className="drop-zone-icon" aria-hidden="true" />
                <p className="drop-zone-title">Drop a PDF here</p>
                <p className="drop-zone-sub">or click to browse · one PDF to start from</p>
                {workspace.isBusy && (
                  <p className="organize-help">
                    <Loader2 size={12} className="converter-spin" aria-hidden="true" /> Adding the document…
                  </p>
                )}
              </div>
              <StateView
                icon={ListTree}
                title="No document yet"
                description="The grid becomes the document: every change is a list change, and the backend only runs when you save."
                compact
              />
            </section>
            <section className="feature-preview">
              <StateView
                icon={Layers}
                title="Add a PDF to begin"
                description="Then insert pages from other PDFs or images, and arrange them here."
              />
            </section>
          </div>
        ) : (
          <div className="organize-workspace">
            <div className="organize-toolbar" role="toolbar" aria-label="Document actions">
              <div className="organize-toolbar-group">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => openInsertPicker('.pdf')} disabled={workspace.isBusy}>
                  <FilePlus2 size={14} aria-hidden="true" /> Insert PDF
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => openInsertPicker('.jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff')} disabled={workspace.isBusy}>
                  <FileImage size={14} aria-hidden="true" /> Insert Image
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => workspace.openPanel('delete')} disabled={workspace.isBusy}>
                  <Trash2 size={14} aria-hidden="true" /> Delete pages
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => workspace.openPanel('sources')} disabled={workspace.isBusy}>
                  <ListTree size={14} aria-hidden="true" /> Sources
                  <span className="organize-count">{workspace.sources.length}</span>
                </button>
              </div>

              <div className="organize-toolbar-group">
                <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.undo} disabled={!workspace.canUndo || workspace.isBusy} title="Undo">
                  <Undo2 size={14} aria-hidden="true" /> Undo
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.redo} disabled={!workspace.canRedo || workspace.isBusy} title="Redo">
                  <Redo2 size={14} aria-hidden="true" /> Redo
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.reset} disabled={workspace.isBusy} title="Back to the initial document">
                  <RotateCcw size={14} aria-hidden="true" /> Reset
                </button>
              </div>

              <div className="organize-toolbar-group">
                {progress && (
                  <span className="organize-progress" role="status" aria-live="polite">
                    <Loader2 size={12} className="converter-spin" aria-hidden="true" />
                    Loading {workspace.thumbnailsLoaded}/{workspace.thumbnailsTotal}
                  </span>
                )}
                <input
                  ref={outputNameRef}
                  className="input organize-output-name"
                  type="text"
                  defaultValue="organized.pdf"
                  aria-label="Output filename"
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
                    <><Loader2 size={14} className="converter-spin" aria-hidden="true" /> Saving…</>
                  ) : (
                    <><Save size={14} aria-hidden="true" /> Save</>
                  )}
                </button>
              </div>
            </div>

            {workspace.selection.size > 0 && (
              <div className="organize-selection-bar" role="toolbar" aria-label="Selected pages">
                <span className="organize-selection-count">
                  {workspace.selection.size} selected
                </span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => workspace.rotateSelection(90)} disabled={workspace.isBusy}>
                  <RotateCw size={13} aria-hidden="true" /> Rotate
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={workspace.flipSelection} disabled={workspace.isBusy}>
                  <FlipHorizontal2 size={13} aria-hidden="true" /> Flip
                </button>
                <button type="button" className="btn btn-danger btn-sm" onClick={workspace.deleteSelection} disabled={workspace.isBusy}>
                  <Trash2 size={13} aria-hidden="true" /> Delete
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.clearSelection} disabled={workspace.isBusy}>
                  Clear
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.selectAll} disabled={workspace.isBusy}>
                  Select all
                </button>
              </div>
            )}

            {workspace.panel === 'insert' && (
              <InsertPanel
                source={workspace.insertDraft.source}
                mode={workspace.insertDraft.mode}
                pagesInput={workspace.insertDraft.pagesInput}
                position={workspace.insertDraft.position}
                preview={workspace.insertPreview}
                selectionCount={workspace.selection.size}
                disabled={workspace.isBusy}
                onModeChange={workspace.setInsertMode}
                onPagesInputChange={workspace.setInsertPagesInput}
                onPositionChange={workspace.setInsertPosition}
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
                disabled={workspace.isBusy}
                onReinsert={workspace.beginInsertFromSource}
                onRemove={workspace.removeSource}
              />
            )}

            {workspace.error && (
              <div className="converter-message converter-message--error" role="alert">
                <span>{workspace.error}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.dismissError}>
                  Dismiss
                </button>
              </div>
            )}

            {workspace.result && (
              <div className="card converter-result">
                <CheckCircle size={26} aria-hidden="true" />
                <div className="converter-result-copy">
                  <p className="converter-result-title">Saved</p>
                  <p className="converter-result-detail">
                    <Filename name={workspace.result.filename} /> · {workspace.result.detail}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => openOutputFolder()}
                  title="Open download folder"
                >
                  <FolderOpen size={14} aria-hidden="true" /> Open Folder
                </button>
              </div>
            )}

            <div className="organize-grid-area">
              <div className="organize-grid-head">
                <span className="organize-help">
                  <ArrowDownUp size={12} aria-hidden="true" /> {workspace.pages.length} page{workspace.pages.length === 1 ? '' : 's'} ·
                  click to select, Ctrl/Cmd-click to toggle, Shift-click for a range
                </span>
                {workspace.selection.size > 0 && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.clearSelection}>
                    <X size={12} aria-hidden="true" /> Clear selection
                  </button>
                )}
              </div>
              <PageGrid
                pages={workspace.pages}
                sources={workspace.sources}
                thumbnails={workspace.thumbnails}
                selection={workspace.selection}
                highlighted={highlighted}
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
