import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import { Stage, Layer, Image as KonvaImage, Line as KonvaLine, Rect as KonvaRect, Ellipse as KonvaEllipse, Text as KonvaText } from 'react-konva';
import useImage from 'use-image';
import apiClient from '../api/client';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { getFilenameFromHeaders, triggerBlobDownload } from '../utils/downloadHelper';
import { openOutputFolder } from '../utils/tauriDialog';
import { Filename } from '../components/Filename';

// ── Types ─────────────────────────────────────────────────────────────────────

type Tool = 'select' | 'pen' | 'highlighter' | 'text' | 'rect' | 'circle' | 'line' | 'eraser';

interface DrawingLine {
  id: string;
  type: 'line';
  points: number[];
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

interface ShapeObj {
  id: string;
  type: 'rect' | 'circle' | 'line-shape';
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: string;
  strokeWidth: number;
}

interface TextObj {
  id: string;
  type: 'text';
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fontFamily: string;
  fill: string;
  fontStyle: string; // 'normal' | 'bold' | 'italic' | 'bold italic'
  visible?: boolean;
}

type KonvaObject = DrawingLine | ShapeObj | TextObj;

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

// ── Individual Konva Page Editor ──────────────────────────────────────────────
interface KonvaPageEditorProps {
  page: PdfPageData;
  objects: KonvaObject[];
  setObjects: (objs: KonvaObject[] | ((prev: KonvaObject[]) => KonvaObject[])) => void;
  activeTool: Tool;
  color: string;
  strokeWidth: number;
  fontFamily: string;
  fontSize: number;
  isBold: boolean;
  isItalic: boolean;
  onTextSelected: (text: TextObj) => void;
  // History structure using get/set
  history: {
    get: () => KonvaObject[][];
    set: (val: KonvaObject[][]) => void;
  };
  historyIndex: {
    get: () => number;
    set: (val: number) => void;
  };
  triggerHistoryChange: () => void;
}

const KonvaPageEditor = React.forwardRef<any, KonvaPageEditorProps>(
  (
    {
      page,
      objects,
      setObjects,
      activeTool,
      color,
      strokeWidth,
      fontFamily,
      fontSize,
      isBold,
      isItalic,
      onTextSelected,
      history,
      historyIndex,
      triggerHistoryChange,
    },
    ref
  ) => {
    const [image] = useImage(`data:image/png;base64,${page.data}`);
    const [textInputState, setTextInputState] = useState<{
      visible: boolean;
      x: number;
      y: number;
      value: string;
      editingId: string | null;
    }>({
      visible: false,
      x: 0,
      y: 0,
      value: '',
      editingId: null,
    });
    const isDrawing = useRef(false);
    const currentShapeId = useRef<string | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
      if (textInputState.visible && textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      }
    }, [textInputState.value, textInputState.visible]);

    // Save to history
    const pushToHistory = useCallback((nextState: KonvaObject[]) => {
      const nextHistory = history.get().slice(0, historyIndex.get() + 1);
      nextHistory.push(nextState);
      
      // Limit to 50 steps
      if (nextHistory.length > 50) {
        nextHistory.shift();
      } else {
        historyIndex.set(nextHistory.length - 1);
      }
      
      history.set(nextHistory);
      triggerHistoryChange();
    }, [history, historyIndex, triggerHistoryChange]);

    const handleMouseDown = (e: any) => {
      if (activeTool === 'select' || activeTool === 'eraser' || activeTool === 'text' || textInputState.visible) return;

      const stage = e.target.getStage();
      const pos = stage.getPointerPosition();
      if (!pos) return;

      isDrawing.current = true;
      const newId = generateId();

      if (activeTool === 'pen' || activeTool === 'highlighter') {
        const newLine: DrawingLine = {
          id: newId,
          type: 'line',
          points: [pos.x, pos.y],
          stroke: color,
          strokeWidth: activeTool === 'highlighter' ? strokeWidth * 2 : strokeWidth,
          opacity: activeTool === 'highlighter' ? 0.4 : 1.0,
        };
        setObjects((prev) => [...prev, newLine]);
      } else if (activeTool === 'rect' || activeTool === 'circle' || activeTool === 'line') {
        currentShapeId.current = newId;
        const newShape: ShapeObj = {
          id: newId,
          type: activeTool === 'line' ? 'line-shape' : activeTool,
          x: pos.x,
          y: pos.y,
          width: 0,
          height: 0,
          stroke: color,
          strokeWidth: strokeWidth,
        };
        setObjects((prev) => [...prev, newShape]);
      } else if (activeTool === 'text') {
        isDrawing.current = false;
        const fontStyle = `${isBold ? 'bold' : ''} ${isItalic ? 'italic' : ''}`.trim() || 'normal';
        const newText: TextObj = {
          id: newId,
          type: 'text',
          x: pos.x,
          y: pos.y - fontSize / 2, // Center vertically
          text: 'Text',
          fontSize: fontSize,
          fontFamily: fontFamily,
          fill: color,
          fontStyle: fontStyle,
          visible: false,
        };
        const nextObjs = [...objects, newText];
        setObjects(nextObjs);
        
        setEditingText({
          id: newId,
          x: pos.x,
          y: pos.y - fontSize / 2,
          text: '',
          isNew: true,
        });
      }
    };

