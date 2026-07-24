import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  MousePointer,
  Pen,
  Highlighter,
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
} from 'lucide-react';
import { Stage, Layer, Image as KonvaImage, Line as KonvaLine, Rect as KonvaRect, Ellipse as KonvaEllipse, Text as KonvaText, Transformer } from 'react-konva';
import useImage from 'use-image';
import apiClient from '../api/client';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { getFilenameFromHeaders, triggerBlobDownload } from '../utils/downloadHelper';
import { openOutputFolder } from '../utils/tauriDialog';
import { Filename } from '../components/Filename';

// ── Types ─────────────────────────────────────────────────────────────────────

type CanvasObjectType = 'pen' | 'highlighter' | 'text' | 'rect' | 'circle' | 'line';

interface BaseCanvasObject {
  id: string;
  type: CanvasObjectType;
  x: number;
  y: number;
}

interface FreehandObject extends BaseCanvasObject {
  type: 'pen' | 'highlighter';
  points: number[];
  strokeColor: string;
  strokeWidth: number;
  opacity: number; // 1 for pen, 0.4 for highlighter
}

interface TextObject extends BaseCanvasObject {
  type: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  width: number | null; // null = auto-expand (point text), number = fixed (area text)
  visible?: boolean;
}

interface ShapeObject extends BaseCanvasObject {
  type: 'rect' | 'circle';
  width: number;
  height: number;
  fillColor: string;
  fillOpacity: number; // 0-100
  strokeColor: string;
  strokeWidth: number;
}

interface LineObject extends BaseCanvasObject {
  type: 'line';
  points: number[]; // [x1, y1, x2, y2]
  strokeColor: string;
  strokeWidth: number;
}

type CanvasObject = FreehandObject | TextObject | ShapeObject | LineObject;

interface PageData {
  index: number;
  width: number;  // actual rendered width dari backend (misal 1654)
  height: number;
  imageUrl: string;
  objects: CanvasObject[];
  history: CanvasObject[][]; // snapshot untuk undo/redo
  historyIndex: number;
}

interface PdfPageData {
  index: number;
  width: number;
  height: number;
  data: string; // Base64 string
}

interface ConversionResponse {
  pages: PdfPageData[];
  total: number;
}

