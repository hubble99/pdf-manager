/**
 * Pure operations on the working page list and its selection.
 *
 * The list is the working document: reordering, deleting, duplicating, and
 * inserting are ordinary array operations, and each entry keeps its own
 * orientation. Keeping these functions pure makes the rules testable without a
 * browser and keeps React state updates trivial.
 */
import type { PageRef, QuarterTurn } from './types';

let sequence = 0;

export function nextPageKey(): string {
  sequence += 1;
  return `page-${sequence}`;
}

export function createPageRef(
  source: string,
  page: number,
  key: string = nextPageKey(),
): PageRef {
  return { key, source, page, rotation: 0, flip: false };
}

export function nextRotation(rotation: QuarterTurn, delta: number): QuarterTurn {
  return (((rotation + delta) % 360) + 360) % 360 as QuarterTurn;
}

/** Insert entries at a zero-based list position, clamped to the list bounds. */
export function insertPages(list: PageRef[], index: number, incoming: PageRef[]): PageRef[] {
  if (incoming.length === 0) return list;
  const at = Math.max(0, Math.min(list.length, index));
  return [...list.slice(0, at), ...incoming, ...list.slice(at)];
}

/** Remove the given zero-based positions. Returns a new list. */
export function removePositions(list: PageRef[], positions: Iterable<number>): PageRef[] {
  const drop = new Set(positions);
  if (drop.size === 0) return list;
  return list.filter((_, index) => !drop.has(index));
}

/** Move one entry, as reported by drag and drop, to another position. */
export function movePage(list: PageRef[], from: number, to: number): PageRef[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/** Duplicate one entry immediately after itself, with a fresh key. */
export function duplicatePage(list: PageRef[], index: number): PageRef[] {
  if (index < 0 || index >= list.length) return list;
  const copy: PageRef = { ...list[index], key: nextPageKey() };
  return [...list.slice(0, index + 1), copy, ...list.slice(index + 1)];
}

/** Rotate the given positions by a quarter-turn delta. */
export function rotatePositions(
  list: PageRef[],
  positions: Iterable<number>,
  delta = 90,
): PageRef[] {
  const targets = new Set(positions);
  if (targets.size === 0) return list;
  return list.map((entry, index) => (
    targets.has(index) ? { ...entry, rotation: nextRotation(entry.rotation, delta) } : entry
  ));
}

/** Mirror the given positions. */
export function flipPositions(list: PageRef[], positions: Iterable<number>): PageRef[] {
  const targets = new Set(positions);
  if (targets.size === 0) return list;
  return list.map((entry, index) => (
    targets.has(index) ? { ...entry, flip: !entry.flip } : entry
  ));
}

/**
 * Display letter for a source, shared by the grid badge and the Sources panel so
 * the two can never disagree. The main document is A, inserted files follow.
 */
export function sourceLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}

// ── selection ────────────────────────────────────────────────────────────────

export function selectOnly(index: number): Set<number> {
  return new Set([index]);
}

export function toggleSelection(selection: Set<number>, index: number): Set<number> {
  const next = new Set(selection);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

export function selectRange(anchor: number, index: number): Set<number> {
  const start = Math.min(anchor, index);
  const end = Math.max(anchor, index);
  const next = new Set<number>();
  for (let position = start; position <= end; position++) next.add(position);
  return next;
}

/** Drop selection entries that no longer exist after the list changed. */
export function pruneSelection(selection: Set<number>, length: number): Set<number> {
  const next = new Set<number>();
  for (const index of selection) {
    if (index >= 0 && index < length) next.add(index);
  }
  return next;
}

/** Positions of the pages belonging to one source. */
export function positionsOfSource(list: PageRef[], sourceId: string): number[] {
  return list.reduce<number[]>((positions, entry, index) => {
    if (entry.source === sourceId) positions.push(index);
    return positions;
  }, []);
}

/**
 * Insertion position for "after"/"before" relative to the current selection.
 * With no selection, "after" means the end and "before" means the start.
 */
export function insertionIndex(
  selection: Set<number>,
  length: number,
  position: 'after' | 'before',
): number {
  if (selection.size === 0) return position === 'after' ? length : 0;
  const positions = [...selection];
  return position === 'after' ? Math.max(...positions) + 1 : Math.min(...positions);
}
