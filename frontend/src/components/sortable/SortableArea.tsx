import { useMemo, type ReactNode } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, verticalListSortingStrategy,
} from '@dnd-kit/sortable';

export interface SortableAreaProps {
  /** Stable ids in their current order. */
  ids: string[];
  /** Called once when a drag ends on a different position. */
  onReorder: (from: number, to: number) => void;
  layout?: 'grid' | 'list';
  children: ReactNode;
}

/**
 * Pointer and keyboard reordering shared by every sortable list in the app.
 *
 * It is built on @dnd-kit, like the Organize PDF grid, because it works on
 * pointer events. The HTML5 drag-and-drop the earlier row hook used is
 * swallowed by the desktop webview, so rows could only be moved with buttons.
 */
export function SortableArea({ ids, onReorder, layout = 'grid', children }: SortableAreaProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const items = useMemo(() => ids, [ids]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = items.indexOf(String(active.id));
    const to = items.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(from, to);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext
        items={items}
        strategy={layout === 'grid' ? rectSortingStrategy : verticalListSortingStrategy}
      >
        {children}
      </SortableContext>
    </DndContext>
  );
}
