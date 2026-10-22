import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../hooks/useToast';
import { addHistoryEntry } from '../../utils/historyStore';
import { chooseFolderDialog, isTauri } from '../../utils/tauriDialog';
import { baseName } from '../../utils/paths';
import { NativeCoreError, isCoreCancelled, revealPath, type CoreProgress } from '../../api/nativeCore';
import {
  describePdfs, inspectPdfs, mergePdfs, scanFolder,
  type FileDescription, type FolderListing, type FolderNode, type MergeProblem,
} from '../../api/pdfMerge';
import { mergeErrorMessage } from './messages';
import { t, tn } from '../../i18n';

export interface ChosenFolder {
  path: string;
  name: string;
}

/** A queued file that cannot be merged, named the way the queue shows it. */
export interface QueueProblem {
  path: string;
  reason: string;
}

export interface FolderMergeState {
  folderModeAvailable: boolean;
  root: ChosenFolder | null;
  listing: FolderListing | null;
  expanded: Set<string>;
  queue: string[];
  /** Size and page count of queued files, filled in as they are read. */
  fileInfo: Record<string, FileDescription>;
  outputName: string;
  /** Scanning, checking or merging. */
  isBusy: boolean;
  isMerging: boolean;
  progress: CoreProgress | null;
  error: string | null;
  notice: string | null;
  problems: QueueProblem[] | null;
  result: {
    outputPath: string;
    filename: string;
    merged: number;
    skipped: number;
    totalPages: number;
  } | null;

  chooseFolder: () => Promise<void>;
  refresh: () => Promise<void>;
  toggleFolder: (relativePath: string) => void;
  setExpandedPaths: (paths: string[]) => void;
  addFile: (relativePath: string) => void;
  addFolder: (node: FolderNode) => void;
  removeAt: (index: number) => void;
  moveAt: (from: number, to: number) => void;
  step: (index: number, direction: -1 | 1) => void;
  clearQueue: () => void;
  setOutputName: (name: string) => void;
  requestMerge: () => Promise<void>;
  skipAndMerge: () => Promise<void>;
  cancelMerge: () => void;
  cancelPreflight: () => void;
  dismissError: () => void;
  isQueued: (relativePath: string) => boolean;
}

/**
 * Files of a folder in display order: subfolders first, then its own PDFs.
 *
 * The order itself comes from the core's listing, which already applies the
 * natural-order rule, so it is not re-applied here.
 */
function collectInOrder(node: FolderNode): string[] {
  const result: string[] = [];
  for (const child of node.folders) result.push(...collectInOrder(child));
  for (const name of node.files) {
    result.push(node.relativePath ? `${node.relativePath}/${name}` : name);
  }
  return result;
}

/** The core's own words for what it refused; anything else gets the fallback. */
const describeFailure = (thrown: unknown, fallback: string) =>
  thrown instanceof NativeCoreError ? mergeErrorMessage(thrown) : fallback;

