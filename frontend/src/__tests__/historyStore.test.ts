import { beforeEach, describe, expect, it } from 'vitest';
import { addHistoryEntry, clearHistory, getHistory, removeHistoryEntry } from '../utils/historyStore';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('session-only output history', () => {
  it('writes to session storage and never to local storage', () => {
    addHistoryEntry({ filename: 'merged_output.pdf', action: 'Merge PDF', size: 1024 });

    expect(getHistory()).toHaveLength(1);
    expect(getHistory()[0].filename).toBe('merged_output.pdf');
    expect(sessionStorage.getItem('pdf_manager_history')).toContain('merged_output.pdf');
    // The list must disappear when the app closes, so it is not persisted.
    expect(localStorage.getItem('pdf_manager_history')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('removes one entry and clears the whole list', () => {
    addHistoryEntry({ filename: 'a.pdf', action: 'Merge PDF', size: 1 });
    addHistoryEntry({ filename: 'b.pdf', action: 'Split PDF', size: 2 });

    removeHistoryEntry(getHistory()[0].id);
    expect(getHistory().map((entry) => entry.filename)).toEqual(['a.pdf']);

    clearHistory();
    expect(getHistory()).toEqual([]);
  });
});
