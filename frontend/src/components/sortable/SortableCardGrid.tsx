import type { KeyboardEvent, ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { SortableArea } from './SortableArea';
import { t } from '../../i18n';

export interface SortableCard {
  id: string;
  /** The preview shown inside the card, e.g. the first page of a PDF. */
  thumbnail: ReactNode;
  /** The full name; it wraps instead of being cut off. */
  title: string;
  /** Small line under the title, e.g. page count and size. */
  meta?: ReactNode;
  /** When set the card shows a Duplicate marker with this text as its tooltip. */
  warning?: string;
  /** Extra buttons shown beside the move buttons, e.g. rotate or mirror. */
  actions?: ReactNode;
}

export interface SortableCardGridProps {
  cards: SortableCard[];
  onReorder: (from: number, to: number) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
  /** Prefix for generated element ids, e.g. "merge". */
  idPrefix: string;
  ariaLabel: string;
  /** Smaller cards, for long lists. */
  compact?: boolean;
}

function Card({
  card, index, total, disabled, idPrefix, onReorder, onRemove,
}: {
  card: SortableCard;
  index: number;
  total: number;
  disabled: boolean;
  idPrefix: string;
  onReorder: (from: number, to: number) => void;
  onRemove: (id: string) => void;
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: card.id, disabled });

  const dragKeyDown = listeners?.onKeyDown as ((event: KeyboardEvent) => void) | undefined;

  /** Alt+Arrow moves the focused card; every other key goes to the drag keyboard handler. */
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey) {
      const earlier = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
      const later = event.key === 'ArrowDown' || event.key === 'ArrowRight';
      if (earlier && index > 0) {
        event.preventDefault();
        onReorder(index, index - 1);
      } else if (later && index < total - 1) {
        event.preventDefault();
        onReorder(index, index + 1);
      }
      return;
    }
    dragKeyDown?.(event);
  };

  return (
    <li
      ref={setNodeRef}
      className={['sort-card', isDragging ? 'sort-card--dragging' : ''].filter(Boolean).join(' ')}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="sort-card-head">
        <span className="chip sort-card-index">#{index + 1}</span>
        {card.warning && (
          <span className="sort-card-warn" title={card.warning}>
            <AlertTriangle size={11} aria-hidden="true" /> {t('Duplicate')}
          </span>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm sort-card-remove"
          onClick={() => onRemove(card.id)}
          disabled={disabled}
          aria-label={t('Remove {name}', { name: card.title })}
          title={t('Remove')}
          id={`${idPrefix}-remove-${index}`}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        onKeyDown={handleKeyDown}
        className="sort-card-body"
        disabled={disabled}
        title={t('Drag to reorder, or press Alt+Arrow')}
        aria-label={t('Position {position}: {name}. Drag to reorder, or press Alt and an arrow key.', { position: index + 1, name: card.title })}
      >
        {card.thumbnail}
      </button>

      <p className="sort-card-title">{card.title}</p>
      {card.meta && <div className="sort-card-meta">{card.meta}</div>}

      <div className="sort-card-steps">
        {card.actions}
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={() => onReorder(index, index - 1)}
          disabled={disabled || index === 0}
          aria-label={t('Move {name} earlier', { name: card.title })}
          id={`${idPrefix}-earlier-${index}`}
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={() => onReorder(index, index + 1)}
          disabled={disabled || index === total - 1}
          aria-label={t('Move {name} later', { name: card.title })}
          id={`${idPrefix}-later-${index}`}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/**
 * A reorderable grid of preview cards, shared by Merge (Quick) and Images to
 * PDF. It reuses the sensors and drag behaviour of the Organize PDF grid but
 * knows nothing about pages, so any list of previews can sit on top of it.
 */
export function SortableCardGrid({
  cards, onReorder, onRemove, disabled = false, idPrefix, ariaLabel, compact = false,
}: SortableCardGridProps) {
  return (
    <SortableArea ids={cards.map((card) => card.id)} onReorder={onReorder} layout="grid">
      <ul className={`sort-grid${compact ? ' sort-grid--compact' : ''}`} aria-label={ariaLabel}>
        {cards.map((card, index) => (
          <Card
            key={card.id}
            card={card}
            index={index}
            total={cards.length}
            disabled={disabled}
            idPrefix={idPrefix}
            onReorder={onReorder}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </SortableArea>
  );
}
