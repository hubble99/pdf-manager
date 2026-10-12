import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { sourceLetter } from './pageList';
import type { InsertMode, InsertPosition, SourceHandle } from './types';

interface InsertPanelProps {
  source: SourceHandle | null;
  mode: InsertMode;
  pagesInput: string;
  position: InsertPosition;
  reference: number;
  total: number;
  preview: {
    pages: number[];
    error: string | null;
    reference: number;
    referenceError: string | null;
    targetIndex: number;
  };
  disabled: boolean;
  onModeChange: (mode: InsertMode) => void;
  onPagesInputChange: (value: string) => void;
  onPositionChange: (position: InsertPosition) => void;
  onReferenceChange: (reference: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function InsertPanel({
  source, mode, pagesInput, position, reference, total, preview, disabled,
  onModeChange, onPagesInputChange, onPositionChange, onReferenceChange, onConfirm, onCancel,
}: InsertPanelProps) {
  if (!source) return null;

  // A single-page source has nothing to choose, so the Pages control is dropped
  // entirely and the panel stays compact.
  const showPages = source.pageCount > 1;
  const pagesInvalid = Boolean(preview.error);
  const referenceInvalid = Boolean(preview.referenceError);
  const canInsert = !disabled && !pagesInvalid && !referenceInvalid
    && preview.pages.length > 0 && total > 0;

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

      <div className="organize-panel-grid">
        {showPages && (
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
            {mode === 'pick' && (
              <>
                <input
                  className="input"
                  type="text"
                  value={pagesInput}
                  onChange={(event) => onPagesInputChange(event.target.value)}
                  placeholder="e.g. 1-5, 8, 10-12"
                  disabled={disabled}
                  aria-label="Pages to insert from the source file"
                  aria-invalid={pagesInvalid || undefined}
                  aria-describedby="insert-pages-help"
                  autoComplete="off"
                />
                <p
                  id="insert-pages-help"
                  className={`organize-help${pagesInvalid ? ' organize-help--error' : ''}`}
                  role={pagesInvalid ? 'alert' : undefined}
                >
                  {pagesInvalid
                    ? preview.error
                    : `${preview.pages.length} page${preview.pages.length === 1 ? '' : 's'} from the source file, in the order typed.`}
                </p>
              </>
            )}
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
          <div className="organize-reference">
            <label className="organize-help" htmlFor="organize-insert-reference">Reference page</label>
            <input
              id="organize-insert-reference"
              className="input organize-reference-input"
              type="number"
              min={1}
              max={Math.max(1, total)}
              value={Number.isFinite(reference) ? reference : ''}
              onChange={(event) => onReferenceChange(
                event.target.value === '' ? Number.NaN : Number(event.target.value),
              )}
              disabled={disabled || total === 0}
              aria-invalid={referenceInvalid || undefined}
              aria-describedby="organize-reference-help"
            />
            <span className="organize-help">of {total}</span>
          </div>
        </div>
      </div>

      <p
        id="organize-reference-help"
        className={`organize-help${referenceInvalid ? ' organize-help--error' : ''}`}
        role={referenceInvalid ? 'alert' : undefined}
      >
        {referenceInvalid
          ? preview.referenceError
          : `Will be inserted ${position} page ${preview.reference} (of ${total}).`}
      </p>

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