export function useFolderMerge(): FolderMergeState {
  const { showToast } = useToast();
  const [root, setRoot] = useState<ChosenFolder | null>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<string[]>([]);
  const [fileInfo, setFileInfo] = useState<Record<string, FileDescription>>({});
  const [outputName, setOutputName] = useState('merged_output.pdf');
  const [isBusy, setIsBusy] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [progress, setProgress] = useState<CoreProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problems, setProblems] = useState<QueueProblem[] | null>(null);
  const [result, setResult] = useState<FolderMergeState['result']>(null);

  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const rootPathRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const folderModeAvailable = isTauri();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const forgetRoot = useCallback(() => {
    rootPathRef.current = null;
    setRoot(null);
    setListing(null);
    setExpanded(new Set());
    setQueue([]);
    setFileInfo({});
    setProblems(null);
    setResult(null);
  }, []);

  const loadListing = useCallback(async (path: string) => {
    const data = await scanFolder(path);
    if (!mountedRef.current) return;
    setListing(data);
    setExpanded(new Set(data.root.folders.map((child) => child.relativePath)));
    setNotice(data.skipped > 0 ? tn(data.skipped, '{n} item could not be read', '{n} items could not be read') : null);
  }, []);

  const chooseFolder = useCallback(async () => {
    if (busyRef.current) return;
    setError(null);
    const path = await chooseFolderDialog({ title: t('Choose a folder of PDFs') });
    if (!path) return;

    busyRef.current = true;
    setIsBusy(true);
    try {
      // Choosing a folder replaces any previous one; the queue is never filled.
      const data = await scanFolder(path);
      if (!mountedRef.current) return;
      rootPathRef.current = path;
      setRoot({ path, name: baseName(path) || path });
      setQueue([]);
      setFileInfo({});
      setResult(null);
      setProblems(null);
      setListing(data);
      setExpanded(new Set(data.root.folders.map((child) => child.relativePath)));
      setNotice(data.skipped > 0 ? tn(data.skipped, '{n} item could not be read', '{n} items could not be read') : null);
    } catch (thrown) {
      if (!mountedRef.current) return;
      forgetRoot();
      setError(describeFailure(thrown, t('That folder could not be read.')));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setIsBusy(false);
    }
  }, [forgetRoot]);

  const refresh = useCallback(async () => {
    if (!root || busyRef.current) return;
    setError(null);
    busyRef.current = true;
    setIsBusy(true);
    try {
      await loadListing(root.path);
    } catch (thrown) {
      if (!mountedRef.current) return;
      setError(describeFailure(thrown, t('That folder could not be read.')));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setIsBusy(false);
    }
  }, [loadListing, root]);

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

  const addFolder = useCallback((node: FolderNode) => {
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
    setIsMerging(true);
    setProgress(null);
    setError(null);
    setProblems(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const report = await mergePdfs(
        files,
        { root: root.path, skipInvalid, outputName },
        { signal: controller.signal, onProgress: (p) => { if (mountedRef.current) setProgress(p); } },
      );
      if (!mountedRef.current) return;
      const filename = baseName(report.outputPath);
      setResult({
        outputPath: report.outputPath,
        filename,
        merged: report.mergedFiles,
        skipped: report.skipped.length,
        totalPages: report.totalPages,
      });
      addHistoryEntry({ filename, action: 'Merge PDF', size: report.outputSizeBytes });
      showToast({
        type: 'success',
        title: t('Merge complete'),
        message: report.skipped.length
          ? tn(report.mergedFiles, '{n} file merged, {skipped} skipped', '{n} files merged, {skipped} skipped', { skipped: report.skipped.length })
          : tn(report.mergedFiles, '{n} file merged', '{n} files merged'),
        action: { label: t('Show in folder'), onClick: () => { void revealPath(report.outputPath).catch(() => undefined); } },
        duration: 8000,
      });
    } catch (thrown) {
      if (!mountedRef.current || isCoreCancelled(thrown)) return;
      setError(mergeErrorMessage(thrown));
    } finally {
      abortRef.current = null;
      busyRef.current = false;
      if (mountedRef.current) {
        setIsBusy(false);
        setIsMerging(false);
        setProgress(null);
      }
    }
  }, [outputName, root, showToast]);

  const requestMerge = useCallback(async () => {
    if (!root || queue.length < 2 || busyRef.current) return;
    setError(null);
    busyRef.current = true;
    setIsBusy(true);
    try {
      const inspection = await inspectPdfs(queue, root.path);
      if (!mountedRef.current) return;
      if (inspection.problems.length === 0) {
        await runMerge(false, queue);
        return;
      }
      setProblems(inspection.problems.map((problem: MergeProblem) => ({
        path: queue[problem.index],
        reason: problem.reason,
      })));
    } catch (thrown) {
      if (!mountedRef.current) return;
      setError(describeFailure(thrown, t('The files could not be checked.')));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setIsBusy(false);
    }
  }, [queue, root, runMerge]);

  const skipAndMerge = useCallback(async () => {
    if (!problems) return;
    const blocked = new Set(problems.map((problem) => problem.path));
    const remaining = queue.filter((entry) => !blocked.has(entry));
    setProblems(null);
    if (remaining.length < 2) {
      setError(t('Fewer than 2 files can be merged after skipping the reported problems.'));
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
    const rootPath = root.path;
    describePdfs(missing, rootPath)
      .then((described) => {
        if (!mountedRef.current || rootPathRef.current !== rootPath) return;
        setFileInfo((previous) => {
          const next = { ...previous };
          missing.forEach((path, index) => {
            if (described[index]) next[path] = described[index];
          });
          return next;
        });
      })
      .catch(() => {
        // Properties are a convenience; let a later change retry them.
        missing.forEach((path) => requestedInfo.current.delete(path));
      });
  }, [queue, root]);

  const cancelMerge = useCallback(() => abortRef.current?.abort(), []);
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
    isMerging,
    progress,
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
    cancelMerge,
    cancelPreflight: () => setProblems(null),
    dismissError: () => setError(null),
    isQueued,
  };
}
