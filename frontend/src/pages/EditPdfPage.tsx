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
  FileEdit,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Pipette,
} from 'lucide-react';
import apiClient from '../api/client';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { getFilenameFromHeaders, triggerBlobDownload } from '../utils/downloadHelper';
import { openOutputFolder } from '../utils/tauriDialog';
import { isEmptyTextState } from '../utils/textPlaceholder';
import { Filename } from '../components/Filename';
import * as fabric from 'fabric';
import type {
  CanvasObject,
  CanvasObjectType,
  FreehandObject,
  LineObject,
  PageData,
  ShapeObject,
  TextObject,
} from '../types/canvas';
import { generateCanvasObjectId } from '../features/edit-pdf/ids';
import {
  HISTORY_DEBOUNCE_MS,
  HISTORY_LIMIT,
  PASTE_OFFSET,
} from '../features/edit-pdf/constants';

interface PdfPageData {
  index: number;
  width: number;
  height: number;
  dpi: number;
  data: string; // Base64 string
}

interface ConversionResponse {
  pages: PdfPageData[];
  total: number;
}


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
          background: '#1E1E2E',
          border: '1px solid #2A2A3E',
          borderRadius: '8px',
          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          color: '#9898B8',
          fontSize: '14px',
          margin: '0 auto',
        }}
      >
        <Loader2 className="animate-spin" size={24} />
        <span>Loading Page...</span>
      </div>
    );
  }

  return <div ref={containerRef}>{children}</div>;
}

import { PageCanvas } from '../components/PageCanvas';

