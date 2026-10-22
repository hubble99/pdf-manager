import {
  AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, FileText, Folder, FolderOpen,
  Loader2, Merge, Plus, RefreshCw, Trash2, X,
} from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { SortableArea } from '../../components/sortable/SortableArea';
import { revealPath } from '../../api/nativeCore';
import type { FileDescription, FolderNode } from '../../api/pdfMerge';
import { useFolderMerge } from './useFolderMerge';
import { reasonLabel } from './messages';
import { t, tn } from '../../i18n';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function describeInfo(info: FileDescription | undefined): string {
  if (!info) return '\u00a0';
  const size = formatBytes(info.sizeBytes);
  return info.pages === null ? size : `${tn(info.pages, '{n} page', '{n} pages')} · ${size}`;
}

/** Every folder path in a listing, so one control can open or close the whole tree. */
function folderPaths(node: FolderNode): string[] {
  return node.folders.flatMap((child) => [child.relativePath, ...folderPaths(child)]);
}

function FolderRow({
  node, depth, expanded, onToggle, onAddAll, queued,
}: {
  node: FolderNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onAddAll: (node: FolderNode) => void;
  queued: (path: string) => boolean;
}) {
  const isOpen = expanded.has(node.relativePath);
  return (
    <li className="merge-tree-folder">
      <div className="merge-tree-row" style={{ paddingLeft: depth * 18 + 10 }}>
        <button
          type="button"
          className="merge-tree-toggle"
          onClick={() => onToggle(node.relativePath)}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? t('Collapse') : t('Expand')} ${node.name}`}
        >
          {isOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
          {isOpen
            ? <FolderOpen size={16} className="merge-tree-folder-icon" aria-hidden="true" />
            : <Folder size={16} className="merge-tree-folder-icon" aria-hidden="true" />}
          <span className="merge-tree-name">{node.name}</span>
          <span className="chip merge-tree-count">{node.pdfCount}</span>
        </button>
        <button
          type="button"
          className="link-btn merge-tree-addall"
          onClick={() => onAddAll(node)}
          aria-label={t('Add all {count} PDFs under {name}', { count: node.pdfCount, name: node.name })}
        >
          {t('Add all')}
        </button>
      </div>

      {isOpen && (
        <ul className="merge-tree-children">
          {node.folders.map((child) => (
            <FolderRow
              key={child.relativePath}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onAddAll={onAddAll}
              queued={queued}
            />
          ))}
          {node.files.map((name) => {
            const relative = node.relativePath ? `${node.relativePath}/${name}` : name;
            const already = queued(relative);
            return (
              <li key={relative}>
                <button
                  type="button"
                  className={`merge-tree-file${already ? ' merge-tree-file--queued' : ''}`}
                  style={{ paddingLeft: (depth + 1) * 18 + 32 }}
                  onClick={() => onToggle(`file:${relative}`)}
                  disabled={already}
                  aria-label={already ? t('{name} is already queued', { name }) : t('Add {name}', { name })}
                >
                  <span className="pdf-badge pdf-badge--sm" aria-hidden="true">PDF</span>
                  <span className="merge-tree-name">{name}</span>
                  <AddTag added={already} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** The reference's "+ Add" / "✓ Added" tag at the end of a file row. */
function AddTag({ added }: { added: boolean }) {
  return (
    <span className="merge-tree-tag" aria-hidden="true">
      {added ? <Check size={13} /> : <Plus size={13} />}
      {added ? t('Added') : t('Add')}
    </span>
  );
}

function QueueRow({
  relative, info, index, onRemove, onStep, disabled, onKeyDown,
}: {
  relative: string;
  info: FileDescription | undefined;
  index: number;
  onRemove: (index: number) => void;
  onStep: (index: number, direction: -1 | 1) => void;
  disabled: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLLIElement>, index: number) => void;
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: relative, disabled });
  const dragKeyDown = listeners?.onKeyDown as ((event: KeyboardEvent) => void) | undefined;
  const name = relative.split('/').pop() ?? relative;
  const folder = relative.includes('/') ? `${relative.slice(0, relative.lastIndexOf('/'))}/` : '';

  return (
    <li
      ref={(node) => { setNodeRef(node); setActivatorNodeRef(node); }}
      className={[
        'merge-queue-row',
        'merge-queue-row--draggable',
        isDragging ? 'merge-queue-row--dragging' : '',
      ].filter(Boolean).join(' ')}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      tabIndex={0}
      aria-roledescription={t('sortable')}
      aria-describedby={attributes['aria-describedby']}
      title={t('Drag to reorder, or press Alt+Up / Alt+Down')}
      {...(disabled ? {} : listeners)}
      onKeyDown={(event) => {
        if (event.altKey) onKeyDown(event, index);
        else if (!disabled) dragKeyDown?.(event);
      }}
    >
      <span className="pdf-badge" aria-hidden="true">PDF</span>
      <span className="merge-queue-copy">
        <span className="merge-queue-name">{name}</span>
        {/* Always shown, so rows never change height and duplicate names stay clear. */}
        <span className="merge-queue-folder">{folder || '\u00a0'}</span>
        <span className="merge-queue-meta">{describeInfo(info)}</span>
      </span>
      <span className="chip merge-queue-index">#{index + 1}</span>
      <span className="merge-queue-actions">
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => onStep(index, -1)} disabled={disabled || index === 0} aria-label={t('Move {name} up', { name })}>
          <ArrowUp size={13} aria-hidden="true" />
        </button>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => onStep(index, 1)} disabled={disabled} aria-label={t('Move {name} down', { name })}>
          <ArrowDown size={13} aria-hidden="true" />
        </button>
        <button type="button" className="btn btn-ghost btn-icon btn-sm converter-danger" onClick={() => onRemove(index)} disabled={disabled} aria-label={t('Remove {name}', { name })}>
          <X size={13} aria-hidden="true" />
        </button>
      </span>
    </li>
  );
}

export function FolderWorkspace() {
  const workspace = useFolderMerge();
  const reorderQueue = (from: number, to: number) => workspace.moveAt(from, to);

  /** Keyboard alternative for a focused queue row. */
  const handleRowKeyDown = (
    event: React.KeyboardEvent<HTMLLIElement>,
    index: number,
  ) => {
    if (!event.altKey) return;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      workspace.step(index, -1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      workspace.step(index, 1);
    }
  };

  const addFileRow = (relative: string) => {
    // A file row reuses the toggle handler for folders; route it by prefix.
    if (relative.startsWith('file:')) workspace.addFile(relative.slice(5));
  };

  const { progress } = workspace;
  const percent = progress?.total ? Math.round((progress.done / progress.total) * 100) : null;
  const progressTitle = progress?.stage === 'saving'
    ? t('Saving the merged PDF…')
    : progress?.total
      ? t('Merging file {done} of {total}…', { done: Math.min(progress.done + 1, progress.total), total: progress.total })
      : t('Preparing the files…');

  const folders = workspace.listing ? folderPaths(workspace.listing.root) : [];
  const allOpen = folders.length > 0 && folders.every((path) => workspace.expanded.has(path));
  const rootFiles = workspace.listing?.root.files ?? [];

  return (
    <div className="page-body">
      <div className={`form-col form-col--wide form-col--two merge-folder-grid${workspace.root ? '' : ' merge-folder-grid--initial'}`}>
        <section className="card card--flush merge-sources" aria-label={t('Sources')}>
          <div className="card-head">
            <span className="card-head-title">
              <Folder size={16} className="card-head-icon" aria-hidden="true" /> {t('Folder')}
            </span>
            {workspace.root && (
              <span className="card-head-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => void workspace.refresh()}
                  disabled={workspace.isBusy}
                  id="merge-refresh-folder"
                  aria-label={t('Refresh folder')}
                  title={t('Refresh folder')}
                >
                  <RefreshCw size={14} className={workspace.isBusy ? 'spin' : undefined} aria-hidden="true" />
                </button>
                {folders.length > 0 && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => workspace.setExpandedPaths(allOpen ? [] : folders)}
                  >
                    {allOpen ? t('Collapse all') : t('Expand all')}
                  </button>
                )}
              </span>
            )}
          </div>

          {!workspace.root ? (
            <div className="merge-folder-empty">
              <FolderOpen size={28} aria-hidden="true" />
              <b>{t('Choose a folder')}</b>
              <small>{t('Its folders and PDFs will be listed here. Nothing is added to the queue automatically.')}</small>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void workspace.chooseFolder()}
                disabled={workspace.isBusy || !workspace.folderModeAvailable}
                id="merge-choose-folder"
              >
                {t('Choose folder')}
              </button>
            </div>
          ) : (
            <div className="merge-root-bar">
              <FolderOpen size={16} className="card-head-icon" aria-hidden="true" />
              <span className="merge-root-path" title={workspace.root.path}>{workspace.root.path}</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => void workspace.chooseFolder()}
                disabled={workspace.isBusy || !workspace.folderModeAvailable}
                id="merge-choose-folder"
              >
                {t('Change folder')}
              </button>
            </div>
          )}

          {workspace.notice && <p className="merge-notice" role="status">{workspace.notice}</p>}

          {workspace.root && workspace.listing && workspace.listing.pdfCount === 0 && (
            <p className="empty-hint">{t('No PDFs in this folder')}</p>
          )}

          {workspace.root && workspace.listing && workspace.listing.pdfCount > 0 && (
            <ul className="merge-tree">
              {workspace.listing.root.folders.map((child) => (
                <FolderRow
                  key={child.relativePath}
                  node={child}
                  depth={0}
                  expanded={workspace.expanded}
                  onToggle={(path) => (path.startsWith('file:') ? addFileRow(path) : workspace.toggleFolder(path))}
                  onAddAll={workspace.addFolder}
                  queued={workspace.isQueued}
                />
              ))}
              {/* The root's own PDFs sit below its folders, as in the tree rule. */}
              {rootFiles.map((name) => {
                const already = workspace.isQueued(name);
                return (
                  <li key={name}>
                    <button
                      type="button"
                      className={`merge-tree-file${already ? ' merge-tree-file--queued' : ''}`}
                      onClick={() => workspace.addFile(name)}
                      disabled={already}
                      aria-label={already ? t('{name} is already queued', { name }) : t('Add {name}', { name })}
                    >
                      <span className="pdf-badge pdf-badge--sm" aria-hidden="true">PDF</span>
                      <span className="merge-tree-name">{name}</span>
                      <AddTag added={already} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {workspace.root && workspace.listing && workspace.listing.pdfCount > 0 && (
            <div className="merge-sources-foot">
              <span>{tn(workspace.listing.pdfCount, '{n} PDF found', '{n} PDFs found')}</span>
              <span>{workspace.queue.length} {t('added')}</span>
            </div>
          )}
        </section>

        <div className="col-stack merge-queue" aria-label={t('Merge queue')} role="region">
          <section className="card card--flush">
            <div className="card-head">
              <span className="card-head-title">
                <FileText size={16} className="card-head-icon" aria-hidden="true" /> {t('Files to Merge')}
                <span className="chip merge-queue-count">{tn(workspace.queue.length, '{n} file', '{n} files')}</span>
              </span>
              {workspace.queue.length > 0 && <span className="card-head-actions">{t('Drag ↑↓ to reorder')}</span>}
            </div>

            {workspace.queue.length === 0 ? (
              <p className="empty-hint merge-queue-empty">{t('Add files from the folder on the left.')}</p>
            ) : (
              <SortableArea ids={workspace.queue} onReorder={reorderQueue} layout="list">
              <ul className="merge-queue-list">
                {workspace.queue.map((relative, index) => (
                  <QueueRow
                    key={relative}
                    relative={relative}
                    info={workspace.fileInfo[relative]}
                    index={index}
                    onRemove={workspace.removeAt}
                    onStep={workspace.step}
                    disabled={workspace.isBusy}
                    onKeyDown={handleRowKeyDown}
                  />
                ))}
              </ul>
              </SortableArea>
            )}
          </section>

          {workspace.problems && (
            <div className="card merge-preflight" role="alertdialog" aria-label={t('Files that cannot be merged')}>
              <p className="merge-preflight-title">
                <AlertTriangle size={14} aria-hidden="true" /> {tn(workspace.problems.length, '{n} file cannot be merged', '{n} files cannot be merged')}
              </p>
              <ul className="merge-preflight-list">
                {workspace.problems.map((problem) => (
                  <li key={problem.path}>
                    <span className="merge-tree-name">{problem.path.split(/[\\/]/).pop()}</span>
                    <span className="merge-queue-folder">{problem.path}</span>
                    <span className="merge-problem-reason">({reasonLabel(problem.reason)})</span>
                  </li>
                ))}
              </ul>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={workspace.cancelPreflight}>{t('Cancel')}</button>
                <button type="button" className="btn btn-primary btn-sm" id="merge-skip-and-merge" onClick={() => void workspace.skipAndMerge()}>
                  {t('Skip these and merge')}
                </button>
              </div>
            </div>
          )}

          {workspace.isMerging && (
            <div className="card status-card" role="status" aria-live="polite" id="merge-folder-progress">
              <Loader2 size={20} className="spin" aria-hidden="true" />
              <div className="status-card-copy">
                <b>{progressTitle}</b>
                <div className={`size-bar size-bar--spaced${percent === null || workspace.progress?.done === 0 ? ' size-bar--busy' : ''}`}>
                  <i style={{ width: `${percent ?? 0}%` }} />
                </div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" id="merge-folder-cancel" onClick={workspace.cancelMerge}>
                {t('Cancel')}
              </button>
            </div>
          )}

          {workspace.error && (
            <div className="converter-message converter-message--error" role="alert">
              <span>{workspace.error}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.dismissError}>{t('Dismiss')}</button>
            </div>
          )}

          {workspace.result && (
            <div className="card status-card status-card--ok">
              <Check size={22} aria-hidden="true" />
              <div className="status-card-copy">
                <p className="merge-result" role="status">
                  {tn(workspace.result.merged, 'Merged {n} file', 'Merged {n} files')}{workspace.result.skipped ? `, ${t('skipped {count}', { count: workspace.result.skipped })}` : ''} · {tn(workspace.result.totalPages, '{n} page', '{n} pages')} · <span className="merge-tree-name">{workspace.result.filename}</span>
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                id="merge-folder-open-folder-btn"
                onClick={() => { void revealPath(workspace.result!.outputPath).catch(() => undefined); }}
                title={t('Show in folder')}
              >
                <FolderOpen size={14} aria-hidden="true" /> {t('Show in folder')}
              </button>
            </div>
          )}

          <div className="card card--flush">
            <div className="card-body">
              <div className="field">
                <label htmlFor="merge-folder-output">{t('Output Filename')}</label>
                <input
                  id="merge-folder-output"
                  className="input"
                  type="text"
                  value={workspace.outputName}
                  onChange={(event) => workspace.setOutputName(event.target.value)}
                  disabled={workspace.isBusy}
                />
                <p className="hint">{t('The .pdf extension will be added automatically if omitted.')}</p>
              </div>
            </div>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={workspace.clearQueue}
              disabled={workspace.isBusy || workspace.queue.length === 0}
            >
              <Trash2 size={15} aria-hidden="true" /> {t('Clear')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              id="merge-folder-run"
              onClick={() => void workspace.requestMerge()}
              disabled={workspace.isBusy || workspace.queue.length < 2}
              title={workspace.queue.length < 2 ? t('Add at least 2 files') : undefined}
            >
              {workspace.isBusy ? (
                <><Loader2 size={15} className="spin" aria-hidden="true" /> {t('Merging…')}</>
              ) : (
                <><Merge size={15} aria-hidden="true" /> {t('Merge PDF')}</>
              )}
            </button>
          </div>
          {workspace.queue.length < 2 && (
            <p className="hint merge-queue-need">{t('Add at least 2 files.')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
