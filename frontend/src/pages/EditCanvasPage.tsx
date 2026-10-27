import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import {
  MousePointer,
  Pen,
  Highlighter,
  ChevronsUp,
  ChevronsDown,
  ChevronUp,
  ChevronDown,
  Type,
  Square,
  Circle as CircleIcon,
  Minus,
  MoveHorizontal,
  Plus,
  Eraser,
  Undo2,
  Redo2,
  Bold,
  Italic,
  Upload,
  Loader2,
  Trash2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Scan,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Pipette,
  ImagePlus,
} from 'lucide-react';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { useNativePaths } from '../hooks/useNativePaths';
import { NativeCoreError, fileSizes, revealPath } from '../api/nativeCore';
import { baseName, stemOf } from '../utils/paths';
import { isTauri } from '../utils/tauriDialog';
import { isEmptyTextState } from '../utils/textPlaceholder';
import { Filename } from '../components/Filename';
import { FEATURE_ICONS } from '../components/icons';
import * as fabric from 'fabric';
import type {
  CanvasObject,
  CanvasImageAsset,
  EditorTool,
  FreehandObject,
  ImageObject,
  LineObject,
  PageData,
  ShapeObject,
  TextObject,
} from '../types/canvas';
import { generateCanvasObjectId } from '../features/edit-canvas/ids';
import {
  addImageAsset,
  CANVAS_IMAGE_ACCEPT,
  collectImageAssets,
  createImageObject,
  isSupportedCanvasImage,
} from '../features/edit-canvas/imageObjects';
import {
  DEFAULT_LETTER_SPACING,
  formatLetterSpacing,
  MAX_LETTER_SPACING,
  MIN_LETTER_SPACING,
  normalizeLetterSpacing,
  stepLetterSpacing,
} from '../features/edit-canvas/letterSpacing';
import {
  ensureApplicationFontFace,
  getAvailableFontWeights,
  getSelectableFontWeights,
  resolveFontFace,
  getFontWeightLabel,
  loadApplicationFontLibrary,
  mergeFontFamilies,
  nearestAvailableFontWeight,
  toggleBoldWeight,
} from '../features/edit-canvas/fontLibrary';
import type { ApplicationFontEntry } from '../features/edit-canvas/fontLibrary';
import { BLANK_PAGE_IMAGE, fetchPagesMeta, renderPage, saveCanvas } from '../features/edit-canvas/pagesApi';
import type { RenderedPage } from '../features/edit-canvas/pagesApi';
import {
  HISTORY_DEBOUNCE_MS,
  HISTORY_LIMIT,
  PASTE_OFFSET,
  DEFAULT_FONT_SIZE,
  DEFAULT_SHAPE_FILL,
  DEFAULT_TEXT_COLOR,
  PAGE_LAZY_THRESHOLD,
  PREVIEW_BASE_DPI,
  PREVIEW_MAX_DPI,
  PREVIEW_MIN_DPI,
} from '../features/edit-canvas/constants';

const PDF_FILTER = { name: 'PDF', extensions: ['pdf'] };

/** Pages rendered at the same time while a document opens. */
const OPEN_RENDER_LANES = 2;

function openErrorMessage(err: unknown): string {
  if (err instanceof NativeCoreError) {
    switch (err.code) {
      case 'password_required':
        return t('This PDF is password protected. Remove the password with Protect PDF, then try again.');
      case 'not_found':
        return t('The PDF could not be found. It may have been moved or deleted.');
      case 'invalid_input':
        return t('This file could not be read as a PDF.');
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : t('Could not extract PDF pages.');
}

type EditTool = EditorTool;


// ── Windows Font Options ──────────────────────────────────────────────────────
const FONT_FAMILIES = [
  'Arial',
  'Times New Roman',
  'Calibri',
  'Cambria',
  'Georgia',
  'Verdana',
  'Trebuchet MS',
  'Courier New',
  'Tahoma',
  'Century Gothic',
];

const BASE_DISPLAY_WIDTH = 800;

// Helper to format file size
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ── Lazy Loading Container ────────────────────────────────────────────────────
function LazyPageContainer({
  children,
  width,
  height,
  active,
}: {
  children: React.ReactNode;
  width: number;
  height: number;
  active: boolean;
}) {
  const [visible, setVisible] = useState(!active);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px 0px' }
    );
    
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    
    return () => observer.disconnect();
  }, [active]);

  if (!visible) {
    return (
      <div
        ref={containerRef}
        style={{
          width: `${width}px`,
          height: `${height}px`,
          background: 'var(--canvas-panel-bg)',
          border: '1px solid var(--canvas-panel-border)',
          borderRadius: '8px',
          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          color: 'var(--canvas-text-muted)',
          fontSize: '14px',
          margin: '0 auto',
        }}
      >
        <Loader2 className="animate-spin" size={24} />
        <span>{t('Loading Page...')}</span>
      </div>
    );
  }

  return <div ref={containerRef}>{children}</div>;
}

import { PageCanvas } from '../components/PageCanvas';
import { t, tn } from '../i18n';

const CanvasIcon = FEATURE_ICONS['edit-canvas'];