    const handleMouseMove = (e: any) => {
      if (!isDrawing.current) return;

      const stage = e.target.getStage();
      const pos = stage.getPointerPosition();
      if (!pos) return;

      if (activeTool === 'pen' || activeTool === 'highlighter') {
        setObjects((prev) => {
          return prev.map((obj) => {
            if (obj.type === 'line' && obj.id === prev[prev.length - 1]?.id) {
              return {
                ...obj,
                points: [...obj.points, pos.x, pos.y],
              };
            }
            return obj;
          });
        });
      } else if (activeTool === 'rect' || activeTool === 'circle' || activeTool === 'line') {
        setObjects((prev) => {
          return prev.map((obj) => {
            if (obj.id === currentShapeId.current && (obj.type === 'rect' || obj.type === 'circle' || obj.type === 'line-shape')) {
              return {
                ...obj,
                width: pos.x - obj.x,
                height: pos.y - obj.y,
              };
            }
            return obj;
          });
        });
      }
    };

    const handleMouseUp = () => {
      if (!isDrawing.current) return;
      isDrawing.current = false;
      currentShapeId.current = null;
      pushToHistory(objects);
    };

    const handleObjectClick = (e: any, objId: string) => {
      if (activeTool === 'eraser') {
        e.cancelBubble = true;
        const nextObjs = objects.filter((o) => o.id !== objId);
        setObjects(nextObjs);
        pushToHistory(nextObjs);
      }
    };

    const handleDragEnd = (e: any, objId: string) => {
      const nextObjs = objects.map((obj) => {
        if (obj.id === objId) {
          return {
            ...obj,
            x: e.target.x(),
            y: e.target.y(),
          };
        }
        return obj;
      });
      setObjects(nextObjs);
      pushToHistory(nextObjs);
    };

    const handleStageClick = (e: any) => {
      if (activeTool !== 'text') return;
      if (textInputState.visible) return;
      
      const stage = e.target.getStage();
      if (!stage) return;
      
      // Let handleTextDoubleClick handle clicks on text objects
      const clickedOnEmpty = e.target === stage || e.target.getClassName() === 'Image';
      if (!clickedOnEmpty) return;

      const pointerPos = stage.getPointerPosition();
      if (!pointerPos) return;

      setTextInputState({
        visible: true,
        x: pointerPos.x,
        y: pointerPos.y,
        value: '',
        editingId: null,
      });
    };

    const handleTextDoubleClick = (e: any, textObj: TextObj) => {
      e.cancelBubble = true;
      const textPosition = e.target.getAbsolutePosition();
      
      // Hide original Konva text object during edit
      const nextObjs = objects.map((obj) => {
        if (obj.id === textObj.id) {
          return { ...obj, visible: false };
        }
        return obj;
      });
      setObjects(nextObjs);
      
      // Update Toolbar state to match this text
      onTextSelected(textObj);
      
      setTextInputState({
        visible: true,
        x: textPosition.x,
        y: textPosition.y,
        value: textObj.text,
        editingId: textObj.id,
      });
    };

