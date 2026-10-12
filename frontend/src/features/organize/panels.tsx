import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { sourceLetter } from './pageList';
import type { InsertMode, InsertPosition } from './useOrganizeWorkspace';
import type { SourceHandle } from './types';

interface InsertPanelProps {
  source: SourceHandle | null;
  mode: InsertMode;
  pagesInput: string;
  position: InsertPosition;
  preview: { pages: number[]; error: string | null };
  selectionCount: number;
  disabled: boolean;
  onModeChange: (mode: InsertMode) => void;
  onPagesInputChange: (value: string) => void;
  onPositionChange: (position: InsertPosition) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function InsertPanel({
  source, mode, pagesInput, position, preview, selectionCount, disabled,
  onModeChange, onPagesInputChange, onPositionChange, onConfirm, onCancel,
}: InsertPanelProps) {
  if (!source) return null;
  const isImage = source.kind === 'image';
  const invalid = Boolean(preview.error);
  const canInsert = !disabled && !invalid && preview.pages.length > 0;

  const relative = selectionCount === 0
    ? (position === 'after' ? 'the end of the document' : 'the start of the document')
    : `${selectionCount} selected page${selectionCount === 1 ? '' : 's'}`;

  return (
    <section className="card organize-panel" aria-label="Insert pages">
      <div className="organize-panel-head">
        <span className="organize-panel-title">
          Insert: {source.name} ({source.pageCount} page{source.pageCount === 1 ? '' : 's'})
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onCancel}
          aria-label="Close insert panel"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {!isImage && (
        <div className="organize-field">
          <span className="organize-field-label" id="insert-pages-label">Pages</span>
          <div role="radiogroup" aria-labelledby="insert-pages-label" className="organize-choices">
            <label className="organize-choice">
              <input
                type="radio"
                name="insert-pages-mode"
                checked={mode === 'all'}
                onChange={() => onModeChange('all')}
                disabled={disabled}
              />
              <span>All</span>
            </label>
            <label className="organize-choice">
              <input
                type="radio"
                name="insert-pages-mode"
                checked={mode === 'pick'}
                onChange={() => onModeChange('pick')}
                disabled={disabled}
              />
              <span>Pick</span>
            </label>
          </div>
          <input
            className="input"
            type="text"
            value={pagesInput}
            onChange={(event) => onPagesInputChange(event.target.value)}
            placeholder="e.g. 1-5, 8, 10-12"
            disabled={disabled || mode === 'all'}
            aria-label="Pages to insert from the source file"
            aria-invalid={invalid || undefined}
            aria-describedby="insert-pages-help"
            autoComplete="off"
          />
          <p id="insert-pages-help" className={`organize-help${invalid ? ' organize-help--error' : ''}`} role={invalid ? 'alert' : undefined}>
            {invalid
              ? preview.error
              : `Numbers refer to pages of the source file. ${preview.pages.length} page${preview.pages.length === 1 ? '' : 's'} will be inserted, in the order typed.`}
          </p>
        </div>
      )}

      <div className="organize-field">
        <span className="organize-field-label" id="insert-position-label">Position</span>
        <div role="radiogroup" aria-labelledby="insert-position-label" className="organize-choices">
          <label className="organize-choice">
            <input
              type="radio"
              name="insert-position"
              checked={position === 'after'}
              onChange={() => onPositionChange('after')}
              disabled={disabled}
            />
            <span>After</span>
          </label>
          <label className="organize-choice">
            <input
              type="radio"
              name="insert-position"
              checked={position === 'before'}
              onChange={() => onPositionChange('before')}
              disabled={disabled}
            />
            <span>Before</span>
          </label>
        </div>
        <p className="organize-help">Relative to {relative}.</p>
      </div>

      <div className="organize-panel-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={disabled}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          id="organize-insert-confirm"
          onClick={onConfirm}
          disabled={!canInsert}
        >
          <Plus size={14} aria-hidden="true" />
          Insert
        </button>
      </div>
    </section>
  );
}

interface DeletePagesPanelProps {
  value: string;
  total: number;
  preview: { positions: number[]; error: string | null };
  disabled: boolean;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeletePagesPanel({
  value, total, preview, disabled, onChange, onConfirm, onCancel,
}: DeletePagesPanelProps) {
  const invalid = Boolean(preview.error);
  const canDelete = !disabled && !invalid && preview.positions.length > 0;

  return (
    <section className="card organize-panel" aria-label="Delete pages">
      <div className="organize-panel-head">
        <span className="organize-panel-title">Delete pages</span>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onCancel}
          aria-label="Close delete panel"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="organize-field">
        <label className="organize-field-label" htmlFor="organize-delete-input">Pages</label>
        <input
          id="organize-delete-input"
          className="input"
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="e.g. 20-45, 50, 61-80"
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby="organize-delete-help"
          autoComplete="off"
        />
        <p
          id="organize-delete-help"
          className={`organize-help${invalid ? ' organize-help--error' : ''}`}
          role={invalid ? 'alert' : undefined}
        >
          {invalid
            ? preview.error
            : `Numbers are current positions in the grid (1-${total}). Will delete ${preview.positions.length} page${preview.positions.length === 1 ? '' : 's'}, highlighted in the grid.`}
        </p>
      </div>

      <div className="organize-panel-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={disabled}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          id="organize-delete-confirm"
          onClick={onConfirm}
          disabled={!canDelete}
        >
          <Trash2 size={14} aria-hidden="true" />
          Delete
        </button>
      </div>
    </section>
  );
}

interface SourcesPanelProps {
  sources: SourceHandle[];
  disabled: boolean;
  onReinsert: (sourceId: string) => void;
  onRemove: (sourceId: string) => void;
}

export function SourcesPanel({ sources, disabled, onReinsert, onRemove }: SourcesPanelProps) {
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <section className="card organize-panel" aria-label="Sources">
      <div className="organize-panel-head">
        <span className="organize-panel-title">Sources</span>
      </div>

      {sources.length === 0 ? (
        <p className="organize-help">No files yet.</p>
      ) : (
        <ul className="organize-source-list">
          {sources.map((source, index) => (
            <li key={source.id} className="organize-source-row">
              <span className="organize-cell-source" aria-hidden="true">
                {sourceLetter(index)}
              </span>
              <span className="organize-source-name">
                {source.name}
                <span className="organize-help"> · {source.pageCount} page{source.pageCount === 1 ? '' : 's'}</span>
              </span>

              {confirming === source.id ? (
                <span className="organize-source-confirm">
                  <span className="organize-help">Remove its pages too?</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => { setConfirming(null); onRemove(source.id); }}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <span className="organize-source-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    onClick={() => onReinsert(source.id)}
                    disabled={disabled}
                    title="Insert again from this file"
                    aria-label={`Insert again from ${source.name}`}
                  >
                    <Plus size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm organize-danger"
                    onClick={() => setConfirming(source.id)}
                    disabled={disabled}
                    title="Remove this file and its pages"
                    aria-label={`Remove ${source.name}`}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="organize-help">
        <ArrowUp size={11} aria-hidden="true" /> <ArrowDown size={11} aria-hidden="true" />{' '}
        Drag any page in the grid to reorder it.
      </p>
    </section>
  );
}