// ── Main EditPdfPage Component ────────────────────────────────────────────────
export function EditPdfPage() {
  const { showToast } = useToast();
  const { fileData: file, setFileData: setFile } = useFeatureFile<File | null>('edit-pdf');

  const [pages, setPages] = useState<PageData[]>([]);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<'select' | CanvasObjectType | 'eraser' | 'eyedropper'>('select');
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const prevZoomRef = useRef(zoomLevel);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outputFilename, setOutputFilename] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const previewRequestTokenRef = useRef<Record<number, number>>({});

  // Default properties untuk object BARU yang akan dibuat (saat tidak ada selection)
  const [defaultTextProps, setDefaultTextProps] = useState<{
    fontFamily: string; fontSize: number; bold: boolean; italic: boolean; color: string; textAlign: 'left' | 'center' | 'right';
  }>({
    fontFamily: 'Arial', fontSize: 20, bold: false, italic: false, color: '#000000', textAlign: 'left'
  });
  const [defaultShapeProps, setDefaultShapeProps] = useState({
    fillColor: '#E8E8E8', fillOpacity: 100, strokeColor: '#000000', strokeWidth: 2
  });
  const [defaultStrokeProps, setDefaultStrokeProps] = useState({
    strokeColor: '#000000', strokeWidth: 3
  });

  const fabricRefs = useRef<Record<number, fabric.Canvas>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const debounceTimeoutRef = useRef<number | null>(null);
  const clipboardRef = useRef<{ objects: any[], sourcePageIndex: number, pasteCountByPage: Record<number, number> } | null>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean } | null>(null);

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

  // Tool default configurations sync
  useEffect(() => {
    if (activeTool === 'pen') {
      setDefaultStrokeProps(prev => ({ ...prev, strokeWidth: 3 }));
    } else if (activeTool === 'highlighter') {
      setDefaultStrokeProps(prev => ({ ...prev, strokeWidth: 12 }));
    } else if (activeTool === 'text') {
      setDefaultTextProps(prev => ({ ...prev, fontSize: 20 }));
    } else if (activeTool === 'rect' || activeTool === 'circle') {
      setDefaultShapeProps(prev => ({ ...prev, strokeWidth: 2 }));
    } else if (activeTool === 'line') {
      setDefaultStrokeProps(prev => ({ ...prev, strokeWidth: 2 }));
    }
  }, [activeTool]);

  // BASE DISPLAY SCALE AND ZOOM CALCULATIONS
  const BASE_DISPLAY_WIDTH = 800; // px

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

  // API Call: pdf to pages conversion
  const convertPdfToPages = async (pdfFile: File) => {
    setLoading(true);
    const formData = new FormData();
    formData.append('file', pdfFile, pdfFile.name || 'preview.pdf');

    try {
      const res = await apiClient.post<ConversionResponse>('/api/v1/pdf-to-image/pages', formData);

      const formatted: PageData[] = res.data.pages.map((p) => ({
        index: p.index,
        width: p.width,
        height: p.height,
        imageUrl: `data:image/png;base64,${p.data}`,
        previewDpi: p.dpi || 200,
        objects: [],
        history: [[]],
        historyIndex: 0
      }));

      setPages(formatted);
      setActivePageIndex(0);
      setSelectedObjectId(null);

      const stem = pdfFile.name.replace(/\.[^/.]+$/, '');
      setOutputFilename(stem);

      showToast({
        type: 'success',
        title: 'PDF Loaded Successfully',
        message: `Loaded ${res.data.total} page(s) for editing.`,
      });
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Conversion Failed',
        message: err.message || 'Could not extract PDF pages.',
      });
      setFile(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (file && pages.length === 0) {
      convertPdfToPages(file);
    }
  }, [file]);

  useEffect(() => {
    if (!file || pages.length === 0) return;
    const visiblePage = pages[activePageIndex];
    if (!visiblePage) return;

    const targetDpi = Math.max(200, Math.min(400, Math.ceil(200 * Math.max(1, zoomLevel))));
    if ((visiblePage.previewDpi || 200) >= targetDpi) return;

    const timeout = window.setTimeout(async () => {
      const token = (previewRequestTokenRef.current[visiblePage.index] || 0) + 1;
      previewRequestTokenRef.current[visiblePage.index] = token;
      const formData = new FormData();
      formData.append('file', file, file.name || 'preview.pdf');
      formData.append('page_index', String(visiblePage.index));
      formData.append('dpi', String(targetDpi));

      try {
        const response = await apiClient.post<PdfPageData>('/api/v1/pdf-to-image/page', formData);
        if (previewRequestTokenRef.current[visiblePage.index] !== token) return;
        setPages(current => current.map(page => page.index === visiblePage.index ? {
          ...page,
          imageUrl: `data:image/png;base64,${response.data.data}`,
          previewDpi: response.data.dpi,
        } : page));
      } catch {
        // Keep the current preview if an optional high-DPI refresh fails.
      }
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [file, pages, activePageIndex, zoomLevel]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && droppedFile.type === 'application/pdf') {
      setFile(droppedFile);
    } else {
      showToast({
        type: 'error',
        title: 'Invalid File',
        message: 'Please drop a valid PDF file.',
      });
    }
  };

  const handleFileBrowse = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
    }
  };

  const handleRemoveFile = () => {
    setFile(null);
    setPages([]);
    setSelectedObjectId(null);
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
                showToast({ type: 'success', title: 'Copied', message: `${copiedObjects.length} objects copied to clipboard.` });
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
                showToast({ type: 'success', title: 'Cut', message: `${copiedObjects.length} objects cut to clipboard.` });
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
            showToast({ type: 'success', title: 'Pasted', message: `${newObjs.length} objects pasted.` });
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
  }, [handleUndo, handleRedo, handleFitToPage, handleZoomIn, handleZoomOut, selectedObjectId, activePageIndex, handleLayering, selectedObject, pages]);

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
              if (obj.type === 'rect' || obj.type === 'circle') {
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
          // objects, but is empty for the current Edit PDF tool set.
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
            canvas_width: pageData.width,
            canvas_height: pageData.height,
          });
        } else {
          exportedPages.push("");
        }
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append(
        'annotations',
        new Blob([JSON.stringify(exportedPages)], { type: 'application/json' }),
        'annotations.json',
      );
      formData.append('output_filename', outputFilename || 'edited_document');

      const response = await apiClient.post('/api/v1/edit-pdf/save', formData, {
        responseType: 'blob',
      });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const finalFilename = getFilenameFromHeaders(response.headers, `${outputFilename || 'edited_document'}.pdf`);
      triggerBlobDownload(blob, finalFilename);

      showToast({
        type: 'success',
        title: 'PDF Saved Successfully',
        message: 'Your edited PDF document is ready.',
        action: {
          label: 'Open Folder',
          onClick: openOutputFolder,
        },
        duration: 8000,
      });
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Save Failed',
        message: err.message || 'Could not compile and save PDF.',
      });
    } finally {
      setSaving(false);
    }
  };

  const showContextualPanel = pages.length > 0 && (
    selectedObject !== null ||
    ['pen', 'highlighter', 'text', 'rect', 'circle', 'line'].includes(activeTool)
  );

  return (
    <div
      className="page-body edit-pdf-page"
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
      {/* Hidden File Input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileBrowse}
        accept=".pdf"
        className="hidden"
      />

      {/* ── Primary Horizontal Top Bar (Height: 52px) ───────────────────────── */}
      <div
        className="canvas-top-bar"
        style={{
          height: '52px',
          minHeight: '52px',
          maxHeight: '52px',
          background: 'var(--canvas-topbar-bg)',
          borderBottom: '1px solid var(--canvas-topbar-border)',
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          zIndex: 20,
          flexShrink: 0,
        }}
      >
        {/* Brand / Title Icon */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[#4A9EFF] font-bold text-sm flex items-center gap-1.5">
            <FileEdit size={18} />
            <span>Edit PDF</span>
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--canvas-panel-border)] text-[var(--canvas-text-muted)] font-semibold">
            BETA
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
                <Filename name={file.name} className="text-xs font-semibold text-[var(--canvas-text-primary)] truncate block" />
                <span className="text-[10px] text-[var(--canvas-text-muted)] block">{formatBytes(file.size)}</span>
              </div>
              <button
                onClick={handleRemoveFile}
                className="text-[var(--canvas-text-muted)] hover:text-[#ffb4ab] transition-colors p-1"
                title="Clear PDF"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
          
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
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
            title="Upload PDF"
          >
            <Upload size={16} />
          </div>
        </div>

        {file && loading && (
          <div className="flex items-center gap-1.5 text-[var(--canvas-text-muted)] text-xs flex-shrink-0">
            <Loader2 className="animate-spin text-[#4A9EFF]" size={14} />
            <span>Converting...</span>
          </div>
        )}

        {/* Separator 1 */}
        <div style={{ width: '1px', height: '24px', background: 'var(--canvas-topbar-border)', flexShrink: 0 }} />

        {/* 8 Tool Buttons (Icon Only) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
          {[
            { id: 'select', label: 'Select (V)', icon: MousePointer },
            { id: 'pen', label: 'Pen (P)', icon: Pen },
            { id: 'highlighter', label: 'Highlighter (H)', icon: Highlighter },
            { id: 'text', label: 'Text (T)', icon: Type },
            { id: 'rect', label: 'Rectangle (R)', icon: Square },
            { id: 'circle', label: 'Circle (C)', icon: CircleIcon },
            { id: 'line', label: 'Line (L)', icon: Minus },
            { id: 'eraser', label: 'Eraser (E)', icon: Eraser },
            { id: 'eyedropper', label: 'Sample Background Color', icon: Pipette },
          ].map((t) => {
            const Icon = t.icon;
            const isActive = activeTool === t.id;
            return (
              <button
                key={t.id}
                onClick={() => {
                  setActiveTool(t.id as any);
                  setSelectedObjectId(null);
                }}
                disabled={pages.length === 0}
                title={t.label}
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
                  background: isActive ? 'var(--primary-container)' : 'transparent',
                  color: isActive ? '#ffffff' : 'var(--canvas-text-muted)',
                  opacity: pages.length === 0 ? 0.4 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!isActive && pages.length > 0) e.currentTarget.style.background = 'var(--surface-container-high)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'transparent';
                }}
              >
                <Icon size={16} />
              </button>
            );
          })}
        </div>

        {/* Separator 2 */}
        <div style={{ width: '1px', height: '24px', background: 'var(--canvas-topbar-border)', flexShrink: 0 }} />

        {/* Zoom & History Controls */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handleZoomOut}
            disabled={pages.length === 0 || zoomLevel <= 0.25}
            title="Zoom Out"
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
            title="Zoom In"
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
            title="Fit to Width"
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
            title="Fit to Page (Ctrl+0)"
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
            title="Undo (Ctrl+Z)"
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
            title="Redo (Ctrl+Y)"
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

        {/* Spacer */}
        <div style={{ flex: 1, minWidth: '12px' }} />

        {/* Output Filename Input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 1, minWidth: '80px', maxWidth: '240px', width: '100%' }}>
          <input
            id="edit-output-name"
            type="text"
            value={outputFilename}
            onChange={(e) => setOutputFilename(e.target.value)}
            placeholder="edited_document"
            disabled={!file || loading}
            title="Output Filename"
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
            background: (!file || loading || saving || pages.length === 0) ? 'var(--canvas-input-border)' : 'var(--primary-container)',
            color: '#ffffff',
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
              <span>Saving...</span>
            </>
          ) : (
            <span>Save as PDF</span>
          )}
        </button>
      </div>

      {/* ── Contextual Controls Toolbar Sub-Bar (Row 2, Height: 40px) ─────────── */}
      <div
        className="canvas-contextual-bar"
        style={{
          height: '40px',
          minHeight: '40px',
          maxHeight: '40px',
          background: showContextualPanel ? 'var(--canvas-panel-bg)' : 'transparent',
          borderBottom: showContextualPanel ? '1px solid var(--canvas-topbar-border)' : '1px solid transparent',
          padding: '0 20px',
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
          zIndex: 15,
          flexShrink: 0,
          overflowX: 'auto',
          pointerEvents: showContextualPanel ? 'auto' : 'none',
        }}
      >
        {showContextualPanel && (
          <>
            {/* Label / Context Badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              <span className="text-[11px] uppercase tracking-wider text-[#4A9EFF] font-bold">
                {selectedObject
                  ? `Selected: ${selectedObject.type}`
                  : `Config: ${activeTool}`}
              </span>
              <div style={{ width: '1px', height: '18px', background: 'var(--canvas-panel-border)' }} />
            </div>

            {/* LAYERING CONTROLS (Only when object is selected) */}
            {selectedObject && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                <button
                  onClick={() => handleLayering('front')}
                  title="Bring to Front (Ctrl+Shift+])"
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
                  title="Bring Forward (Ctrl+])"
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
                  title="Send Backward (Ctrl+[)"
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
                  title="Send to Back (Ctrl+Shift+[)"
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[#9898B8]">Font</span>
                  <select
                    value={selectedObject ? (selectedObject as TextObject).fontFamily : defaultTextProps.fontFamily}
                    onChange={(e) => {
                      if (selectedObject) {
                        updateSelectedObject({ fontFamily: e.target.value });
                      } else {
                        setDefaultTextProps(prev => ({ ...prev, fontFamily: e.target.value }));
                      }
                    }}
                    style={{ background: 'var(--canvas-input-bg)', border: '1px solid var(--canvas-input-border)', color: 'var(--canvas-text-primary)', padding: '2px 8px', borderRadius: '4px', outline: 'none', cursor: 'pointer', fontSize: '12px', height: '28px' }}
                  >
                    {FONT_FAMILIES.map((font) => (
                      <option key={font} value={font} style={{ fontFamily: font }}>
                        {font}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[#9898B8]">Size</span>
                  <input
                    type="number"
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[#9898B8]" title="Rotation Angle">Rot°</span>
                  <input
                    type="number"
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
                      if (selectedObject) {
                        updateSelectedObject({ bold: !(selectedObject as TextObject).bold });
                      } else {
                        setDefaultTextProps(prev => ({ ...prev, bold: !prev.bold }));
                      }
                    }}
                    title="Bold"
                    style={{
                      width: '28px',
                      height: '28px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: (selectedObject ? (selectedObject as TextObject).bold : defaultTextProps.bold) ? 'var(--primary-container)' : 'var(--canvas-input-bg)',
                      border: '1px solid var(--canvas-input-border)',
                      borderRadius: '4px',
                      color: (selectedObject ? (selectedObject as TextObject).bold : defaultTextProps.bold) ? '#ffffff' : 'var(--canvas-text-muted)',
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
                    title="Italic"
                    style={{
                      width: '28px',
                      height: '28px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: (selectedObject ? (selectedObject as TextObject).italic : defaultTextProps.italic) ? 'var(--primary-container)' : 'var(--canvas-input-bg)',
                      border: '1px solid var(--canvas-input-border)',
                      borderRadius: '4px',
                      color: (selectedObject ? (selectedObject as TextObject).italic : defaultTextProps.italic) ? '#ffffff' : 'var(--canvas-text-muted)',
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
                    title="Align Left"
                    style={{
                      width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: (selectedObject ? (selectedObject as TextObject).textAlign : defaultTextProps.textAlign) === 'left' ? 'var(--primary-container)' : 'var(--canvas-input-bg)',
                      border: '1px solid var(--canvas-input-border)', borderRadius: '4px',
                      color: (selectedObject ? (selectedObject as TextObject).textAlign : defaultTextProps.textAlign) === 'left' ? '#ffffff' : 'var(--canvas-text-muted)', cursor: 'pointer'
                    }}
                  >
                    <AlignLeft size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (selectedObject) updateSelectedObject({ textAlign: 'center' });
                      else setDefaultTextProps(prev => ({ ...prev, textAlign: 'center' }));
                    }}
                    title="Align Center"
                    style={{
                      width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: (selectedObject ? (selectedObject as TextObject).textAlign : defaultTextProps.textAlign) === 'center' ? 'var(--primary-container)' : 'var(--canvas-input-bg)',
                      border: '1px solid var(--canvas-input-border)', borderRadius: '4px',
                      color: (selectedObject ? (selectedObject as TextObject).textAlign : defaultTextProps.textAlign) === 'center' ? '#ffffff' : 'var(--canvas-text-muted)', cursor: 'pointer'
                    }}
                  >
                    <AlignCenter size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (selectedObject) updateSelectedObject({ textAlign: 'right' });
                      else setDefaultTextProps(prev => ({ ...prev, textAlign: 'right' }));
                    }}
                    title="Align Right"
                    style={{
                      width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: (selectedObject ? (selectedObject as TextObject).textAlign : defaultTextProps.textAlign) === 'right' ? 'var(--primary-container)' : 'var(--canvas-input-bg)',
                      border: '1px solid var(--canvas-input-border)', borderRadius: '4px',
                      color: (selectedObject ? (selectedObject as TextObject).textAlign : defaultTextProps.textAlign) === 'right' ? '#ffffff' : 'var(--canvas-text-muted)', cursor: 'pointer'
                    }}
                  >
                    <AlignRight size={14} />
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[#9898B8]">Color</span>
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
                    title="Text Color"
                    style={{ width: '26px', height: '26px', border: '1px solid var(--canvas-input-border)', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '1px' }}
                  />
                </div>
              </div>
            )}

            {/* SHAPE PROPERTIES (rect, circle) */}
            {((selectedObject && (selectedObject.type === 'rect' || selectedObject.type === 'circle')) ||
              (!selectedObject && (activeTool === 'rect' || activeTool === 'circle'))) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0 }}>
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
                      style={{ accentColor: '#4A9EFF', cursor: 'pointer', margin: 0 }}
                    />
                    <span className="text-xs font-semibold text-[#9898B8]">Stroke</span>
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
                    title="Stroke Color"
                    style={{ width: '26px', height: '26px', border: '1px solid var(--canvas-input-border)', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '1px', opacity: (selectedObject ? (selectedObject as ShapeObject).strokeWidth : defaultShapeProps.strokeWidth) === 0 ? 0.4 : 1 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[#9898B8]">Width</span>
                  <input
                    type="range"
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
                    style={{ width: '80px', accentColor: '#4A9EFF', cursor: 'pointer' }}
                  />
                  <span className="text-[11px] font-mono font-semibold text-[#4A9EFF] min-w-[24px]">
                    {selectedObject ? (selectedObject as ShapeObject).strokeWidth : defaultShapeProps.strokeWidth}px
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[#9898B8]">Fill</span>
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
                    title="Fill Color"
                    style={{ width: '26px', height: '26px', border: '1px solid var(--canvas-input-border)', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '1px' }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[#9898B8]">Opacity</span>
                  <input
                    type="range"
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
                    style={{ width: '80px', accentColor: '#4A9EFF', cursor: 'pointer' }}
                  />
                  <span className="text-[11px] font-mono font-semibold text-[#4A9EFF] min-w-[32px]">
                    {selectedObject ? (selectedObject as ShapeObject).fillOpacity : defaultShapeProps.fillOpacity}%
                  </span>
                </div>
              </div>
            )}

            {/* LINE / FREEHAND PROPERTIES (line, pen, highlighter) */}
            {((selectedObject && (selectedObject.type === 'line' || selectedObject.type === 'pen' || selectedObject.type === 'highlighter')) ||
              (!selectedObject && (activeTool === 'line' || activeTool === 'pen' || activeTool === 'highlighter'))) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[#9898B8]">Color</span>
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
                    title="Stroke Color"
                    style={{ width: '26px', height: '26px', border: '1px solid var(--canvas-input-border)', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '1px' }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="text-xs font-semibold text-[#9898B8]">Width</span>
                  <input
                    type="range"
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
                    style={{ width: '80px', accentColor: '#4A9EFF', cursor: 'pointer' }}
                  />
                  <span className="text-[11px] font-mono font-semibold text-[#4A9EFF] min-w-[24px]">
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
        style={{
          flex: 1,
          height: 'calc(100% - 92px)',
          width: '100%',
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
      >
        {pages.length === 0 ? (
          <div 
            onClick={() => fileInputRef.current?.click()}
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
              <Upload size={28} className="text-[#4A9EFF]" />
            </div>
            <p className="text-base font-semibold text-[var(--canvas-text-primary)] mt-2">No Document Uploaded</p>
            <p className="text-sm">Click here or drag a file to begin editing.</p>
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
              const isLazy = pages.length > 50;
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
                    />
                  </div>
                </LazyPageContainer>
              );
            })}
            </div>
          </div>
        )}
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
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            padding: '4px 0',
            zIndex: 9999,
            minWidth: '160px',
            display: 'flex',
            flexDirection: 'column',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-center text-[10px] uppercase font-bold tracking-wider text-[var(--canvas-text-muted)] border-b border-[var(--canvas-panel-border)] mb-1">
            Layer Order
          </div>
          <button
            onClick={() => { handleLayering('front'); setContextMenu(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 12px', background: 'transparent', border: 'none', color: 'var(--canvas-text-primary)', cursor: 'pointer', textAlign: 'left', fontSize: '13px' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--canvas-input-bg)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <ChevronsUp size={14} /> Bring to Front
          </button>
          <button
            onClick={() => { handleLayering('forward'); setContextMenu(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 12px', background: 'transparent', border: 'none', color: 'var(--canvas-text-primary)', cursor: 'pointer', textAlign: 'left', fontSize: '13px' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--canvas-input-bg)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <ChevronUp size={14} /> Bring Forward
          </button>
          <button
            onClick={() => { handleLayering('backward'); setContextMenu(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 12px', background: 'transparent', border: 'none', color: 'var(--canvas-text-primary)', cursor: 'pointer', textAlign: 'left', fontSize: '13px' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--canvas-input-bg)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <ChevronDown size={14} /> Send Backward
          </button>
          <button
            onClick={() => { handleLayering('back'); setContextMenu(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 12px', background: 'transparent', border: 'none', color: 'var(--canvas-text-primary)', cursor: 'pointer', textAlign: 'left', fontSize: '13px' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--canvas-input-bg)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <ChevronsDown size={14} /> Send to Back
          </button>
        </div>
      )}
    </div>
  );
}