    const commitTextInput = () => {
      if (!textInputState.visible) return;
      const val = textInputState.value.trim();
      
      if (textInputState.editingId) {
        if (!val) {
          // Delete the Konva object if empty
          const nextObjs = objects.filter((o) => o.id !== textInputState.editingId);
          setObjects(nextObjs);
          pushToHistory(nextObjs);
        } else {
          // Update existing text
          const nextObjs = objects.map((obj) => {
            if (obj.id === textInputState.editingId && obj.type === 'text') {
              return {
                ...obj,
                text: val,
                visible: true,
              };
            }
            return obj;
          });
          setObjects(nextObjs);
          pushToHistory(nextObjs);
        }
      } else {
        // Create new text
        if (val) {
          const fontStyle = `${isBold ? 'bold' : ''} ${isItalic ? 'italic' : ''}`.trim() || 'normal';
          const newText: TextObj = {
            id: generateId(),
            type: 'text',
            x: textInputState.x,
            y: textInputState.y - fontSize / 2, // Center vertically
            text: val,
            fontSize: fontSize,
            fontFamily: fontFamily,
            fill: color,
            fontStyle: fontStyle,
            visible: true,
          };
          const nextObjs = [...objects, newText];
          setObjects(nextObjs);
          pushToHistory(nextObjs);
        }
      }
      setTextInputState({ visible: false, x: 0, y: 0, value: '', editingId: null });
    };

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
          ref={ref}
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
          style={{ cursor: activeTool === 'select' ? 'default' : activeTool === 'eraser' ? 'cell' : 'crosshair' }}
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
            {objects.map((obj) => {
              if (obj.type === 'line') {
                return (
                  <KonvaLine
                    key={obj.id}
                    points={obj.points}
                    stroke={obj.stroke}
                    strokeWidth={obj.strokeWidth}
                    tension={0.5}
                    lineCap="round"
                    lineJoin="round"
                    opacity={obj.opacity}
                    onClick={(e) => handleObjectClick(e, obj.id)}
                    onTouchEnd={(e) => handleObjectClick(e, obj.id)}
                  />
                );
              }
              if (obj.type === 'rect') {
                return (
                  <KonvaRect
                    key={obj.id}
                    x={obj.x}
                    y={obj.y}
                    width={obj.width}
                    height={obj.height}
                    stroke={obj.stroke}
                    strokeWidth={obj.strokeWidth}
                    draggable={activeTool === 'select'}
                    onClick={(e) => handleObjectClick(e, obj.id)}
                    onTouchEnd={(e) => handleObjectClick(e, obj.id)}
                    onDragEnd={(e) => handleDragEnd(e, obj.id)}
                  />
                );
              }
              if (obj.type === 'circle') {
                return (
                  <KonvaEllipse
                    key={obj.id}
                    x={obj.x + obj.width / 2}
                    y={obj.y + obj.height / 2}
                    radiusX={Math.abs(obj.width / 2)}
                    radiusY={Math.abs(obj.height / 2)}
                    stroke={obj.stroke}
                    strokeWidth={obj.strokeWidth}
                    draggable={activeTool === 'select'}
                    onClick={(e) => handleObjectClick(e, obj.id)}
                    onTouchEnd={(e) => handleObjectClick(e, obj.id)}
                    onDragEnd={(e) => {
                      const nextObjs = objects.map((item) => {
                        if (item.id === obj.id) {
                          return {
                            ...item,
                            x: e.target.x() - obj.width / 2,
                            y: e.target.y() - obj.height / 2,
                          };
                        }
                        return item;
                      });
                      setObjects(nextObjs);
                      pushToHistory(nextObjs);
                    }}
                  />
                );
              }
              if (obj.type === 'line-shape') {
                return (
                  <KonvaLine
                    key={obj.id}
                    points={[obj.x, obj.y, obj.x + obj.width, obj.y + obj.height]}
                    stroke={obj.stroke}
                    strokeWidth={obj.strokeWidth}
                    draggable={activeTool === 'select'}
                    onClick={(e) => handleObjectClick(e, obj.id)}
                    onTouchEnd={(e) => handleObjectClick(e, obj.id)}
                    onDragEnd={(e) => handleDragEnd(e, obj.id)}
                  />
                );
              }
              if (obj.type === 'text') {
                return (
                  <KonvaText
                    key={obj.id}
                    x={obj.x}
                    y={obj.y}
                    text={obj.text}
                    fontSize={obj.fontSize}
                    fontFamily={obj.fontFamily}
                    fontStyle={obj.fontStyle}
                    fill={obj.fill}
                    visible={obj.visible !== false}
                    draggable={activeTool === 'select'}
                    onClick={(e) => handleObjectClick(e, obj.id)}
                    onTouchEnd={(e) => handleObjectClick(e, obj.id)}
                    onDblClick={(e) => handleTextDoubleClick(e, obj)}
                    onDblTap={(e) => handleTextDoubleClick(e, obj)}
                    onDragEnd={(e) => handleDragEnd(e, obj.id)}
                  />
                );
              }
              return null;
            })}
          </Layer>
        </Stage>

