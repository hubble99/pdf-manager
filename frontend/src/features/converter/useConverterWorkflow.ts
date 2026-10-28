import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useFeatureFile } from '../../hooks/useFeatureFile';
import { useToast } from '../../hooks/useToast';
import { addHistoryEntry } from '../../utils/historyStore';
import { baseName, stemOf } from '../../utils/paths';
import { NativeCoreError, fileSizes, isCoreCancelled, type CoreProgress } from '../../api/nativeCore';
import { getPdfInfo, type PdfInfo } from '../../api/pdfRender';
import {
  exportPdfImages, imagesToPdf, type ImageToPdfReport, type PdfImageFormat, type PdfToImageReport,
} from '../../api/pdfImage';
import {
  addConverterPaths, classifyConverterPath, converterKind,
  type ConverterImage, type ConverterInput, type ConverterKind,
} from './batch';
import { formatBytes, nextRotation } from './options';
import {
  initialPageSelection, pageSelectionReducer, resolvePageSelection, serializePageSelection,
  type ResolvedSelection,
} from './pageSelection';
import { t, tn } from '../../i18n';

export interface ConverterResult {
  /** Where the file was saved. */
  outputPath: string;
  filename: string;
  detail: string;
  isZip: boolean;
}

export type PdfInfoState = 'idle' | 'loading' | 'ready' | 'protected' | 'error';

export interface ConverterWorkflow {
  kind: ConverterKind;
  /** Path of the loaded PDF. */
  pdfPath: string | null;
  images: ConverterImage[];
  /** Size in bytes of each image by id; `null` when unreadable, missing while unknown. */
  imageSizes: Record<string, number | null>;

  batchError: string | null;
  error: string | null;
  /** Images the last PDF could not include. */
  skippedNotice: string | null;
  result: ConverterResult | null;
  isConverting: boolean;
  progress: CoreProgress | null;

  pdfInfo: PdfInfo | null;
  pdfInfoState: PdfInfoState;
  selection: ResolvedSelection;
  selectionMode: 'all' | 'selected';
  selectionDraft: string;
  pdfBlockReason: string | null;

  format: string;
  dpi: number;
  pdfOutputName: string;
  pageSize: string;
  imageOutputName: string;

  /** `expected` is the tab the files were added on; a mismatch is reported, not guessed. */
  addPaths: (paths: string[], expected?: 'pdf' | 'images') => void;
  replacePaths: (paths: string[]) => void;
  clear: () => void;
  dismissError: () => void;
  dismissBatchError: () => void;
  reportBatchError: (message: string) => void;
  setSelectionMode: (mode: 'all' | 'selected') => void;
  setSelectionDraft: (draft: string) => void;
  togglePageSelection: (page: number) => void;
  setFormat: (format: string) => void;
  setDpi: (dpi: number) => void;
  setPdfOutputName: (name: string) => void;
  setPageSize: (size: string) => void;
  setImageOutputName: (name: string) => void;
  rotateImage: (id: string) => void;
  flipImage: (id: string) => void;
  reorderImages: (from: number, to: number) => void;
  removeImage: (id: string) => void;
  convert: () => Promise<void>;
  cancel: () => void;
}