interface TextEditingState {
  id: string | null;
  x: number;
  y: number;
  width: number | null;
  value: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  color: string;
  isAreaText: boolean;
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

// Helper to generate unique IDs
function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
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

// ── PageCanvas Component ──────────────────────────────────────────────────────
interface PageCanvasProps {
  page: PageData;
  activeTool: 'select' | CanvasObjectType | 'eraser';
  selectedObjectId: string | null;
  setSelectedObjectId: (id: string | null) => void;
  setActiveTool: (tool: 'select' | CanvasObjectType | 'eraser') => void;
  updateSelectedObject: (patch: Partial<CanvasObject>) => void;
  commitPageObjectsToHistory: (pageIndex: number, finalObjects: CanvasObject[]) => void;
  stageRefs: React.MutableRefObject<Record<number, any>>;
  setPages: React.Dispatch<React.SetStateAction<PageData[]>>;
  defaultTextProps: { fontFamily: string; fontSize: number; bold: boolean; italic: boolean; color: string };
  defaultShapeProps: { fillColor: string; fillOpacity: number; strokeColor: string; strokeWidth: number };
  defaultStrokeProps: { strokeColor: string; strokeWidth: number };
  hexToRgba: (hex: string, opacity: number) => string;
}

const PageCanvas = React.forwardRef<any, PageCanvasProps>((props, ref) => {
  const {
    page,
    activeTool,
    selectedObjectId,
    setSelectedObjectId,
    setActiveTool,
    updateSelectedObject,
    commitPageObjectsToHistory,
    stageRefs,
    setPages,
    defaultTextProps,
    defaultShapeProps,
    defaultStrokeProps,
    hexToRgba,
  } = props;

  const [image] = useImage(page.imageUrl);
  const [textEditor, setTextEditor] = useState<TextEditingState | null>(null);

  const isDrawing = useRef(false);
  const activeObjectId = useRef<string | null>(null);
  const textDragStartPos = useRef<{ x: number; y: number } | null>(null);
  const [textDragRect, setTextDragRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const transformerRef = useRef<any>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textEditor && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [textEditor]);

  useEffect(() => {
    if (textEditor && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [textEditor?.value]);

  useEffect(() => {
    if (selectedObjectId && transformerRef.current) {
      const stage = transformerRef.current.getStage();
      if (stage) {
        const node = stage.findOne(`#${selectedObjectId}`);
        if (node) {
          transformerRef.current.nodes([node]);
          transformerRef.current.getLayer()?.batchDraw();
        } else {
          transformerRef.current.nodes([]);
        }
      }
    } else if (transformerRef.current) {
      transformerRef.current.nodes([]);
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [selectedObjectId, page.objects]);

  const commitText = () => {
    if (!textEditor) return;
    const val = textEditor.value.trim();

    if (textEditor.id) {
      // Edit existing TextObject
      const finalObjects = page.objects.map(obj => {
        if (obj.id === textEditor.id) {
          if (!val) return null;
          return {
            ...obj,
            text: val,
            visible: true
          } as TextObject;
        }
        return obj;
      }).filter(Boolean) as CanvasObject[];

      setPages(prev => prev.map(p => p.index === page.index ? { ...p, objects: finalObjects } : p));
      commitPageObjectsToHistory(page.index, finalObjects);
    } else {
      // Create new TextObject
      if (val) {
        const newText: TextObject = {
          id: generateId(),
          type: 'text',
          x: textEditor.x,
          y: textEditor.y,
          text: val,
          fontFamily: textEditor.fontFamily,
          fontSize: textEditor.fontSize,
          bold: textEditor.bold,
          italic: textEditor.italic,
          color: textEditor.color,
          width: textEditor.width
        };
        const finalObjects = [...page.objects, newText];
        setPages(prev => prev.map(p => p.index === page.index ? { ...p, objects: finalObjects } : p));
        commitPageObjectsToHistory(page.index, finalObjects);
        
        setSelectedObjectId(newText.id);
        setActiveTool('select');
      }
    }
    setTextEditor(null);
  };

  const cancelText = () => {
    if (!textEditor) return;
    if (textEditor.id) {
      // Restore visibility of existing TextObject
      const finalObjects = page.objects.map(obj =>
        obj.id === textEditor.id ? { ...obj, visible: true } as CanvasObject : obj
      );
      setPages(prev => prev.map(p => p.index === page.index ? { ...p, objects: finalObjects } : p));
    }
    setTextEditor(null);
  };

  const eraseObjectAtPoint = (stage: any) => {
    const pos = stage.getPointerPosition();
    if (!pos) return;

    const tolerance = 10;
    const nextObjects = page.objects.filter(obj => {
      let x1 = 0, y1 = 0, x2 = 0, y2 = 0;

      if (obj.type === 'pen' || obj.type === 'highlighter') {
        const xs = obj.points.filter((_, i) => i % 2 === 0);
        const ys = obj.points.filter((_, i) => i % 2 !== 0);
        if (xs.length === 0 || ys.length === 0) return true;
        x1 = Math.min(...xs);
        y1 = Math.min(...ys);
        x2 = Math.max(...xs);
        y2 = Math.max(...ys);
      } else if (obj.type === 'line') {
        x1 = Math.min(obj.points[0], obj.points[2]);
        y1 = Math.min(obj.points[1], obj.points[3]);
        x2 = Math.max(obj.points[0], obj.points[2]);
        y2 = Math.max(obj.points[1], obj.points[3]);
      } else if (obj.type === 'rect' || obj.type === 'circle') {
        x1 = Math.min(obj.x, obj.x + obj.width);
        y1 = Math.min(obj.y, obj.y + obj.height);
        x2 = Math.max(obj.x, obj.x + obj.width);
        y2 = Math.max(obj.y, obj.y + obj.height);
      } else if (obj.type === 'text') {
        x1 = obj.x;
        y1 = obj.y;
        const textWidth = obj.width || (obj.text.length * obj.fontSize * 0.6);
        x2 = obj.x + textWidth;
        y2 = obj.y + obj.fontSize;
      }

      const collides = (
        pos.x >= x1 - tolerance &&
        pos.x <= x2 + tolerance &&
        pos.y >= y1 - tolerance &&
        pos.y <= y2 + tolerance
      );

      return !collides;
    });

    if (nextObjects.length !== page.objects.length) {
      setPages(prev => prev.map(p => p.index === page.index ? { ...p, objects: nextObjects } : p));
      commitPageObjectsToHistory(page.index, nextObjects);
    }
  };

  const handleMouseDown = (e: any) => {
    const stage = e.target.getStage();
    if (!stage) return;

    if (activeTool === 'eraser') {
      isDrawing.current = true;
      eraseObjectAtPoint(stage);
      return;
    }

    if (activeTool === 'select') {
      const clickedOnEmpty = e.target === stage || e.target.getClassName() === 'Image';
      if (clickedOnEmpty) {
        setSelectedObjectId(null);
      }
      return;
    }

    if (activeTool === 'text') {
      const pos = stage.getPointerPosition();
      if (pos) {
        textDragStartPos.current = pos;
      }
      return;
    }

    if (textEditor) return;

    const pos = stage.getPointerPosition();
    if (!pos) return;

    isDrawing.current = true;
    const newId = generateId();
    activeObjectId.current = newId;

    if (activeTool === 'pen' || activeTool === 'highlighter') {
      const isHighlighter = activeTool === 'highlighter';
      const newObj: FreehandObject = {
        id: newId,
        type: isHighlighter ? 'highlighter' : 'pen',
        x: 0,
        y: 0,
        points: [pos.x, pos.y],
        strokeColor: defaultStrokeProps.strokeColor,
        strokeWidth: isHighlighter ? 12 : defaultStrokeProps.strokeWidth,
        opacity: isHighlighter ? 0.4 : 1.0
      };
      const nextObjects = [...page.objects, newObj];
      setPages(prev => prev.map(p => p.index === page.index ? { ...p, objects: nextObjects } : p));
    } else if (activeTool === 'rect' || activeTool === 'circle') {
      const newObj: ShapeObject = {
        id: newId,
        type: activeTool,
        x: pos.x,
        y: pos.y,
        width: 0,
        height: 0,
        fillColor: defaultShapeProps.fillColor,
        fillOpacity: defaultShapeProps.fillOpacity,
        strokeColor: defaultShapeProps.strokeColor,
        strokeWidth: defaultShapeProps.strokeWidth
      };
      const nextObjects = [...page.objects, newObj];
      setPages(prev => prev.map(p => p.index === page.index ? { ...p, objects: nextObjects } : p));
    } else if (activeTool === 'line') {
      const newObj: LineObject = {
        id: newId,
        type: 'line',
        x: 0,
        y: 0,
        points: [pos.x, pos.y, pos.x, pos.y],
        strokeColor: defaultStrokeProps.strokeColor,
        strokeWidth: defaultStrokeProps.strokeWidth
      };
      const nextObjects = [...page.objects, newObj];
      setPages(prev => prev.map(p => p.index === page.index ? { ...p, objects: nextObjects } : p));
    }
  };

  const handleMouseMove = (e: any) => {
    const stage = e.target.getStage();
    if (!stage) return;

    if (activeTool === 'eraser' && isDrawing.current) {
      eraseObjectAtPoint(stage);
      return;
    }

    if (activeTool === 'text') {
      if (!textDragStartPos.current) return;
      const pos = stage.getPointerPosition();
      if (!pos) return;

      const dx = pos.x - textDragStartPos.current.x;
      const dy = pos.y - textDragStartPos.current.y;

      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        setTextDragRect({
          x: Math.min(pos.x, textDragStartPos.current.x),
          y: Math.min(pos.y, textDragStartPos.current.y),
          w: Math.abs(dx),
          h: Math.abs(dy)
        });
      }
      return;
    }

    if (!isDrawing.current || !activeObjectId.current) return;
    const pos = stage.getPointerPosition();
    if (!pos) return;

    setPages(prev => prev.map(p => {
      if (p.index !== page.index) return p;
      return {
        ...p,
        objects: p.objects.map(obj => {
          if (obj.id !== activeObjectId.current) return obj;

          if (obj.type === 'pen' || obj.type === 'highlighter') {
            return {
              ...obj,
              points: [...obj.points, pos.x, pos.y]
            } as FreehandObject;
          } else if (obj.type === 'rect' || obj.type === 'circle') {
            return {
              ...obj,
              width: pos.x - obj.x,
              height: pos.y - obj.y
            } as ShapeObject;
          } else if (obj.type === 'line') {
            return {
              ...obj,
              points: [obj.points[0], obj.points[1], pos.x, pos.y]
            } as LineObject;
          }
          return obj;
        })
      };
    }));
  };

  const handleMouseUp = (e: any) => {
    const stage = e.target.getStage();
    if (activeTool === 'eraser') {
      isDrawing.current = false;
      return;
    }

    if (activeTool === 'text') {
      if (!textDragStartPos.current) return;
      const pos = stage ? stage.getPointerPosition() : null;
      if (!pos) {
        textDragStartPos.current = null;
        setTextDragRect(null);
        return;
      }

      const dx = Math.abs(pos.x - textDragStartPos.current.x);
      const dy = Math.abs(pos.y - textDragStartPos.current.y);
      const isDrag = dx > 10 || dy > 10;

      if (isDrag && textDragRect) {
        setTextEditor({
          id: null,
          x: textDragRect.x,
          y: textDragRect.y,
          width: textDragRect.w,
          value: '',
          fontSize: defaultTextProps.fontSize,
          fontFamily: defaultTextProps.fontFamily,
          bold: defaultTextProps.bold,
          italic: defaultTextProps.italic,
          color: defaultTextProps.color,
          isAreaText: true
        });
      } else {
        setTextEditor({
          id: null,
          x: textDragStartPos.current.x,
          y: textDragStartPos.current.y,
          width: null,
          value: '',
          fontSize: defaultTextProps.fontSize,
          fontFamily: defaultTextProps.fontFamily,
          bold: defaultTextProps.bold,
          italic: defaultTextProps.italic,
          color: defaultTextProps.color,
          isAreaText: false
        });
      }

      textDragStartPos.current = null;
      setTextDragRect(null);
      return;
    }

    if (!isDrawing.current) return;
    isDrawing.current = false;
    
    const newlyCreatedId = activeObjectId.current;
    activeObjectId.current = null;

    setPages(prev => {
      const updatedPage = prev.find(p => p.index === page.index);
      if (updatedPage) {
        commitPageObjectsToHistory(page.index, updatedPage.objects);
      }
      return prev;
    });

    if (newlyCreatedId) {
      setSelectedObjectId(newlyCreatedId);
      setActiveTool('select');
    }
  };

  const handleFreehandDragEnd = (e: any, objId: string) => {
    const node = e.target;
    const dx = node.x();
    const dy = node.y();
    node.x(0);
    node.y(0);

    setPages(prev => {
      const nextPages = prev.map(p => {
        if (p.index !== page.index) return p;
        const nextObjs = p.objects.map(obj => {
          if (obj.id !== objId || (obj.type !== 'pen' && obj.type !== 'highlighter')) return obj;
          const newPoints = obj.points.map((val, idx) => idx % 2 === 0 ? val + dx : val + dy);
          return { ...obj, points: newPoints } as CanvasObject;
        });
        return { ...p, objects: nextObjs };
      });

      const activePage = nextPages.find(p => p.index === page.index);
      if (activePage) {
        commitPageObjectsToHistory(page.index, activePage.objects);
      }
      return nextPages;
    });
  };

  const handleFreehandTransformEnd = (e: any, objId: string) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    const nodeX = node.x();
    const nodeY = node.y();

    node.scaleX(1);
    node.scaleY(1);
    node.x(0);
    node.y(0);

    setPages(prev => {
      const nextPages = prev.map(p => {
        if (p.index !== page.index) return p;
        const nextObjs = p.objects.map(obj => {
          if (obj.id !== objId || (obj.type !== 'pen' && obj.type !== 'highlighter')) return obj;
          const newPoints = obj.points.map((val, idx) => idx % 2 === 0 ? val * scaleX + nodeX : val * scaleY + nodeY);
          return { ...obj, points: newPoints } as CanvasObject;
        });
        return { ...p, objects: nextObjs };
      });

      const activePage = nextPages.find(p => p.index === page.index);
      if (activePage) {
        commitPageObjectsToHistory(page.index, activePage.objects);
      }
      return nextPages;
    });
  };

  const handleRectDragEnd = (e: any, objId: string) => {
    const node = e.target;
    const newX = node.x();
    const newY = node.y();

    setPages(prev => {
      const nextPages = prev.map(p => {
        if (p.index !== page.index) return p;
        const nextObjs = p.objects.map(obj => {
          if (obj.id !== objId) return obj;
          return { ...obj, x: newX, y: newY } as CanvasObject;
        });
        return { ...p, objects: nextObjs };
      });

      const activePage = nextPages.find(p => p.index === page.index);
      if (activePage) {
        commitPageObjectsToHistory(page.index, activePage.objects);
      }
      return nextPages;
    });
  };

  const handleRectTransformEnd = (e: any, objId: string) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();

    node.scaleX(1);
    node.scaleY(1);

    const newWidth = Math.max(5, node.width() * scaleX);
    const newHeight = Math.max(5, node.height() * scaleY);

    setPages(prev => {
      const nextPages = prev.map(p => {
        if (p.index !== page.index) return p;
        const nextObjs = p.objects.map(obj => {
          if (obj.id !== objId || obj.type !== 'rect') return obj;
          return { ...obj, x: node.x(), y: node.y(), width: newWidth, height: newHeight } as CanvasObject;
        });
        return { ...p, objects: nextObjs };
      });

      const activePage = nextPages.find(p => p.index === page.index);
      if (activePage) {
        commitPageObjectsToHistory(page.index, activePage.objects);
      }
      return nextPages;
    });
  };

  const handleCircleDragEnd = (e: any, objId: string) => {
    const node = e.target;
    const centerResX = node.x();
    const centerResY = node.y();

    setPages(prev => {
      const nextPages = prev.map(p => {
        if (p.index !== page.index) return p;
        const nextObjs = p.objects.map(obj => {
          if (obj.id !== objId || obj.type !== 'circle') return obj;
          return { ...obj, x: centerResX - obj.width / 2, y: centerResY - obj.height / 2 } as CanvasObject;
        });
        return { ...p, objects: nextObjs };
      });

      const activePage = nextPages.find(p => p.index === page.index);
      if (activePage) {
        commitPageObjectsToHistory(page.index, activePage.objects);
      }
      return nextPages;
    });
  };

  const handleCircleTransformEnd = (e: any, objId: string) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();

    node.scaleX(1);
    node.scaleY(1);

    const newWidth = Math.max(5, node.width() * scaleX);
    const newHeight = Math.max(5, node.height() * scaleY);

    setPages(prev => {
      const nextPages = prev.map(p => {
        if (p.index !== page.index) return p;
        const nextObjs = p.objects.map(obj => {
          if (obj.id !== objId || obj.type !== 'circle') return obj;
          return { ...obj, x: node.x() - newWidth / 2, y: node.y() - newHeight / 2, width: newWidth, height: newHeight } as CanvasObject;
        });
        return { ...p, objects: nextObjs };
      });

      const activePage = nextPages.find(p => p.index === page.index);
      if (activePage) {
        commitPageObjectsToHistory(page.index, activePage.objects);
      }
      return nextPages;
    });
  };

  const handleLineDragEnd = (e: any, objId: string) => {
    const node = e.target;
    const dx = node.x();
    const dy = node.y();
    node.x(0);
    node.y(0);

    setPages(prev => {
      const nextPages = prev.map(p => {
        if (p.index !== page.index) return p;
        const nextObjs = p.objects.map(obj => {
          if (obj.id !== objId || obj.type !== 'line') return obj;
          const newPoints = [
            obj.points[0] + dx,
            obj.points[1] + dy,
            obj.points[2] + dx,
            obj.points[3] + dy
          ];
          return { ...obj, points: newPoints } as CanvasObject;
        });
        return { ...p, objects: nextObjs };
      });

      const activePage = nextPages.find(p => p.index === page.index);
      if (activePage) {
        commitPageObjectsToHistory(page.index, activePage.objects);
      }
      return nextPages;
    });
  };

  const handleLineTransformEnd = (e: any, objId: string) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();

    node.scaleX(1);
    node.scaleY(1);

    setPages(prev => {
      const nextPages = prev.map(p => {
        if (p.index !== page.index) return p;
        const nextObjs = p.objects.map(obj => {
          if (obj.id !== objId || obj.type !== 'line') return obj;
          const newPoints = [
            obj.points[0],
            obj.points[1],
            obj.points[0] + (obj.points[2] - obj.points[0]) * scaleX,
            obj.points[1] + (obj.points[3] - obj.points[1]) * scaleY
          ];
          return { ...obj, x: node.x(), y: node.y(), points: newPoints } as CanvasObject;
        });
        return { ...p, objects: nextObjs };
      });

      const activePage = nextPages.find(p => p.index === page.index);
      if (activePage) {
        commitPageObjectsToHistory(page.index, activePage.objects);
      }
      return nextPages;
    });
  };

  const handleTextDragEnd = (e: any, objId: string) => {
    const node = e.target;
    const newX = node.x();
    const newY = node.y();

    setPages(prev => {
      const nextPages = prev.map(p => {
        if (p.index !== page.index) return p;
        const nextObjs = p.objects.map(obj => {
          if (obj.id !== objId) return obj;
          return { ...obj, x: newX, y: newY } as CanvasObject;
        });
        return { ...p, objects: nextObjs };
      });

      const activePage = nextPages.find(p => p.index === page.index);
      if (activePage) {
        commitPageObjectsToHistory(page.index, activePage.objects);
      }
      return nextPages;
    });
  };

  const handleTextTransformEnd = (e: any, objId: string) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();

    // WAJIB: reset scale SEBELUM baca/hitung apapun, tanpa terkecuali di semua cabang
    node.scaleX(1);
    node.scaleY(1);

    setPages(prev => {
      const nextPages = prev.map(p => {
        if (p.index !== page.index) return p;
        const nextObjs = p.objects.map(obj => {
          if (obj.id !== objId || obj.type !== 'text') return obj;

          let patch: Partial<TextObject> = { x: node.x(), y: node.y() };

          if (obj.width === null) {
            // Point Text: scale fontSize proporsional
            const scale = Math.max(scaleX, scaleY);
            patch.fontSize = Math.max(1, Math.round(obj.fontSize * scale * 10) / 10);
          } else {
            // Area Text: resize width dan/atau fontSize berdasarkan arah drag
            const horizontalChanged = Math.abs(scaleX - 1) > 0.01;
            const verticalChanged = Math.abs(scaleY - 1) > 0.01;

            if (horizontalChanged && !verticalChanged) {
              patch.width = Math.max(20, obj.width * scaleX);
            } else if (verticalChanged && !horizontalChanged) {
              patch.fontSize = Math.max(1, Math.round(obj.fontSize * scaleY * 10) / 10);
            } else if (horizontalChanged && verticalChanged) {
              patch.width = Math.max(20, obj.width * scaleX);
              patch.fontSize = Math.max(1, Math.round(obj.fontSize * scaleY * 10) / 10);
            }
          }
          return { ...obj, ...patch } as CanvasObject;
        });
        return { ...p, objects: nextObjs };
      });

      const activePage = nextPages.find(p => p.index === page.index);
      if (activePage) {
        commitPageObjectsToHistory(page.index, activePage.objects);
      }
      return nextPages;
    });
  };

