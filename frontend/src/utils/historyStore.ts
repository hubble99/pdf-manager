export interface HistoryEntry {
  id: string;
  filename: string;
  action: string;
  timestamp: number;
  size: number;
}

const STORAGE_KEY = 'pdf_manager_history';

export function getHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to read history', e);
  }
  return [];
}

export function addHistoryEntry(entry: Omit<HistoryEntry, 'id' | 'timestamp'>) {
  const current = getHistory();
  const newEntry: HistoryEntry = {
    ...entry,
    id: Math.random().toString(36).slice(2, 10),
    timestamp: Date.now(),
  };
  const updated = [newEntry, ...current].slice(0, 50); // Keep last 50
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  // Dispatch an event so other tabs/components can react if needed
  window.dispatchEvent(new Event('history-updated'));
}

export function clearHistory() {
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event('history-updated'));
}
