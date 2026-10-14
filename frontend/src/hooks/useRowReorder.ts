import { useCallback, useRef, useState } from 'react';

export interface RowReorderHandlers {
  draggable: true;
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}

/**
 * Pointer-drag reordering for a list of stable ids.
 *
 * The owner keeps the order; this hook only tracks which row is lifted and asks
 * the owner to move it as the pointer crosses another row. Moving during the
 * drag, rather than only on drop, is what keeps the number badges correct while
 * the row is still in the air.
 *
 * Keyboard users get the same result through the caller's Alt+Up / Alt+Down
 * handler, so a focused row never depends on a pointer.
 */
export function useRowReorder(onMove: (fromId: string, toId: string) => void) {
  const activeRef = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const end = useCallback(() => {
    activeRef.current = null;
    setActiveId(null);
  }, []);

  const rowProps = useCallback((id: string): RowReorderHandlers => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
      activeRef.current = id;
      setActiveId(id);
    },
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const current = activeRef.current;
      if (current && current !== id) onMove(current, id);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      end();
    },
    onDragEnd: end,
  }), [end, onMove]);

  return { activeId, rowProps };
}