export function converterErrorMessage(err: unknown): string {
  if (err instanceof NativeCoreError) {
    switch (err.code) {
      case 'password_required':
        return t('This PDF is protected. Remove the protection first, then export its pages.');
      case 'not_found':
        return t('A file could not be found. It may have been moved or renamed.');
      case 'invalid_input':
        return err.message.includes('none of the provided images')
          ? t('None of the images could be read. Check that they are valid pictures.')
          : t('This file does not look like a valid PDF.');
      case 'io':
        return t('The result could not be saved. Check that the Downloads folder is writable and has free space.');
      case 'insufficient_memory':
        return t('The computer is low on memory. Close other programs and try again.');
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : t('Unknown error');
}

/**
 * Owns converter batch transitions, explicit page selection, job ownership,
 * and conversion submission. Files are paths on disk; the native core reads
 * them and saves the result in the Downloads folder.
 */
export function useConverterWorkflow(): ConverterWorkflow {
  const { showToast } = useToast();
  const { fileData, setFileData, clearFileData } = useFeatureFile<ConverterInput>('converter');
  const input = fileData ?? null;

  const [batchError, setBatchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skippedNotice, setSkippedNotice] = useState<string | null>(null);
  const [result, setResult] = useState<ConverterResult | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [progress, setProgress] = useState<CoreProgress | null>(null);

  const [pdfInfo, setPdfInfo] = useState<PdfInfo | null>(null);
  const [pdfInfoFailed, setPdfInfoFailed] = useState(false);
  const [pageSelection, dispatch] = useReducer(pageSelectionReducer, undefined, initialPageSelection);

  const [format, setFormatState] = useState('PNG');
  const [dpi, setDpiState] = useState(150);
  const [pdfOutputName, setPdfOutputNameState] = useState('');
  const [pageSize, setPageSizeState] = useState('a4');
  const [imageOutputName, setImageOutputNameState] = useState('output.pdf');
  const [imageSizes, setImageSizes] = useState<Record<string, number | null>>({});

  const kind = converterKind(input);
  const pdfPath = typeof input === 'string' ? input : null;
  const images = useMemo(() => (Array.isArray(input) ? input : []), [input]);
  const totalPages = pdfInfo?.pages ?? 0;
  const selection = resolvePageSelection(pageSelection, totalPages);
  const pdfInfoState: PdfInfoState = !pdfPath
    ? 'idle'
    : pdfInfo
      ? (pdfInfo.encrypted ? 'protected' : 'ready')
      : pdfInfoFailed ? 'error' : 'loading';

  const generationRef = useRef(0);
  const convertingRef = useRef(false);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // Read the page count for the active PDF. Results are applied only while the
  // request still owns the current document.
  useEffect(() => {
    if (!pdfPath) return;
    const generation = ++generationRef.current;
    let cancelled = false;
    getPdfInfo(pdfPath)
      .then((info) => {
        if (cancelled || generation !== generationRef.current || !mountedRef.current) return;
        setPdfInfo(info);
      })
      .catch(() => {
        if (cancelled || generation !== generationRef.current || !mountedRef.current) return;
        setPdfInfoFailed(true);
      });
    return () => { cancelled = true; };
  }, [pdfPath]);

  // Sizes of newly added images, for the cards.
  useEffect(() => {
    const unknown = images.filter((entry) => !(entry.id in imageSizes));
    if (unknown.length === 0) return;
    let cancelled = false;
    fileSizes(unknown.map((entry) => entry.path))
      .then((sizes) => {
        if (cancelled || !mountedRef.current) return;
        setImageSizes((previous) => {
          const next = { ...previous };
          unknown.forEach((entry, index) => { next[entry.id] = sizes[index] ?? null; });
          return next;
        });
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        setImageSizes((previous) => {
          const next = { ...previous };
          unknown.forEach((entry) => { next[entry.id] = null; });
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [images, imageSizes]);

  const invalidateResult = useCallback(() => { setResult(null); setSkippedNotice(null); }, []);

  /** Document-specific state is reset here, not in the fetch effect. */
  const startNewDocument = useCallback((document: string) => {
    dispatch({ type: 'reset' });
    setPdfInfo(null);
    setPdfInfoFailed(false);
    setResult(null);
    setSkippedNotice(null);
    setError(null);
    setPdfOutputNameState(stemOf(document));
  }, []);

  const commitInput = useCallback((next: ConverterInput) => {
    if (typeof next === 'string') startNewDocument(next);
    setFileData(next);
    setBatchError(null);
    setError(null);
    setResult(null);
    setSkippedNotice(null);
  }, [setFileData, startNewDocument]);

  const reportBatchError = useCallback((message: string) => {
    setBatchError(message);
    showToast({ type: 'error', title: t('Files not added'), message });
  }, [showToast]);

  const addPaths = useCallback((incoming: string[], expected?: 'pdf' | 'images') => {
    if (convertingRef.current) return;
    setBatchError(null);
    if (expected && incoming.length > 0) {
      const wrongTab = incoming.every((path) => {
        const detected = classifyConverterPath(path);
        return detected !== null && detected !== expected;
      });
      if (wrongTab) {
        reportBatchError(expected === 'pdf'
          ? t('This tab takes one PDF. To combine images into a PDF, use the Images to PDF tab.')
          : t('This tab takes images. To export PDF pages as images, use the PDF to Images tab.'));
        return;
      }
    }
    const addition = addConverterPaths(input, incoming);
    if (addition.error) {
      reportBatchError(addition.error);
      return;
    }
    if (addition.input === input) return;
    commitInput(addition.input);
  }, [commitInput, input, reportBatchError]);

  const replacePaths = useCallback((incoming: string[]) => {
    if (convertingRef.current) return;
    setBatchError(null);
    // Replace is an explicit user action, so validation runs against an empty batch.
    const addition = addConverterPaths(null, incoming);
    if (addition.error) {
      reportBatchError(addition.error);
      return;
    }
    if (addition.input === null) return;
    commitInput(addition.input);
  }, [commitInput, reportBatchError]);

  const clear = useCallback(() => {
    generationRef.current += 1;
    clearFileData();
    setBatchError(null);
    setError(null);
    setResult(null);
    setSkippedNotice(null);
    setPdfInfo(null);
    setPdfInfoFailed(false);
    setImageSizes({});
    dispatch({ type: 'reset' });
  }, [clearFileData]);

  const mutateImages = useCallback((updater: (entries: ConverterImage[]) => ConverterImage[]) => {
    if (convertingRef.current) return;
    setFileData((previous) => updater(Array.isArray(previous) ? previous as ConverterImage[] : []));
    setBatchError(null);
    setError(null);
    setResult(null);
    setSkippedNotice(null);
  }, [setFileData]);

  const setSelectionMode = useCallback((mode: 'all' | 'selected') => {
    dispatch({ type: 'mode', mode });
    invalidateResult();
  }, [invalidateResult]);

  const setSelectionDraft = useCallback((draft: string) => {
    dispatch({ type: 'draft', draft });
    invalidateResult();
  }, [invalidateResult]);

  const togglePageSelection = useCallback((page: number) => {
    if (pdfInfoState !== 'ready') return;
    dispatch({ type: 'toggle', page, total: totalPages });
    invalidateResult();
  }, [invalidateResult, pdfInfoState, totalPages]);

  const rotateImage = useCallback((id: string) => {
    mutateImages((entries) => entries.map((entry) => (
      entry.id === id ? { ...entry, rotation: nextRotation(entry.rotation) } : entry
    )));
  }, [mutateImages]);

  const flipImage = useCallback((id: string) => {
    mutateImages((entries) => entries.map((entry) => (
      entry.id === id ? { ...entry, flipH: !entry.flipH } : entry
    )));
  }, [mutateImages]);

  const reorderImages = useCallback((from: number, to: number) => {
    mutateImages((entries) => {
      if (from < 0 || to < 0 || from >= entries.length || to >= entries.length || from === to) return entries;
      const next = [...entries];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, [mutateImages]);

  const removeImage = useCallback((id: string) => {
    mutateImages((entries) => entries.filter((entry) => entry.id !== id));
  }, [mutateImages]);

  const setFormat = useCallback((value: string) => { setFormatState(value); invalidateResult(); }, [invalidateResult]);
  const setDpi = useCallback((value: number) => { setDpiState(value); invalidateResult(); }, [invalidateResult]);
  const setPdfOutputName = useCallback((value: string) => { setPdfOutputNameState(value); invalidateResult(); }, [invalidateResult]);
  const setPageSize = useCallback((value: string) => { setPageSizeState(value); invalidateResult(); }, [invalidateResult]);
  const setImageOutputName = useCallback((value: string) => { setImageOutputNameState(value); invalidateResult(); }, [invalidateResult]);

  const pdfBlockReason = useMemo(() => {
    if (kind !== 'pdf') return t('Add a PDF to export images.');
    if (pdfInfoState === 'loading') return t('Reading the PDF page count…');
    if (pdfInfoState === 'protected') return t('This PDF is protected. Remove the protection first, then export its pages.');
    if (pdfInfoState === 'error') return t('The PDF page count could not be read. Remove and add the PDF again.');
    if (!selection.valid) return selection.error;
    return null;
  }, [kind, pdfInfoState, selection]);

  const cancel = useCallback(() => { abortRef.current?.abort(); }, []);

  const finish = useCallback((cancelled: boolean) => {
    abortRef.current = null;
    convertingRef.current = false;
    if (!mountedRef.current) return;
    setIsConverting(false);
    setProgress(null);
    if (cancelled) {
      showToast({ type: 'info', title: t('Conversion cancelled'), message: t('Nothing was saved.') });
    }
  }, [showToast]);

  const convert = useCallback(async () => {
    if (convertingRef.current) return;
    const isPdf = kind === 'pdf';
    if (isPdf && (!pdfPath || pdfInfoState !== 'ready' || !selection.valid || selection.pages.size === 0)) return;
    if (!isPdf && (kind !== 'images' || images.length === 0)) return;

    convertingRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsConverting(true);
    setError(null);
    setResult(null);
    setSkippedNotice(null);
    setProgress(null);
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current && mountedRef.current;
    const jobOptions = { signal: controller.signal, onProgress: (p: CoreProgress) => { if (isCurrent()) setProgress(p); } };
    let cancelled = false;

    try {
      if (isPdf && pdfPath) {
        const report: PdfToImageReport = await exportPdfImages(pdfPath, {
          format: format.toLowerCase() as PdfImageFormat,
          dpi,
          pageRanges: serializePageSelection(pageSelection, totalPages),
          outputName: pdfOutputName || stemOf(pdfPath),
        }, jobOptions);
        if (!isCurrent()) return;
        const filename = baseName(report.outputPath);
        const reduced = report.reducedPages.length > 0
          ? ` · ${tn(report.reducedPages.length, '{n} large page used a lower DPI', '{n} large pages used a lower DPI')}`
          : '';
        setResult({
          outputPath: report.outputPath,
          filename,
          isZip: report.isZip,
          detail: `${tn(report.pages, '{n} page', '{n} pages')} · ${format} · ${dpi} DPI${report.isZip ? t(' (ZIP archive)') : ''} · ${formatBytes(report.outputSizeBytes)}${reduced}`,
        });
        addHistoryEntry({ filename, action: 'PDF to Image', size: report.outputSizeBytes });
      } else {
        const report: ImageToPdfReport = await imagesToPdf(
          images.map((entry) => ({ path: entry.path, rotation: entry.rotation, flipH: entry.flipH })),
          pageSize,
          imageOutputName || 'output.pdf',
          jobOptions,
        );
        if (!isCurrent()) return;
        const filename = baseName(report.outputPath);
        setResult({
          outputPath: report.outputPath,
          filename,
          isZip: false,
          detail: `${tn(report.pages, '{n} page', '{n} pages')} · ${report.pageSize.toUpperCase()} · ${formatBytes(report.outputSizeBytes)}`,
        });
        if (report.skipped.length > 0) {
          setSkippedNotice(t('Skipped because they could not be read: {names}', {
            names: report.skipped.map((item) => baseName(item.source)).join(', '),
          }));
        }
        addHistoryEntry({ filename, action: 'Image to PDF', size: report.outputSizeBytes });
      }
    } catch (err: unknown) {
      if (isCoreCancelled(err)) {
        cancelled = true;
      } else if (isCurrent()) {
        const message = converterErrorMessage(err);
        setError(message);
        showToast({ type: 'error', title: t('Conversion failed'), message });
      }
    } finally {
      finish(cancelled && generation === generationRef.current);
    }
  }, [
    dpi, finish, format, imageOutputName, images, kind, pageSelection, pageSize, pdfInfoState,
    pdfOutputName, pdfPath, selection, showToast, totalPages,
  ]);

  return {
    kind,
    pdfPath,
    images,
    imageSizes,
    batchError,
    error,
    skippedNotice,
    result,
    isConverting,
    progress,
    pdfInfo,
    pdfInfoState,
    selection,
    selectionMode: pageSelection.mode,
    selectionDraft: pageSelection.draft,
    pdfBlockReason,
    format,
    dpi,
    pdfOutputName,
    pageSize,
    imageOutputName,
    addPaths,
    replacePaths,
    clear,
    dismissError: () => setError(null),
    dismissBatchError: () => setBatchError(null),
    reportBatchError,
    setSelectionMode,
    setSelectionDraft,
    togglePageSelection,
    setFormat,
    setDpi,
    setPdfOutputName,
    setPageSize,
    setImageOutputName,
    rotateImage,
    flipImage,
    reorderImages,
    removeImage,
    convert,
    cancel,
  };
}