  const handleTextDoubleClick = (e: any, textObj: TextObject) => {
    e.cancelBubble = true;
    setSelectedObjectId(textObj.id);

    setTextEditor({
      id: textObj.id,
      x: textObj.x,
      y: textObj.y,
      width: textObj.width,
      value: textObj.text,
      fontSize: textObj.fontSize,
      fontFamily: textObj.fontFamily,
      bold: textObj.bold,
      italic: textObj.italic,
      color: textObj.color,
      isAreaText: textObj.width !== null
    });

    setPages(prev => prev.map(p => p.index === page.index ? {
      ...p,
      objects: p.objects.map(obj => obj.id === textObj.id ? { ...obj, visible: false } as CanvasObject : obj)
    } : p));
  };

  const handleObjectClick = (e: any, objId: string) => {
    if (activeTool === 'select') {
      e.cancelBubble = true;
      setSelectedObjectId(objId);
    }
  };

  const handleStageClick = (e: any) => {
    const stage = e.target.getStage();
    if (!stage) return;
    const clickedOnEmpty = e.target === stage || e.target.getClassName() === 'Image';
    if (clickedOnEmpty && activeTool === 'select') {
      setSelectedObjectId(null);
    }
  };

  const stageCursor = activeTool === 'select' ? 'default' : activeTool === 'eraser' ? 'cell' : 'crosshair';

