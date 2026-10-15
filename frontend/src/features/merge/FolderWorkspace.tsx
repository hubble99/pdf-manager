import {
  AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, FileText, Folder, FolderOpen,
  Loader2, Merge, Plus, RefreshCw, Trash2, X,
} from 'lucide-react';
import { useRowReorder } from '../../hooks/useRowReorder';
import type { RowReorderHandlers } from '../../hooks/useRowReorder';
import { useFolderMerge } from './useFolderMerge';
import type { FolderFileNode } from './api';

/** Every folder path in a listing, so one control can open or close the whole tree. */
function folderPaths(node: FolderFileNode): string[] {
  return node.folders.flatMap((child) => [child.relative_path, ...folderPaths(child)]);
}

function FolderRow({
  node, depth, expanded, onToggle, onAddAll, queued,
}: {
  node: FolderFileNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onAddAll: (node: FolderFileNode) => void;
  queued: (path: string) => boolean;
}) {
  const isOpen = expanded.has(node.relative_path);
  return (
    <li className="merge-tree-folder">
      <div className="merge-tree-row" style={{ paddingLeft: depth * 18 + 10 }}>
        <button
          type="button"
          className="merge-tree-toggle"
          onClick={() => onToggle(node.relative_path)}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.name}`}
        >
          {isOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
          {isOpen
            ? <FolderOpen size={16} className="merge-tree-folder-icon" aria-hidden="true" />
            : <Folder size={16} className="merge-tree-folder-icon" aria-hidden="true" />}
          <span className="merge-tree-name">{node.name}</span>
          <span className="chip merge-tree-count">{node.pdf_count}</span>
        </button>
        <button
          type="button"
          className="link-btn merge-tree-addall"
          onClick={() => onAddAll(node)}
          aria-label={`Add all ${node.pdf_count} PDFs under ${node.name}`}
        >
          Add all
        </button>
      </div>

      {isOpen && (
        <ul className="merge-tree-children">
          {node.folders.map((child) => (
            <FolderRow
              key={child.relative_path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onAddAll={onAddAll}
              queued={queued}
            />
          ))}
          {node.files.map((name) => {
            const relative = node.relative_path ? `${node.relative_path}/${name}` : name;
            const already = queued(relative);
            return (
              <li key={relative}>
                <button
                  type="button"
                  className={`merge-tree-file${already ? ' merge-tree-file--queued' : ''}`}
                  style={{ paddingLeft: (depth + 1) * 18 + 32 }}
                  onClick={() => onToggle(`file:${relative}`)}
                  disabled={already}
                  aria-label={already ? `${name} is already queued` : `Add ${name}`}
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
      {added ? 'Added' : 'Add'}
    </span>
  );
}

function QueueRow({
  relative, index, onRemove, onStep, disabled, reorderProps, dragging, onKeyDown,
}: {
  relative: string;
  index: number;
  onRemove: (index: number) => void;
  onStep: (index: number, direction: -1 | 1) => void;
  disabled: boolean;
  reorderProps: (id: string) => RowReorderHandlers;
  dragging: boolean;
  onKeyDown: (event: React.KeyboardEvent<HTMLLIElement>, index: number) => void;
}) {
  const name = relative.split('/').pop() ?? relative;
  const folder = relative.includes('/') ? `${relative.slice(0, relative.lastIndexOf('/'))}/` : '';

  return (
    <li
      className={[
        'merge-queue-row',
        'merge-queue-row--draggable',
        dragging ? 'merge-queue-row--dragging' : '',
      ].filter(Boolean).join(' ')}
      tabIndex={0}
      onKeyDown={(event) => onKeyDown(event, index)}
      title="Drag to reorder, or press Alt+Up / Alt+Down"
      {...(disabled ? {} : reorderProps(relative))}
    >
      <span className="pdf-badge" aria-hidden="true">PDF</span>
      <span className="merge-queue-copy">
        <span className="merge-queue-name">{name}</span>
        {/* Always shown, so rows never change height and duplicate names stay clear. */}
        <span className="merge-queue-folder">{folder || '\u00a0'}</span>
      </span>
      <span className="chip merge-queue-index">#{index + 1}</span>
      <span className="merge-queue-actions">
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => onStep(index, -1)} disabled={disabled || index === 0} aria-label={`Move ${name} up`}>
          <ArrowUp size={13} aria-hidden="true" />
        </button>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => onStep(index, 1)} disabled={disabled} aria-label={`Move ${name} down`}>
          <ArrowDown size={13} aria-hidden="true" />
        </button>
        <button type="button" className="btn btn-ghost btn-icon btn-sm converter-danger" onClick={() => onRemove(index)} disabled={disabled} aria-label={`Remove ${name}`}>
          <X size={13} aria-hidden="true" />
        </button>
      </span>
    </li>
  );
}

export function FolderWorkspace() {
  const workspace = useFolderMerge();
  const { activeId, rowProps } = useRowReorder((fromId, toId) => {
    workspace.moveAt(workspace.queue.indexOf(fromId), workspace.queue.indexOf(toId));
  });

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

  const folders = workspace.listing ? folderPaths(workspace.listing.root) : [];
  const allOpen = folders.length > 0 && folders.every((path) => workspace.expanded.has(path));
  const rootFiles = workspace.listing?.root.files ?? [];

  return (
    <div className="page-body">
      <div className="form-col form-col--wide form-col--two merge-folder-grid">
        <section className="card card--flush merge-sources" aria-label="Sources">
          <div className="card-head">
            <span className="card-head-title">
              <Folder size={16} className="card-head-icon" aria-hidden="true" /> Folder
            </span>
            {workspace.root && (
              <span className="card-head-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => void workspace.refresh()}
                  disabled={workspace.isBusy}
                  id="merge-refresh-folder"
                  aria-label="Refresh folder"
                  title="Refresh folder"
                >
                  <RefreshCw size={14} className={workspace.isBusy ? 'spin' : undefined} aria-hidden="true" />
                </button>
                {folders.length > 0 && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => workspace.setExpandedPaths(allOpen ? [] : folders)}
                  >
                    {allOpen ? 'Collapse all' : 'Expand all'}
                  </button>
                )}
              </span>
            )}
          </div>

          {!workspace.root ? (
            <div className="merge-folder-empty">
              <FolderOpen size={28} aria-hidden="true" />
              <b>Choose a folder</b>
              <small>Its folders and PDFs will be listed here. Nothing is added to the queue automatically.</small>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void workspace.chooseFolder()}
                disabled={workspace.isBusy || !workspace.folderModeAvailable}
                id="merge-choose-folder"
              >
                Choose folder
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
                Change folder
              </button>
            </div>
          )}

          {workspace.notice && <p className="merge-notice" role="status">{workspace.notice}</p>}

          {workspace.root && workspace.listing && workspace.listing.pdf_count === 0 && (
            <p className="empty-hint">No PDFs in this folder</p>
          )}

          {workspace.root && workspace.listing && workspace.listing.pdf_count > 0 && (
            <ul className="merge-tree">
              {workspace.listing.root.folders.map((child) => (
                <FolderRow
                  key={child.relative_path}
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
                      aria-label={already ? `${name} is already queued` : `Add ${name}`}
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

          {workspace.root && workspace.listing && workspace.listing.pdf_count > 0 && (
            <div className="merge-sources-foot">
              <span>{workspace.listing.pdf_count} PDF{workspace.listing.pdf_count === 1 ? '' : 's'} found</span>
              <span>{workspace.queue.length} added</span>
            </div>
          )}
        </section>

        <div className="col-stack merge-queue" aria-label="Merge queue" role="region">
          <section className="card card--flush">
            <div className="card-head">
              <span className="card-head-title">
                <FileText size={16} className="card-head-icon" aria-hidden="true" /> Files to Merge
                <span className="chip merge-queue-count">{workspace.queue.length} file{workspace.queue.length === 1 ? '' : 's'}</span>
              </span>
              {workspace.queue.length > 0 && <span className="card-head-actions">Drag ↑↓ to reorder</span>}
            </div>

            {workspace.queue.length === 0 ? (
              <p className="empty-hint merge-queue-empty">Add files from the folder on the left.</p>
            ) : (
              <ul className="merge-queue-list">
                {workspace.queue.map((relative, index) => (
                  <QueueRow
                    key={relative}
                    relative={relative}
                    index={index}
                    onRemove={workspace.removeAt}
                    onStep={workspace.step}
                    disabled={workspace.isBusy}
                    reorderProps={rowProps}
                    dragging={activeId === relative}
                    onKeyDown={handleRowKeyDown}
                  />
                ))}
              </ul>
            )}
          </section>

          {workspace.problems && (
            <div className="card merge-preflight" role="alertdialog" aria-label="Files that cannot be merged">
              <p className="merge-preflight-title">
                <AlertTriangle size={14} aria-hidden="true" /> {workspace.problems.length} file{workspace.problems.length === 1 ? '' : 's'} cannot be merged
              </p>
              <ul className="merge-preflight-list">
                {workspace.problems.map((problem) => (
                  <li key={problem.path}>
                    <span className="merge-tree-name">{problem.path.split(/[\\/]/).pop()}</span>
                    <span className="merge-queue-folder">{problem.path}</span>
                    <span className="merge-problem-reason">({problem.reason})</span>
                  </li>
                ))}
              </ul>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={workspace.cancelPreflight}>Cancel</button>
                <button type="button" className="btn btn-primary btn-sm" id="merge-skip-and-merge" onClick={() => void workspace.skipAndMerge()}>
                  Skip these and merge
                </button>
              </div>
            </div>
          )}

          {workspace.error && (
            <div className="converter-message converter-message--error" role="alert">
              <span>{workspace.error}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.dismissError}>Dismiss</button>
            </div>
          )}

          {workspace.result && (
            <div className="card status-card status-card--ok">
              <Check size={22} aria-hidden="true" />
              <div className="status-card-copy">
                <p className="merge-result" role="status">
                  Merged {workspace.result.merged} files{workspace.result.skipped ? `, skipped ${workspace.result.skipped}` : ''} · {workspace.result.totalPages} pages · <span className="merge-tree-name">{workspace.result.filename}</span>
                </p>
              </div>
            </div>
          )}

          <div className="card card--flush">
            <div className="card-body">
              <div className="field">
                <label htmlFor="merge-folder-output">Output Filename</label>
                <input
                  id="merge-folder-output"
                  className="input"
                  type="text"
                  value={workspace.outputName}
                  onChange={(event) => workspace.setOutputName(event.target.value)}
                  disabled={workspace.isBusy}
                />
                <p className="hint">The .pdf extension will be added automatically if omitted.</p>
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
              <Trash2 size={15} aria-hidden="true" /> Clear
            </button>
            <button
              type="button"
              className="btn btn-primary"
              id="merge-folder-run"
              onClick={() => void workspace.requestMerge()}
              disabled={workspace.isBusy || workspace.queue.length < 2}
              title={workspace.queue.length < 2 ? 'Add at least 2 files' : undefined}
            >
              {workspace.isBusy ? (
                <><Loader2 size={15} className="spin" aria-hidden="true" /> Merging…</>
              ) : (
                <><Merge size={15} aria-hidden="true" /> Merge &amp; Download</>
              )}
            </button>
          </div>
          {workspace.queue.length < 2 && (
            <p className="hint merge-queue-need">Add at least 2 files.</p>
          )}
        </div>
      </div>
    </div>
  );
}
