import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addHistoryEntry } from '../../utils/historyStore';
import { useToast } from '../../hooks/useToast';
import { isCoreCancelled, revealPath } from '../../api/nativeCore';
import { baseName, pathKey } from '../../utils/paths';
import {
  assembleDocument, fetchThumbnails, openDocument, releaseDocument, thumbnailKey, thumbnailUrl,
  type AssemblePagePayload,
} from './api';
import { organizeErrorMessage } from './messages';
import { parsePageExpression } from './pageExpression';
import {
  clampReference, createPageRef, defaultReferencePage, duplicatePage, flipPositions,
  insertionIndex, insertPages, movePage, positionsOfSource, pruneSelection, removePositions,
  rotatePositions, selectOnly, selectRange, toggleSelection,
} from './pageList';
import type {
  InsertMode, InsertPosition, OrganizeSnapshot, PageRef, SourceHandle,
} from './types';
import { t, tn } from '../../i18n';

export type { InsertMode, InsertPosition } from './types';

export const THUMBNAIL_BATCH = 24;
export const THUMBNAIL_WIDTH = 150;
const HISTORY_LIMIT = 50;

export type WorkspacePanel = 'none' | 'insert' | 'delete' | 'sources';

interface WorkspaceState {
  pages: PageRef[];
  sources: SourceHandle[];
  past: OrganizeSnapshot[];
  future: OrganizeSnapshot[];
}

const EMPTY_STATE: WorkspaceState = { pages: [], sources: [], past: [], future: [] };

export interface OrganizeWorkspace {
  pages: PageRef[];
  sources: SourceHandle[];
  mainSourceId: string | null;
  selection: Set<number>;
  selectedPositions: number[];
  hasDocument: boolean;
  canUndo: boolean;
  canRedo: boolean;

  panel: WorkspacePanel;
  openPanel: (panel: WorkspacePanel) => void;
  closePanel: () => void;

  thumbnails: Record<string, string>;
  thumbnailsLoaded: number;
  thumbnailsTotal: number;

  isBusy: boolean;
  error: string | null;
  dismissError: () => void;
  result: { filename: string; detail: string; outputPath: string } | null;

  insertDraft: {
    source: SourceHandle | null;
    mode: InsertMode;
    pagesInput: string;
    position: InsertPosition;
    reference: number;
  };
  insertPreview: {
    pages: number[];
    error: string | null;
    reference: number;
    referenceError: string | null;
    targetIndex: number;
  };
  deleteInput: string;
  deletePreview: { positions: number[]; error: string | null };

  openFile: (path: string) => Promise<void>;
  /** Closes the main PDF together with everything inserted into it. */
  closeDocument: () => void;
  beginInsertFile: (path: string) => Promise<void>;
  beginInsertFromSource: (sourceId: string) => void;
  setInsertMode: (mode: InsertMode) => void;
  setInsertPagesInput: (value: string) => void;
  setInsertPosition: (position: InsertPosition) => void;
  setInsertReference: (reference: number) => void;
  confirmInsert: () => void;

  setDeleteInput: (value: string) => void;
  confirmDelete: () => void;

  removeSource: (sourceId: string) => void;

  selectAt: (index: number, modifiers: { toggle: boolean; range: boolean }) => void;
  clearSelection: () => void;
  selectAll: () => void;

  rotateSelection: (delta?: number) => void;
  flipSelection: () => void;
  deleteSelection: () => void;
  rotateAt: (index: number) => void;
  flipAt: (index: number) => void;
  removeAt: (index: number) => void;
  duplicateAt: (index: number) => void;
  movePage: (from: number, to: number) => void;

  undo: () => void;
  redo: () => void;
  reset: () => void;
  save: (outputFilename: string) => Promise<void>;
}

/**
 * Owns the whole Organize workspace session: the page list, sources, selection,
 * bounded undo history, thumbnail loading, and saving. Editing happens entirely
 * in memory; the native core is contacted only to add a file, to render
 * thumbnails, to release a handle, and to assemble the final list on save.
 * Files are named by their path on disk and never copied.
 */
