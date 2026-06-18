/**
 * Tauri v2 native dialog helpers with graceful fallback.
 * When running in a browser (dev mode without Tauri shell), these helpers
 * return null so that components can fall back to their <input type="file"> elements.
 */

// Detect Tauri runtime at call time (not import time) for SSR / HMR safety
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Open a native file-picker dialog.
 * Returns an array of selected file paths, or null when not in Tauri or cancelled.
 */
export const openFilePicker = async (options?: {
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
  title?: string;
}): Promise<string[] | null> => {
  if (!isTauri()) return null;

  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({
      multiple: options?.multiple ?? false,
      filters: options?.filters,
      title: options?.title,
    });
    if (!result) return null;
    return Array.isArray(result) ? result : [result];
  } catch (err) {
    console.warn('[tauriDialog] openFilePicker failed:', err);
    return null;
  }
};

/**
 * Open a native save dialog.
 * Returns the chosen save path, or null when not in Tauri or cancelled.
 */
export const saveFilePicker = async (options?: {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
  title?: string;
}): Promise<string | null> => {
  if (!isTauri()) return null;

  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const result = await save({
      defaultPath: options?.defaultPath,
      filters: options?.filters,
      title: options?.title,
    });
    return result ?? null;
  } catch (err) {
    console.warn('[tauriDialog] saveFilePicker failed:', err);
    return null;
  }
};

import apiClient from '../api/client';

/**
 * Open the system Downloads folder.
 * Uses backend subprocess to reliably open folder on Windows.
 */
export const openOutputFolder = async (): Promise<void> => {
  try {
    await apiClient.post('/api/v1/settings/open-downloads');
  } catch (err) {
    console.warn('[tauriDialog] openOutputFolder failed:', err);
  }
};