        {textInputState.visible && (
          <textarea
            ref={textareaRef}
            value={textInputState.value}
            onChange={(e) => setTextInputState((prev) => ({ ...prev, value: e.target.value }))}
            onBlur={commitTextInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitTextInput();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                if (textInputState.editingId) {
                  // Restore text visibility
                  const nextObjs = objects.map((obj) => {
                    if (obj.id === textInputState.editingId) {
                      return { ...obj, visible: true };
                    }
                    return obj;
                  });
                  setObjects(nextObjs);
                }
                setTextInputState({ visible: false, x: 0, y: 0, value: '', editingId: null });
              }
            }}
            autoFocus
            style={{
              position: 'absolute',
              top: `${textInputState.y}px`,
              left: `${textInputState.x}px`,
              background: 'transparent',
              color: color,
              border: '1px solid #4A9EFF',
              borderRadius: '4px',
              fontFamily: fontFamily,
              fontSize: `${fontSize}px`,
              fontWeight: isBold ? 'bold' : 'normal',
              fontStyle: isItalic ? 'italic' : 'normal',
              outline: 'none',
              resize: 'none',
              zIndex: 1000,
              minWidth: '120px',
              minHeight: '32px',
              padding: '4px',
              overflow: 'hidden',
              pointerEvents: 'all',
            }}
          />
        )}
      </div>
    );
  }
);

KonvaPageEditor.displayName = 'KonvaPageEditor';

