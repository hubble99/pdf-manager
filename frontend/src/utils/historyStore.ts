export interface HistoryEntry {
  id: string;
  filename: string;
  action: string;
  timestamp: number;
  size: number;
}

const STORAGE_KEY = 'pdf_manager_history';
const MAX_ENTRIES = 50;

/**
 * Output history for the current session only.
 *
 * `sessionStorage` is deliberate: the list is a convenience while the app is
 * open and is expected to disappear when it closes, so it is never restored on
 * the next run and is never written to disk.
 */
function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getHistory(): HistoryEntry[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as HistoryEntry[];
  } catch (e) {
    console.error('Failed to read history', e);
  }
  return [];
}

export function addHistoryEntry(entry: Omit<HistoryEntry, 'id' | 'timestamp'>) {
  const store = storage();
  if (!store) return;
  const current = getHistory();
  const newEntry: HistoryEntry = {
    ...entry,
    id: Math.random().toString(36).slice(2, 10),
    timestamp: Date.now(),
  };
  const updated = [newEntry, ...current].slice(0, MAX_ENTRIES);
  store.setItem(STORAGE_KEY, JSON.stringify(updated));
  // Dispatch an event so other tabs/components can react if needed
  window.dispatchEvent(new Event('history-updated'));
}

export function clearHistory() {
  storage()?.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event('history-updated'));
}

/** Removes one entry; the session list is the only thing being edited. */
export function removeHistoryEntry(id: string) {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(getHistory().filter((entry) => entry.id !== id)));
  window.dispatchEvent(new Event('history-updated'));
}
