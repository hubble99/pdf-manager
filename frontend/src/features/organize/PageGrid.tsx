import { memo, useMemo } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Copy, FlipVertical2, RotateCw, Trash2 } from 'lucide-react';
import { sourceLetter } from './pageList';
import type { InsertPosition, PageRef, SourceHandle } from './types';
import { t } from '../../i18n';

export interface PageGridProps {
  pages: PageRef[];
  sources: SourceHandle[];
  thumbnails: Record<string, string>;
  selection: Set<number>;
  highlighted: Set<number>;
  /** Zero-based cell showing where an insertion will land, and on which side. */
  markerIndex: number | null;
  markerSide: InsertPosition;
  disabled: boolean;
  onSelect: (index: number, modifiers: { toggle: boolean; range: boolean }) => void;
  onRotate: (index: number) => void;
  onFlip: (index: number) => void;
  onDuplicate: (index: number) => void;
  onRemove: (index: number) => void;
  onReorder: (from: number, to: number) => void;
}

function sourceLabel(sources: SourceHandle[], sourceId: string): string | null {
  const index = sources.findIndex((source) => source.id === sourceId);
  // Pages of the main document carry no badge; inserted files match the letter
  // shown for them in the Sources panel.
  if (index <= 0) return null;
  return sourceLetter(index);
}

const PageCell = memo(function PageCell({
  page, position, label, thumbnail, selected, highlighted, marker, disabled,
  onSelect, onRotate, onFlip, onDuplicate, onRemove,
}: {
  page: PageRef;
  position: number;
  label: string | null;
  thumbnail: string | undefined;
  selected: boolean;
  highlighted: boolean;
  marker: InsertPosition | null;
  disabled: boolean;
  onSelect: PageGridProps['onSelect'];
  onRotate: (index: number) => void;
  onFlip: (index: number) => void;
  onDuplicate: (index: number) => void;
  onRemove: (index: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: page.key,
    disabled,
  });

  return (
    <div
      ref={setNodeRef}
      className={[
        'organize-cell',
        selected ? 'organize-cell--selected' : '',
        highlighted ? 'organize-cell--highlighted' : '',
        marker ? `organize-cell--marker-${marker}` : '',
        isDragging ? 'organize-cell--dragging' : '',
      ].filter(Boolean).join(' ')}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-position={position + 1}
      data-page-key={page.key}
    >
      <div className="organize-cell-head">
        <label className="organize-cell-select" title={t('Select page at position {position}', { position: position + 1 })}>
          <input
            type="checkbox"
            checked={selected}
            disabled={disabled}
            onChange={(event) => onSelect(position, {
              toggle: true,
              range: (event.nativeEvent as MouseEvent).shiftKey === true,
            })}
            aria-label={t('Select page at position {position}', { position: position + 1 })}
          />
        </label>
        <span className="organize-cell-position">{position + 1}</span>
        {label && <span className="organize-cell-source">{label}</span>}
      </div>

      <button
        type="button"
        {...attributes}
        {...listeners}
        className="organize-cell-body"
        aria-label={t('Page at position {position}', { position: position + 1 })}
        aria-pressed={selected}
        disabled={disabled}
        onClick={(event) => onSelect(position, {
          toggle: event.ctrlKey || event.metaKey,
          range: event.shiftKey,
        })}
      >
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            draggable={false}
            style={{ transform: `rotate(${page.rotation}deg) ${page.flip ? 'scaleX(-1)' : ''}` }}
          />
        ) : (
          <span className="organize-cell-placeholder" aria-hidden="true" />
        )}
      </button>

      <div className="organize-cell-actions">
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={() => onRotate(position)}
          disabled={disabled}
          aria-label={t('Rotate page at position {position}', { position: position + 1 })}
          title={t('Rotate 90°')}
        >
          <RotateCw size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={() => onFlip(position)}
          disabled={disabled}
          aria-label={t('Mirror page at position {position}', { position: position + 1 })}
          title={t('Mirror horizontally')}
        >
          <FlipVertical2 size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={() => onDuplicate(position)}
          disabled={disabled}
          aria-label={t('Duplicate page at position {position}', { position: position + 1 })}
          title={t('Duplicate')}
        >
          <Copy size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm organize-danger"
          onClick={() => onRemove(position)}
          disabled={disabled}
          aria-label={t('Delete page at position {position}', { position: position + 1 })}
          title={t('Delete')}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
});

export function PageGrid({
  pages, sources, thumbnails, selection, highlighted, markerIndex, markerSide, disabled,
  onSelect, onRotate, onFlip, onDuplicate, onRemove, onReorder,
}: PageGridProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const keys = useMemo(() => pages.map((page) => page.key), [pages]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = keys.indexOf(String(active.id));
    const to = keys.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(from, to);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={keys} strategy={rectSortingStrategy}>
        <div className="organize-grid" role="group" aria-label={t('Page grid')}>
          {pages.map((page, index) => (
            <PageCell
              key={page.key}
              page={page}
              position={index}
              label={sourceLabel(sources, page.source)}
              thumbnail={thumbnails[`${page.source}:${page.page}`]}
              selected={selection.has(index)}
              highlighted={highlighted.has(index)}
              marker={index === markerIndex ? markerSide : null}
              disabled={disabled}
              onSelect={onSelect}
              onRotate={onRotate}
              onFlip={onFlip}
              onDuplicate={onDuplicate}
              onRemove={onRemove}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