// ── Main Page Component ───────────────────────────────────────────────────────
export function EditPdfPage() {
  const { showToast } = useToast();
  const { fileData: file, setFileData: setFile } = useFeatureFile<File | null>('edit-pdf');

  const [pages, setPages] = useState<PdfPageData[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outputFilename, setOutputFilename] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

  // Tools & States
  const [activeTool, setActiveTool] = useState<Tool>('select');
  const [color, setColor] = useState('#4A9EFF');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [fontFamily, setFontFamily] = useState('Arial');
  const [fontSize, setFontSize] = useState(24);
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);

  // Store annotation objects per page index
  const [pageObjects, setPageObjects] = useState<Record<number, KonvaObject[]>>({});

  const [zoomLevel, setZoomLevel] = useState(1.0);

  // Sync active settings when activeTool changes
  useEffect(() => {
    if (activeTool === 'pen') {
      setColor('#4A9EFF');
      setStrokeWidth(3);
    } else if (activeTool === 'highlighter') {
      setColor('#FFFF00');
      setStrokeWidth(12);
    } else if (activeTool === 'text') {
      setColor('#000000');
      setFontSize(16);
    } else if (activeTool === 'rect' || activeTool === 'circle' || activeTool === 'line') {
      setColor('#4A9EFF');
      setStrokeWidth(2);
    }
  }, [activeTool]);

  const handleZoomIn = () => {
    setZoomLevel((prev) => Math.min(prev + 0.25, 2.0));
  };

  const handleZoomOut = () => {
    setZoomLevel((prev) => Math.max(prev - 0.25, 0.25));
  };

  const handleFitToWidth = () => {
    setZoomLevel(1);
  };

  // History system per page index
  const pageHistory = useRef<Record<number, KonvaObject[][]>>({});
  const pageHistoryIndex = useRef<Record<number, number>>({});
  const [, setHistoryTrigger] = useState(0); // Trigger re-render for Undo/Redo button disable state

  const stageRefs = useRef<Record<number, any>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Call API to convert PDF to base64 PNG pages
  const convertPdfToPages = async (pdfFile: File) => {
    setLoading(true);
    const formData = new FormData();
    formData.append('file', pdfFile);

    try {
      const res = await apiClient.post<ConversionResponse>('/api/v1/pdf-to-image/pages', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setPages(res.data.pages);
      
      // Initialize objects & history for each page
      const initialObjects: Record<number, KonvaObject[]> = {};
      res.data.pages.forEach((p) => {
        initialObjects[p.index] = [];
        pageHistory.current[p.index] = [[]];
        pageHistoryIndex.current[p.index] = 0;
      });
      setPageObjects(initialObjects);
      
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

  // Auto conversion if file was dropped / restored
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
    setPageObjects({});
    pageHistory.current = {};
    pageHistoryIndex.current = {};
  };

  const triggerHistoryChange = () => {
    setHistoryTrigger((prev) => prev + 1);
  };

  // Global Undo / Redo helpers that look at the first page or could be active page
  // For simplicity, we undo/redo the page history that has active undo available.
  const handleUndo = () => {
    // Check if we have undo on any page, usually the user wants to undo on pages they edited.
    // We can just undo for all pages that have history index > 0.
    let undone = false;
    const nextObjects = { ...pageObjects };
    
    Object.keys(pageHistory.current).forEach((key) => {
      const idx = Number(key);
      const histIdx = pageHistoryIndex.current[idx] ?? 0;
      if (histIdx > 0) {
        const prevIdx = histIdx - 1;
        pageHistoryIndex.current[idx] = prevIdx;
        nextObjects[idx] = pageHistory.current[idx][prevIdx];
        undone = true;
      }
    });

    if (undone) {
      setPageObjects(nextObjects);
      triggerHistoryChange();
    }
  };

  const handleRedo = () => {
    let redone = false;
    const nextObjects = { ...pageObjects };
    
    Object.keys(pageHistory.current).forEach((key) => {
      const idx = Number(key);
      const histIdx = pageHistoryIndex.current[idx] ?? 0;
      const histLen = pageHistory.current[idx]?.length ?? 0;
      if (histIdx < histLen - 1) {
        const nextIdx = histIdx + 1;
        pageHistoryIndex.current[idx] = nextIdx;
        nextObjects[idx] = pageHistory.current[idx][nextIdx];
        redone = true;
      }
    });

    if (redone) {
      setPageObjects(nextObjects);
      triggerHistoryChange();
    }
  };

  // Check if Undo/Redo is disabled
  const isUndoDisabled = !Object.keys(pageHistoryIndex.current).some(
    (key) => (pageHistoryIndex.current[Number(key)] ?? 0) > 0
  );

  const isRedoDisabled = !Object.keys(pageHistoryIndex.current).some(
    (key) =>
      (pageHistoryIndex.current[Number(key)] ?? 0) <
      (pageHistory.current[Number(key)]?.length ?? 0) - 1
  );

  const handleTextSelected = (textObj: TextObj) => {
    // Sync toolbar contextual controls to this text object
    setFontFamily(textObj.fontFamily);
    setFontSize(textObj.fontSize);
    setColor(textObj.fill);
    setIsBold(textObj.fontStyle.includes('bold'));
    setIsItalic(textObj.fontStyle.includes('italic'));
  };

  // Save flow
  const handleSave = async () => {
    if (!file || pages.length === 0) return;
    setSaving(true);

    try {
      const exportedPages: string[] = [];

      // Export each Konva Stage as high-res base64 PNG
      for (const p of pages) {
        const stage = stageRefs.current[p.index];
        if (stage) {
          // pixelRatio: 2 for print-quality rendering
          const dataUrl = stage.toDataURL({ pixelRatio: 2 });
          exportedPages.push(dataUrl);
        } else {
          // Fallback if page stage is not loaded yet (rendered as lazy placeholder)
          // We can use the original base64 page directly
          exportedPages.push(`data:image/png;base64,${p.data}`);
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
        
        {/* Left Panel: 320px fixed controls */}
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

          {/* Zona 1 — File Info (only when file is uploaded) */}
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

          {/* Zona 2 — Drop Zone (only when no file is uploaded) */}
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

          {/* Loading status under file card */}
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
                  onClick={() => setActiveTool(t.id as Tool)}
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
              {activeTool === 'pen' && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span className="text-xs font-semibold text-[#9898B8]">Color</span>
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      style={{ width: '100%', height: '32px', border: '1px solid #2A2A3E', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '2px' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-semibold text-[#9898B8]">Size</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#12121A] text-[#4A9EFF]">
                        {strokeWidth}px
                      </span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="20"
                      value={strokeWidth}
                      onChange={(e) => setStrokeWidth(Number(e.target.value))}
                      style={{ width: '100%', accentColor: '#4A9EFF', cursor: 'pointer' }}
                    />
                  </div>
                </>
              )}

              {activeTool === 'highlighter' && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span className="text-xs font-semibold text-[#9898B8]">Color</span>
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      style={{ width: '100%', height: '32px', border: '1px solid #2A2A3E', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '2px' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-semibold text-[#9898B8]">Size</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#12121A] text-[#4A9EFF]">
                        {strokeWidth}px
                      </span>
                    </div>
                    <input
                      type="range"
                      min="5"
                      max="30"
                      value={strokeWidth}
                      onChange={(e) => setStrokeWidth(Number(e.target.value))}
                      style={{ width: '100%', accentColor: '#4A9EFF', cursor: 'pointer' }}
                    />
                  </div>
                </>
              )}

              {activeTool === 'text' && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span className="text-xs font-semibold text-[#9898B8]">Font</span>
                    <select
                      value={fontFamily}
                      onChange={(e) => setFontFamily(e.target.value)}
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
                      min="8"
                      max="72"
                      value={fontSize}
                      onChange={(e) => setFontSize(Math.max(8, Math.min(72, Number(e.target.value))))}
                      style={{ width: '100%', background: '#12121A', border: '1px solid #2A2A3E', color: '#E8E8F0', padding: '6px 10px', borderRadius: '6px', outline: 'none', fontSize: '13px' }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={() => setIsBold(!isBold)}
                      style={{ flex: 1, height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: isBold ? '#4A9EFF' : '#12121A', border: '1px solid #2A2A3E', borderRadius: '6px', color: isBold ? '#ffffff' : '#9898B8', cursor: 'pointer' }}
                    >
                      <Bold size={16} />
                    </button>
                    <button
                      onClick={() => setIsItalic(!isItalic)}
                      style={{ flex: 1, height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: isItalic ? '#4A9EFF' : '#12121A', border: '1px solid #2A2A3E', borderRadius: '6px', color: isItalic ? '#ffffff' : '#9898B8', cursor: 'pointer' }}
                    >
                      <Italic size={16} />
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span className="text-xs font-semibold text-[#9898B8]">Color</span>
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      style={{ width: '100%', height: '32px', border: '1px solid #2A2A3E', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '2px' }}
                    />
                  </div>
                </>
              )}

              {(activeTool === 'rect' || activeTool === 'circle' || activeTool === 'line') && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span className="text-xs font-semibold text-[#9898B8]">Color</span>
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      style={{ width: '100%', height: '32px', border: '1px solid #2A2A3E', background: 'transparent', cursor: 'pointer', borderRadius: '4px', padding: '2px' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-semibold text-[#9898B8]">Border Size</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#12121A] text-[#4A9EFF]">
                        {strokeWidth}px
                      </span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={strokeWidth}
                      onChange={(e) => setStrokeWidth(Number(e.target.value))}
                      style={{ width: '100%', accentColor: '#4A9EFF', cursor: 'pointer' }}
                    />
                  </div>
                </>
              )}

              {activeTool === 'select' && (
                <span className="text-xs text-[#9898B8]" style={{ fontStyle: 'italic' }}>
                  Click object to select. Drag to move.
                </span>
              )}

              {activeTool === 'eraser' && (
                <span className="text-xs text-[#9898B8]" style={{ fontStyle: 'italic' }}>
                  Click any object to delete it.
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

        {/* Right Panel: Toolbar + Canvas Editor viewport */}
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
                  transform: `scale(${zoomLevel})`,
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
                      <KonvaPageEditor
                        ref={(el) => {
                          if (el) {
                            stageRefs.current[p.index] = el;
                          } else {
                            delete stageRefs.current[p.index];
                          }
                        }}
                        page={p}
                        objects={pageObjects[p.index] || []}
                        setObjects={(action) => {
                          setPageObjects((prev) => {
                            const currentObjs = prev[p.index] || [];
                            const nextObjs = typeof action === 'function' ? action(currentObjs) : action;
                            return {
                              ...prev,
                              [p.index]: nextObjs,
                            };
                          });
                        }}
                        activeTool={activeTool}
                        color={color}
                        strokeWidth={strokeWidth}
                        fontFamily={fontFamily}
                        fontSize={fontSize}
                        isBold={isBold}
                        isItalic={isItalic}
                        onTextSelected={handleTextSelected}
                        history={{
                          get: () => pageHistory.current[p.index] || [[]],
                          set: (val) => {
                            pageHistory.current[p.index] = val;
                          },
                        }}
                        historyIndex={{
                          get: () => pageHistoryIndex.current[p.index] ?? 0,
                          set: (val) => {
                            pageHistoryIndex.current[p.index] = val;
                          },
                        }}
                        triggerHistoryChange={triggerHistoryChange}
                      />
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
