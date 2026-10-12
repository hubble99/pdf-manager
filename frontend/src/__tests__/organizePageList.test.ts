import { describe, expect, it } from 'vitest';
import { formatPageNumbers, parsePageExpression } from '../features/organize/pageExpression';
import {
  clampReference, createPageRef, defaultReferencePage, duplicatePage, flipPositions,
  insertionIndex, insertPages, movePage, positionsOfSource, pruneSelection, removePositions,
  rotatePositions, selectRange, selectOnly, toggleSelection,
} from '../features/organize/pageList';
import type { PageRef } from '../features/organize/types';

const list = (source = 'main', pages = [1, 2, 3, 4, 5]): PageRef[] =>
  pages.map((page) => createPageRef(source, page));

describe('page expression parsing', () => {
  it.each([
    ['3', [3]],
    ['2-4', [2, 3, 4]],
    ['1, 3-5', [1, 3, 4, 5]],
    [' 5 , 1 - 2 ', [5, 1, 2]],
  ])('accepts %j', (input, expected) => {
    const result = parsePageExpression(input, 5);
    expect(result.valid).toBe(true);
    expect(result.pages).toEqual(expected);
  });

  it('preserves requested order and duplicates', () => {
    expect(parsePageExpression('7, 1, 3', 10).pages).toEqual([7, 1, 3]);
    expect(parsePageExpression('2, 2, 2', 5).pages).toEqual([2, 2, 2]);
    expect(parsePageExpression('3-4, 3', 5).pages).toEqual([3, 4, 3]);
  });

  it.each([
    '', ' ', '0', '6', '4-2', '1x', '1.5', '-1', '1,,2', '1,', '1-2-3', 'a', '2, oops',
  ])('rejects the whole expression %j', (input) => {
    const result = parsePageExpression(input, 5);
    expect(result.valid).toBe(false);
    expect(result.pages).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('reports the offending token and the valid range', () => {
    expect(parsePageExpression('2, oops', 5).error).toContain('oops');
    expect(parsePageExpression('9', 5).error).toContain('between 1 and 5');
    expect(parsePageExpression('4-2', 5).error).toContain('backwards');
    expect(parsePageExpression('', 5).error).toContain('at least one page');
  });

  it('blocks parsing before a document is loaded', () => {
    expect(parsePageExpression('1', 0).valid).toBe(false);
  });

  it('formats page numbers as ascending collapsed runs', () => {
    expect(formatPageNumbers([3, 1, 2, 5])).toBe('1-3, 5');
    expect(formatPageNumbers([2, 2, 2])).toBe('2');
    expect(formatPageNumbers([])).toBe('');
  });
});

describe('page list operations', () => {
  it('inserts at a position and clamps out-of-range positions', () => {
    const base = list('main', [1, 2, 3]);
    const inserted = insertPages(base, 1, [createPageRef('other', 7, 'x')]);
    expect(inserted.map((entry) => entry.page)).toEqual([1, 7, 2, 3]);
    expect(insertPages(base, 99, [createPageRef('other', 7, 'x')]).map((e) => e.page)).toEqual([1, 2, 3, 7]);
    expect(insertPages(base, -5, [createPageRef('other', 7, 'x')]).map((e) => e.page)).toEqual([7, 1, 2, 3]);
    expect(insertPages(base, 0, [])).toBe(base);
  });

  it('removes positions expressed in the current order', () => {
    const base = list('main', [1, 2, 3, 4, 5]);
    expect(removePositions(base, [1, 3]).map((entry) => entry.page)).toEqual([1, 3, 5]);
    expect(removePositions(base, [])).toBe(base);
  });

  it('moves an entry without disturbing the others', () => {
    const base = list('main', [1, 2, 3, 4]);
    expect(movePage(base, 0, 2).map((entry) => entry.page)).toEqual([2, 3, 1, 4]);
    expect(movePage(base, 3, 0).map((entry) => entry.page)).toEqual([4, 1, 2, 3]);
    expect(movePage(base, 1, 1)).toBe(base);
  });

  it('duplicates next to the original with a distinct key', () => {
    const base = list('main', [1, 2]);
    const duplicated = duplicatePage(base, 0);
    expect(duplicated.map((entry) => entry.page)).toEqual([1, 1, 2]);
    expect(duplicated[0].key).not.toBe(duplicated[1].key);
  });

  it('changes orientation per position and keeps it through moves', () => {
    const base = list('main', [1, 2, 3]);
    const rotated = rotatePositions(base, [1]);
    const flipped = flipPositions(rotated, [1]);
    expect(rotated[1].rotation).toBe(90);
    expect(flipped[1].flip).toBe(true);
    expect(flipped[0].rotation).toBe(0);

    const moved = movePage(flipped, 1, 2);
    expect(moved[2].rotation).toBe(90);
    expect(moved[2].flip).toBe(true);
    expect(moved[0].rotation).toBe(0);

    expect(rotatePositions(base, []).length).toBe(3);
    expect(rotatePositions(base, [0], 180)[0].rotation).toBe(180);
    expect(rotatePositions(base, [0], 180)[0].rotation).not.toBe(270);
  });

  it('wraps rotation in both directions', () => {
    const base = [createPageRef('main', 1)];
    expect(rotatePositions(base, [0], -90)[0].rotation).toBe(270);
    expect(rotatePositions(base, [0], 900)[0].rotation).toBe(180);
  });
});

describe('selection', () => {
  it('selects one, toggles membership, and selects an inclusive range', () => {
    expect([...selectOnly(4)]).toEqual([4]);
    expect([...toggleSelection(new Set([1]), 1)]).toEqual([]);
    expect([...toggleSelection(new Set([1]), 3)].sort()).toEqual([1, 3]);
    expect([...selectRange(3, 6)]).toEqual([3, 4, 5, 6]);
    expect([...selectRange(6, 3)]).toEqual([3, 4, 5, 6]);
  });

  it('drops selection entries that no longer exist', () => {
    expect([...pruneSelection(new Set([0, 2, 9]), 3)].sort()).toEqual([0, 2]);
    expect([...pruneSelection(new Set([5]), 2)]).toEqual([]);
  });
});

describe('grid-derived positions', () => {
  it('finds the positions of one source', () => {
    const mixed = [
      createPageRef('main', 1), createPageRef('other', 1),
      createPageRef('main', 2), createPageRef('other', 2),
    ];
    expect(positionsOfSource(mixed, 'other')).toEqual([1, 3]);
    expect(positionsOfSource(mixed, 'absent')).toEqual([]);
  });

  it('derives the starting reference page from the selection', () => {
    expect(defaultReferencePage(new Set([4]), 10, 'after')).toBe(5);
    expect(defaultReferencePage(new Set([4]), 10, 'before')).toBe(5);
    // Several selected pages: after the last, before the first.
    expect(defaultReferencePage(new Set([2, 5, 8]), 10, 'after')).toBe(9);
    expect(defaultReferencePage(new Set([2, 5, 8]), 10, 'before')).toBe(3);
    // No selection always points at the last page of the CURRENT grid.
    expect(defaultReferencePage(new Set(), 10, 'after')).toBe(10);
    expect(defaultReferencePage(new Set(), 10, 'before')).toBe(10);
    // An empty grid still reports a usable one-based page.
    expect(defaultReferencePage(new Set(), 0, 'after')).toBe(1);
  });

  it('keeps a reference page inside the current grid', () => {
    expect(clampReference(0, 10)).toBe(1);
    expect(clampReference(-4, 10)).toBe(1);
    expect(clampReference(99, 10)).toBe(10);
    expect(clampReference(4.7, 10)).toBe(4);
    expect(clampReference(Number.NaN, 10)).toBe(10);
  });

  it('measures the insertion index from the reference page, never the document', () => {
    expect(insertionIndex(5, 'after')).toBe(5);
    expect(insertionIndex(5, 'before')).toBe(4);
    expect(insertionIndex(10, 'after')).toBe(10);
    expect(insertionIndex(1, 'before')).toBe(0);
  });
});

describe('worked example from the specification', () => {
  it('keeps positions correct after an insert shifts the numbering', () => {
    // Start: [1][2][3][4][5][6][7]
    let pages = list('main', [1, 2, 3, 4, 5, 6, 7]);
    expect(pages.map((entry) => entry.page)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Insert an image after the page at position 5 (index 4).
    pages = insertPages(pages, insertionIndex(defaultReferencePage(new Set([4]), pages.length, 'after'), 'after'), [
      createPageRef('img', 1, 'img-1'),
    ]);
    expect(pages.map((entry) => entry.source === 'img' ? 'IMG' : entry.page))
      .toEqual([1, 2, 3, 4, 5, 'IMG', 6, 7]);

    // The page that was `7` now sits at position 7 (index 6). Insert PDF pages
    // 2-3 after it; the target is the selected cell, not a typed number.
    const targetIndex = 6;
    pages = insertPages(pages, insertionIndex(defaultReferencePage(new Set([targetIndex]), pages.length, 'after'), 'after'), [
      createPageRef('other', 2, 'p2'), createPageRef('other', 3, 'p3'),
    ]);
    expect(pages.map((entry) => (
      entry.source === 'img' ? 'IMG' : entry.source === 'other' ? `P${entry.page}` : entry.page
    ))).toEqual([1, 2, 3, 4, 5, 'IMG', 6, 'P2', 'P3', 7]);
  });
});
