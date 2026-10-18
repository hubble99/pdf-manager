import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import apiClient from '../../api/client';
import { useFeatureFile } from '../../hooks/useFeatureFile';
import { useToast } from '../../hooks/useToast';
import { addHistoryEntry } from '../../utils/historyStore';
import { getFilenameFromHeaders, triggerBlobDownload } from '../../utils/downloadHelper';
import { openOutputFolder } from '../../utils/tauriDialog';
import type { PdfInfoResult } from '../../types';
import {
  addConverterFiles, classifyConverterFile, converterKind,
  type ConverterImage, type ConverterInput, type ConverterKind,
} from './batch';
import { formatBytes, nextRotation } from './options';
import {
  initialPageSelection, pageSelectionReducer, resolvePageSelection, serializePageSelection,
  type ResolvedSelection,
} from './pageSelection';
import { t, tn } from '../../i18n';

export interface ConverterResult {
  filename: string;
  detail: string;
  isZip: boolean;
}

export type PdfInfoState = 'idle' | 'loading' | 'ready' | 'error';

export interface ConverterWorkflow {
  kind: ConverterKind;
  pdfFile: File | null;
  images: ConverterImage[];

  batchError: string | null;
  error: string | null;
  result: ConverterResult | null;
  isConverting: boolean;

  pdfInfo: PdfInfoResult | null;
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

  previewPage: number;
  activeImageId: string | null;
  activeImage: ConverterImage | null;
  zoom: number;

  accept: string;
  /** `expected` is the tab the files were added on; a mismatch is reported, not guessed. */
  addFiles: (files: File[], expected?: 'pdf' | 'images') => void;
  replaceFiles: (files: File[]) => void;
  clear: () => void;
  dismissError: () => void;
  dismissBatchError: () => void;
  setSelectionMode: (mode: 'all' | 'selected') => void;
  setSelectionDraft: (draft: string) => void;
  togglePageSelection: (page: number) => void;
  setFormat: (format: string) => void;
  setDpi: (dpi: number) => void;
  setPdfOutputName: (name: string) => void;
  setPageSize: (size: string) => void;
  setImageOutputName: (name: string) => void;
  setPreviewPage: (page: number) => void;
  setActiveImageId: (id: string) => void;
  setZoom: (zoom: number) => void;
  rotateImage: (id: string) => void;
  flipImage: (id: string) => void;
  moveImage: (id: string, direction: 'up' | 'down') => void;
  reorderImages: (from: number, to: number) => void;
  removeImage: (id: string) => void;
  convert: () => Promise<void>;
}

const CONVERTER_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff';

/**
 * Owns converter batch transitions, explicit page selection, request ownership,
 * and conversion submission. Preview object URLs are owned by the components
 * that display them, so retained source files survive navigation.
 */
