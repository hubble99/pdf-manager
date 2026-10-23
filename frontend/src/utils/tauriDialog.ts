import { openDownloadsFolder } from '../api/housekeeping';

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
 * Open a native folder-picker dialog.
 * Returns the chosen folder path, or null when not in Tauri or cancelled.
 *
 * Folder mode in Merge needs a path rather than a file list, because the backend
 * reads the folder directly instead of receiving uploads.
 */
export const chooseFolderDialog = async (options?: { title?: string }): Promise<string | null> => {
  if (!isTauri()) return null;

  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({
      directory: true,
      multiple: false,
      title: options?.title,
    });
    if (!result) return null;
    return Array.isArray(result) ? result[0] ?? null : result;
  } catch (err) {
    console.warn('[tauriDialog] chooseFolderDialog failed:', err);
    return null;
  }
};

/**
 * Open the system Downloads folder in the file manager.
 * Resolves false outside the desktop shell or when the folder cannot be opened.
 */
export const openOutputFolder = async (): Promise<boolean> => {
  if (!isTauri()) return false;
  try {
    await openDownloadsFolder();
    return true;
  } catch (err) {
    console.warn('[tauriDialog] openOutputFolder failed:', err);
    return false;
  }
};