// ── Main EditCanvasPage Component ────────────────────────────────────────────
export function EditCanvasPage() {
  const { showToast } = useToast();
  const showToastRef = useRef(showToast);
  const { fileData: file, setFileData: setFile } = useFeatureFile<string | null>('edit-canvas');
  const [fileSize, setFileSize] = useState<number | null>(null);

  const [pages, setPages] = useState<PageData[]>([]);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<EditTool>('select');
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const prevZoomRef = useRef(zoomLevel);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null);
  const [outputFilename, setOutputFilename] = useState('');
  const [applicationFontEntries, setApplicationFontEntries] = useState<ApplicationFontEntry[]>([]);
  const previewRequestTokenRef = useRef<Record<number, number>>({});
  // Bumped whenever the open document changes, so late page images are dropped.
  const openRunRef = useRef(0);
  // Object URLs of the page images, so replaced and abandoned ones are freed.
  const pageImagesRef = useRef(new Map<number, { url: string; dpi: number }>());
  // The highest dpi asked for per page, so a capped render is not asked for again.
  const requestedDpiRef = useRef<Record<number, number>>({});

  // Default properties untuk object BARU yang akan dibuat (saat tidak ada selection)
  const [defaultTextProps, setDefaultTextProps] = useState<{
    fontFamily: string; fontSize: number; letterSpacing: number; fontWeight: number; bold: boolean; italic: boolean; color: string; textAlign: 'left' | 'center' | 'right';
  }>({
    fontFamily: 'Arial', fontSize: DEFAULT_FONT_SIZE, letterSpacing: DEFAULT_LETTER_SPACING, fontWeight: 400, bold: false, italic: false, color: DEFAULT_TEXT_COLOR, textAlign: 'left'
  });
  const [defaultShapeProps, setDefaultShapeProps] = useState({
    fillColor: DEFAULT_SHAPE_FILL, fillOpacity: 100, strokeColor: DEFAULT_TEXT_COLOR, strokeWidth: 2
  });
  const [defaultStrokeProps, setDefaultStrokeProps] = useState({
    strokeColor: DEFAULT_TEXT_COLOR, strokeWidth: 3
  });

  const fabricRefs = useRef<Record<number, fabric.Canvas>>({});
  const imageInputRef = useRef<HTMLInputElement>(null);
  // Image bytes live here, outside page state, so history snapshots stay small.
  const [imageAssets] = useState(() => new Map<string, CanvasImageAsset>());
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const debounceTimeoutRef = useRef<number | null>(null);
  const clipboardRef = useRef<{ objects: any[], sourcePageIndex: number, pasteCountByPage: Record<number, number> } | null>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean } | null>(null);

  const fontFamilies = useMemo(
    () => mergeFontFamilies(FONT_FAMILIES, applicationFontEntries.map((entry) => entry.family)),
    [applicationFontEntries],
  );

  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  useEffect(() => {
    // The font library lives in the desktop app; the browser preview has none.
    if (!isTauri()) return undefined;
    let cancelled = false;
    loadApplicationFontLibrary()
      .then(({ entries }) => {
        if (cancelled) return;
        setApplicationFontEntries(entries);
      })
      .catch((error) => {
        if (cancelled) return;
        showToastRef.current({
          type: 'warning',
          title: t('Font library unavailable'),
          message: error instanceof Error ? error.message : t('Could not load application fonts.'),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const closeMenu = () => {
      if (contextMenu?.visible) setContextMenu(null);
    };
    
    const handleCustomContextMenu = (e: any) => {
      setContextMenu({ x: e.detail.x, y: e.detail.y, visible: true });
    };

    window.addEventListener('click', closeMenu);
    window.addEventListener('contextmenu', closeMenu); // Close on native right click elsewhere
    window.addEventListener('show-context-menu', handleCustomContextMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('contextmenu', closeMenu);
      window.removeEventListener('show-context-menu', handleCustomContextMenu);
    };
  }, [contextMenu]);

  // Derived Selected Object
  const selectedObject = useMemo(() => {
    if (!selectedObjectId) return null;
    return pages[activePageIndex]?.objects.find(o => o.id === selectedObjectId) ?? null;
  }, [selectedObjectId, pages, activePageIndex]);

  const currentFontFamily = selectedObject?.type === 'text'
    ? (selectedObject as TextObject).fontFamily
    : defaultTextProps.fontFamily;
  const currentFontWeight = selectedObject?.type === 'text'
    ? ((selectedObject as TextObject).fontWeight ?? ((selectedObject as TextObject).bold ? 700 : 400))
    : defaultTextProps.fontWeight;
  const currentFontItalic = selectedObject?.type === 'text'
    ? (selectedObject as TextObject).italic
    : defaultTextProps.italic;
  const realFontWeights = useMemo(
    () => getAvailableFontWeights(currentFontFamily, applicationFontEntries),
    [currentFontFamily, applicationFontEntries],
  );
  const availableFontWeights = useMemo(
    () => getSelectableFontWeights(currentFontFamily, applicationFontEntries),
    [currentFontFamily, applicationFontEntries],
  );
  const currentFontFace = resolveFontFace(currentFontWeight, realFontWeights);

  useEffect(() => {
    let cancelled = false;
    ensureApplicationFontFace(
      applicationFontEntries,
      currentFontFamily,
      currentFontFace.faceWeight,
      currentFontItalic,
    )
      .then((registered) => {
        if (!cancelled && registered) {
          Object.values(fabricRefs.current).forEach((canvas) => canvas.requestRenderAll());
        }
      })
      .catch((error) => {
        if (cancelled) return;
        showToastRef.current({
          type: 'warning',
          title: t('Font face unavailable'),
          message: error instanceof Error ? error.message : t('The selected font face could not be loaded.'),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [applicationFontEntries, currentFontFamily, currentFontFace.faceWeight, currentFontItalic]);

  // Instantly commits current objects state of page to history (for drag/transform/draw finishes)
  const commitPageObjectsToHistory = useCallback((pageIndex: number, finalObjects: CanvasObject[]) => {
    setPages(prev => prev.map((page, idx) => {
      if (idx !== pageIndex) return page;
      const lastSnapshot = page.history[page.historyIndex];
      if (JSON.stringify(lastSnapshot) === JSON.stringify(finalObjects)) {
        return page;
      }
      const nextHistory = page.history.slice(0, page.historyIndex + 1);
      nextHistory.push(finalObjects);
      if (nextHistory.length > HISTORY_LIMIT) {
        nextHistory.shift();
      }
      return {
        ...page,
        objects: finalObjects,
        history: nextHistory,
        historyIndex: nextHistory.length - 1
      };
    }));
  }, []);

  const handleLayering = useCallback((action: 'front' | 'back' | 'forward' | 'backward') => {
    if (!selectedObjectId) return;
    
    setPages(prev => {
      const updatedPages = prev.map((page, idx) => {
        if (idx !== activePageIndex) return page;
        
        const objIndex = page.objects.findIndex(o => o.id === selectedObjectId);
        if (objIndex === -1) return page;
        
        const nextObjects = [...page.objects];
        const [obj] = nextObjects.splice(objIndex, 1);
        
        if (action === 'front') {
          nextObjects.push(obj);
        } else if (action === 'back') {
          nextObjects.unshift(obj);
        } else if (action === 'forward') {
          const newIndex = Math.min(nextObjects.length, objIndex + 1);
          nextObjects.splice(newIndex, 0, obj);
        } else if (action === 'backward') {
          const newIndex = Math.max(0, objIndex - 1);
          nextObjects.splice(newIndex, 0, obj);
        }
        
        return {
          ...page,
          objects: nextObjects
        };
      });
      
      // Debounce history push
      if (debounceTimeoutRef.current) {
        window.clearTimeout(debounceTimeoutRef.current);
      }
      debounceTimeoutRef.current = window.setTimeout(() => {
        setPages(curr => curr.map((page, idx) => {
          if (idx !== activePageIndex) return page;
          const currentObjects = page.objects;
          const lastSnapshot = page.history[page.historyIndex];

          if (JSON.stringify(lastSnapshot) === JSON.stringify(currentObjects)) {
            return page;
          }

          const nextHistory = page.history.slice(0, page.historyIndex + 1);
          nextHistory.push(currentObjects);
          if (nextHistory.length > HISTORY_LIMIT) {
            nextHistory.shift();
          }
          return {
            ...page,
            history: nextHistory,
            historyIndex: nextHistory.length - 1
          };
        }));
      }, HISTORY_DEBOUNCE_MS);
      
      return updatedPages;
    });
  }, [selectedObjectId, activePageIndex]);

  // Unified properties update handler with debounced history push
  const updateSelectedObject = useCallback((patch: Partial<CanvasObject>, overrideId?: string) => {
    const targetId = overrideId || selectedObjectId;
    if (!targetId) return;

    setPages(prev => {
      const updatedPages = prev.map((page, idx) => {
        if (idx !== activePageIndex) return page;
        const nextObjects = page.objects.map(obj => {
          if (obj.id === targetId) {
            return { ...obj, ...patch } as CanvasObject;
          }
          return obj;
        });
        return {
          ...page,
          objects: nextObjects
        };
      });

      // Debounce history push (300-500ms, using 400ms)
      if (debounceTimeoutRef.current) {
        window.clearTimeout(debounceTimeoutRef.current);
      }

      debounceTimeoutRef.current = window.setTimeout(() => {
        setPages(curr => curr.map((page, idx) => {
          if (idx !== activePageIndex) return page;
          const currentObjects = page.objects;
          const lastSnapshot = page.history[page.historyIndex];

          if (JSON.stringify(lastSnapshot) === JSON.stringify(currentObjects)) {
            return page;
          }

          const nextHistory = page.history.slice(0, page.historyIndex + 1);
          nextHistory.push(currentObjects);
          if (nextHistory.length > HISTORY_LIMIT) {
            nextHistory.shift();
          }
          return {
            ...page,
            history: nextHistory,
            historyIndex: nextHistory.length - 1
          };
        }));
      }, HISTORY_DEBOUNCE_MS);

      return updatedPages;
    });
  }, [selectedObjectId, activePageIndex]);

  const setFontWeight = useCallback((requestedWeight: number) => {
    const weight = nearestAvailableFontWeight(requestedWeight, availableFontWeights);
    const face = resolveFontFace(weight, realFontWeights);
    const patch = {
      fontWeight: weight,
      fontFaceWeight: face.faceWeight,
      syntheticStrokeEm: face.strokeEm,
      bold: weight >= 700,
    };
    if (selectedObject?.type === 'text') {
      updateSelectedObject(patch);
    } else {
      setDefaultTextProps(previous => ({ ...previous, ...patch }));
    }
  }, [availableFontWeights, realFontWeights, selectedObject, updateSelectedObject]);

  const setFontFamily = useCallback((family: string) => {
    const weights = getSelectableFontWeights(family, applicationFontEntries);
    const weight = nearestAvailableFontWeight(currentFontWeight, weights);
    const face = resolveFontFace(weight, getAvailableFontWeights(family, applicationFontEntries));
    const patch = {
      fontFamily: family,
      fontWeight: weight,
      fontFaceWeight: face.faceWeight,
      syntheticStrokeEm: face.strokeEm,
      bold: weight >= 700,
    };
    if (selectedObject?.type === 'text') {
      updateSelectedObject(patch);
    } else {
      setDefaultTextProps(previous => ({ ...previous, ...patch }));
    }
  }, [applicationFontEntries, currentFontWeight, selectedObject, updateSelectedObject]);

  const currentLetterSpacing = normalizeLetterSpacing(
    selectedObject?.type === 'text'
      ? (selectedObject as TextObject).letterSpacing
      : defaultTextProps.letterSpacing,
  );

  const setLetterSpacing = useCallback((nextValue: number) => {
    const value = normalizeLetterSpacing(nextValue);
    if (selectedObject?.type === 'text') {
      updateSelectedObject({ letterSpacing: value });
    } else {
      setDefaultTextProps(previous => ({ ...previous, letterSpacing: value }));
    }
  }, [selectedObject, updateSelectedObject]);

  // Undo/Redo trigger
  const handleUndo = useCallback(() => {
    setPages(prev => prev.map((page, idx) => {
      if (idx !== activePageIndex) return page;
      if (page.historyIndex > 0) {
        const nextIndex = page.historyIndex - 1;
        return {
          ...page,
          objects: page.history[nextIndex],
          historyIndex: nextIndex
        };
      }
      return page;
    }));
  }, [activePageIndex]);

  const handleRedo = useCallback(() => {
    setPages(prev => prev.map((page, idx) => {
      if (idx !== activePageIndex) return page;
      if (page.historyIndex < page.history.length - 1) {
        const nextIndex = page.historyIndex + 1;
        return {
          ...page,
          objects: page.history[nextIndex],
          historyIndex: nextIndex
        };
      }
      return page;
    }));
  }, [activePageIndex]);

  // Derived disabled states for Undo/Redo
  const isUndoDisabled = useMemo(() => {
    const activePage = pages[activePageIndex];
    if (!activePage) return true;
    return activePage.historyIndex <= 0;
  }, [pages, activePageIndex]);

  const isRedoDisabled = useMemo(() => {
    const activePage = pages[activePageIndex];
    if (!activePage) return true;
    return activePage.historyIndex >= activePage.history.length - 1;
  }, [pages, activePageIndex]);

  // Global hotkeys for delete, undo, redo
  // (Moved keydown listeners below zoom functions)

  const handleToolSelect = useCallback((tool: EditTool) => {
    setActiveTool(tool);
    setSelectedObjectId(null);

    if (tool === 'pen') {
      setDefaultStrokeProps(prev => ({ ...prev, strokeWidth: 3 }));
    } else if (tool === 'highlighter') {
      setDefaultStrokeProps(prev => ({ ...prev, strokeWidth: 12 }));
    } else if (tool === 'text') {
      setDefaultTextProps(prev => ({ ...prev, fontSize: DEFAULT_FONT_SIZE }));
    } else if (tool === 'rect' || tool === 'circle') {
      setDefaultShapeProps(prev => ({ ...prev, strokeWidth: 2 }));
    } else if (tool === 'line') {
      setDefaultStrokeProps(prev => ({ ...prev, strokeWidth: 2 }));
    }
  }, []);

  // BASE DISPLAY SCALE AND ZOOM CALCULATIONS

  const baseDisplayScale = useMemo(() => {
    if (pages.length === 0) return 1;
    return BASE_DISPLAY_WIDTH / pages[0].width;
  }, [pages]);

  const finalScale = baseDisplayScale * zoomLevel;

  // Viewport resize and shrink detection (Initial load only)
  const hasInitializedZoomRef = useRef(false);
  useEffect(() => {
    if (pages.length === 0) {
      hasInitializedZoomRef.current = false;
      return;
    }
    if (hasInitializedZoomRef.current || !canvasViewportRef.current) return;
    
    const viewportWidth = canvasViewportRef.current.clientWidth - 48;
    if (viewportWidth < BASE_DISPLAY_WIDTH) {
      const newZoom = Math.max(viewportWidth / BASE_DISPLAY_WIDTH, 0.25);
      setZoomLevel(newZoom);
      prevZoomRef.current = newZoom;
    } else {
      setZoomLevel(1.0);
      prevZoomRef.current = 1.0;
    }
    hasInitializedZoomRef.current = true;
  }, [pages.length]);

  // Convert hex color and opacity (0-100) to rgba string
  const hexToRgba = useCallback((hex: string, opacity: number) => {
    if (!hex) return 'transparent';
    if (hex.startsWith('rgba') || hex === 'transparent') return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
  }, []);

  const handleSampledColor = useCallback((color: string) => {
    if (selectedObject?.type === 'text') updateSelectedObject({ color });
    else if (selectedObject?.type === 'rect' || selectedObject?.type === 'circle') updateSelectedObject({ fillColor: color });
    else if (selectedObject && ['line', 'pen', 'highlighter'].includes(selectedObject.type)) updateSelectedObject({ strokeColor: color });
    else if (activeTool === 'text') setDefaultTextProps(current => ({ ...current, color }));
    else if (activeTool === 'rect' || activeTool === 'circle') setDefaultShapeProps(current => ({ ...current, fillColor: color }));
    else setDefaultStrokeProps(current => ({ ...current, strokeColor: color }));
    setActiveTool('select');
  }, [activeTool, selectedObject, updateSelectedObject]);

  const releasePageUrls = useCallback(() => {
    pageImagesRef.current.forEach(({ url }) => URL.revokeObjectURL(url));
    pageImagesRef.current.clear();
    requestedDpiRef.current = {};
  }, []);

  // Shows a rendered page image, unless a sharper one is already there.
  const applyPageImage = useCallback((index: number, image: RenderedPage) => {
    const current = pageImagesRef.current.get(index);
    if (current && current.dpi > image.dpi) {
      URL.revokeObjectURL(image.url);
      return;
    }
    pageImagesRef.current.set(index, { url: image.url, dpi: image.dpi });
    setPages(list => list.map(page => page.index === index ? {
      ...page,
      imageUrl: image.url,
      previewDpi: image.dpi,
    } : page));
    if (current) URL.revokeObjectURL(current.url);
  }, []);

  // Opens the PDF: every page's size first so the document lays out at once,
  // then the page images, a few at a time.
  const openPdf = async (pdfPath: string) => {
    const run = ++openRunRef.current;
    releasePageUrls();
    setLoading(true);

    try {
      const [meta, sizes] = await Promise.all([fetchPagesMeta(pdfPath, PREVIEW_BASE_DPI), fileSizes([pdfPath])]);
      if (run !== openRunRef.current) return;

      setFileSize(sizes[0] ?? null);
      setPages(meta.pages.map((p) => ({
        index: p.index,
        width: p.width,
        height: p.height,
        imageUrl: BLANK_PAGE_IMAGE,
        previewDpi: 0,
        objects: [],
        history: [[]],
        historyIndex: 0
      })));
      setActivePageIndex(0);
      setSelectedObjectId(null);
      setOutputFilename(stemOf(pdfPath));

      showToast({
        type: 'success',
        title: t('PDF Loaded Successfully'),
        message: tn(meta.total, 'Loaded {n} page for editing.', 'Loaded {n} pages for editing.'),
      });

      let next = 0;
      let failed = false;
      const lane = async () => {
        while (run === openRunRef.current && next < meta.pages.length) {
          const pageNumber = next + 1;
          next += 1;
          try {
            const image = await renderPage(pdfPath, pageNumber, PREVIEW_BASE_DPI);
            if (run !== openRunRef.current) {
              URL.revokeObjectURL(image.url);
              return;
            }
            applyPageImage(pageNumber - 1, image);
          } catch {
            failed = true;
          }
          if (pageNumber === 1 && run === openRunRef.current) setLoading(false);
        }
      };
      await Promise.all(Array.from({ length: Math.min(OPEN_RENDER_LANES, meta.pages.length) }, lane));
      if (failed && run === openRunRef.current) {
        showToast({
          type: 'warning',
          title: t('Some pages could not be shown'),
          message: t('Pages that failed to render stay blank. Try opening the PDF again.'),
        });
      }
    } catch (err: unknown) {
      if (run !== openRunRef.current) return;
      showToast({
        type: 'error',
        title: t('Conversion Failed'),
        message: openErrorMessage(err),
      });
      setFile(null);
    } finally {
      if (run === openRunRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (file && pages.length === 0) {
      // Feature-file context persists the selected file across route remounts.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void openPdf(file);
    }
  }, [file]);

  useEffect(() => {
    if (!file || pages.length === 0) return;
    const visiblePage = pages[activePageIndex];
    if (!visiblePage) return;

    const targetDpi = Math.max(PREVIEW_MIN_DPI, Math.min(PREVIEW_MAX_DPI, Math.ceil(PREVIEW_MIN_DPI * Math.max(1, zoomLevel))));
    if ((visiblePage.previewDpi || PREVIEW_BASE_DPI) >= targetDpi) return;
    // A huge page comes back below the target; do not ask for it again.
    if ((requestedDpiRef.current[visiblePage.index] || 0) >= targetDpi) return;

    const timeout = window.setTimeout(async () => {
      const token = (previewRequestTokenRef.current[visiblePage.index] || 0) + 1;
      previewRequestTokenRef.current[visiblePage.index] = token;
      const run = openRunRef.current;
      requestedDpiRef.current[visiblePage.index] = targetDpi;

      try {
        const image = await renderPage(file, visiblePage.index + 1, targetDpi);
        if (run !== openRunRef.current || previewRequestTokenRef.current[visiblePage.index] !== token) {
          URL.revokeObjectURL(image.url);
          return;
        }
        applyPageImage(visiblePage.index, image);
      } catch {
        // Keep the current preview if an optional high-DPI refresh fails.
        if (run === openRunRef.current) requestedDpiRef.current[visiblePage.index] = 0;
      }
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [file, pages, activePageIndex, zoomLevel, applyPageImage]);

  const clearDocument = useCallback(() => {
    openRunRef.current += 1;
    releasePageUrls();
    setFile(null);
    setFileSize(null);
    setPages([]);
    setSelectedObjectId(null);
    setLoading(false);
    imageAssets.clear();
  }, [releasePageUrls, setFile, imageAssets]);

  const { desktop, isDragOver, pick: pickFile } = useNativePaths({
    filter: PDF_FILTER,
    pickerTitle: t('Choose a PDF to edit'),
    disabled: loading || saving,
    onPaths: (accepted, rejected) => {
      if (accepted[0]) {
        if (pages.length > 0) {
          showToast({
            type: 'info',
            title: t('A PDF is already open'),
            message: t('Clear the current PDF first to open another one.'),
          });
          return;
        }
        setFile(accepted[0]);
      } else if (rejected > 0) {
        showToast({ type: 'error', title: t('Invalid File'), message: t('Please drop a valid PDF file.') });
      }
    },
  });

  // Frees the page images when the editor is left.
  useEffect(() => () => {
    openRunRef.current += 1;
    releasePageUrls();
  }, [releasePageUrls]);

  useEffect(() => () => imageAssets.clear(), [imageAssets]);

  // Adds image files as objects on one page, centred on `point` (page units) or on the page.
  const insertImageFiles = useCallback(async (
    files: File[],
    pageIndex: number,
    point?: { x: number; y: number },
  ) => {
    const page = pages[pageIndex];
    if (!page || files.length === 0) return;

    const supported = files.filter(isSupportedCanvasImage);
    if (supported.length < files.length) {
      showToast({
        type: 'error',
        title: t('Unsupported image'),
        message: t('Choose a PNG, JPG, or WEBP image.'),
      });
    }

    const created: ImageObject[] = [];
    for (const imageFile of supported) {
      try {
        const assetId = await addImageAsset(imageAssets, imageFile);
        const asset = imageAssets.get(assetId)!;
        created.push(createImageObject(assetId, asset, page.width, page.height, point, created.length));
      } catch {
        showToast({
          type: 'error',
          title: t('Image could not be added'),
          message: t('{name} could not be read as an image.', { name: imageFile.name }),
        });
      }
    }
    if (created.length === 0) return;

    setPages(prev => prev.map((current, idx) => {
      if (idx !== pageIndex) return current;
      const nextObjects = [...current.objects, ...created];
      const nextHistory = current.history.slice(0, current.historyIndex + 1);
      nextHistory.push(nextObjects);
      if (nextHistory.length > HISTORY_LIMIT) nextHistory.shift();
      return { ...current, objects: nextObjects, history: nextHistory, historyIndex: nextHistory.length - 1 };
    }));
    setActivePageIndex(pageIndex);
    setActiveTool('select');
    setSelectedObjectId(created[created.length - 1].id);
  }, [pages, showToast, imageAssets]);

  const handleImageBrowse = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = '';
    void insertImageFiles(selected, activePageIndex);
  };

  // Dropping image files on a page places them where they were dropped.
  const handleWorkspaceDragOver = (e: React.DragEvent) => {
    if (pages.length > 0 && Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleWorkspaceDrop = (e: React.DragEvent) => {
    if (pages.length === 0) return;
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length === 0) return;
    e.preventDefault();

    let targetIndex = activePageIndex;
    let point: { x: number; y: number } | undefined;
    for (const [index, canvas] of Object.entries(fabricRefs.current)) {
      const element = canvas.upperCanvasEl;
      const page = pages[Number(index)];
      if (!element || !page) continue;
      const rect = element.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        targetIndex = Number(index);
        point = {
          x: ((e.clientX - rect.left) / rect.width) * page.width,
          y: ((e.clientY - rect.top) / rect.height) * page.height,
        };
        break;
      }
    }
    void insertImageFiles(droppedFiles, targetIndex, point);
  };

  const applyZoomWithScrollCompensation = useCallback((newZoom: number, cursor?: {x: number, y: number}) => {
    const viewport = canvasViewportRef.current;
    if (!viewport) {
      setZoomLevel(newZoom);
      prevZoomRef.current = newZoom;
      return;
    }
    
    const oldZoom = prevZoomRef.current;
    
    let centerY_viewport, centerX_viewport;
    if (cursor) {
      centerY_viewport = viewport.scrollTop + cursor.y;
      centerX_viewport = viewport.scrollLeft + cursor.x;
    } else {
      centerY_viewport = viewport.scrollTop + viewport.clientHeight / 2;
      centerX_viewport = viewport.scrollLeft + viewport.clientWidth / 2;
    }

    const centerY_content = (centerY_viewport - 24) / oldZoom;
    const centerX_content = (centerX_viewport - 24) / oldZoom;

    // Flush synchronous re-render so the Virtual Spacer instantly resizes in the DOM
    flushSync(() => {
      setZoomLevel(newZoom);
    });
    
    prevZoomRef.current = newZoom;

    // Immediately calculate and apply the new scroll targets synchronously in the same frame
    const newScrollTop = (centerY_content * newZoom) + 24 - (cursor ? cursor.y : viewport.clientHeight / 2);
    const newScrollLeft = (centerX_content * newZoom) + 24 - (cursor ? cursor.x : viewport.clientWidth / 2);
    
    viewport.scrollTop = Math.max(0, newScrollTop);
    viewport.scrollLeft = Math.max(0, newScrollLeft);
  }, []);

  const handleZoomIn = useCallback(() => {
    applyZoomWithScrollCompensation(Math.min(prevZoomRef.current + 0.25, 3.0));
  }, [applyZoomWithScrollCompensation]);

  const handleZoomOut = useCallback(() => {
    applyZoomWithScrollCompensation(Math.max(prevZoomRef.current - 0.25, 0.1));
  }, [applyZoomWithScrollCompensation]);

  const handleFitToWidth = useCallback(() => {
    applyZoomWithScrollCompensation(1.0);
  }, [applyZoomWithScrollCompensation]);

  const handleFitToPage = useCallback(() => {
    if (pages.length === 0 || !canvasViewportRef.current) return;
    const activePage = pages[activePageIndex] || pages[0];
    const vw = canvasViewportRef.current.clientWidth - 48; // padding left + right
    const vh = canvasViewportRef.current.clientHeight - 48; // padding top + bottom
    
    const scaleX = vw / activePage.width;
    const scaleY = vh / activePage.height;
    
    const fitScale = Math.min(scaleX, scaleY);
    const baseDisplayScale = BASE_DISPLAY_WIDTH / pages[0].width;
    const newZoom = Math.max(0.1, Math.min(fitScale / baseDisplayScale, 3.0));
    applyZoomWithScrollCompensation(newZoom);
  }, [pages, activePageIndex, applyZoomWithScrollCompensation]);

  // Global hotkeys for delete, undo, redo, and zoom
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.getAttribute('contenteditable') === 'true')) {
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          handleUndo();
        } else if (e.key.toLowerCase() === 'y') {
          e.preventDefault();
          handleRedo();
        } else if (e.key === '0') {
          e.preventDefault();
          handleFitToPage();
        } else if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          handleZoomIn();
        } else if (e.key === '-') {
          e.preventDefault();
          handleZoomOut();
        } else if (e.key === ']') {
          e.preventDefault();
          if (e.shiftKey) handleLayering('front');
          else handleLayering('forward');
        } else if (e.key === '[') {
          e.preventDefault();
          if (e.shiftKey) handleLayering('back');
          else handleLayering('backward');
        } else if (e.key.toLowerCase() === 'a') {
          e.preventDefault();
          setActiveTool('select');
          const activeCanvas = fabricRefs.current[activePageIndex];
          if (activeCanvas) {
            activeCanvas.discardActiveObject();
            
            // Only select user objects (which have an id) and clone the array to prevent mutation issues
            const allObjs = activeCanvas.getObjects().filter((o: fabric.Object) => (o as any).id);
            
            // Force objects to be selectable immediately because setActiveTool is async
            allObjs.forEach((obj: fabric.Object) => {
              obj.selectable = true;
              obj.evented = true;
            });

            if (allObjs.length === 1) {
              activeCanvas.setActiveObject(allObjs[0]);
              setSelectedObjectId((allObjs[0] as any).id || null);
            } else if (allObjs.length > 1) {
              const sel = new fabric.ActiveSelection(allObjs, { canvas: activeCanvas });
              activeCanvas.setActiveObject(sel);
              setSelectedObjectId(null);
            }
            activeCanvas.requestRenderAll();
          }
        } else if (e.key.toLowerCase() === 'c') {
          const activeCanvas = fabricRefs.current[activePageIndex];
          if (activeCanvas) {
            const activeFabricObjects = activeCanvas.getActiveObjects();
            if (activeFabricObjects && activeFabricObjects.length > 0) {
              e.preventDefault();
              const copiedObjects = [];
              for (const fObj of activeFabricObjects) {
                if ((fObj as any).id) {
                  const stateObj = pages[activePageIndex].objects.find((o: CanvasObject) => o.id === (fObj as any).id);
                  if (stateObj) copiedObjects.push(JSON.parse(JSON.stringify(stateObj)));
                }
              }
              if (copiedObjects.length > 0) {
                clipboardRef.current = { objects: copiedObjects, sourcePageIndex: activePageIndex, pasteCountByPage: {} };
                showToast({ type: 'success', title: t('Copied'), message: tn(copiedObjects.length, '{n} object copied to clipboard.', '{n} objects copied to clipboard.') });
              }
            }
          }
        } else if (e.key.toLowerCase() === 'x') {
          const activeCanvas = fabricRefs.current[activePageIndex];
          if (activeCanvas) {
            const activeFabricObjects = activeCanvas.getActiveObjects();
            if (activeFabricObjects && activeFabricObjects.length > 0) {
              e.preventDefault();
              const copiedObjects = [];
              const copiedIds = new Set();
              for (const fObj of activeFabricObjects) {
                if ((fObj as any).id) {
                  const stateObj = pages[activePageIndex].objects.find((o: CanvasObject) => o.id === (fObj as any).id);
                  if (stateObj) {
                    copiedObjects.push(JSON.parse(JSON.stringify(stateObj)));
                    copiedIds.add((fObj as any).id);
                  }
                }
              }
              if (copiedObjects.length > 0) {
                clipboardRef.current = { objects: copiedObjects, sourcePageIndex: activePageIndex, pasteCountByPage: {} };
                setPages(prev => prev.map((page, idx) => {
                  if (idx !== activePageIndex) return page;
                  const nextObjects = page.objects.filter(obj => !copiedIds.has(obj.id));
                  const newHistory = page.history.slice(0, page.historyIndex + 1);
                  newHistory.push(nextObjects);
                  if (newHistory.length > HISTORY_LIMIT) newHistory.shift();
                  return { ...page, objects: nextObjects, history: newHistory, historyIndex: newHistory.length - 1 };
                }));
                setSelectedObjectId(null);
                activeCanvas.discardActiveObject();
                activeCanvas.requestRenderAll();
                showToast({ type: 'success', title: t('Cut'), message: tn(copiedObjects.length, '{n} object cut to clipboard.', '{n} objects cut to clipboard.') });
              }
            }
          }
        } else if (e.key.toLowerCase() === 'v') {
          const clip = clipboardRef.current;
          if (clip && clip.objects.length > 0 && pages[activePageIndex]) {
            e.preventDefault();
            const { objects, pasteCountByPage } = clip;
            const currentPasteCount = pasteCountByPage[activePageIndex] || 0;
            clipboardRef.current!.pasteCountByPage[activePageIndex] = currentPasteCount + 1;
            
            const newObjs = objects.map(clipObj => {
              const newObj = JSON.parse(JSON.stringify(clipObj));
              newObj.id = generateCanvasObjectId();
              
              const offset = (currentPasteCount + 1) * PASTE_OFFSET;
                
              newObj.x = (newObj.x || 0) + offset;
              newObj.y = (newObj.y || 0) + offset;
              
              return newObj;
            });
            
            setPages(prev => prev.map((page, idx) => {
              if (idx !== activePageIndex) return page;
              const nextObjects = [...page.objects, ...newObjs];
              const newHistory = page.history.slice(0, page.historyIndex + 1);
              newHistory.push(nextObjects);
              if (newHistory.length > HISTORY_LIMIT) newHistory.shift();
              return { ...page, objects: nextObjects, history: newHistory, historyIndex: newHistory.length - 1 };
            }));
            
            // Allow React to render the new objects in PageCanvas, then select them natively
            setTimeout(() => {
              const activeCanvas = fabricRefs.current?.[activePageIndex];
              if (activeCanvas) {
                activeCanvas.discardActiveObject();
                const newIds = new Set(newObjs.map(o => o.id));
                const targetObjects = activeCanvas.getObjects().filter((o: fabric.Object) => newIds.has((o as any).id));
                
                if (targetObjects.length === 1) {
                  activeCanvas.setActiveObject(targetObjects[0]);
                  setSelectedObjectId((targetObjects[0] as any).id);
                } else if (targetObjects.length > 1) {
                  const sel = new fabric.ActiveSelection(targetObjects, { canvas: activeCanvas });
                  activeCanvas.setActiveObject(sel);
                  setSelectedObjectId(null);
                }
                activeCanvas.requestRenderAll();
              }
            }, 50);
            showToast({ type: 'success', title: t('Pasted'), message: tn(newObjs.length, '{n} object pasted.', '{n} objects pasted.') });
          }
        }
      }

      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        const activeCanvas = fabricRefs.current[activePageIndex];
        if (activeCanvas) {
          const activeObj = activeCanvas.getActiveObject();
          if (activeObj) {
            e.preventDefault();
            const step = e.shiftKey ? 10 : 1;
            const currentLeft = activeObj.left || 0;
            const currentTop = activeObj.top || 0;
            
            if (e.key === 'ArrowUp') activeObj.set('top', currentTop - step);
            if (e.key === 'ArrowDown') activeObj.set('top', currentTop + step);
            if (e.key === 'ArrowLeft') activeObj.set('left', currentLeft - step);
            if (e.key === 'ArrowRight') activeObj.set('left', currentLeft + step);
            
            activeObj.setCoords();
            activeCanvas.requestRenderAll();
            activeCanvas.fire('object:modified', { target: activeObj });
            return;
          }
        }
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const activeCanvas = fabricRefs.current[activePageIndex];
        if (activeCanvas) {
          const activeFabricObjects = activeCanvas.getActiveObjects();
          if (activeFabricObjects && activeFabricObjects.length > 0) {
            e.preventDefault();
            const deleteIds = new Set();
            for (const fObj of activeFabricObjects) {
              if ((fObj as any).id) deleteIds.add((fObj as any).id);
            }
            
            setPages(prev => prev.map((page, idx) => {
              if (idx !== activePageIndex) return page;
              const nextObjects = page.objects.filter(obj => !deleteIds.has(obj.id));
              const newHistory = page.history.slice(0, page.historyIndex + 1);
              newHistory.push(nextObjects);
              if (newHistory.length > HISTORY_LIMIT) newHistory.shift();
              return { ...page, objects: nextObjects, history: newHistory, historyIndex: newHistory.length - 1 };
            }));
            setSelectedObjectId(null);
            activeCanvas.discardActiveObject();
            activeCanvas.requestRenderAll();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo, handleFitToPage, handleZoomIn, handleZoomOut, selectedObjectId, activePageIndex, handleLayering, selectedObject, pages, activeTool]);

  // Ctrl+Scroll Native Event Listener
  useEffect(() => {
    const viewport = canvasViewportRef.current;
    if (!viewport) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        
        const rect = viewport.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;

        let delta = e.deltaY;
        if (e.deltaMode === 1) delta *= 33; // DOM_DELTA_LINE
        else if (e.deltaMode === 2) delta *= window.innerHeight; // DOM_DELTA_PAGE
        
        const zoomDelta = -delta * 0.0005; // ~5% zoom per standard 100px wheel tick
        const currentZoom = prevZoomRef.current;
        const newZoom = Math.max(0.1, Math.min(currentZoom + zoomDelta, 3.0));

        if (newZoom !== currentZoom) {
          applyZoomWithScrollCompensation(newZoom, { x: cursorX, y: cursorY });
        }
      }
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [applyZoomWithScrollCompensation]);

  // Scroll Sync handler to sync Fabric calcOffset
  const scrollRafRef = useRef<number | null>(null);
  const handleWorkspaceScroll = () => {
    if (scrollRafRef.current === null) {
      scrollRafRef.current = requestAnimationFrame(() => {
        window.dispatchEvent(new Event('canvas-workspace-scroll'));
        scrollRafRef.current = null;
      });
    }
  };

  // Compile & save document flow
  const handleSave = async () => {
    if (!file || pages.length === 0) return;
    setSaving(true);

    try {
      const exportedPages: any[] = [];

      for (const p of pages) {
        const fabricCanvas = fabricRefs.current[p.index];
        const pageData = pages.find(pd => pd.index === p.index);

        if (fabricCanvas && p.objects.length > 0 && pageData) {
          const nativeObjects = p.objects
            .filter(obj => !isEmptyTextState(obj.type === 'text' ? obj.text : 'content'))
            .map(obj => {
              const fabricObject = fabricCanvas.getObjects().find(
                (candidate: fabric.Object) => (candidate as any).id === obj.id,
              ) as any;

              if (obj.type === 'pen' || obj.type === 'highlighter') {
                return {
                  ...obj,
                  vectorPath: obj.points,
                  transformMatrix: fabricObject?.calcTransformMatrix?.(),
                  pathOffset: fabricObject?.pathOffset
                    ? [fabricObject.pathOffset.x, fabricObject.pathOffset.y]
                    : undefined,
                };
              }
              if (obj.type === 'rect' || obj.type === 'circle' || obj.type === 'image') {
                return {
                  ...obj,
                  vectorCorners: fabricObject?.getCoords?.().map((point: fabric.Point) => [point.x, point.y]),
                };
              }
              if (obj.type === 'line') {
                if (!fabricObject?.calcLinePoints || !fabricObject?.calcTransformMatrix) return obj;
                const linePoints = fabricObject.calcLinePoints();
                const matrix = fabricObject.calcTransformMatrix();
                const start = fabric.util.transformPoint(new fabric.Point(linePoints.x1, linePoints.y1), matrix);
                const end = fabric.util.transformPoint(new fabric.Point(linePoints.x2, linePoints.y2), matrix);
                return { ...obj, points: [start.x, start.y, end.x, end.y], angle: 0 };
              }
              if (obj.type !== 'text') return obj;

              const fabricText = fabricObject;
              const lines = Array.isArray(fabricText?._textLines)
                ? fabricText._textLines.map((line: string[] | string) => Array.isArray(line) ? line.join('') : line)
                : obj.text.split('\n');
              const lineWidths = lines.map((_: string, index: number) => {
                if (typeof fabricText?.getLineWidth === 'function') {
                  return fabricText.getLineWidth(index);
                }
                return 0;
              });
              return {
                ...obj,
                transformMatrix: fabricText?.calcTransformMatrix?.(),
                lines,
                lineWidths,
                lineHeight: fabricText?.lineHeight || 1.16,
                opacity: fabricText?.opacity ?? 1,
              };
            });
          const temporarilyHiddenObjects = p.objects;

          fabricCanvas.discardActiveObject();
          
          // All supported editor objects are emitted as native PDF operators.
          // The raster channel remains in the contract for future unsupported
          // objects, but is empty for the current Edit Canvas tool set.
          for (const hiddenObject of temporarilyHiddenObjects) {
            const fObj = fabricCanvas.getObjects().find((f: fabric.Object) => (f as any).id === hiddenObject.id);
            if (fObj) fObj.set('visible', false);
          }
          fabricCanvas.renderAll();
          
          // Determine if there are any visible non-shape objects left to rasterize
          const hasRasterObjects = fabricCanvas.getObjects().some((f: fabric.Object) => f.visible);
          let fabricData = "";
          if (hasRasterObjects) {
            fabricData = fabricCanvas.toDataURL({ format: 'png', multiplier: 3 });
          }

          // Restore editor visibility after snapshot.
          for (const hiddenObject of temporarilyHiddenObjects) {
            const fObj = fabricCanvas.getObjects().find((f: fabric.Object) => (f as any).id === hiddenObject.id);
            if (fObj) fObj.set('visible', true);
          }
          fabricCanvas.renderAll();

          exportedPages.push({
            image_b64: fabricData,
            native_objects: nativeObjects,
            image_assets: collectImageAssets(nativeObjects, imageAssets),
            canvas_width: pageData.width,
            canvas_height: pageData.height,
          });
        } else {
          exportedPages.push("");
        }
      }

      const report = await saveCanvas(file, exportedPages, outputFilename || 'edited_document', {
        onProgress: (progress) => {
          if (progress.stage === 'pages' && progress.total) setSaveProgress({ done: progress.done, total: progress.total });
        },
      });

      showToast({
        type: 'success',
        title: t('PDF Saved Successfully'),
        message: t('Your edited PDF document is ready.'),
        action: {
          label: t('Open Folder'),
          onClick: () => { void revealPath(report.outputPath).catch(() => undefined); },
        },
        duration: 8000,
      });
    } catch (err: any) {
      showToast({
        type: 'error',
        title: t('Save Failed'),
        message: err.message || t('Could not compile and save PDF.'),
      });
    } finally {
      setSaving(false);
      setSaveProgress(null);
    }
  };

  const showContextualPanel = pages.length > 0 && (
    selectedObject !== null ||
    ['pen', 'highlighter', 'text', 'rect', 'circle', 'line'].includes(activeTool)
  );

  return (
    <div
      className="page-body edit-canvas-page"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        padding: 0,
        overflow: 'hidden',
        position: 'relative',
        background: 'var(--canvas-bg)',
      }}
    >
      <input
        type="file"
        ref={imageInputRef}
        onChange={handleImageBrowse}
        accept={CANVAS_IMAGE_ACCEPT}
        multiple
        className="hidden"
        data-testid="canvas-image-input"
      />

      {/* ── Top bar: row 1 names the page and holds the file and Save; row 2 is the toolbar ── */}
      <div
        className="canvas-top-bar"
        style={{
          background: 'var(--canvas-topbar-bg)',
          borderBottom: '1px solid var(--canvas-topbar-border)',
          zIndex: 20,
          flexShrink: 0,
        }}
      >
        <div
          className="canvas-top-bar-head"
          style={{
            minHeight: '52px',
            padding: '6px 16px',
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            rowGap: '6px',
            columnGap: '12px',
          }}
        >
        {/* Brand / Title Icon */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            className="font-bold flex items-center gap-2"
            style={{ whiteSpace: 'nowrap', fontSize: '16px', color: 'var(--canvas-text-primary)', letterSpacing: '-0.01em' }}
          >
            <CanvasIcon size={28} />
            <span>{t('Canvas PDF')}</span>
          </span>
        </div>

        {/* Compact File Info & Upload Trigger */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          {file && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                background: 'var(--canvas-card-bg)',
                border: '1px solid var(--canvas-input-border)',
                borderRadius: '6px',
                padding: '2px 10px',
                height: '32px',
                maxWidth: '220px',
                flexShrink: 0,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <Filename name={baseName(file)} className="text-xs font-semibold text-[var(--canvas-text-primary)] truncate block" />
                <span className="text-[10px] text-[var(--canvas-text-muted)] block">{fileSize !== null ? formatBytes(fileSize) : ''}</span>
              </div>
              <button
                onClick={clearDocument}
                className="text-[var(--canvas-text-muted)] hover:text-[var(--canvas-danger)] transition-colors p-1"
                title={t('Clear PDF')}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
          
          <div
            onClick={() => void pickFile()}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: isDragOver ? 'var(--accent-dim)' : 'transparent',
              border: 'none',
              borderRadius: '6px',
              width: '32px',
              height: '32px',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--canvas-text-primary)',
              flexShrink: 0,
              transition: 'background var(--transition-fast)'
            }}
            onMouseEnter={(e) => {
              if (!isDragOver) e.currentTarget.style.background = 'var(--accent-dim)';
            }}
            onMouseLeave={(e) => {
              if (!isDragOver) e.currentTarget.style.background = 'transparent';
            }}
            title={t('Upload PDF')}
          >
            <Upload size={16} />
          </div>
        </div>

        {file && loading && (
          <div className="flex items-center gap-1.5 text-[var(--canvas-text-muted)] text-xs flex-shrink-0">
            <Loader2 className="animate-spin text-[var(--canvas-accent)]" size={14} />
            <span>{t('Opening the PDF…')}</span>
          </div>
        )}

        {/* Output name + save stay together and hug the right edge, also when the bar wraps. */}
        <div
          className="canvas-save-group"
          style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto', flex: '0 1 auto', minWidth: 0, maxWidth: '100%' }}
        >
        {/* Output Filename Input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: '1 1 160px', minWidth: '80px', maxWidth: '240px' }}>
          <input
            id="edit-output-name"
            type="text"
            aria-label={t('Output filename')}
            value={outputFilename}
            onChange={(e) => setOutputFilename(e.target.value)}
            placeholder="edited_document"
            disabled={!file || loading}
            title={t('Output Filename')}
            style={{
              width: '100%',
              height: '32px',
              background: 'var(--canvas-input-bg)',
              border: '1px solid var(--canvas-input-border)',
              color: 'var(--canvas-text-primary)',
              padding: '0 10px',
              borderRadius: '6px',
              outline: 'none',
              fontSize: '13px',
              minWidth: 0,
            }}
          />
        </div>

        {/* Save as PDF Button */}
        <button
          onClick={handleSave}
          disabled={!file || loading || saving || pages.length === 0}
          style={{
            height: '32px',
            padding: '0 14px',
            background: (!file || loading || saving || pages.length === 0) ? 'var(--canvas-input-border)' : 'var(--primary)',
            color: (!file || loading || saving || pages.length === 0) ? 'var(--canvas-text-muted)' : 'var(--canvas-on-accent)',
            borderRadius: '6px',
            fontWeight: 600,
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            flexShrink: 0,
            whiteSpace: 'nowrap',
            border: 'none',
            cursor: (!file || loading || saving || pages.length === 0) ? 'not-allowed' : 'pointer',
            transition: 'background 0.2s ease'
          }}
        >
          {saving ? (
            <>
              <Loader2 className="animate-spin" size={14} />
              <span>{saveProgress ? `${t('Saving...')} ${saveProgress.done}/${saveProgress.total}` : t('Saving...')}</span>
            </>
          ) : (
            <span>{t('Save as PDF')}</span>
          )}
        </button>
        </div>
        </div>

        <div
          className="canvas-top-bar-tools"
          style={{
            minHeight: '44px',
            padding: '4px 16px',
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            rowGap: '6px',
            columnGap: '10px',
            borderTop: '1px solid var(--canvas-topbar-border)',
          }}
        >
        {/* Canvas Tool Buttons (Icon Only) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
          {[
            { id: 'select', label: t('Select (V)'), icon: MousePointer },
            { id: 'pen', label: t('Pen (P)'), icon: Pen },
            { id: 'highlighter', label: t('Highlighter (H)'), icon: Highlighter },
            { id: 'text', label: t('Text (T)'), icon: Type },
            { id: 'rect', label: t('Rectangle (R)'), icon: Square },
            { id: 'circle', label: t('Circle (C)'), icon: CircleIcon },
            { id: 'line', label: t('Line (L)'), icon: Minus },
            { id: 'eraser', label: t('Eraser (E)'), icon: Eraser },
            { id: 'eyedropper', label: t('Smart Eyedropper — sample nearby foreground color'), icon: Pipette },
          ].map((tool) => {
            const Icon = tool.icon;
            const isActive = activeTool === tool.id;
            const disabled = pages.length === 0;
            return (
              <button
                key={tool.id}
                onClick={() => handleToolSelect(tool.id as EditTool)}
                disabled={disabled}
                title={tool.label}
                style={{
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '6px',
                  border: 'none',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  transition: 'all 0.15s ease',
                  background: isActive ? 'var(--primary-container)' : 'transparent',
                  color: isActive ? 'var(--canvas-on-active)' : 'var(--canvas-text-muted)',
                  opacity: pages.length === 0 ? 0.4 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!isActive && !disabled) e.currentTarget.style.background = 'var(--surface-container-high)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'transparent';
                }}
              >
                <Icon size={16} />
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            disabled={pages.length === 0}
            title={t('Insert image')}
            aria-label={t('Insert image')}
            style={{
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
              border: 'none',
              cursor: pages.length === 0 ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
              background: 'transparent',
              color: 'var(--canvas-text-muted)',
              opacity: pages.length === 0 ? 0.4 : 1,
            }}
            onMouseEnter={(e) => {
              if (pages.length > 0) e.currentTarget.style.background = 'var(--surface-container-high)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <ImagePlus size={16} />
          </button>
        </div>

        {/* Separator 2 */}
        <div style={{ width: '1px', height: '24px', background: 'var(--canvas-topbar-border)', flexShrink: 0 }} />

        {/* Zoom & History Controls */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handleZoomOut}
            disabled={pages.length === 0 || zoomLevel <= 0.25}
            title={t('Zoom Out')}
            style={{
              background: 'transparent',
              color: (pages.length === 0 || zoomLevel <= 0.25) ? 'var(--outline-variant)' : 'var(--canvas-text-muted)',
              border: 'none',
              padding: '4px',
              borderRadius: '4px',
              cursor: (pages.length === 0 || zoomLevel <= 0.25) ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <ZoomOut size={16} />
          </button>
          <span style={{ fontSize: '13px', color: 'var(--canvas-text-primary)', minWidth: '40px', textAlign: 'center', fontFamily: 'monospace' }}>
            {Math.round(zoomLevel * 100)}%
          </span>
          <button
            onClick={handleZoomIn}
            disabled={pages.length === 0 || zoomLevel >= 2.0}
            title={t('Zoom In')}
            style={{
              background: 'transparent',
              color: (pages.length === 0 || zoomLevel >= 2.0) ? 'var(--outline-variant)' : 'var(--canvas-text-muted)',
              border: 'none',
              padding: '4px',
              borderRadius: '4px',
              cursor: (pages.length === 0 || zoomLevel >= 2.0) ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <ZoomIn size={16} />
          </button>
          <button
            onClick={handleFitToWidth}
            disabled={pages.length === 0}
            title={t('Fit to Width')}
            style={{
              background: 'transparent',
              color: pages.length === 0 ? 'var(--outline-variant)' : 'var(--canvas-text-muted)',
              border: 'none',
              padding: '4px',
              borderRadius: '4px',
              cursor: pages.length === 0 ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Maximize2 size={16} />
          </button>
          <button
            onClick={handleFitToPage}
            disabled={pages.length === 0}
            title={t('Fit to Page (Ctrl+0)')}
            style={{
              background: 'transparent',
              color: pages.length === 0 ? 'var(--outline-variant)' : 'var(--canvas-text-muted)',
              border: 'none',
              padding: '4px',
              borderRadius: '4px',
              cursor: pages.length === 0 ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Scan size={16} />
          </button>
          <div style={{ width: '1px', height: '16px', background: 'var(--canvas-topbar-border)', margin: '0 2px' }} />
          <button
            onClick={handleUndo}
            disabled={isUndoDisabled || pages.length === 0}
            title={t('Undo (Ctrl+Z)')}
            style={{
              background: 'transparent',
              color: (isUndoDisabled || pages.length === 0) ? 'var(--outline-variant)' : 'var(--canvas-text-primary)',
              border: 'none',
              padding: '4px',
              borderRadius: '4px',
              cursor: (isUndoDisabled || pages.length === 0) ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Undo2 size={16} />
          </button>
          <button
            onClick={handleRedo}
            disabled={isRedoDisabled || pages.length === 0}
            title={t('Redo (Ctrl+Y)')}
            style={{
              background: 'transparent',
              color: (isRedoDisabled || pages.length === 0) ? 'var(--outline-variant)' : 'var(--canvas-text-primary)',
              border: 'none',
              padding: '4px',
              borderRadius: '4px',
              cursor: (isRedoDisabled || pages.length === 0) ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Redo2 size={16} />
          </button>
        </div>
        </div>
      </div>

      {/* ── Workspace: contextual controls in a left panel, canvas to the right ── */}
      <div className="canvas-main">
      <div
        className="canvas-side-panel"
        role="region"
        aria-label={t('Tool options')}
        hidden={!showContextualPanel}
      >
        {showContextualPanel && (
          <>
            {/* Label / Context Badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            <span className="text-[11px] uppercase tracking-wider text-[var(--canvas-accent)] font-bold">
                {selectedObject
                  ? t('Selected: {type}', { type: t(selectedObject.type) })
                  : t('Config: {tool}', { tool: t(activeTool) })}
              </span>
              <div style={{ width: '1px', height: '18px', background: 'var(--canvas-panel-border)' }} />
            </div>

            {/* LAYERING CONTROLS (Only when object is selected) */}
            {selectedObject && (
              <div className="canvas-layer-group" style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                <button
                  onClick={() => handleLayering('front')}
                  title={t('Bring to Front (Ctrl+Shift+])')}
                  style={{
                    width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'transparent', border: 'none', borderRadius: '4px', color: 'var(--canvas-text-muted)', cursor: 'pointer'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--canvas-input-bg)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <ChevronsUp size={16} />
                </button>
                <button
                  onClick={() => handleLayering('forward')}
                  title={t('Bring Forward (Ctrl+])')}
                  style={{
                    width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'transparent', border: 'none', borderRadius: '4px', color: 'var(--canvas-text-muted)', cursor: 'pointer'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--canvas-input-bg)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <ChevronUp size={16} />
                </button>
                <button
                  onClick={() => handleLayering('backward')}
                  title={t('Send Backward (Ctrl+[)')}
                  style={{
                    width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'transparent', border: 'none', borderRadius: '4px', color: 'var(--canvas-text-muted)', cursor: 'pointer'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--canvas-input-bg)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <ChevronDown size={16} />
                </button>
                <button
                  onClick={() => handleLayering('back')}
                  title={t('Send to Back (Ctrl+Shift+[)')}
                  style={{
                    width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'transparent', border: 'none', borderRadius: '4px', color: 'var(--canvas-text-muted)', cursor: 'pointer'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--canvas-input-bg)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <ChevronsDown size={16} />
                </button>
                <div style={{ width: '1px', height: '18px', background: 'var(--canvas-panel-border)', margin: '0 4px' }} />
              </div>
            )}

            {/* TEXT PROPERTIES */}
            {((selectedObject && selectedObject.type === 'text') || (!selectedObject && activeTool === 'text')) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px 14px', flexWrap: 'wrap', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]">{t('Font')}</span>
                  <select
                    aria-label={t('Font family')}
                    value={currentFontFamily}
                    onChange={(e) => setFontFamily(e.target.value)}
                    style={{ background: 'var(--canvas-input-bg)', border: '1px solid var(--canvas-input-border)', color: 'var(--canvas-text-primary)', padding: '2px 8px', borderRadius: '4px', outline: 'none', cursor: 'pointer', fontSize: '12px', height: '28px' }}
                  >
                    {fontFamilies.map((font) => (
                      <option key={font} value={font} style={{ fontFamily: font }}>
                        {font}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]">{t('Weight')}</span>
                  <select
                    aria-label={t('Font weight')}
                    title={t('Font weight')}
                    value={nearestAvailableFontWeight(currentFontWeight, availableFontWeights)}
                    onChange={(event) => setFontWeight(Number(event.target.value))}
                    style={{ width: '118px', background: 'var(--canvas-input-bg)', border: '1px solid var(--canvas-input-border)', color: 'var(--canvas-text-primary)', padding: '2px 8px', borderRadius: '4px', outline: 'none', cursor: 'pointer', fontSize: '12px', height: '28px' }}
                  >
                    {availableFontWeights.map((weight) => (
                      <option key={weight} value={weight} style={{ fontWeight: weight }}>
                        {getFontWeightLabel(weight)}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]">{t('Size')}</span>
                  <input
                    type="number"
                    aria-label={t('Font size')}
                    min="1"
                    step={0.5}
                    value={selectedObject ? (selectedObject as TextObject).fontSize : defaultTextProps.fontSize}
                    onChange={(e) => {
                      const val = Math.max(1, Number(e.target.value));
                      if (selectedObject) {
                        updateSelectedObject({ fontSize: val });
                      } else {
                        setDefaultTextProps(prev => ({ ...prev, fontSize: val }));
                      }
                    }}
                    style={{ width: '60px', height: '28px', background: 'var(--canvas-input-bg)', border: '1px solid var(--canvas-input-border)', color: 'var(--canvas-text-primary)', padding: '2px 6px', borderRadius: '4px', outline: 'none', fontSize: '12px' }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span
                    title={t('Letter spacing')}
                    style={{ display: 'inline-flex', color: 'var(--canvas-text-muted)' }}
                  >
                    <MoveHorizontal size={16} aria-hidden="true" />
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-label={t('Decrease letter spacing by 1')}
                    title={t('Decrease letter spacing by 1')}
                    disabled={currentLetterSpacing <= MIN_LETTER_SPACING}
                    onClick={() => setLetterSpacing(stepLetterSpacing(currentLetterSpacing, -1))}
                  >
                    <Minus size={14} aria-hidden="true" />
                  </button>
                  <input
                    id="canvas-letter-spacing"
                    type="range"
                    min={MIN_LETTER_SPACING}
                    max={MAX_LETTER_SPACING}
                    step={1}
                    aria-label={t('Letter spacing')}
                    title={t('Tighten or expand the space between letters')}
                    value={currentLetterSpacing}
                    onChange={(e) => setLetterSpacing(Number(e.target.value))}
                    style={{ width: '96px', height: '28px', accentColor: 'var(--canvas-accent)', cursor: 'pointer' }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-label={t('Increase letter spacing by 1')}
                    title={t('Increase letter spacing by 1')}
                    disabled={currentLetterSpacing >= MAX_LETTER_SPACING}
                    onClick={() => setLetterSpacing(stepLetterSpacing(currentLetterSpacing, 1))}
                  >
                    <Plus size={14} aria-hidden="true" />
                  </button>
                  <output
                    htmlFor="canvas-letter-spacing"
                    className="text-xs text-[var(--canvas-text-muted)]"
                    style={{ minWidth: '30px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatLetterSpacing(currentLetterSpacing)}
                  </output>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]" title={t('Rotation Angle')}>{t('Rot°')}</span>
                  <input
                    type="number"
                    aria-label={t('Rotation angle in degrees')}
                    step={1}
                    value={selectedObject ? (Math.round((selectedObject.angle || 0) * 10) / 10) : 0}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (selectedObject) {
                        updateSelectedObject({ angle: val });
                      }
                    }}
                    style={{ width: '55px', height: '28px', background: 'var(--canvas-input-bg)', border: '1px solid var(--canvas-input-border)', color: 'var(--canvas-text-primary)', padding: '2px 6px', borderRadius: '4px', outline: 'none', fontSize: '12px' }}
                  />
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    onClick={() => {
                      setFontWeight(toggleBoldWeight(currentFontWeight, availableFontWeights));
                    }}
                    title={t('Toggle Bold (700)')}
                    aria-label={t('Toggle Bold (700)')}
                    style={{
                      width: '28px',
                      height: '28px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: currentFontWeight >= 700 ? 'var(--primary-container)' : 'var(--canvas-input-bg)',
                      border: '1px solid var(--canvas-input-border)',
                      borderRadius: '4px',
                      color: currentFontWeight >= 700 ? 'var(--canvas-on-active)' : 'var(--canvas-text-muted)',
                      cursor: 'pointer'
                    }}
                  >
                    <Bold size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (selectedObject) {
                        updateSelectedObject({ italic: !(selectedObject as TextObject).italic });
                      } else {
                        setDefaultTextProps(prev => ({ ...prev, italic: !prev.italic }));
                      }
                    }}
                    title={t('Italic')}
                    style={{
                      width: '28px',
                      height: '28px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: (selectedObject ? (selectedObject as TextObject).italic : defaultTextProps.italic) ? 'var(--primary-container)' : 'var(--canvas-input-bg)',
                      border: '1px solid var(--canvas-input-border)',
                      borderRadius: '4px',
                      color: (selectedObject ? (selectedObject as TextObject).italic : defaultTextProps.italic) ? 'var(--canvas-on-active)' : 'var(--canvas-text-muted)',
                      cursor: 'pointer'
                    }}
                  >
                    <Italic size={14} />
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '4px', borderLeft: '1px solid var(--canvas-panel-border)', paddingLeft: '14px', marginLeft: '4px' }}>
                  <button
                    onClick={() => {
                      if (selectedObject) updateSelectedObject({ textAlign: 'left' });
                      else setDefaultTextProps(prev => ({ ...prev, textAlign: 'left' }));
                    }}
                    title={t('Align Left')}
                    style={{
                      width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: (selectedObject ? (selectedObject as TextObject).textAlign : defaultTextProps.textAlign) === 'left' ? 'var(--primary-container)' : 'var(--canvas-input-bg)',
                      border: '1px solid var(--canvas-input-border)', borderRadius: '4px',
                    color: (selectedObject ? (selectedObject as TextObject).textAlign : defaultTextProps.textAlign) === 'left' ? 'var(--canvas-on-active)' : 'var(--canvas-text-muted)', cursor: 'pointer'
                    }}
                  >
                    <AlignLeft size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (selectedObject) updateSelectedObject({ textAlign: 'center' });
                      else setDefaultTextProps(prev => ({ ...prev, textAlign: 'center' }));
                    }}
                    title={t('Align Center')}
                    style={{
                      width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: (selectedObject ? (selectedObject as TextObject).textAlign : defaultTextProps.textAlign) === 'center' ? 'var(--primary-container)' : 'var(--canvas-input-bg)',
                      border: '1px solid var(--canvas-input-border)', borderRadius: '4px',
                    color: (selectedObject ? (selectedObject as TextObject).textAlign : defaultTextProps.textAlign) === 'center' ? 'var(--canvas-on-active)' : 'var(--canvas-text-muted)', cursor: 'pointer'
                    }}
                  >
                    <AlignCenter size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (selectedObject) updateSelectedObject({ textAlign: 'right' });
                      else setDefaultTextProps(prev => ({ ...prev, textAlign: 'right' }));
                    }}
                    title={t('Align Right')}
                    style={{
                      width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: (selectedObject ? (selectedObject as TextObject).textAlign : defaultTextProps.textAlign) === 'right' ? 'var(--primary-container)' : 'var(--canvas-input-bg)',
                      border: '1px solid var(--canvas-input-border)', borderRadius: '4px',
                    color: (selectedObject ? (selectedObject as TextObject).textAlign : defaultTextProps.textAlign) === 'right' ? 'var(--canvas-on-active)' : 'var(--canvas-text-muted)', cursor: 'pointer'
                    }}
                  >
                    <AlignRight size={14} />
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]">{t('Color')}</span>
                  <input
                    type="color"
                    value={selectedObject ? (selectedObject as TextObject).color : defaultTextProps.color}
                    onChange={(e) => {
                      if (selectedObject) {
                        updateSelectedObject({ color: e.target.value });
                      } else {
                        setDefaultTextProps(prev => ({ ...prev, color: e.target.value }));
                      }
                    }}
                    title={t('Text Color')}
                    aria-label={t('Text color')}
                    style={{ width: '26px', height: '26px', border: '1px solid var(--canvas-input-border)', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '1px' }}
                  />
                </div>
              </div>
            )}

            {/* SHAPE PROPERTIES (rect, circle) */}
            {((selectedObject && (selectedObject.type === 'rect' || selectedObject.type === 'circle')) ||
              (!selectedObject && (activeTool === 'rect' || activeTool === 'circle'))) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px 14px', flexWrap: 'wrap', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={(selectedObject ? (selectedObject as ShapeObject).strokeWidth : defaultShapeProps.strokeWidth) > 0}
                      onChange={(e) => {
                        const val = e.target.checked ? 2 : 0;
                        if (selectedObject) {
                          updateSelectedObject({ strokeWidth: val });
                        } else {
                          setDefaultShapeProps(prev => ({ ...prev, strokeWidth: val }));
                        }
                      }}
                    style={{ accentColor: 'var(--canvas-accent)', cursor: 'pointer', margin: 0 }}
                    />
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]">{t('Stroke')}</span>
                  </label>
                  <input
                    type="color"
                    value={selectedObject ? (selectedObject as ShapeObject).strokeColor : defaultShapeProps.strokeColor}
                    disabled={(selectedObject ? (selectedObject as ShapeObject).strokeWidth : defaultShapeProps.strokeWidth) === 0}
                    onChange={(e) => {
                      if (selectedObject) {
                        updateSelectedObject({ strokeColor: e.target.value });
                      } else {
                        setDefaultShapeProps(prev => ({ ...prev, strokeColor: e.target.value }));
                      }
                    }}
                    title={t('Stroke Color')}
                    aria-label={t('Stroke color')}
                    style={{ width: '26px', height: '26px', border: '1px solid var(--canvas-input-border)', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '1px', opacity: (selectedObject ? (selectedObject as ShapeObject).strokeWidth : defaultShapeProps.strokeWidth) === 0 ? 0.4 : 1 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]">{t('Width')}</span>
                  <input
                    type="range"
                    aria-label={t('Outline width')}
                    min="0"
                    max="20"
                    value={selectedObject ? (selectedObject as ShapeObject).strokeWidth : defaultShapeProps.strokeWidth}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (selectedObject) {
                        updateSelectedObject({ strokeWidth: val });
                      } else {
                        setDefaultShapeProps(prev => ({ ...prev, strokeWidth: val }));
                      }
                    }}
                    style={{ width: '80px', accentColor: 'var(--canvas-accent)', cursor: 'pointer' }}
                  />
                  <span className="text-[11px] font-mono font-semibold text-[var(--canvas-accent)] min-w-[24px]">
                    {selectedObject ? (selectedObject as ShapeObject).strokeWidth : defaultShapeProps.strokeWidth}px
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]">{t('Fill')}</span>
                  <input
                    type="color"
                    value={selectedObject ? (selectedObject as ShapeObject).fillColor : defaultShapeProps.fillColor}
                    onChange={(e) => {
                      if (selectedObject) {
                        updateSelectedObject({ fillColor: e.target.value });
                      } else {
                        setDefaultShapeProps(prev => ({ ...prev, fillColor: e.target.value }));
                      }
                    }}
                    title={t('Fill Color')}
                    aria-label={t('Fill color')}
                    style={{ width: '26px', height: '26px', border: '1px solid var(--canvas-input-border)', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '1px' }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]">{t('Opacity')}</span>
                  <input
                    type="range"
                    aria-label={t('Fill opacity')}
                    min="0"
                    max="100"
                    value={selectedObject ? (selectedObject as ShapeObject).fillOpacity : defaultShapeProps.fillOpacity}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (selectedObject) {
                        updateSelectedObject({ fillOpacity: val });
                      } else {
                        setDefaultShapeProps(prev => ({ ...prev, fillOpacity: val }));
                      }
                    }}
                    style={{ width: '80px', accentColor: 'var(--canvas-accent)', cursor: 'pointer' }}
                  />
                  <span className="text-[11px] font-mono font-semibold text-[var(--canvas-accent)] min-w-[32px]">
                    {selectedObject ? (selectedObject as ShapeObject).fillOpacity : defaultShapeProps.fillOpacity}%
                  </span>
                </div>
              </div>
            )}

            {/* IMAGE PROPERTIES */}
            {selectedObject && selectedObject.type === 'image' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px 14px', flexWrap: 'wrap', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]">{t('Opacity')}</span>
                  <input
                    type="range"
                    aria-label={t('Image opacity')}
                    min="0"
                    max="100"
                    value={Math.round(((selectedObject as ImageObject).opacity ?? 1) * 100)}
                    onChange={(e) => updateSelectedObject({ opacity: Number(e.target.value) / 100 })}
                    style={{ width: '80px', accentColor: 'var(--canvas-accent)', cursor: 'pointer' }}
                  />
                  <span className="text-[11px] font-mono font-semibold text-[var(--canvas-accent)] min-w-[32px]">
                    {Math.round(((selectedObject as ImageObject).opacity ?? 1) * 100)}%
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]" title={t('Rotation Angle')}>{t('Rot°')}</span>
                  <input
                    type="number"
                    aria-label={t('Rotation angle in degrees')}
                    step={1}
                    value={Math.round((selectedObject.angle || 0) * 10) / 10}
                    onChange={(e) => updateSelectedObject({ angle: Number(e.target.value) })}
                    style={{ width: '55px', height: '28px', background: 'var(--canvas-input-bg)', border: '1px solid var(--canvas-input-border)', color: 'var(--canvas-text-primary)', padding: '2px 6px', borderRadius: '4px', outline: 'none', fontSize: '12px' }}
                  />
                </div>
                <span className="text-[11px] text-[var(--canvas-text-muted)]">
                  {t('Corners keep the proportions. Side handles or Shift stretch the image.')}
                </span>
              </div>
            )}

            {/* LINE / FREEHAND PROPERTIES (line, pen, highlighter) */}
            {((selectedObject && (selectedObject.type === 'line' || selectedObject.type === 'pen' || selectedObject.type === 'highlighter')) ||
              (!selectedObject && (activeTool === 'line' || activeTool === 'pen' || activeTool === 'highlighter'))) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px 14px', flexWrap: 'wrap', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]">{t('Color')}</span>
                  <input
                    type="color"
                    value={selectedObject ? (selectedObject as LineObject | FreehandObject).strokeColor : defaultStrokeProps.strokeColor}
                    onChange={(e) => {
                      if (selectedObject) {
                        updateSelectedObject({ strokeColor: e.target.value });
                      } else {
                        setDefaultStrokeProps(prev => ({ ...prev, strokeColor: e.target.value }));
                      }
                    }}
                    title={t('Stroke Color')}
                    aria-label={t('Stroke color')}
                    style={{ width: '26px', height: '26px', border: '1px solid var(--canvas-input-border)', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '1px' }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[var(--canvas-text-muted)]">{t('Width')}</span>
                  <input
                    type="range"
                    aria-label={t('Stroke width')}
                    min="1"
                    max="20"
                    value={selectedObject ? (selectedObject as LineObject | FreehandObject).strokeWidth : defaultStrokeProps.strokeWidth}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (selectedObject) {
                        updateSelectedObject({ strokeWidth: val });
                      } else {
                        setDefaultStrokeProps(prev => ({ ...prev, strokeWidth: val }));
                      }
                    }}
                    style={{ width: '80px', accentColor: 'var(--canvas-accent)', cursor: 'pointer' }}
                  />
                  <span className="text-[11px] font-mono font-semibold text-[var(--canvas-accent)] min-w-[24px]">
                    {selectedObject ? (selectedObject as LineObject | FreehandObject).strokeWidth : defaultStrokeProps.strokeWidth}px
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Canvas Workspace Area ──────────────────────────────────────────────── */}
      <div
        ref={canvasViewportRef}
        className="canvas-workspace"
        role="region"
        aria-label={t('Document canvas')}
        tabIndex={0}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          overflowY: 'auto',
          overflowX: 'auto',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--canvas-bg)',
          backgroundImage: 'radial-gradient(var(--canvas-dot-grid) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
        onScroll={handleWorkspaceScroll}
        onDragOver={handleWorkspaceDragOver}
        onDrop={handleWorkspaceDrop}
      >
        {pages.length === 0 ? (
          <div 
            onClick={() => void pickFile()}
            style={{ 
              margin: 'auto', 
              textAlign: 'center', 
              color: 'var(--canvas-text-muted)', 
              display: 'flex', 
              flexDirection: 'column', 
              alignItems: 'center', 
              gap: '12px',
              cursor: 'pointer',
              padding: '32px',
              borderRadius: '16px',
              border: '1px dashed transparent',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--canvas-card-bg)';
              e.currentTarget.style.borderColor = 'var(--canvas-input-border)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.borderColor = 'transparent';
            }}
          >
            <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'var(--canvas-topbar-bg)', border: '1px solid var(--canvas-input-border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Upload size={28} className="text-[var(--canvas-accent)]" />
            </div>
            <p className="text-base font-semibold text-[var(--canvas-text-primary)] mt-2">{t('No Document Uploaded')}</p>
            <p className="text-sm">
              {desktop
                ? t('Click here or drag a file to begin editing.')
                : t('Canvas PDF runs in the Dokuwu desktop app. It reads the PDF straight from your computer, which the browser preview cannot do.')}
            </p>
          </div>
        ) : (
          <div 
            style={{ 
              width: Math.max(...pages.map(p => p.width)) * finalScale,
              height: (pages.reduce((acc, p) => acc + p.height, 0) + (pages.length - 1) * 24 + 100) * finalScale,
              position: 'relative',
              margin: '0 auto', 
              flexShrink: 0
            }}
          >
            <div
              style={{
                transform: `scale(${finalScale})`,
                transformOrigin: 'top left',
                transition: 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: '24px',
                alignItems: 'center',
                width: Math.max(...pages.map(p => p.width)),
                position: 'absolute',
                top: 0,
                left: 0,
                paddingBottom: '100px',
              }}
            >
            {pages.map((p) => {
              const isLazy = pages.length > PAGE_LAZY_THRESHOLD;
              return (
                <LazyPageContainer
                  key={p.index}
                  width={p.width}
                  height={p.height}
                  active={isLazy}
                >
                  <div 
                    onMouseDown={() => setActivePageIndex(p.index)} 
                    onTouchStart={() => setActivePageIndex(p.index)}
                  >
                    <PageCanvas
                      page={p}
                      activeTool={activeTool}
                      selectedObjectId={selectedObjectId}
                      setSelectedObjectId={setSelectedObjectId}
                      setActiveTool={setActiveTool}
                      updateSelectedObject={updateSelectedObject}
                      commitPageObjectsToHistory={commitPageObjectsToHistory}
                      fabricRefs={fabricRefs}
                      setPages={setPages}
                      defaultTextProps={defaultTextProps}
                      defaultShapeProps={defaultShapeProps}
                      defaultStrokeProps={defaultStrokeProps}
                      hexToRgba={hexToRgba}
                      onSampleColor={handleSampledColor}
                      finalScale={finalScale}
                      imageAssets={imageAssets}
                    />
                  </div>
                </LazyPageContainer>
              );
            })}
            </div>
          </div>
        )}
      </div>
      </div>

      {/* ── Context Menu ──────────────────────────────────────────────────────── */}
      {contextMenu?.visible && selectedObjectId && (
        <div
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            background: 'var(--canvas-panel-bg)',
            border: '1px solid var(--canvas-panel-border)',
            borderRadius: '6px',
            boxShadow: 'var(--canvas-menu-shadow)',
            padding: '4px 0',
            zIndex: 9999,
            minWidth: '160px',
            display: 'flex',
            flexDirection: 'column',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-center text-[10px] uppercase font-bold tracking-wider text-[var(--canvas-text-muted)] border-b border-[var(--canvas-panel-border)] mb-1">
            {t('Layer Order')}
          </div>
          <button
            onClick={() => { handleLayering('front'); setContextMenu(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 12px', background: 'transparent', border: 'none', color: 'var(--canvas-text-primary)', cursor: 'pointer', textAlign: 'left', fontSize: '13px' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--canvas-input-bg)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <ChevronsUp size={14} /> {t('Bring to Front')}
          </button>
          <button
            onClick={() => { handleLayering('forward'); setContextMenu(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 12px', background: 'transparent', border: 'none', color: 'var(--canvas-text-primary)', cursor: 'pointer', textAlign: 'left', fontSize: '13px' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--canvas-input-bg)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <ChevronUp size={14} /> {t('Bring Forward')}
          </button>
          <button
            onClick={() => { handleLayering('backward'); setContextMenu(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 12px', background: 'transparent', border: 'none', color: 'var(--canvas-text-primary)', cursor: 'pointer', textAlign: 'left', fontSize: '13px' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--canvas-input-bg)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <ChevronDown size={14} /> {t('Send Backward')}
          </button>
          <button
            onClick={() => { handleLayering('back'); setContextMenu(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 12px', background: 'transparent', border: 'none', color: 'var(--canvas-text-primary)', cursor: 'pointer', textAlign: 'left', fontSize: '13px' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--canvas-input-bg)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <ChevronsDown size={14} /> {t('Send to Back')}
          </button>
        </div>
      )}
    </div>
  );
}