  return (
    <div
      className="pdf-page-editor-container"
      style={{
        position: 'relative',
        width: `${page.width}px`,
        height: `${page.height}px`,
        margin: '0 auto',
        background: '#ffffff',
        borderRadius: '4px',
        boxShadow: '0 4px 10px rgba(0, 0, 0, 0.3)',
        border: '1px solid #2A2A3E',
      }}
    >
      <Stage
        ref={(el) => {
          if (el) {
            stageRefs.current[page.index] = el;
          } else {
            delete stageRefs.current[page.index];
          }
        }}
        width={page.width}
        height={page.height}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onTouchStart={handleMouseDown}
        onTouchMove={handleMouseMove}
        onTouchEnd={handleMouseUp}
        onClick={handleStageClick}
        onTap={handleStageClick}
        style={{ cursor: stageCursor }}
      >
        <Layer>
          {image && (
            <KonvaImage
              image={image}
              width={page.width}
              height={page.height}
              listenUpload={false}
            />
          )}
        </Layer>
        <Layer>
          {page.objects.map((obj) => {
            if (obj.type === 'pen' || obj.type === 'highlighter') {
              return (
                <KonvaLine
                  key={obj.id}
                  id={obj.id}
                  points={obj.points}
                  stroke={obj.strokeColor}
                  strokeWidth={obj.strokeWidth}
                  tension={0.5}
                  lineCap="round"
                  lineJoin="round"
                  opacity={obj.opacity}
                  draggable={activeTool === 'select'}
                  onClick={(e) => handleObjectClick(e, obj.id)}
                  onTouchEnd={(e) => handleObjectClick(e, obj.id)}
                  onDragEnd={(e) => handleFreehandDragEnd(e, obj.id)}
                  onTransformEnd={(e) => handleFreehandTransformEnd(e, obj.id)}
                />
              );
            }
            if (obj.type === 'rect') {
              const fillVal = obj.fillColor && obj.fillOpacity > 0
                ? hexToRgba(obj.fillColor, obj.fillOpacity)
                : 'transparent';
              return (
                <KonvaRect
                  key={obj.id}
                  id={obj.id}
                  x={obj.x}
                  y={obj.y}
                  width={obj.width}
                  height={obj.height}
                  stroke={obj.strokeColor}
                  strokeWidth={obj.strokeWidth}
                  strokeScaleEnabled={false}
                  fill={fillVal}
                  draggable={activeTool === 'select'}
                  onClick={(e) => handleObjectClick(e, obj.id)}
                  onTouchEnd={(e) => handleObjectClick(e, obj.id)}
                  onDragEnd={(e) => handleRectDragEnd(e, obj.id)}
                  onTransformEnd={(e) => handleRectTransformEnd(e, obj.id)}
                />
              );
            }
            if (obj.type === 'circle') {
              const fillVal = obj.fillColor && obj.fillOpacity > 0
                ? hexToRgba(obj.fillColor, obj.fillOpacity)
                : 'transparent';
              return (
                <KonvaEllipse
                  key={obj.id}
                  id={obj.id}
                  x={obj.x + obj.width / 2}
                  y={obj.y + obj.height / 2}
                  radiusX={Math.abs(obj.width / 2)}
                  radiusY={Math.abs(obj.height / 2)}
                  stroke={obj.strokeColor}
                  strokeWidth={obj.strokeWidth}
                  strokeScaleEnabled={false}
                  fill={fillVal}
                  draggable={activeTool === 'select'}
                  onClick={(e) => handleObjectClick(e, obj.id)}
                  onTouchEnd={(e) => handleObjectClick(e, obj.id)}
                  onDragEnd={(e) => handleCircleDragEnd(e, obj.id)}
                  onTransformEnd={(e) => handleCircleTransformEnd(e, obj.id)}
                />
              );
            }
            if (obj.type === 'line') {
              return (
                <KonvaLine
                  key={obj.id}
                  id={obj.id}
                  points={obj.points}
                  stroke={obj.strokeColor}
                  strokeWidth={obj.strokeWidth}
                  draggable={activeTool === 'select'}
                  onClick={(e) => handleObjectClick(e, obj.id)}
                  onTouchEnd={(e) => handleObjectClick(e, obj.id)}
                  onDragEnd={(e) => handleLineDragEnd(e, obj.id)}
                  onTransformEnd={(e) => handleLineTransformEnd(e, obj.id)}
                />
              );
            }
            if (obj.type === 'text') {
              const fontStyle = `${obj.italic ? 'italic' : ''} ${obj.bold ? 'bold' : ''}`.trim() || 'normal';
              return (
                <KonvaText
                  key={obj.id}
                  id={obj.id}
                  x={obj.x}
                  y={obj.y}
                  text={obj.text}
                  fontSize={obj.fontSize}
                  fontFamily={obj.fontFamily}
                  fontStyle={fontStyle}
                  fill={obj.color}
                  width={obj.width || undefined}
                  wrap={obj.width ? 'word' : 'none'}
                  visible={obj.visible !== false}
                  draggable={activeTool === 'select'}
                  onClick={(e) => handleObjectClick(e, obj.id)}
                  onTouchEnd={(e) => handleObjectClick(e, obj.id)}
                  onDblClick={(e) => handleTextDoubleClick(e, obj)}
                  onDblTap={(e) => handleTextDoubleClick(e, obj)}
                  onDragEnd={(e) => handleTextDragEnd(e, obj.id)}
                  onTransformEnd={(e) => handleTextTransformEnd(e, obj.id)}
                />
              );
            }
            return null;
          })}

          {textDragRect && (
            <KonvaRect
              x={textDragRect.x}
              y={textDragRect.y}
              width={textDragRect.w}
              height={textDragRect.h}
              stroke="#4A9EFF"
              strokeWidth={1}
              dash={[4, 4]}
              fill="rgba(74,158,255,0.05)"
              listening={false}
            />
          )}

          {selectedObjectId && (
            <Transformer
              ref={transformerRef}
              rotateEnabled={false}
              anchorSize={16}
              anchorStrokeWidth={2}
              anchorCornerRadius={4}
              boundBoxFunc={(oldBox, newBox) => {
                if (newBox.width < 20 || newBox.height < 20) return oldBox;
                return newBox;
              }}
            />
          )}
        </Layer>
      </Stage>

      {textEditor && (
        <textarea
          ref={textareaRef}
          value={textEditor.value}
          onChange={(e) => setTextEditor((prev) => prev ? { ...prev, value: e.target.value } : null)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (textEditor.isAreaText) {
                if (!e.shiftKey) {
                  e.preventDefault();
                  commitText();
                }
              } else {
                e.preventDefault();
                commitText();
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelText();
            }
          }}
          autoFocus
          style={{
            position: 'absolute',
            top: `${textEditor.y}px`,
            left: `${textEditor.x}px`,
            background: 'transparent',
            color: textEditor.color,
            border: '2px dashed #000000',
            borderRadius: '4px',
            fontFamily: textEditor.fontFamily,
            fontSize: `${textEditor.fontSize}px`,
            fontWeight: textEditor.bold ? 'bold' : 'normal',
            fontStyle: textEditor.italic ? 'italic' : 'normal',
            outline: 'none',
            zIndex: 1000,
            padding: '4px',
            overflow: 'hidden',
            pointerEvents: 'all',
            width: textEditor.isAreaText && textEditor.width ? `${textEditor.width}px` : 'auto',
            minWidth: textEditor.isAreaText ? undefined : '120px',
            height: 'auto',
            minHeight: `${textEditor.fontSize + 8}px`,
            whiteSpace: textEditor.isAreaText ? 'pre-wrap' : 'nowrap',
            wordWrap: textEditor.isAreaText ? 'break-word' : undefined,
            resize: 'none',
          }}
        />
      )}
    </div>
  );
});

