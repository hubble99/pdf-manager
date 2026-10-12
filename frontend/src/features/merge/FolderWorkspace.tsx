import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, FolderOpen, GripVertical,
  Loader2, RefreshCw, X,
} from 'lucide-react';
import { StateView } from '../../components/ui';
import { useFolderMerge } from './useFolderMerge';
import type { FolderFileNode } from './api';

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
      <div className="merge-tree-row" style={{ paddingLeft: depth * 14 + 8 }}>
        <button
          type="button"
          className="merge-tree-toggle"
          onClick={() => onToggle(node.relative_path)}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.name}`}
        >
          {isOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          <FolderOpen size={13} aria-hidden="true" />
          <span className="merge-tree-name">{node.name}</span>
          <span className="merge-tree-count">{node.pdf_count}</span>
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
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
                  style={{ paddingLeft: (depth + 1) * 14 + 8 }}
                  onClick={() => onToggle(`file:${relative}`)}
                  disabled={already}
                  aria-label={already ? `${name} is already queued` : `Add ${name}`}
                >
                  <span className="merge-tree-name">{name}</span>
                  {already && <Check size={12} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function QueueRow({
  relative, index, onRemove, onStep, disabled,
}: {
  relative: string;
  index: number;
  onRemove: (index: number) => void;
  onStep: (index: number, direction: -1 | 1) => void;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: relative, disabled });
  const name = relative.split('/').pop() ?? relative;
  const folder = relative.includes('/') ? `${relative.slice(0, relative.lastIndexOf('/'))}/` : '';

  return (
    <li
      ref={setNodeRef}
      className="merge-queue-row"
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="merge-queue-handle"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${name}`}
        disabled={disabled}
      >
        <GripVertical size={13} aria-hidden="true" />
      </button>
      <span className="merge-queue-index">{index + 1}</span>
      <span className="merge-queue-copy">
        <span className="merge-queue-name">{name}</span>
        {/* Always shown, so rows never change height and duplicate names stay clear. */}
        <span className="merge-queue-folder">{folder || '\u00a0'}</span>
      </span>
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
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    workspace.moveAt(workspace.queue.indexOf(String(active.id)), workspace.queue.indexOf(String(over.id)));
  };

  const addFileRow = (relative: string) => {
    // A file row reuses the toggle handler for folders; route it by prefix.
    if (relative.startsWith('file:')) workspace.addFile(relative.slice(5));
  };

  return (
    <div className="page-body page-body--workspace">
      <div className="merge-folder-layout">
        <section className="card merge-sources" aria-label="Sources">
          <div className="merge-panel-head">
            <span className="merge-panel-title">Sources</span>
            <span className="merge-panel-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void workspace.chooseFolder()} disabled={workspace.isBusy || !workspace.folderModeAvailable} id="merge-choose-folder">
                <FolderOpen size={13} aria-hidden="true" /> Choose folder
              </button>
              {workspace.root && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void workspace.refresh()} disabled={workspace.isBusy} id="merge-refresh-folder">
                  <RefreshCw size={13} aria-hidden="true" /> Refresh
                </button>
              )}
            </span>
          </div>

          {workspace.root && <p className="merge-root-path" title={workspace.root.path}>{workspace.root.path}</p>}
          {workspace.notice && <p className="merge-notice" role="status">{workspace.notice}</p>}

          {!workspace.root ? (
            <StateView
              icon={FolderOpen}
              title="No folder chosen"
              description="Choose a folder to list the PDFs inside it. Nothing is added to the queue automatically."
              compact
            />
          ) : workspace.listing && workspace.listing.pdf_count === 0 ? (
            <StateView icon={FolderOpen} title="No PDFs in this folder" compact />
          ) : workspace.listing ? (
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
              {workspace.listing.root.files.map((name) => {
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
                      <span className="merge-tree-name">{name}</span>
                      {already && <Check size={12} aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        <section className="card merge-queue" aria-label="Merge queue">
          <div className="merge-panel-head">
            <span className="merge-panel-title">Merge queue</span>
            <span className="merge-queue-count">{workspace.queue.length} file{workspace.queue.length === 1 ? '' : 's'}</span>
          </div>

          {workspace.queue.length === 0 ? (
            <StateView icon={FolderOpen} title="Add files from the folder on the left." compact />
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={workspace.queue} strategy={verticalListSortingStrategy}>
                <ul className="merge-queue-list">
                  {workspace.queue.map((relative, index) => (
                    <QueueRow
                      key={relative}
                      relative={relative}
                      index={index}
                      onRemove={workspace.removeAt}
                      onStep={workspace.step}
                      disabled={workspace.isBusy}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}

          {workspace.problems && (
            <div className="merge-preflight" role="alertdialog" aria-label="Files that cannot be merged">
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
              <div className="merge-panel-actions">
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
            <p className="merge-result" role="status">
              Merged {workspace.result.merged} files{workspace.result.skipped ? `, skipped ${workspace.result.skipped}` : ''} · {workspace.result.totalPages} pages · <span className="merge-tree-name">{workspace.result.filename}</span>
            </p>
          )}

          <div className="merge-queue-footer">
            <label className="organize-field-label" htmlFor="merge-folder-output">Output name</label>
            <input
              id="merge-folder-output"
              className="input"
              type="text"
              value={workspace.outputName}
              onChange={(event) => workspace.setOutputName(event.target.value)}
              disabled={workspace.isBusy}
            />
            <div className="merge-panel-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={workspace.clearQueue}
                disabled={workspace.isBusy || workspace.queue.length === 0}
              >
                Clear
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                id="merge-folder-run"
                onClick={() => void workspace.requestMerge()}
                disabled={workspace.isBusy || workspace.queue.length < 2}
                title={workspace.queue.length < 2 ? 'Add at least 2 files' : undefined}
              >
                {workspace.isBusy ? (
                  <><Loader2 size={14} className="converter-spin" aria-hidden="true" /> Merging…</>
                ) : (
                  'Merge'
                )}
              </button>
            </div>
            {workspace.queue.length < 2 && (
              <p className="organize-help">Add at least 2 files.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
