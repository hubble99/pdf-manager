import { useState } from 'react';
import { ArrowDown, ArrowUp, FileImage, FilePlus2, Plus, Trash2, X } from 'lucide-react';
import { RadioCardGroup } from '../../components/ui';
import { sourceLetter } from './pageList';
import type { InsertMode, InsertPosition, SourceHandle } from './types';
import { t, tn } from '../../i18n';

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
  const SourceIcon = source.kind === 'image' ? FileImage : FilePlus2;

  // The pages that will sit on either side of the new ones, so the result is visible
  // before it happens.
  const before = position === 'after' ? preview.reference : preview.reference - 1;
  const neighbours = {
    previous: before >= 1 ? t('Page {n}', { n: before }) : t('Start'),
    next: before + 1 <= total ? t('Page {n}', { n: before + 1 }) : t('End'),
  };

  const summary = (
    <div className={`organize-insert-summary${referenceInvalid ? ' organize-insert-summary--error' : ''}`}>
      {referenceInvalid ? null : (
        <span className="organize-insert-strip" aria-hidden="true">
          <span className="organize-strip-chip">{neighbours.previous}</span>
          <span className="organize-strip-chip organize-strip-chip--new">
            <Plus size={12} />
            {tn(preview.pages.length, '{n} new page', '{n} new pages')}
          </span>
          <span className="organize-strip-chip">{neighbours.next}</span>
        </span>
      )}
      <p
        id="organize-reference-help"
        className={`organize-help${referenceInvalid ? ' organize-help--error' : ''}`}
        role={referenceInvalid ? 'alert' : undefined}
      >
        {referenceInvalid
          ? preview.referenceError
          : t('Will be inserted {position} page {reference} (of {total}).', { position, reference: preview.reference, total })}
      </p>
    </div>
  );

  return (
    <section className="card organize-panel organize-insert" aria-label={t('Insert pages')}>
      <div className="organize-panel-head">
        <span className="organize-insert-file">
          <span className="organize-insert-icon" aria-hidden="true"><SourceIcon size={18} /></span>
          <span className="organize-insert-copy">
            <span className="organize-panel-title organize-insert-name" title={source.name}>
              {source.name}
            </span>
            <span className="organize-help">
              {source.kind === 'image' ? t('Image') : 'PDF'} · {tn(source.pageCount, '{n} page', '{n} pages')}
            </span>
          </span>
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onCancel}
          aria-label={t('Close insert panel')}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="organize-panel-grid">
        {showPages && (
          <div className="organize-insert-section">
            <span className="organize-field-label" id="insert-pages-label">{t('Pages')}</span>
            <RadioCardGroup
              labelledBy="insert-pages-label"
              name="insert-pages-mode"
              idPrefix="insert-pages"
              value={mode}
              disabled={disabled}
              onChange={onModeChange}
              options={[
                { value: 'all', label: t('All'), desc: t('Every page of the file') },
                { value: 'pick', label: t('Pick'), desc: t('Choose which pages to use') },
              ]}
            />
            {mode === 'pick' && (
              <>
                <input
                  className="input"
                  type="text"
                  value={pagesInput}
                  onChange={(event) => onPagesInputChange(event.target.value)}
                  placeholder="e.g. 1-5, 8, 10-12"
                  disabled={disabled}
                  aria-label={t('Pages to insert from the source file')}
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
                    : tn(preview.pages.length, '{n} page from the source file, in the order typed.', '{n} pages from the source file, in the order typed.')}
                </p>
              </>
            )}
          </div>
        )}

        <div className="organize-insert-section">
          <span className="organize-field-label" id="insert-position-label">{t('Position')}</span>
          <RadioCardGroup
            labelledBy="insert-position-label"
            name="insert-position"
            idPrefix="insert-position"
            value={position}
            disabled={disabled}
            onChange={onPositionChange}
            options={[
              { value: 'after', label: t('After'), desc: t('Placed after the reference page') },
              { value: 'before', label: t('Before'), desc: t('Placed before the reference page') },
            ]}
          />
          <div className="organize-insert-inline">
          <div className="organize-reference">
            <label className="organize-help" htmlFor="organize-insert-reference">{t('Reference page')}</label>
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
            <span className="organize-help">{t('of')} {total}</span>
          </div>
          {!showPages && summary}
          </div>
        </div>
      </div>

      {showPages && summary}

      <div className="organize-panel-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={disabled}>
          {t('Cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          id="organize-insert-confirm"
          onClick={onConfirm}
          disabled={!canInsert}
        >
          <Plus size={14} aria-hidden="true" />
          {t('Insert')}
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
  // Nothing typed yet is not a mistake: the hint says which pages can be deleted.
  const empty = value.trim() === '';
  const invalid = !empty && Boolean(preview.error);
  const canDelete = !disabled && !invalid && preview.positions.length > 0;

  return (
    <section className="card organize-panel" aria-label={t('Delete pages')}>
      <div className="organize-panel-head">
        <span className="organize-panel-title">{t('Delete pages')}</span>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onCancel}
          aria-label={t('Close delete panel')}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="organize-field">
        <label className="organize-field-label" htmlFor="organize-delete-input">{t('Pages')}</label>
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
            : empty
              ? t('You can delete any page from 1 to {total}. Type page numbers or ranges, for example 20-45, 50.', { total })
              : tn(preview.positions.length, 'Numbers are current positions in the grid (1-{total}). Will delete {n} page, highlighted in the grid.', 'Numbers are current positions in the grid (1-{total}). Will delete {n} pages, highlighted in the grid.', { total })}
        </p>
      </div>

      <div className="organize-panel-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={disabled}>
          {t('Cancel')}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          id="organize-delete-confirm"
          onClick={onConfirm}
          disabled={!canDelete}
        >
          <Trash2 size={14} aria-hidden="true" />
          {t('Delete')}
        </button>
      </div>
    </section>
  );
}