PageCanvas.displayName = 'PageCanvas';

// ── Main EditPdfPage Component ────────────────────────────────────────────────
export function EditPdfPage() {
  const { showToast } = useToast();
  const { fileData: file, setFileData: setFile } = useFeatureFile<File | null>('edit-pdf');

  const [pages, setPages] = useState<PageData[]>([]);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<'select' | CanvasObjectType | 'eraser'>('select');
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const prevZoomRef = useRef(zoomLevel);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outputFilename, setOutputFilename] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

  // Default properties untuk object BARU yang akan dibuat (saat tidak ada selection)
  const [defaultTextProps, setDefaultTextProps] = useState({
    fontFamily: 'Arial', fontSize: 20, bold: false, italic: false, color: '#000000'
  });
  const [defaultShapeProps, setDefaultShapeProps] = useState({
    fillColor: '#E8E8E8', fillOpacity: 100, strokeColor: '#4A9EFF', strokeWidth: 2
  });
  const [defaultStrokeProps, setDefaultStrokeProps] = useState({
    strokeColor: '#4A9EFF', strokeWidth: 3
  });

  const stageRefs = useRef<Record<number, any>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const debounceTimeoutRef = useRef<number | null>(null);

  // Derived Selected Object
  const selectedObject = useMemo(() => {
    if (!selectedObjectId) return null;
    return pages[activePageIndex]?.objects.find(o => o.id === selectedObjectId) ?? null;
  }, [selectedObjectId, pages, activePageIndex]);

  // Unified properties update handler with debounced history push
  const updateSelectedObject = useCallback((patch: Partial<CanvasObject>) => {
    if (!selectedObjectId) return;

    setPages(prev => {
      const updatedPages = prev.map((page, idx) => {
        if (idx !== activePageIndex) return page;
        const nextObjects = page.objects.map(obj => {
          if (obj.id === selectedObjectId) {
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
          if (nextHistory.length > 50) {
            nextHistory.shift();
          }
          return {
            ...page,
            history: nextHistory,
            historyIndex: nextHistory.length - 1
          };
        }));
      }, 400);

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
      if (nextHistory.length > 50) {
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
        }
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedObjectId) {
          setPages(prev => prev.map((page, idx) => {
            if (idx !== activePageIndex) return page;
            const nextObjects = page.objects.filter(obj => obj.id !== selectedObjectId);
            const newHistory = page.history.slice(0, page.historyIndex + 1);
            newHistory.push(nextObjects);
            if (newHistory.length > 50) newHistory.shift();

            return {
              ...page,
              objects: nextObjects,
              history: newHistory,
              historyIndex: newHistory.length - 1
            };
          }));
          setSelectedObjectId(null);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo, selectedObjectId, activePageIndex]);

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

  // Viewport resize and shrink detection
  useEffect(() => {
    if (pages.length === 0 || !canvasViewportRef.current) return;
    const viewportWidth = canvasViewportRef.current.clientWidth - 48;
    if (viewportWidth < BASE_DISPLAY_WIDTH) {
      const newZoom = Math.max(viewportWidth / BASE_DISPLAY_WIDTH, 0.25);
      setZoomLevel(newZoom);
      prevZoomRef.current = newZoom;
    } else {
      setZoomLevel(1.0);
      prevZoomRef.current = 1.0;
    }
  }, [pages]);

  // Convert hex color and opacity (0-100) to rgba string
  const hexToRgba = useCallback((hex: string, opacity: number) => {
    if (!hex) return 'transparent';
    if (hex.startsWith('rgba') || hex === 'transparent') return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
  }, []);

  // API Call: pdf to pages conversion
  const convertPdfToPages = async (pdfFile: File) => {
    setLoading(true);
    const formData = new FormData();
    formData.append('file', pdfFile, pdfFile.name || 'preview.pdf');

    try {
      const res = await apiClient.post<ConversionResponse>('/api/v1/pdf-to-image/pages', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      const formatted: PageData[] = res.data.pages.map((p) => ({
        index: p.index,
        width: p.width,
        height: p.height,
        imageUrl: `data:image/png;base64,${p.data}`,
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

  const applyZoomWithScrollCompensation = (newZoom: number) => {
    const viewport = canvasViewportRef.current;
    if (!viewport) {
      setZoomLevel(newZoom);
      prevZoomRef.current = newZoom;
      return;
    }
    const oldZoom = prevZoomRef.current;
    const centerY_viewport = viewport.scrollTop + viewport.clientHeight / 2;
    const centerY_content = centerY_viewport / oldZoom;

    setZoomLevel(newZoom);
    prevZoomRef.current = newZoom;

    requestAnimationFrame(() => {
      const newScrollTop = centerY_content * newZoom - viewport.clientHeight / 2;
      viewport.scrollTop = Math.max(0, newScrollTop);
    });
  };

  const handleZoomIn = () => {
    applyZoomWithScrollCompensation(Math.min(zoomLevel + 0.25, 2.0));
  };

  const handleZoomOut = () => {
    applyZoomWithScrollCompensation(Math.max(zoomLevel - 0.25, 0.25));
  };

  const handleFitToWidth = () => {
    applyZoomWithScrollCompensation(1.0);
  };

  // Compile & save document flow
  const handleSave = async () => {
    if (!file || pages.length === 0) return;
    setSaving(true);

    try {
      const exportedPages: string[] = [];

      for (const p of pages) {
        const stage = stageRefs.current[p.index];
        if (stage) {
          const dataUrl = stage.toDataURL({ pixelRatio: 3 });
          exportedPages.push(dataUrl);
        } else {
          exportedPages.push(p.imageUrl);
        }
      }

      const payload = {
        pages: exportedPages,
        output_filename: outputFilename || 'edited_document',
      };

      const response = await apiClient.post('/api/v1/edit-pdf/save', payload, {
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

  return (
    <div className="page-body" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="feature-split-layout" style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        
        {/* Left Panel */}
        <div
          className="feature-controls"
          style={{
            width: '320px',
            minWidth: '320px',
            maxWidth: '320px',
            background: '#1E1E2E',
            borderRight: '1px solid #2A2A3E',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            overflowY: 'auto',
          }}
        >
          {/* Header */}
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[#4A9EFF] font-bold text-lg">Edit PDF</span>
            <span className="text-xs px-2 py-0.5 rounded bg-[#2A2A3E] text-[#9898B8] font-semibold">BETA</span>
          </div>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileBrowse}
            accept=".pdf"
            className="hidden"
          />

          {/* Zona 1 — File Info */}
          {file && (
            <div
              className="card"
              style={{
                padding: '8px 12px',
                background: '#12121A',
                border: '1px solid #2A2A3E',
                borderRadius: '8px',
                maxHeight: '64px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <Filename name={file.name} className="text-xs font-semibold text-[#E8E8F0] truncate block" />
                <span className="text-[10px] text-[#9898B8] block mt-0.5">{formatBytes(file.size)}</span>
              </div>
              <button
                onClick={handleRemoveFile}
                className="text-[#9898B8] hover:text-[#ffb4ab] transition-colors p-1"
                title="Clear PDF"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          )}

          {/* Zona 2 — Drop Zone */}
          {!file && (
            <div
              className={`drop-zone ${isDragOver ? 'drag-over' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: '2px dashed #2A2A3E',
                borderRadius: '8px',
                padding: '16px',
                textAlign: 'center',
                background: '#12121A',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                height: '120px',
                maxHeight: '120px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Upload className="mx-auto mb-1.5 text-[#9898B8]" size={20} />
              <p style={{ fontSize: '0.8rem', fontWeight: 500, color: '#E8E8F0', marginBottom: '2px' }}>Drag & Drop PDF</p>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>or click to browse</span>
            </div>
          )}

          {file && loading && (
            <div className="flex items-center gap-2 text-[#9898B8] text-xs">
              <Loader2 className="animate-spin text-[#4A9EFF]" size={14} />
              <span>Converting PDF pages to images...</span>
            </div>
          )}

          {/* Zona 3 — Vertical Tools */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {[
              { id: 'select', label: 'Select', icon: MousePointer },
              { id: 'pen', label: 'Pen', icon: Pen },
              { id: 'highlighter', label: 'Highlighter', icon: Highlighter },
              { id: 'text', label: 'Text', icon: Type },
              { id: 'rect', label: 'Rect', icon: Square },
              { id: 'circle', label: 'Circle', icon: CircleIcon },
              { id: 'line', label: 'Line', icon: Minus },
              { id: 'eraser', label: 'Eraser', icon: Eraser },
            ].map((t) => {
              const Icon = t.icon;
              const isActive = activeTool === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    setActiveTool(t.id as any);
                    setSelectedObjectId(null); // Deselect on tool switch
                  }}
                  disabled={pages.length === 0}
                  style={{
                    width: '100%',
                    height: '36px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '0 12px',
                    borderRadius: '6px',
                    border: 'none',
                    cursor: pages.length === 0 ? 'not-allowed' : 'pointer',
                    fontSize: '14px',
                    fontWeight: 500,
                    transition: 'all 0.2s ease',
                    background: isActive ? '#4A9EFF' : 'transparent',
                    color: isActive ? '#ffffff' : '#9898B8',
                    opacity: pages.length === 0 ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive && pages.length > 0) e.currentTarget.style.background = '#2A2A3E';
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <Icon size={16} />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>

          <div style={{ borderBottom: '1px solid #2A2A3E' }} />

          {/* Zona 4 — Contextual Controls */}
          {pages.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              
              <div className="text-[11px] uppercase tracking-wider text-[#4A9EFF] font-bold mb-2">
                {selectedObject 
                  ? `Editing: Selected ${selectedObject.type}` 
                  : `Editing defaults: ${activeTool}`}
              </div>

              {/* TEXT PROPERTIES (either selected TextObject or default Text tool properties) */}
              {((selectedObject && selectedObject.type === 'text') || (!selectedObject && activeTool === 'text')) && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
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
                      style={{ width: '100%', background: '#12121A', border: '1px solid #2A2A3E', color: '#E8E8F0', padding: '6px 10px', borderRadius: '6px', outline: 'none', cursor: 'pointer', fontSize: '13px' }}
                    >
                      {FONT_FAMILIES.map((font) => (
                        <option key={font} value={font} style={{ fontFamily: font }}>
                          {font}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
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
                      style={{ width: '100%', background: '#12121A', border: '1px solid #2A2A3E', color: '#E8E8F0', padding: '6px 10px', borderRadius: '6px', outline: 'none', fontSize: '13px' }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={() => {
                        if (selectedObject) {
                          updateSelectedObject({ bold: !(selectedObject as TextObject).bold });
                        } else {
                          setDefaultTextProps(prev => ({ ...prev, bold: !prev.bold }));
                        }
                      }}
                      style={{
                        flex: 1,
                        height: '32px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: (selectedObject ? (selectedObject as TextObject).bold : defaultTextProps.bold) ? '#4A9EFF' : '#12121A',
                        border: '1px solid #2A2A3E',
                        borderRadius: '6px',
                        color: (selectedObject ? (selectedObject as TextObject).bold : defaultTextProps.bold) ? '#ffffff' : '#9898B8',
                        cursor: 'pointer'
                      }}
                    >
                      <Bold size={16} />
                    </button>
                    <button
                      onClick={() => {
                        if (selectedObject) {
                          updateSelectedObject({ italic: !(selectedObject as TextObject).italic });
                        } else {
                          setDefaultTextProps(prev => ({ ...prev, italic: !prev.italic }));
                        }
                      }}
                      style={{
                        flex: 1,
                        height: '32px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: (selectedObject ? (selectedObject as TextObject).italic : defaultTextProps.italic) ? '#4A9EFF' : '#12121A',
                        border: '1px solid #2A2A3E',
                        borderRadius: '6px',
                        color: (selectedObject ? (selectedObject as TextObject).italic : defaultTextProps.italic) ? '#ffffff' : '#9898B8',
                        cursor: 'pointer'
                      }}
                    >
                      <Italic size={16} />
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
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
                      style={{ width: '100%', height: '32px', border: '1px solid #2A2A3E', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '2px' }}
                    />
                  </div>
                </>
              )}

              {/* SHAPE PROPERTIES (rect, circle) */}
              {((selectedObject && (selectedObject.type === 'rect' || selectedObject.type === 'circle')) ||
                (!selectedObject && (activeTool === 'rect' || activeTool === 'circle'))) && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span className="text-xs font-semibold text-[#9898B8]">Stroke Color</span>
                    <input
                      type="color"
                      value={selectedObject ? (selectedObject as ShapeObject).strokeColor : defaultShapeProps.strokeColor}
                      onChange={(e) => {
                        if (selectedObject) {
                          updateSelectedObject({ strokeColor: e.target.value });
                        } else {
                          setDefaultShapeProps(prev => ({ ...prev, strokeColor: e.target.value }));
                        }
                      }}
                      style={{ width: '100%', height: '32px', border: '1px solid #2A2A3E', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '2px' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-semibold text-[#9898B8]">Stroke Width</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#12121A] text-[#4A9EFF]">
                        {selectedObject ? (selectedObject as ShapeObject).strokeWidth : defaultShapeProps.strokeWidth}px
                      </span>
                    </div>
                    <input
                      type="range"
                      min="1"
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
                      style={{ width: '100%', accentColor: '#4A9EFF', cursor: 'pointer' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span className="text-xs font-semibold text-[#9898B8]">Fill Color</span>
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
                      style={{ width: '100%', height: '32px', border: '1px solid #2A2A3E', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '2px' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-semibold text-[#9898B8]">Fill Opacity</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#12121A] text-[#4A9EFF]">
                        {selectedObject ? (selectedObject as ShapeObject).fillOpacity : defaultShapeProps.fillOpacity}%
                      </span>
                    </div>
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
                      style={{ width: '100%', accentColor: '#4A9EFF', cursor: 'pointer' }}
                    />
                  </div>
                </>
              )}

              {/* LINE / FREEHAND PROPERTIES (line, pen, highlighter) */}
              {((selectedObject && (selectedObject.type === 'line' || selectedObject.type === 'pen' || selectedObject.type === 'highlighter')) ||
                (!selectedObject && (activeTool === 'line' || activeTool === 'pen' || activeTool === 'highlighter'))) && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span className="text-xs font-semibold text-[#9898B8]">Stroke Color</span>
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
                      style={{ width: '100%', height: '32px', border: '1px solid #2A2A3E', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '2px' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-semibold text-[#9898B8]">Stroke Width</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#12121A] text-[#4A9EFF]">
                        {selectedObject ? (selectedObject as LineObject | FreehandObject).strokeWidth : defaultStrokeProps.strokeWidth}px
                      </span>
                    </div>
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
                      style={{ width: '100%', accentColor: '#4A9EFF', cursor: 'pointer' }}
                    />
                  </div>
                </>
              )}

              {activeTool === 'select' && !selectedObject && (
                <span className="text-xs text-[#9898B8]" style={{ fontStyle: 'italic' }}>
                  Click object to select. Drag to move.
                </span>
              )}

              {activeTool === 'eraser' && (
                <span className="text-xs text-[#9898B8]" style={{ fontStyle: 'italic' }}>
                  Click or drag over any object to delete it.
                </span>
              )}
            </div>
          )}

          {/* Zona 5 — Bottom Controls */}
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label className="text-xs font-semibold text-[#9898B8]" htmlFor="edit-output-name">
                Output Filename
              </label>
              <input
                id="edit-output-name"
                type="text"
                value={outputFilename}
                onChange={(e) => setOutputFilename(e.target.value)}
                placeholder="edited_document"
                disabled={!file || loading}
                style={{
                  width: '100%',
                  background: '#12121A',
                  border: '1px solid #2A2A3E',
                  color: '#E8E8F0',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  outline: 'none',
                  fontSize: '14px',
                }}
              />
            </div>

            <button
              onClick={handleSave}
              disabled={!file || loading || saving || pages.length === 0}
              style={{
                width: '100%',
                background: (!file || loading || saving || pages.length === 0) ? '#2A2A3E' : '#4A9EFF',
                color: '#ffffff',
                padding: '12px',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                border: 'none',
                cursor: (!file || loading || saving || pages.length === 0) ? 'not-allowed' : 'pointer',
                transition: 'background 0.2s ease',
              }}
            >
              {saving ? (
                <>
                  <Loader2 className="animate-spin" size={16} />
                  <span>Saving PDF...</span>
                </>
              ) : (
                <span>Save as PDF</span>
              )}
            </button>
          </div>
        </div>

        {/* Right Panel */}
        <div
          className="feature-preview"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            background: '#131318',
            overflow: 'hidden',
          }}
        >
          {/* Sticky Horizontal Toolbar */}
          <div
            style={{
              height: '48px',
              background: '#12121A',
              borderBottom: '1px solid #2A2A3E',
              padding: '8px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              zIndex: 10,
            }}
          >
            {/* Zoom Controls */}
            <div className="flex items-center gap-2">
              <button
                onClick={handleZoomOut}
                disabled={pages.length === 0 || zoomLevel <= 0.25}
                title="Zoom Out"
                style={{
                  background: 'transparent',
                  color: (pages.length === 0 || zoomLevel <= 0.25) ? '#414752' : '#9898B8',
                  border: 'none',
                  padding: '6px',
                  borderRadius: '4px',
                  cursor: (pages.length === 0 || zoomLevel <= 0.25) ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <ZoomOut size={16} />
              </button>
              <span style={{ fontSize: '13px', color: '#E8E8F0', minWidth: '40px', textAlign: 'center', fontFamily: 'monospace' }}>
                {Math.round(zoomLevel * 100)}%
              </span>
              <button
                onClick={handleZoomIn}
                disabled={pages.length === 0 || zoomLevel >= 2.0}
                title="Zoom In"
                style={{
                  background: 'transparent',
                  color: (pages.length === 0 || zoomLevel >= 2.0) ? '#414752' : '#9898B8',
                  border: 'none',
                  padding: '6px',
                  borderRadius: '4px',
                  cursor: (pages.length === 0 || zoomLevel >= 2.0) ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <ZoomIn size={16} />
              </button>
            </div>

            {/* Separator */}
            <div style={{ width: '1px', height: '24px', background: '#2A2A3E' }} />

            {/* Undo / Redo */}
            <div className="flex items-center gap-1">
              <button
                onClick={handleUndo}
                disabled={isUndoDisabled || pages.length === 0}
                title="Undo"
                style={{
                  background: 'transparent',
                  color: (isUndoDisabled || pages.length === 0) ? '#414752' : '#E8E8F0',
                  border: 'none',
                  padding: '6px',
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
                title="Redo"
                style={{
                  background: 'transparent',
                  color: (isRedoDisabled || pages.length === 0) ? '#414752' : '#E8E8F0',
                  border: 'none',
                  padding: '6px',
                  borderRadius: '4px',
                  cursor: (isRedoDisabled || pages.length === 0) ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <Redo2 size={16} />
              </button>
            </div>

            {/* Separator */}
            <div style={{ width: '1px', height: '24px', background: '#2A2A3E' }} />

            {/* Fit to Width */}
            <button
              onClick={handleFitToWidth}
              disabled={pages.length === 0}
              title="Fit to Width"
              style={{
                background: 'transparent',
                color: pages.length === 0 ? '#414752' : '#9898B8',
                border: 'none',
                padding: '6px 10px',
                borderRadius: '4px',
                cursor: pages.length === 0 ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '13px',
                fontWeight: 500,
              }}
            >
              <Maximize2 size={16} />
              <span>Fit to Width</span>
            </button>
          </div>

          {/* Canvas editor pages area */}
          <div
            ref={canvasViewportRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '24px',
              alignItems: 'center',
            }}
          >
            {pages.length === 0 ? (
              <div style={{ margin: 'auto', textAlign: 'center', color: '#9898B8' }}>
                <p className="text-base font-medium mb-1">No Document Uploaded</p>
                <p className="text-sm">Please drop a PDF on the left panel to begin editing.</p>
              </div>
            ) : (
              <div
                style={{
                  transform: `scale(${finalScale})`,
                  transformOrigin: 'top center',
                  transition: 'transform 0.15s ease',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '24px',
                  alignItems: 'center',
                  width: '100%',
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
                          stageRefs={stageRefs}
                          setPages={setPages}
                          defaultTextProps={defaultTextProps}
                          defaultShapeProps={defaultShapeProps}
                          defaultStrokeProps={defaultStrokeProps}
                          hexToRgba={hexToRgba}
                        />
                      </div>
                    </LazyPageContainer>
                  );
                })}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
