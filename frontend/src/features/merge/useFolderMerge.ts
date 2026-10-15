import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../hooks/useToast';
import { triggerBlobDownload } from '../../utils/downloadHelper';
import { openOutputFolder } from '../../utils/tauriDialog';
import { addHistoryEntry } from '../../utils/historyStore';
import { chooseFolderDialog, isTauri } from '../../utils/tauriDialog';
import {
  CHOOSE_FOLDER_AGAIN, describeFiles, inspectFiles, listFolder, mergeFolderFiles, registerFolder, releaseFolder,
  type FileInfo, type FolderFileNode, type FolderListing, type MergeProblem, type RegisteredRoot,
} from './api';

export interface FolderMergeState {
  folderModeAvailable: boolean;
  root: RegisteredRoot | null;
  listing: FolderListing | null;
  expanded: Set<string>;
  queue: string[];
  /** Size and page count of queued files, filled in as they are read. */
  fileInfo: Record<string, FileInfo>;
  outputName: string;
  isBusy: boolean;
  error: string | null;
  notice: string | null;
  problems: MergeProblem[] | null;
  result: { filename: string; merged: number; skipped: number; totalPages: number } | null;

  chooseFolder: () => Promise<void>;
  refresh: () => Promise<void>;
  toggleFolder: (relativePath: string) => void;
  setExpandedPaths: (paths: string[]) => void;
  addFile: (relativePath: string) => void;
  addFolder: (node: FolderFileNode) => void;
  removeAt: (index: number) => void;
  moveAt: (from: number, to: number) => void;
  step: (index: number, direction: -1 | 1) => void;
  clearQueue: () => void;
  setOutputName: (name: string) => void;
  requestMerge: () => Promise<void>;
  skipAndMerge: () => Promise<void>;
  cancelPreflight: () => void;
  dismissError: () => void;
  isQueued: (relativePath: string) => boolean;
}

/**
 * Files of a folder in display order: subfolders first, then its own PDFs.
 *
 * The order itself comes from the backend listing, which already applies the
 * natural-order rule, so it is not re-applied here.
 */
function collectInOrder(node: FolderFileNode): string[] {
  const result: string[] = [];
  for (const child of node.folders) result.push(...collectInOrder(child));
  for (const name of node.files) {
    result.push(node.relative_path ? `${node.relative_path}/${name}` : name);
  }
  return result;
}