interface SourcesPanelProps {
  /** Every source of the document; the main PDF is shown in the header, not here. */
  sources: SourceHandle[];
  mainSourceId: string | null;
  disabled: boolean;
  onReinsert: (sourceId: string) => void;
  onRemove: (sourceId: string) => void;
  onClose: () => void;
}

export function SourcesPanel({ sources, mainSourceId, disabled, onReinsert, onRemove, onClose }: SourcesPanelProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  // The letters match the badge on the grid cells, so they keep the position the
  // file has among all sources even though the main PDF is not listed.
  const inserted = sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => source.id !== mainSourceId);

  return (
    <section className="card organize-panel" aria-label={t('Sources')}>
      <div className="organize-panel-head">
        <span className="organize-panel-title">{t('Sources')}</span>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onClose}
          aria-label={t('Close Sources')}
          title={t('Close')}
          id="organize-sources-close"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {inserted.length === 0 ? (
        <p className="organize-help">{t('No inserted files yet. Files you insert are listed here.')}</p>
      ) : (
        <ul className="organize-source-list">
          {inserted.map(({ source, index }) => (
            <li key={source.id} className="organize-source-row">
              <span className="organize-cell-source" aria-hidden="true">
                {sourceLetter(index)}
              </span>
              <span className="organize-source-name">
                {source.name}
                <span className="organize-help"> · {tn(source.pageCount, '{n} page', '{n} pages')}</span>
              </span>

              {confirming === source.id ? (
                <span className="organize-source-confirm">
                  <span className="organize-help">{t('Remove its pages too?')}</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => { setConfirming(null); onRemove(source.id); }}
                  >
                    {t('Confirm')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirming(null)}
                  >
                    {t('Cancel')}
                  </button>
                </span>
              ) : (
                <span className="organize-source-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    onClick={() => onReinsert(source.id)}
                    disabled={disabled}
                    title={t('Insert again from this file')}
                    aria-label={t('Insert again from {name}', { name: source.name })}
                  >
                    <Plus size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm organize-danger"
                    onClick={() => setConfirming(source.id)}
                    disabled={disabled}
                    title={t('Remove this file and its pages')}
                    aria-label={t('Remove {name}', { name: source.name })}
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
        {t('Drag any page in the grid to reorder it.')}
      </p>
    </section>
  );
}