export function useConverterWorkflow(): ConverterWorkflow {
  const { showToast } = useToast();
  const { fileData, setFileData, clearFileData } = useFeatureFile<ConverterInput>('converter');
  const input = fileData ?? null;

  const [batchError, setBatchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConverterResult | null>(null);
  const [isConverting, setIsConverting] = useState(false);

  const [pdfInfo, setPdfInfo] = useState<PdfInfoResult | null>(null);
  const [pdfInfoFailed, setPdfInfoFailed] = useState(false);
  const [pageSelection, dispatch] = useReducer(pageSelectionReducer, undefined, initialPageSelection);

  const [format, setFormatState] = useState('PNG');
  const [dpi, setDpiState] = useState(150);
  const [pdfOutputName, setPdfOutputNameState] = useState('');
  const [pageSize, setPageSizeState] = useState('a4');
  const [imageOutputName, setImageOutputNameState] = useState('output.pdf');

  const [previewPage, setPreviewPage] = useState(1);
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.0);

  const kind = converterKind(input);
  const pdfFile = input instanceof File ? input : null;
  const images = useMemo(() => (Array.isArray(input) ? input : []), [input]);
  const activeImage = images.find((entry) => entry.id === activeImageId) ?? images[0] ?? null;
  const totalPages = pdfInfo?.total_pages ?? 0;
  const selection = resolvePageSelection(pageSelection, totalPages);
  const pdfInfoState: PdfInfoState = !pdfFile ? 'idle' : pdfInfo ? 'ready' : pdfInfoFailed ? 'error' : 'loading';

  const generationRef = useRef(0);
  const convertingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Read the page count for the active PDF. Results are applied only while the
  // request still owns the current document.
  useEffect(() => {
    if (!pdfFile) return;
    const generation = ++generationRef.current;
    let cancelled = false;
    const form = new FormData();
    form.append('file', pdfFile);
    apiClient
      .post<{ status: string; data: PdfInfoResult }>('/api/v1/pdf-info/', form)
      .then((response) => {
        if (cancelled || generation !== generationRef.current || !mountedRef.current) return;
        setPdfInfo(response.data.data);
      })
      .catch(() => {
        if (cancelled || generation !== generationRef.current || !mountedRef.current) return;
        setPdfInfoFailed(true);
      });
    return () => { cancelled = true; };
  }, [pdfFile]);

  const invalidateResult = useCallback(() => setResult(null), []);

  /** Document-specific state is reset here, not in the fetch effect. */
  const startNewDocument = useCallback((document: File) => {
    dispatch({ type: 'reset' });
    setPdfInfo(null);
    setPdfInfoFailed(false);
    setResult(null);
    setError(null);
    setPreviewPage(1);
    setPdfOutputNameState(document.name.replace(/\.pdf$/i, ''));
  }, []);

  const commitInput = useCallback((next: ConverterInput) => {
    if (next instanceof File) startNewDocument(next);
    setFileData(next);
    setBatchError(null);
    setError(null);
    setResult(null);
  }, [setFileData, startNewDocument]);

  const addFiles = useCallback((incoming: File[], expected?: 'pdf' | 'images') => {
    if (convertingRef.current) return;
    setBatchError(null);
    if (expected && incoming.length > 0) {
      const wrongTab = incoming.every((file) => {
        const detected = classifyConverterFile(file);
        return detected !== null && detected !== expected;
      });
      if (wrongTab) {
        const message = expected === 'pdf'
          ? t('This tab takes one PDF. To combine images into a PDF, use the Images to PDF tab.')
          : t('This tab takes images. To export PDF pages as images, use the PDF to Images tab.');
        setBatchError(message);
        showToast({ type: 'error', title: t('Files not added'), message });
        return;
      }
    }
    const addition = addConverterFiles(input, incoming);
    if (addition.error) {
      setBatchError(addition.error);
      showToast({ type: 'error', title: t('Files not added'), message: addition.error });
      return;
    }
    if (addition.input === input) return;
    commitInput(addition.input);
  }, [commitInput, input, showToast]);

  const replaceFiles = useCallback((incoming: File[]) => {
    if (convertingRef.current) return;
    setBatchError(null);
    // Replace is an explicit user action, so validation runs against an empty batch.
    const addition = addConverterFiles(null, incoming);
    if (addition.error) {
      setBatchError(addition.error);
      showToast({ type: 'error', title: t('Files not added'), message: addition.error });
      return;
    }
    if (addition.input === null) return;
    commitInput(addition.input);
  }, [commitInput, showToast]);

  const clear = useCallback(() => {
    generationRef.current += 1;
    clearFileData();
    setBatchError(null);
    setError(null);
    setResult(null);
    setPdfInfo(null);
    setPdfInfoFailed(false);
    dispatch({ type: 'reset' });
    setActiveImageId(null);
    setPreviewPage(1);
  }, [clearFileData]);

  const mutateImages = useCallback((updater: (entries: ConverterImage[]) => ConverterImage[]) => {
    if (convertingRef.current) return;
    setFileData((previous) => updater(Array.isArray(previous) ? previous : []));
    setBatchError(null);
    setError(null);
    setResult(null);
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

  const moveImage = useCallback((id: string, direction: 'up' | 'down') => {
    mutateImages((entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      const swapIndex = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || swapIndex < 0 || swapIndex >= entries.length) return entries;
      const next = [...entries];
      [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
      return next;
    });
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
    if (pdfInfoState === 'error') return t('The PDF page count could not be read. Remove and add the PDF again.');
    if (!selection.valid) return selection.error;
    return null;
  }, [kind, pdfInfoState, selection]);

  const convert = useCallback(async () => {
    if (convertingRef.current) return;

    if (kind === 'pdf') {
      if (!pdfFile || pdfInfoState !== 'ready' || !selection.valid || selection.pages.size === 0) return;
      convertingRef.current = true;
      setIsConverting(true);
      setError(null);
      setResult(null);
      const generation = generationRef.current;
      const isCurrent = () => generation === generationRef.current && mountedRef.current;
      try {
        const formData = new FormData();
        formData.append('file', pdfFile);
        formData.append('page_ranges', serializePageSelection(pageSelection, totalPages));
        formData.append('format', format);
        formData.append('dpi', dpi.toString());
        formData.append('output_filename', pdfOutputName || pdfFile.name.replace(/\.pdf$/i, ''));
        const response = await apiClient.post('/api/v1/pdf-to-image/', formData, { responseType: 'blob' });
        if (!isCurrent()) return;
        const pagesExported = parseInt(response.headers['x-pages-exported'] || '1', 10);
        const resFormat = response.headers['x-format'] || format;
        const resDpi = parseInt(response.headers['x-dpi'] || dpi.toString(), 10);
        const isZip = pagesExported > 1;
        const blob = new Blob([response.data], { type: isZip ? 'application/zip' : `image/${resFormat.toLowerCase()}` });
        const filename = getFilenameFromHeaders(response.headers, pdfOutputName || `exported.${isZip ? 'zip' : resFormat.toLowerCase()}`);
        triggerBlobDownload(blob, filename);
        setResult({
          filename,
          isZip,
          detail: `${tn(pagesExported, '{n} page', '{n} pages')} · ${resFormat} · ${resDpi} DPI${isZip ? t(' (ZIP archive)') : ''}`,
        });
        addHistoryEntry({ filename, action: 'PDF to Image', size: 0 });
        showToast({
          type: 'success',
          title: t('Conversion complete'),
          message: tn(pagesExported, '{n} page exported to {format}', '{n} pages exported to {format}', { format: resFormat }),
          action: { label: t('Open Folder'), onClick: () => openOutputFolder() },
          duration: 8000,
        });
      } catch (err: unknown) {
        if (!isCurrent()) return;
        const message = err instanceof Error ? err.message : t('Unknown error');
        setError(message);
        showToast({ type: 'error', title: t('Conversion failed'), message });
      } finally {
        convertingRef.current = false;
        if (mountedRef.current) setIsConverting(false);
      }
      return;
    }

    if (kind === 'images') {
      const batch = images;
      if (batch.length === 0) return;
      const submittedPageSize = pageSize;
      const submittedName = imageOutputName;
      convertingRef.current = true;
      setIsConverting(true);
      setError(null);
      setResult(null);
      const generation = generationRef.current;
      const isCurrent = () => generation === generationRef.current && mountedRef.current;
      try {
        const formData = new FormData();
        batch.forEach((entry) => formData.append('files', entry.file));
        formData.append('output_filename', submittedName || 'output.pdf');
        formData.append('page_size', submittedPageSize);
        formData.append('rotations', JSON.stringify(batch.map((entry) => entry.rotation)));
        formData.append('flips', JSON.stringify(batch.map((entry) => entry.flipH)));
        const response = await apiClient.post('/api/v1/image-to-pdf/', formData, { responseType: 'blob' });
        if (!isCurrent()) return;
        const blob = new Blob([response.data], { type: 'application/pdf' });
        const total = parseInt(response.headers['x-total-pages'] || '0', 10);
        const resPageSize = response.headers['x-page-size'] || submittedPageSize.toUpperCase();
        const filename = getFilenameFromHeaders(response.headers, submittedName || 'output.pdf');
        triggerBlobDownload(blob, filename);
        setResult({
          filename,
          isZip: false,
          detail: `${tn(total, '{n} page', '{n} pages')} · ${resPageSize} · ${formatBytes(blob.size)}`,
        });
        addHistoryEntry({ filename, action: 'Image to PDF', size: blob.size });
        showToast({
          type: 'success',
          title: t('Conversion complete'),
          message: tn(total, '{n} image converted', '{n} images converted'),
          action: { label: t('Open Folder'), onClick: () => openOutputFolder() },
          duration: 8000,
        });
      } catch (err: unknown) {
        if (!isCurrent()) return;
        const message = err instanceof Error ? err.message : t('Unknown error');
        setError(message);
        showToast({ type: 'error', title: t('Conversion failed'), message });
      } finally {
        convertingRef.current = false;
        if (mountedRef.current) setIsConverting(false);
      }
    }
  }, [
    dpi, format, imageOutputName, images, kind, pageSize, pageSelection,
    pdfFile, pdfInfoState, pdfOutputName, selection, showToast, totalPages,
  ]);

  return {
    kind,
    pdfFile,
    images,
    batchError,
    error,
    result,
    isConverting,
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
    previewPage,
    activeImageId,
    activeImage,
    zoom,
    accept: CONVERTER_ACCEPT,
    addFiles,
    replaceFiles,
    clear,
    dismissError: () => setError(null),
    dismissBatchError: () => setBatchError(null),
    setSelectionMode,
    setSelectionDraft,
    togglePageSelection,
    setFormat,
    setDpi,
    setPdfOutputName,
    setPageSize,
    setImageOutputName,
    setPreviewPage,
    setActiveImageId,
    setZoom,
    rotateImage,
    flipImage,
    moveImage,
    reorderImages,
    removeImage,
    convert,
  };
}