export function useFolderMerge(): FolderMergeState {
  const { showToast } = useToast();
  const [root, setRoot] = useState<RegisteredRoot | null>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<string[]>([]);
  const [fileInfo, setFileInfo] = useState<Record<string, FileInfo>>({});
  const [outputName, setOutputName] = useState('merged_output.pdf');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problems, setProblems] = useState<MergeProblem[] | null>(null);
  const [result, setResult] = useState<FolderMergeState['result']>(null);

  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const rootIdRef = useRef<string | null>(null);
  const folderModeAvailable = isTauri();

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const forgetRoot = useCallback(() => {
    setRoot(null);
    setListing(null);
    setExpanded(new Set());
    setQueue([]);
    setFileInfo({});
    setProblems(null);
    setResult(null);
  }, []);

  // Leaving the workspace releases the registration, so folder mode resets.
  useEffect(() => {
    return () => {
      const rootId = rootIdRef.current;
      if (rootId) void releaseFolder(rootId).catch(() => {});
    };
  }, []);

  const describeError = useCallback((thrown: unknown, fallback: string) => {
    const message = thrown instanceof Error ? thrown.message : fallback;
    // A lapsed registration is a normal state, not a failure to interpret.
    if (message.includes(CHOOSE_FOLDER_AGAIN)) {
      forgetRoot();
      return CHOOSE_FOLDER_AGAIN;
    }
    return message;
  }, [forgetRoot]);

  const loadListing = useCallback(async (rootId: string) => {
    const data = await listFolder(rootId);
    if (!mountedRef.current) return;
    setListing(data);
    setExpanded(new Set(data.root.folders.map((child) => child.relative_path)));
    setNotice(data.skipped > 0 ? `${data.skipped} item${data.skipped === 1 ? '' : 's'} could not be read` : null);
  }, []);

  const chooseFolder = useCallback(async () => {
    if (busyRef.current) return;
    setError(null);
    const path = await chooseFolderDialog({ title: 'Choose a folder of PDFs' });
    if (!path) return;

    // Choosing a folder replaces any previous root; the queue is never filled.
    const previous = rootIdRef.current;
    if (previous) void releaseFolder(previous).catch(() => {});

    busyRef.current = true;
    setIsBusy(true);
    try {
      const registered = await registerFolder(path);
      rootIdRef.current = registered.rootId;
      if (!mountedRef.current) return;
      setRoot(registered);
      setQueue([]);
      setFileInfo({});
      setResult(null);
      await loadListing(registered.rootId);
    } catch (thrown) {
      if (!mountedRef.current) return;
      forgetRoot();
      setError(describeError(thrown, 'That folder could not be read.'));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setIsBusy(false);
    }
  }, [describeError, forgetRoot, loadListing]);

  const refresh = useCallback(async () => {
    if (!root || busyRef.current) return;
    setError(null);
    busyRef.current = true;
    setIsBusy(true);
    try {
      await loadListing(root.rootId);
    } catch (thrown) {
      if (!mountedRef.current) return;
      setError(describeError(thrown, 'That folder could not be read.'));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setIsBusy(false);
    }
  }, [describeError, loadListing, root]);

  const toggleFolder = useCallback((relativePath: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(relativePath)) next.delete(relativePath);
      else next.add(relativePath);
      return next;
    });
  }, []);

  const setExpandedPaths = useCallback((paths: string[]) => {
    setExpanded(new Set(paths));
  }, []);

  const addFiles = useCallback((relativePaths: string[]) => {
    setQueue((previous) => {
      const seen = new Set(previous);
      const appended = relativePaths.filter((path) => !seen.has(path));
      return appended.length ? [...previous, ...appended] : previous;
    });
    setResult(null);
  }, []);

  const addFile = useCallback((relativePath: string) => addFiles([relativePath]), [addFiles]);

  const addFolder = useCallback((node: FolderFileNode) => {
    // Tree display order, which is the same rule the tree itself uses.
    addFiles(collectInOrder(node));
  }, [addFiles]);

  const removeAt = useCallback((index: number) => {
    setQueue((previous) => previous.filter((_, position) => position !== index));
    setResult(null);
  }, []);

  const moveAt = useCallback((from: number, to: number) => {
    setQueue((previous) => {
      if (from === to || from < 0 || from >= previous.length) return previous;
      const target = Math.max(0, Math.min(previous.length - 1, to));
      if (target === from) return previous;
      const next = [...previous];
      const [moved] = next.splice(from, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

  const step = useCallback((index: number, direction: -1 | 1) => {
    moveAt(index, index + direction);
  }, [moveAt]);

  const clearQueue = useCallback(() => setQueue([]), []);

  const runMerge = useCallback(async (skipInvalid: boolean, files: string[]) => {
    if (!root) return;
    busyRef.current = true;
    setIsBusy(true);
    setError(null);
    setProblems(null);
    try {
      const merged = await mergeFolderFiles(root.rootId, files, outputName || 'merged_output.pdf', skipInvalid);
      if (!mountedRef.current) return;
      triggerBlobDownload(merged.blob, merged.filename);
      setResult({
        filename: merged.filename,
        merged: merged.merged,
        skipped: merged.skipped,
        totalPages: merged.totalPages,
      });
      addHistoryEntry({ filename: merged.filename, action: 'Merge PDF', size: merged.blob.size });
      showToast({
        type: 'success',
        title: 'Merge complete',
        message: `${merged.merged} files merged${merged.skipped ? `, ${merged.skipped} skipped` : ''}`,
        action: { label: 'Open Folder', onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (thrown) {
      if (!mountedRef.current) return;
      setError(describeError(thrown, 'The merge failed.'));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setIsBusy(false);
    }
  }, [describeError, outputName, root, showToast]);

  const requestMerge = useCallback(async () => {
    if (!root || queue.length < 2 || busyRef.current) return;
    setError(null);
    busyRef.current = true;
    setIsBusy(true);
    try {
      const found = await inspectFiles(root.rootId, queue);
      if (!mountedRef.current) return;
      if (found.length === 0) {
        busyRef.current = false;
        setIsBusy(false);
        await runMerge(false, queue);
        return;
      }
      setProblems(found);
    } catch (thrown) {
      if (!mountedRef.current) return;
      setError(describeError(thrown, 'The files could not be checked.'));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setIsBusy(false);
    }
  }, [describeError, queue, root, runMerge]);

  const skipAndMerge = useCallback(async () => {
    if (!problems) return;
    const blocked = new Set(problems.map((problem) => problem.path));
    const remaining = queue.filter((entry) => !blocked.has(entry));
    setProblems(null);
    if (remaining.length < 2) {
      setError('Fewer than 2 files can be merged after skipping the reported problems.');
      return;
    }
    await runMerge(true, remaining);
  }, [problems, queue, runMerge]);

  const isQueued = useCallback((relativePath: string) => queue.includes(relativePath), [queue]);

  // Properties of queued files, read once per file so reordering costs nothing.
  const requestedInfo = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!root) {
      requestedInfo.current = new Set();
      return;
    }
    const missing = queue.filter((path) => !requestedInfo.current.has(path));
    if (missing.length === 0) return;
    missing.forEach((path) => requestedInfo.current.add(path));
    const rootId = root.rootId;
    describeFiles(rootId, missing)
      .then((described) => {
        if (!mountedRef.current || rootIdRef.current !== rootId) return;
        setFileInfo((previous) => {
          const next = { ...previous };
          for (const info of described) next[info.path] = info;
          return next;
        });
      })
      .catch(() => {
        // Properties are a convenience; let a later change retry them.
        missing.forEach((path) => requestedInfo.current.delete(path));
      });
  }, [queue, root]);

  const orderedQueue = useMemo(() => queue, [queue]);

  return {
    folderModeAvailable,
    root,
    listing,
    expanded,
    queue: orderedQueue,
    fileInfo,
    outputName,
    isBusy,
    error,
    notice,
    problems,
    result,
    chooseFolder,
    refresh,
    toggleFolder,
    setExpandedPaths,
    addFile,
    addFolder,
    removeAt,
    moveAt,
    step,
    clearQueue,
    setOutputName,
    requestMerge,
    skipAndMerge,
    cancelPreflight: () => setProblems(null),
    dismissError: () => setError(null),
    isQueued,
  };
}
