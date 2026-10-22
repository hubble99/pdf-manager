import { useCallback, useEffect, useRef, useState } from 'react';
import { extensionOf } from '../utils/paths';
import { isTauri, openFilePicker } from '../utils/tauriDialog';

export interface NativePathFilter {
  /** Label in the system dialog, e.g. "PDF". */
  name: string;
  /** Accepted extensions without the dot, case-insensitive. */
  extensions: string[];
}

export interface UseNativePathsOptions {
  filter: NativePathFilter;
  /** Several files at once (picker and drop) or just the first one. */
  multiple?: boolean;
  /** Title of the system dialog. */
  pickerTitle: string;
  /** Ignore picks and drops, e.g. while a job runs. */
  disabled?: boolean;
  /**
   * Receives the paths that passed the filter and how many were turned away.
   * Not called when nothing was picked or dropped. With `multiple` off only
   * the first path is looked at.
   */
  onPaths: (accepted: string[], rejected: number) => void;
}

/**
 * Choosing files for a native feature: the system file dialog and files
 * dropped on the window. The desktop shell reports dropped files with their
 * paths (a browser `File` has none), which is what the Rust core needs.
 * Outside the desktop shell `desktop` is false and nothing is listened to.
 */
export function useNativePaths({ filter, multiple = false, pickerTitle, disabled = false, onPaths }: UseNativePathsOptions) {
  const desktop = isTauri();
  const [isDragOver, setIsDragOver] = useState(false);
  const latest = useRef({ filter, multiple, pickerTitle, disabled, onPaths });
  useEffect(() => {
    latest.current = { filter, multiple, pickerTitle, disabled, onPaths };
  });

  const accept = useCallback((incoming: string[]) => {
    const { filter: current, multiple: many, disabled: off, onPaths: report } = latest.current;
    if (off) return;
    const considered = many ? incoming : incoming.slice(0, 1);
    if (considered.length === 0) return;
    const allowed = new Set(current.extensions.map((ext) => ext.toLowerCase()));
    const accepted = considered.filter((path) => allowed.has(extensionOf(path)));
    report(accepted, considered.length - accepted.length);
  }, []);

  const pick = useCallback(async () => {
    const { filter: current, multiple: many, pickerTitle: title, disabled: off } = latest.current;
    if (off) return;
    // Some platforms match the dialog filter case-sensitively.
    const extensions = [...new Set(current.extensions.flatMap((ext) => [ext.toLowerCase(), ext.toUpperCase()]))];
    const picked = await openFilePicker({
      multiple: many,
      filters: [{ name: current.name, extensions }],
      title,
    });
    if (picked) accept(picked);
  }, [accept]);

  useEffect(() => {
    if (!desktop) return undefined;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        const { payload } = event;
        if (payload.type === 'enter' || payload.type === 'over') setIsDragOver(true);
        else if (payload.type === 'leave') setIsDragOver(false);
        else if (payload.type === 'drop') {
          setIsDragOver(false);
          accept(payload.paths);
        }
      }))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, accept]);

  return { desktop, isDragOver, pick };
}