export function useOrganizeWorkspace(): OrganizeWorkspace {
  const { showToast } = useToast();
  const [state, setState] = useState<WorkspaceState>(EMPTY_STATE);
  const [mainSourceId, setMainSourceId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [panel, setPanel] = useState<WorkspacePanel>('none');

  const [insertSource, setInsertSource] = useState<SourceHandle | null>(null);
  const [insertPendingSource, setInsertPendingSource] = useState<SourceHandle | null>(null);
  const [insertMode, setInsertMode] = useState<InsertMode>('all');
  const [insertPagesInput, setInsertPagesInput] = useState('');
  const [insertPosition, setInsertPositionState] = useState<InsertPosition>('after');
  const [insertReference, setInsertReferenceState] = useState(1);
  const [deleteInput, setDeleteInput] = useState('');

  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ filename: string; detail: string; outputPath: string } | null>(null);

  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const loadedSourcesRef = useRef<Set<string>>(new Set());
  const thumbnailUrlsRef = useRef<Map<string, string>>(new Map());
  const sourcesRef = useRef<SourceHandle[]>([]);
  const saveAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveAbortRef.current?.abort();
    };
  }, []);

  // Keep the latest sources for teardown without re-running teardown.
  useEffect(() => {
    sourcesRef.current = state.sources;
  }, [state.sources]);

  // Release handles and preview URLs when the workspace goes away.
  useEffect(() => {
    // Copy the ref object (not its value) so the cleanup still sees every URL
    // created after mount.
    const urls = thumbnailUrlsRef;
    const handles = sourcesRef;
    return () => {
      urls.current.forEach((url) => URL.revokeObjectURL(url));
      urls.current.clear();
      for (const source of handles.current) {
        void releaseDocument(source.documentId).catch(() => {});
      }
    };
  }, []);

  // Load every page of every source, in bounded batches from the first page, and
  // only once per source. Editing stays available while this runs.
  useEffect(() => {
    let cancelled = false;
    const pending = state.sources.filter((source) => !loadedSourcesRef.current.has(source.id));
    if (pending.length === 0) return;

    void (async () => {
      for (const source of pending) {
        for (let start = 1; start <= source.pageCount; start += THUMBNAIL_BATCH) {
          if (cancelled) return;
          const count = Math.min(THUMBNAIL_BATCH, source.pageCount - start + 1);
          let batch;
          try {
            batch = await fetchThumbnails(source.documentId, start, count, THUMBNAIL_WIDTH);
          } catch {
            return; // a failed batch stops this source; the grid keeps placeholders
          }
          if (cancelled) return;

          const additions: Record<string, string> = {};
          for (const entry of batch.pages) {
            const key = thumbnailKey(source.id, entry.page);
            const url = thumbnailUrl(entry.png);
            thumbnailUrlsRef.current.set(key, url);
            additions[key] = url;
          }
          setThumbnails((previous) => ({ ...previous, ...additions }));
        }
        loadedSourcesRef.current.add(source.id);
      }
    })();

    return () => { cancelled = true; };
  }, [state.sources]);

  // ── history ───────────────────────────────────────────────────────────────
  const commit = useCallback((update: (snapshot: OrganizeSnapshot) => OrganizeSnapshot) => {
    setState((current) => {
      const next = update({ pages: current.pages, sources: current.sources });
      if (next.pages === current.pages && next.sources === current.sources) return current;
      const snapshot: OrganizeSnapshot = { pages: current.pages, sources: current.sources };
      return {
        pages: next.pages,
        sources: next.sources,
        past: [...current.past, snapshot].slice(-HISTORY_LIMIT),
        future: [],
      };
    });
    setResult(null);
  }, []);

  const undo = useCallback(() => {
    if (state.past.length === 0) return;
    const previous = state.past[state.past.length - 1];
    const present: OrganizeSnapshot = { pages: state.pages, sources: state.sources };
    setState({
      pages: previous.pages,
      sources: previous.sources,
      past: state.past.slice(0, -1),
      future: [present, ...state.future].slice(0, HISTORY_LIMIT),
    });
    setSelection((selected) => pruneSelection(selected, previous.pages.length));
    setResult(null);
  }, [state]);

  const redo = useCallback(() => {
    if (state.future.length === 0) return;
    const [next, ...rest] = state.future;
    const present: OrganizeSnapshot = { pages: state.pages, sources: state.sources };
    setState({
      pages: next.pages,
      sources: next.sources,
      past: [...state.past, present].slice(-HISTORY_LIMIT),
      future: rest,
    });
    setSelection((selected) => pruneSelection(selected, next.pages.length));
    setResult(null);
  }, [state]);

  // ── opening and inserting files ───────────────────────────────────────────
  const openFile = useCallback(async (path: string) => {
    if (busyRef.current || state.pages.length > 0) return;
    setError(null);
    setIsBusy(true);
    busyRef.current = true;
    try {
      const opened = await openDocument(path);
      if (!mountedRef.current) return;
      const source: SourceHandle = { id: opened.documentId, ...opened, fingerprint: pathKey(path) };
      const pages = Array.from({ length: opened.pageCount }, (_, index) =>
        createPageRef(source.id, index + 1));
      setState({ pages, sources: [source], past: [], future: [] });
      setMainSourceId(source.id);
      setSelection(new Set());
    } catch (err) {
      if (!mountedRef.current) return;
      const message = organizeErrorMessage(err, t('The file could not be added.'));
      setError(message);
      showToast({ type: 'error', title: t('File not added'), message });
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setIsBusy(false);
    }
  }, [showToast, state.pages.length]);

  const beginInsertFile = useCallback(async (path: string) => {
    if (busyRef.current || state.pages.length === 0) return;

    // The same file is never added twice, so Sources never holds duplicates.
    const fingerprint = pathKey(path);
    const name = baseName(path);
    const existing = state.sources.find((entry) => entry.fingerprint === fingerprint);
    if (existing || insertPendingSource?.fingerprint === fingerprint) {
      const isMain = existing?.id === mainSourceId;
      const message = isMain
        ? t('{name} is the PDF you opened. Use Duplicate on a page to repeat its pages.', { name })
        : t('{name} is already in Sources. Use + next to it there to insert pages from it again.', { name });
      setError(message);
      showToast({ type: 'error', title: t('File already added'), message });
      if (!isMain) setPanel('sources');
      return;
    }

    setError(null);
    setIsBusy(true);
    busyRef.current = true;
    try {
      const opened = await openDocument(path);
      if (!mountedRef.current) return;
      const source: SourceHandle = { id: opened.documentId, ...opened, fingerprint };
      setInsertPendingSource(source);
      setInsertSource(source);
      setInsertMode('all');
      setInsertPagesInput('');
      setInsertPositionState('after');
      setInsertReferenceState(defaultReferencePage(selection, state.pages.length, 'after'));
      setPanel('insert');
    } catch (err) {
      if (!mountedRef.current) return;
      const message = organizeErrorMessage(err, t('The file could not be added.'));
      setError(message);
      showToast({ type: 'error', title: t('File not added'), message });
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setIsBusy(false);
    }
  }, [insertPendingSource, mainSourceId, selection, showToast, state.pages.length, state.sources]);

  const beginInsertFromSource = useCallback((sourceId: string) => {
    const source = state.sources.find((entry) => entry.id === sourceId);
    if (!source) return;
    setInsertPendingSource(null);
    setInsertSource(source);
    setInsertMode('all');
    setInsertPagesInput('');
    setInsertPositionState('after');
    setInsertReferenceState(defaultReferencePage(selection, state.pages.length, 'after'));
    setPanel('insert');
  }, [selection, state.pages.length, state.sources]);

  const setInsertPosition = useCallback((position: InsertPosition) => {
    // Re-derive only when the side really changes: choosing the side that is
    // already active must not discard a reference page the user typed.
    if (position === insertPosition) return;
    setInsertPositionState(position);
    // "After" measures from the last selected page and "before" from the first.
    setInsertReferenceState(defaultReferencePage(selection, state.pages.length, position));
  }, [insertPosition, selection, state.pages.length]);

  const setInsertReference = useCallback((reference: number) => {
    setInsertReferenceState(reference);
  }, []);

  const closePanel = useCallback(() => {
    // A file uploaded for an insert that was never confirmed is released again.
    if (insertPendingSource) {
      void releaseDocument(insertPendingSource.documentId).catch(() => {});
    }
    setInsertPendingSource(null);
    setInsertSource(null);
    setDeleteInput('');
    setPanel('none');
  }, [insertPendingSource]);

  const insertPreview = useMemo(() => {
    const total = state.pages.length;
    const pages = !insertSource
      ? []
      : insertSource.pageCount === 1 || insertMode === 'all'
        ? Array.from({ length: insertSource.pageCount }, (_, index) => index + 1)
        : parsePageExpression(insertPagesInput, insertSource.pageCount).pages;
    const error = insertSource && insertSource.pageCount > 1 && insertMode === 'pick'
      ? parsePageExpression(insertPagesInput, insertSource.pageCount).error
      : null;

    const reference = clampReference(insertReference, total);
    const referenceError = !Number.isFinite(insertReference)
      ? t('Enter the page the insertion is measured from.')
      : insertReference < 1 || insertReference > total
        ? t('Reference page must be between 1 and {total}.', { total })
        : null;

    return {
      pages,
      error,
      reference,
      referenceError,
      targetIndex: insertionIndex(reference, insertPosition),
    };
  }, [insertMode, insertPagesInput, insertPosition, insertReference, insertSource, state.pages.length]);

  const confirmInsert = useCallback(() => {
    if (!insertSource) return;
    const pages = insertMode === 'all'
      ? Array.from({ length: insertSource.pageCount }, (_, index) => index + 1)
      : parsePageExpression(insertPagesInput, insertSource.pageCount).pages;
    if (pages.length === 0) return;

    if (insertPreview.referenceError) return;
    const source = insertPendingSource ?? insertSource;
    const incoming = pages.map((page) => createPageRef(source.id, page));
    commit((snapshot) => {
      const at = insertionIndex(insertPreview.reference, insertPosition);
      const sources = snapshot.sources.some((entry) => entry.id === source.id)
        ? snapshot.sources
        : [...snapshot.sources, source];
      return { pages: insertPages(snapshot.pages, at, incoming), sources };
    });
    setInsertPendingSource(null);
    setInsertSource(null);
    setPanel('none');
  }, [commit, insertMode, insertPagesInput, insertPendingSource, insertPosition, insertPreview, insertSource]);

  // ── bulk delete ───────────────────────────────────────────────────────────
  const deletePreview = useMemo(() => {
    if (state.pages.length === 0) return { positions: [], error: null };
    const parsed = parsePageExpression(deleteInput, state.pages.length);
    if (!parsed.valid) return { positions: [], error: parsed.error };
    return { positions: [...new Set(parsed.pages.map((page) => page - 1))], error: null };
  }, [deleteInput, state.pages.length]);

  const confirmDelete = useCallback(() => {
    if (deletePreview.positions.length === 0) return;
    const targets = deletePreview.positions;
    commit((snapshot) => ({ pages: removePositions(snapshot.pages, targets), sources: snapshot.sources }));
    setSelection((previous) => pruneSelection(previous, state.pages.length - targets.length));
    setDeleteInput('');
    setPanel('none');
  }, [commit, deletePreview.positions, state.pages.length]);

  const removeSource = useCallback((sourceId: string) => {
    const positions = positionsOfSource(state.pages, sourceId);
    const thumbs = thumbnailUrlsRef.current;
    for (const [key, url] of thumbs) {
      if (key.startsWith(`${sourceId}:`)) {
        URL.revokeObjectURL(url);
        thumbs.delete(key);
      }
    }
    setThumbnails((previous) => {
      const next = { ...previous };
      for (const key of Object.keys(next)) {
        if (key.startsWith(`${sourceId}:`)) delete next[key];
      }
      return next;
    });
    setSelection((previous) => pruneSelection(previous, state.pages.length - positions.length));
    commit((snapshot) => ({
      pages: removePositions(snapshot.pages, positions),
      sources: snapshot.sources.filter((entry) => entry.id !== sourceId),
    }));
    const removed = state.sources.find((entry) => entry.id === sourceId);
    if (removed) void releaseDocument(removed.documentId).catch(() => {});

    // Removing the document the workspace started from leaves nothing to reset
    // to, so the session ends and its history goes with it.
    if (sourceId === mainSourceId) {
      setMainSourceId(null);
      setState((current) => ({ ...current, past: [], future: [] }));
    }
  }, [commit, mainSourceId, state.pages, state.sources]);

  // ── selection ─────────────────────────────────────────────────────────────
  const selectAt = useCallback((index: number, modifiers: { toggle: boolean; range: boolean }) => {
    // While the insert panel is open, the clicked page also becomes the
    // reference the insertion is measured from.
    if (panel === 'insert') setInsertReferenceState(index + 1);
    if (modifiers.range && anchor !== null) {
      setSelection(selectRange(anchor, index));
      return;
    }
    if (modifiers.toggle) {
      setSelection((previous) => toggleSelection(previous, index));
      setAnchor(index);
      return;
    }
    setSelection(selectOnly(index));
    setAnchor(index);
  }, [anchor, panel]);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    setAnchor(null);
  }, []);

  const selectAll = useCallback(() => {
    setSelection(new Set(state.pages.map((_, index) => index)));
  }, [state.pages]);

  const selectedPositions = useMemo(() => [...selection].sort((a, b) => a - b), [selection]);

  // ── page actions ──────────────────────────────────────────────────────────
  const rotateSelection = useCallback((delta = 90) => {
    if (selection.size === 0) return;
    const targets = selectedPositions;
    commit((snapshot) => ({ pages: rotatePositions(snapshot.pages, targets, delta), sources: snapshot.sources }));
  }, [commit, selectedPositions, selection.size]);

  const flipSelection = useCallback(() => {
    if (selection.size === 0) return;
    const targets = selectedPositions;
    commit((snapshot) => ({ pages: flipPositions(snapshot.pages, targets), sources: snapshot.sources }));
  }, [commit, selectedPositions, selection.size]);

  const deleteSelection = useCallback(() => {
    if (selection.size === 0) return;
    const targets = selectedPositions;
    commit((snapshot) => ({ pages: removePositions(snapshot.pages, targets), sources: snapshot.sources }));
    setSelection(new Set());
    setAnchor(null);
  }, [commit, selectedPositions, selection.size]);

  const duplicateAt = useCallback((index: number) => {
    commit((snapshot) => ({ pages: duplicatePage(snapshot.pages, index), sources: snapshot.sources }));
  }, [commit]);

  // Single-cell actions target that cell directly rather than going through the
  // selection, which would still hold the previous value in the same tick.
  const rotateAt = useCallback((index: number) => {
    commit((snapshot) => ({ pages: rotatePositions(snapshot.pages, [index]), sources: snapshot.sources }));
  }, [commit]);

  const flipAt = useCallback((index: number) => {
    commit((snapshot) => ({ pages: flipPositions(snapshot.pages, [index]), sources: snapshot.sources }));
  }, [commit]);

  const removeAt = useCallback((index: number) => {
    commit((snapshot) => ({ pages: removePositions(snapshot.pages, [index]), sources: snapshot.sources }));
    setSelection((previous) => pruneSelection(previous, state.pages.length - 1));
  }, [commit, state.pages.length]);

  const move = useCallback((from: number, to: number) => {
    commit((snapshot) => ({ pages: movePage(snapshot.pages, from, to), sources: snapshot.sources }));
  }, [commit]);

  // ── close, reset and save ─────────────────────────────────────────────────
  const closeDocument = useCallback(() => {
    if (busyRef.current) return;
    // Everything inserted belongs to this document, so every handle goes with it.
    for (const source of state.sources) {
      void releaseDocument(source.documentId).catch(() => {});
    }
    if (insertPendingSource) void releaseDocument(insertPendingSource.documentId).catch(() => {});
    thumbnailUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    thumbnailUrlsRef.current.clear();
    loadedSourcesRef.current.clear();
    setThumbnails({});
    setState(EMPTY_STATE);
    setMainSourceId(null);
    setSelection(new Set());
    setAnchor(null);
    setPanel('none');
    setInsertPendingSource(null);
    setInsertSource(null);
    setDeleteInput('');
    setResult(null);
    setError(null);
  }, [insertPendingSource, state.sources]);

  const reset = useCallback(() => {
    const main = state.sources.find((entry) => entry.id === mainSourceId);
    if (!main) return;
    // Only the released documents lose their previews; the main document's
    // thumbnails stay cached, because its pages are about to be restored.
    for (const source of state.sources) {
      if (source.id === main.id) continue;
      void releaseDocument(source.documentId).catch(() => {});
      for (const [key, url] of thumbnailUrlsRef.current) {
        if (key.startsWith(`${source.id}:`)) {
          URL.revokeObjectURL(url);
          thumbnailUrlsRef.current.delete(key);
        }
      }
    }
    setThumbnails((previous) => {
      const next: Record<string, string> = {};
      for (const [key, url] of Object.entries(previous)) {
        if (key.startsWith(`${main.id}:`)) next[key] = url;
      }
      return next;
    });
    // Reset releases the inserted documents' handles, so the history that
    // referred to them is cleared rather than left un-undoable.
    setState({
      pages: Array.from({ length: main.pageCount }, (_, index) => createPageRef(main.id, index + 1)),
      sources: [main],
      past: [],
      future: [],
    });
    setSelection(new Set());
    setAnchor(null);
    setPanel('none');
    setResult(null);
  }, [mainSourceId, state.sources]);

  const save = useCallback(async (outputFilename: string) => {
    if (busyRef.current || state.pages.length === 0) return;
    setError(null);
    setResult(null);
    setIsBusy(true);
    busyRef.current = true;
    const controller = new AbortController();
    saveAbortRef.current = controller;
    try {
      const payload: AssemblePagePayload[] = state.pages.map((entry) => ({
        source: entry.source, page: entry.page, rotation: entry.rotation, flip: entry.flip,
      }));
      const report = await assembleDocument(payload, outputFilename || 'organized', { signal: controller.signal });
      if (!mountedRef.current) return;
      const filename = baseName(report.outputPath);
      setResult({
        filename,
        outputPath: report.outputPath,
        detail: tn(report.pages, '{n} page', '{n} pages'),
      });
      addHistoryEntry({ filename, action: 'Organize PDF', size: report.outputSizeBytes });
      showToast({
        type: 'success',
        title: t('Document saved'),
        message: tn(report.pages, '{n} page assembled', '{n} pages assembled'),
        action: { label: t('Show in folder'), onClick: () => { void revealPath(report.outputPath).catch(() => undefined); } },
        duration: 8000,
      });
    } catch (err) {
      if (!mountedRef.current || isCoreCancelled(err)) return;
      const message = organizeErrorMessage(err, t('The document could not be saved.'));
      setError(message);
      showToast({ type: 'error', title: t('Save failed'), message });
    } finally {
      saveAbortRef.current = null;
      busyRef.current = false;
      if (mountedRef.current) setIsBusy(false);
    }
  }, [showToast, state.pages]);

  return {
    pages: state.pages,
    sources: state.sources,
    mainSourceId,
    selection,
    selectedPositions,
    hasDocument: state.pages.length > 0,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,

    panel,
    openPanel: setPanel,
    closePanel,

    thumbnails,
    thumbnailsLoaded: Object.keys(thumbnails).length,
    thumbnailsTotal: state.sources.reduce((total, source) => total + source.pageCount, 0),

    isBusy,
    error,
    dismissError: () => setError(null),
    result,

    insertDraft: {
      source: insertSource,
      mode: insertMode,
      pagesInput: insertPagesInput,
      position: insertPosition,
      reference: insertReference,
    },
    insertPreview,
    deleteInput,
    deletePreview,

    openFile,
    closeDocument,
    beginInsertFile,
    beginInsertFromSource,
    setInsertMode,
    setInsertPagesInput,
    setInsertPosition,
    setInsertReference,
    confirmInsert,

    setDeleteInput,
    confirmDelete,

    removeSource,

    selectAt,
    clearSelection,
    selectAll,

    rotateSelection,
    flipSelection,
    deleteSelection,
    rotateAt,
    flipAt,
    removeAt,
    duplicateAt,
    movePage: move,

    undo,
    redo,
    reset,
    save,
  };
}
