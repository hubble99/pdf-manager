export interface PageSelection {
  mode: 'all' | 'selected';
  draft: string;
}

export type PageSelectionAction =
  | { type: 'mode'; mode: PageSelection['mode'] }
  | { type: 'draft'; draft: string }
  | { type: 'toggle'; page: number; total: number }
  | { type: 'reset' };

export type ResolvedSelection =
  | { valid: true; pages: Set<number>; pageRanges: string; error: null }
  | { valid: false; pages: Set<number>; pageRanges: null; error: string };

export const initialPageSelection = (): PageSelection => ({ mode: 'all', draft: '' });

export function formatPageNumbers(values: Iterable<number>): string {
  const pages = [...new Set(values)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let index = 0; index < pages.length; index++) {
    const start = pages[index];
    let end = start;
    while (pages[index + 1] === end + 1) end = pages[++index];
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join(', ');
}

export function resolvePageSelection(selection: PageSelection, total: number): ResolvedSelection {
  const invalid = (error: string): ResolvedSelection => ({
    valid: false, pages: new Set<number>(), pageRanges: null, error,
  });
  if (!Number.isSafeInteger(total) || total < 1) {
    return invalid('Load a readable PDF before choosing pages.');
  }
  if (selection.mode === 'all') {
    return {
      valid: true,
      pages: new Set(Array.from({ length: total }, (_, index) => index + 1)),
      pageRanges: '',
      error: null,
    };
  }
  if (!selection.draft.trim()) {
    return invalid('Choose at least one page. Enter a page or range, such as 2, 4-7.');
  }
  const pages = new Set<number>();
  for (const token of selection.draft.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token.trim());
    if (!match) return invalid('Use page numbers or ranges separated by commas, such as 2, 4-7.');
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > total) {
      return invalid(`Pages must be between 1 and ${total}.`);
    }
    if (start > end) return invalid('A page range must start before it ends.');
    for (let page = start; page <= end; page++) pages.add(page);
  }
  return { valid: true, pages, pageRanges: formatPageNumbers(pages), error: null };
}

export function serializePageSelection(selection: PageSelection, total: number): string {
  const result = resolvePageSelection(selection, total);
  if (!result.valid) throw new Error(result.error);
  return result.pageRanges;
}

export function pageSelectionReducer(state: PageSelection, action: PageSelectionAction): PageSelection {
  switch (action.type) {
    case 'reset': return initialPageSelection();
    case 'mode': return { ...state, mode: action.mode };
    case 'draft': return state.mode === 'selected' ? { ...state, draft: action.draft } : state;
    case 'toggle': {
      if (state.mode !== 'selected' || !Number.isInteger(action.page) || action.page < 1 || action.page > action.total) {
        return state;
      }
      const { pages } = resolvePageSelection(state, action.total);
      if (pages.has(action.page)) pages.delete(action.page);
      else pages.add(action.page);
      return { mode: 'selected', draft: formatPageNumbers(pages) };
    }
  }
}
