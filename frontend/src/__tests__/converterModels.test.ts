import { describe, expect, it, vi } from 'vitest';
import {
  addConverterPaths, classifyConverterPath, converterKind,
  type ConverterImage, type ConverterInput,
} from '../features/converter/batch';
import {
  initialPageSelection, pageSelectionReducer, resolvePageSelection, serializePageSelection,
  type PageSelection,
} from '../features/converter/pageSelection';

const pdf = (name = 'document.pdf') => `C:\\Docs\\${name}`;
const image = (name = 'image.png') => `C:\\Pics\\${name}`;
const entry = (): ConverterImage => ({ id: 'existing', path: image(), rotation: 90, flipH: true });
const selected = (draft: string): PageSelection => ({ mode: 'selected', draft });

describe('converter batch validation', () => {
  it('accepts one PDF without a manual direction', () => {
    const path = pdf();
    const result = addConverterPaths(null, [path]);
    expect(result).toEqual({ input: path, error: null });
    expect(converterKind(result.input)).toBe('pdf');
  });

  it('accepts mixed image formats in order, preserving existing transforms', () => {
    const existing = entry();
    const paths = [image('one.jpg'), image('two.jpeg'), image()];
    let id = 0;
    const result = addConverterPaths([existing], paths, () => `new-${++id}`);
    expect(result.error).toBeNull();
    const entries = result.input as ConverterImage[];
    expect(entries[0]).toBe(existing);
    expect(entries.slice(1).map((item) => item.path)).toEqual(paths);
    expect(entries.slice(1).every((item) => item.rotation === 0 && !item.flipH)).toBe(true);
    expect(converterKind(entries)).toBe('images');
  });

  it('lets the same picture be added twice, one page each', () => {
    const result = addConverterPaths([entry()], [image()], () => 'again');
    expect((result.input as ConverterImage[]).map((item) => item.path)).toEqual([image(), image()]);
  });

  it.each(['JPG', 'JPEG', 'PNG', 'WEBP', 'BMP', 'TIF', 'TIFF', 'jpg', 'tiff'])('accepts the %s extension in any case', (extension) => {
    expect(classifyConverterPath(image(`photo.${extension}`))).toBe('images');
  });

  it('accepts uppercase PDF extensions and POSIX paths', () => {
    expect(classifyConverterPath('C:\\Docs\\REPORT.PDF')).toBe('pdf');
    expect(classifyConverterPath('/home/a/report.pdf')).toBe('pdf');
  });

  it.each(['notes.txt', 'archive.zip', 'photo', 'photo.gif'])('does not know %s', (name) => {
    expect(classifyConverterPath(`C:\\Pics\\${name}`)).toBeNull();
  });

  it.each([
    ['mixed categories', null, [pdf(), image()]],
    ['multiple PDFs', null, [pdf('a.pdf'), pdf('b.pdf')]],
    ['second PDF', pdf(), [pdf('other.pdf')]],
    ['image added to PDF', pdf(), [image()]],
    ['PDF added to images', [entry()], [pdf()]],
    ['unsupported file', [entry()], [image(), 'C:\\Docs\\notes.txt']],
  ] as [string, ConverterInput, string[]][])('rejects %s atomically', (_name, current, incoming) => {
    const createId = vi.fn();
    const result = addConverterPaths(current, incoming, createId);
    expect(result.error).toBeTruthy();
    expect(result.input).toBe(current);
    expect(createId).not.toHaveBeenCalled();
  });

  it('does nothing when the picker is cancelled', () => {
    const current = [entry()];
    expect(addConverterPaths(current, []).input).toBe(current);
    expect(addConverterPaths(current, []).error).toBeNull();
  });

  it('allows a different category after the batch is cleared', () => {
    expect(converterKind(null)).toBe('empty');
    expect(converterKind([])).toBe('empty');
    expect(addConverterPaths([], [pdf()]).error).toBeNull();
  });
});

describe('strict converter page selection', () => {
  it('uses the empty request sentinel only for All pages', () => {
    const result = resolvePageSelection(initialPageSelection(), 3);
    expect([...result.pages]).toEqual([1, 2, 3]);
    expect(serializePageSelection({ mode: 'all', draft: 'invalid' }, 3)).toBe('');
    expect(() => serializePageSelection(selected(''), 3)).toThrow();
  });

  it.each([
    ['3', '3', [3]],
    ['2-4', '2-4', [2, 3, 4]],
    ['1, 3-5, 4', '1, 3-5', [1, 3, 4, 5]],
    [' 5 , 1 - 2 , 2 ', '1-2, 5', [1, 2, 5]],
  ])('validates and canonicalizes %s', (draft, request, pages) => {
    const result = resolvePageSelection(selected(draft as string), 5);
    expect(result.valid).toBe(true);
    expect([...result.pages].sort((a, b) => a - b)).toEqual(pages);
    expect(serializePageSelection(selected(draft as string), 5)).toBe(request);
  });

  it.each(['', ' ', '0', '6', '1-6', '4-2', '1x', '1.5', '-1', '1,,2', '1,', '1-2-3', '1,wrong', '999999999999999999999'])('rejects the entire invalid draft %j', (draft) => {
    const result = resolvePageSelection(selected(draft), 5);
    expect(result.valid).toBe(false);
    expect(result.pages.size).toBe(0);
    expect(result.pageRanges).toBeNull();
    expect(() => serializePageSelection(selected(draft), 5)).toThrow();
  });

  it.each([0, -1, NaN, 1.5])('blocks conversion before a valid page count exists (%s)', (total) => {
    expect(resolvePageSelection(initialPageSelection(), total).valid).toBe(false);
  });

  it('retains the custom draft across mode changes but ignores it in All pages', () => {
    const state = selected('2');
    const all = pageSelectionReducer(state, { type: 'mode', mode: 'all' });
    expect(all.draft).toBe('2');
    expect(serializePageSelection(all, 4)).toBe('');
    expect(pageSelectionReducer(all, { type: 'mode', mode: 'selected' })).toEqual(state);
    expect(pageSelectionReducer(all, { type: 'draft', draft: '3' })).toBe(all);
    expect(pageSelectionReducer(all, { type: 'toggle', page: 2, total: 4 })).toBe(all);
  });

  it('keeps zero selected after removing the final page', () => {
    const state = pageSelectionReducer(selected('2'), { type: 'toggle', page: 2, total: 3 });
    expect(state).toEqual(selected(''));
    expect(resolvePageSelection(state, 3).valid).toBe(false);
    expect(() => serializePageSelection(state, 3)).toThrow();
  });

  it('does not silently switch modes when every checkbox is selected', () => {
    const state = pageSelectionReducer(selected('1-2'), { type: 'toggle', page: 3, total: 3 });
    expect(state).toEqual(selected('1-3'));
    expect(serializePageSelection(state, 3)).toBe('1-3');
  });

  it('recovers from an invalid draft through an explicit checkbox change', () => {
    expect(pageSelectionReducer(selected('wrong'), { type: 'toggle', page: 2, total: 3 })).toEqual(selected('2'));
  });

  it('resets document-specific state for a replacement PDF', () => {
    const state = pageSelectionReducer(selected('7-9'), { type: 'reset' });
    expect(state).toEqual(initialPageSelection());
    expect([...resolvePageSelection(state, 2).pages]).toEqual([1, 2]);
  });
});
