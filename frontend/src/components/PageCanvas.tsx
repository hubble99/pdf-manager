import React, { useEffect, useRef } from 'react';
import * as fabric from 'fabric';
import type {
  CanvasObject, 
  CanvasObjectType, 
  DefaultShapeProps,
  DefaultStrokeProps,
  DefaultTextProps,
  FreehandObject, 
  LineObject, 
  PageData, 
  ShapeObject, 
  TextObject,
} from '../types/canvas';
import { generateCanvasObjectId } from '../features/edit-canvas/ids';
import { CanvasBridge } from '../features/edit-canvas/canvasBridge';
import { normalizeLetterSpacing } from '../features/edit-canvas/letterSpacing';
import { useTheme } from '../hooks/useTheme';
import {
  CONTROL_CORNER_SIZE,
  DEFAULT_TEXT_WIDTH,
  ERASER_TOLERANCE,
  HISTORY_LIMIT,
  MIN_SHAPE_SIZE,
  MIN_TEXT_WIDTH,
  SNAP_ANGLE_DEGREES,
  SNAP_ANGLE_RADIANS,
  SNAP_THRESHOLD_DEGREES,
  DEFAULT_SHAPE_FILL,
  DEFAULT_STROKE_COLOR,
} from '../features/edit-canvas/constants';
import {
  EMPTY_TEXT_SENTINEL,
  getTextCanvasPresentation,
  isEmptyTextState,
  normalizeTextState,
  TEXT_PLACEHOLDER_LABEL,
} from '../utils/textPlaceholder';
import { sampleForegroundColor } from '../utils/colorSampling';

// ── PageCanvas Component ──────────────────────────────────────────────────────
export interface PageCanvasProps {
  page: PageData;
  activeTool: 'select' | CanvasObjectType | 'eraser' | 'eyedropper';
  selectedObjectId: string | null;
  setSelectedObjectId: (id: string | null) => void;
  setActiveTool: (tool: 'select' | CanvasObjectType | 'eraser' | 'eyedropper') => void;
  updateSelectedObject: (patch: Partial<CanvasObject>, overrideId?: string) => void;
  commitPageObjectsToHistory: (pageIndex: number, finalObjects: CanvasObject[]) => void;
  fabricRefs?: React.MutableRefObject<Record<number, fabric.Canvas>>;
  setPages: React.Dispatch<React.SetStateAction<PageData[]>>;
  defaultTextProps: DefaultTextProps;
  defaultShapeProps: DefaultShapeProps;
  defaultStrokeProps: DefaultStrokeProps;
  hexToRgba: (hex: string, opacity: number) => string;
  onSampleColor: (color: string) => void;
  finalScale: number;
}

// Patch fabric.Canvas.prototype.calcOffset to prevent crash on disposal in v6
if (!(fabric.Canvas.prototype as any)._calcOffsetPatched) {
  const originalCalcOffset = fabric.Canvas.prototype.calcOffset;
  fabric.Canvas.prototype.calcOffset = function() {
    try {
      const hasEl = (this as any).el || (this as any).elements?.lower?.el;
      if (!hasEl) {
        return (this as any)._offset || { left: 0, top: 0 };
      }
      return (originalCalcOffset as any).call(this);
    } catch {
      return (this as any)._offset || { left: 0, top: 0 };
    }
  };
  (fabric.Canvas.prototype as any)._calcOffsetPatched = true;
}

fabric.Object.prototype.transparentCorners = false;
fabric.Object.prototype.cornerSize = CONTROL_CORNER_SIZE;
fabric.Object.prototype.borderScaleFactor = 1.5;

interface CanvasThemeColors {
  selectionFill: string;
  selectionBorder: string;
  selectionCorner: string;
}

function readCanvasThemeColors(): CanvasThemeColors {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    selectionFill: read('--canvas-selection-fill', 'rgba(74, 158, 255, 0.2)'),
    selectionBorder: read('--canvas-selection-border', '#4A9EFF'),
    selectionCorner: read('--canvas-selection-corner', '#FFFFFF'),
  };
}

export const PageCanvas = React.forwardRef<fabric.Canvas, PageCanvasProps>((props) => {
  const { theme } = useTheme();
  const {
    page,
    activeTool,
    selectedObjectId,
    setSelectedObjectId,
    setActiveTool,
    updateSelectedObject,
    commitPageObjectsToHistory,
    fabricRefs,
    setPages,
    defaultTextProps,
    defaultShapeProps,
    defaultStrokeProps,
    hexToRgba,
    onSampleColor,
    finalScale,
  } = props;

  // ============================================================================
  // FABRIC JS IMPLEMENTATION (NATIVE)
  const fabricCanvasRef = useRef<fabric.Canvas | null>(null);
  const fabricContainerRef = useRef<HTMLCanvasElement>(null);
  const fabricEditingRef = useRef<boolean>(false);
  const fabricRebuildingRef = useRef<boolean>(false);
  const backgroundImageRef = useRef<HTMLImageElement>(null);
  const themeColorsRef = useRef<CanvasThemeColors>(readCanvasThemeColors());

  useEffect(() => {
    const colors = readCanvasThemeColors();
    themeColorsRef.current = colors;

    const canvas = fabricCanvasRef.current;
    if (!canvas) return;

    canvas.selectionColor = colors.selectionFill;
    canvas.selectionBorderColor = colors.selectionBorder;
    canvas.getObjects().forEach((object) => {
      object.set({
        borderColor: colors.selectionBorder,
        cornerColor: colors.selectionCorner,
        cornerStrokeColor: colors.selectionBorder,
      });
      if (object instanceof fabric.Textbox) {
        object.set({ editingBorderColor: colors.selectionBorder } as Partial<fabric.Textbox>);
      }
    });

    const activeObject = canvas.getActiveObject();
    activeObject?.set({
      borderColor: colors.selectionBorder,
      cornerColor: colors.selectionCorner,
      cornerStrokeColor: colors.selectionBorder,
    });
    canvas.requestRenderAll();
  }, [theme]);


  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (canvas) {
      canvas.calcOffset();
      
      const compensatedCornerSize = Math.max(1, Math.round(CONTROL_CORNER_SIZE / finalScale));
      const compensatedTouchSize = Math.max(1, Math.round(24 / finalScale));
      const compensatedPadding = Math.max(1, Math.round(6 / finalScale));
      
      canvas.getObjects().forEach(obj => {
        obj.set({
          cornerSize: compensatedCornerSize,
          touchCornerSize: compensatedTouchSize,
          padding: compensatedPadding
        });
      });
      canvas.requestRenderAll();
    }
  }, [finalScale]);

  useEffect(() => {
    if (!fabricContainerRef.current) return;

    const colors = themeColorsRef.current;
    const canvas = new fabric.Canvas(fabricContainerRef.current, {
      width: page.width,
      height: page.height,
      selection: true,
      selectionColor: colors.selectionFill,
      selectionBorderColor: colors.selectionBorder,
      selectionLineWidth: 1.5,
      fireRightClick: true,
      stopContextMenu: true,
    });
    if (fabricRefs) fabricRefs.current[page.index] = canvas;
    fabricCanvasRef.current = canvas;
    CanvasBridge.connect(canvas, {
      activeTool,
      currentPage: page,
      defaultTextProps,
      defaultShapeProps,
      defaultStrokeProps,
      updateSelectedObject,
      setSelectedObjectId,
      onSampleColor,
    });

    let isDragging = false;
    let dragStartPos = { x: 0, y: 0 };
    let dragRect: fabric.Rect | fabric.Ellipse | fabric.Line | null = null;
    let erasedAnyInSession = false;

    const eraseFabricObjectAtPoint = (canvasObj: fabric.Canvas, e: any) => {
      const pointer = canvasObj.getScenePoint(e.e);
      const tolerance = ERASER_TOLERANCE;
      let erasedSomething = false;

      const objects = [...canvasObj.getObjects()];
      const currentPage = CanvasBridge.get(canvasObj).currentPage;
      
      objects.forEach((obj) => {
        if (!(obj as any).id) return;
        
        const bound = obj.getBoundingRect();
        const collides = (
          pointer.x >= bound.left - tolerance &&
          pointer.x <= bound.left + bound.width + tolerance &&
          pointer.y >= bound.top - tolerance &&
          pointer.y <= bound.top + bound.height + tolerance
        );

        if (collides) {
          const objId = (obj as any).id;
          canvasObj.remove(obj);
          erasedSomething = true;
          
          setPages(prev => prev.map(p => {
            if (p.index !== currentPage.index) return p;
            return {
              ...p,
              objects: p.objects.filter(o => o.id !== objId)
            };
          }));
        }
      });
      return erasedSomething;
    };

    canvas.on('mouse:down', (e) => {

      if ((e.e as MouseEvent).button === 2 || (e.e as MouseEvent).button === 3) {
        const hasTarget = !!((e.target as any) && (e.target as any).id);
        if (hasTarget) {
          const targetId = (e.target as any).id;
          CanvasBridge.get(canvas).setSelectedObjectId(targetId);
          canvas.setActiveObject(e.target as any);
          canvas.requestRenderAll();
          window.dispatchEvent(new CustomEvent('show-context-menu', {
            detail: { x: (e.e as MouseEvent).clientX, y: (e.e as MouseEvent).clientY, id: targetId }
          }));
        } else {
          CanvasBridge.get(canvas).setSelectedObjectId(null);
          canvas.discardActiveObject();
          canvas.requestRenderAll();
        }
        e.e.preventDefault();
        e.e.stopPropagation();
        return;
      }

      const bridge = CanvasBridge.get(canvas);
      const currentTool = bridge.activeTool;
      if (currentTool === 'eyedropper') {
        const pointer = canvas.getScenePoint(e.e);
        const image = backgroundImageRef.current;
        if (!image?.naturalWidth || !image.naturalHeight) return;
        const sampleCanvas = document.createElement('canvas');
        sampleCanvas.width = image.naturalWidth;
        sampleCanvas.height = image.naturalHeight;
        const context = sampleCanvas.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        context.drawImage(image, 0, 0);
        const pixelX = Math.max(0, Math.min(image.naturalWidth - 1, Math.round(pointer.x * image.naturalWidth / page.width)));
        const pixelY = Math.max(0, Math.min(image.naturalHeight - 1, Math.round(pointer.y * image.naturalHeight / page.height)));
        const sourceScale = image.naturalWidth / page.width;
        const sampleRadius = Math.max(4, Math.min(12, Math.round(5 * sourceScale)));
        const sampleX = Math.max(0, pixelX - sampleRadius);
        const sampleY = Math.max(0, pixelY - sampleRadius);
        const sampleWidth = Math.min(image.naturalWidth - sampleX, sampleRadius * 2 + 1);
        const sampleHeight = Math.min(image.naturalHeight - sampleY, sampleRadius * 2 + 1);
        const pixels = context.getImageData(sampleX, sampleY, sampleWidth, sampleHeight);
        bridge.onSampleColor(sampleForegroundColor(
          pixels,
          pixelX - sampleX,
          pixelY - sampleY,
          sampleRadius,
        ));
        return;
      }
      if (currentTool === 'eraser') {
        isDragging = true;
        erasedAnyInSession = false;
        if (eraseFabricObjectAtPoint(canvas, e)) {
          erasedAnyInSession = true;
        }
        return;
      }
      
      if (['text', 'rect', 'circle', 'line'].includes(currentTool) && !e.target) {
        const pointer = canvas.getScenePoint(e.e);
        
        if (currentTool === 'text') {
          const currentPage = bridge.currentPage;
          const newText: TextObject = {
            id: generateCanvasObjectId(), type: 'text', x: pointer.x, y: pointer.y, text: EMPTY_TEXT_SENTINEL,
            fontFamily: bridge.defaultTextProps.fontFamily,
            fontSize: bridge.defaultTextProps.fontSize,
            letterSpacing: bridge.defaultTextProps.letterSpacing,
            fontWeight: bridge.defaultTextProps.fontWeight,
            bold: bridge.defaultTextProps.bold,
            italic: bridge.defaultTextProps.italic,
            color: bridge.defaultTextProps.color,
            width: DEFAULT_TEXT_WIDTH
          };
          const finalObjects = [...currentPage.objects, newText];
          setPages(prev => prev.map(p => p.index === currentPage.index ? { ...p, objects: finalObjects } : p));
          commitPageObjectsToHistory(currentPage.index, finalObjects);
          setSelectedObjectId(newText.id);
          setActiveTool('select');
          return;
        }

        isDragging = true;
        dragStartPos = { x: pointer.x, y: pointer.y };

        const strokeColor = bridge.defaultShapeProps.strokeColor || DEFAULT_STROKE_COLOR;
        
        const commonDragProps = {
          left: dragStartPos.x, top: dragStartPos.y,
          originX: 'left', originY: 'top',
          stroke: strokeColor, strokeWidth: 1, strokeDashArray: [],
          fill: bridge.defaultShapeProps.fillColor || DEFAULT_SHAPE_FILL,
          selectable: false, evented: false
        };

        if (currentTool === 'circle') {
          dragRect = new fabric.Ellipse({ ...commonDragProps, rx: 0, ry: 0 } as any);
        } else if (currentTool === 'line') {
          const defaultStrokeProps = bridge.defaultStrokeProps;
          const lineStrokeColor = defaultStrokeProps?.strokeColor || DEFAULT_STROKE_COLOR;
          const lineStrokeWidth = defaultStrokeProps?.strokeWidth || 4;
          dragRect = new fabric.Line([dragStartPos.x, dragStartPos.y, dragStartPos.x, dragStartPos.y], {
            originX: 'center', originY: 'center',
            stroke: lineStrokeColor, strokeWidth: lineStrokeWidth,
            selectable: false, evented: false
          } as any);
        } else {
          dragRect = new fabric.Rect({ ...commonDragProps, width: 0, height: 0 } as any);
        }
        canvas.add(dragRect);
      }
    });

    canvas.on('mouse:move', (e) => {
      const currentTool = CanvasBridge.get(canvas).activeTool;
      if (currentTool === 'eraser' && isDragging) {
        if (eraseFabricObjectAtPoint(canvas, e)) {
          erasedAnyInSession = true;
        }
        return;
      }
      
      if (isDragging && dragRect) {
        const pointer = canvas.getScenePoint(e.e);
        const w = pointer.x - dragStartPos.x;
        const h = pointer.y - dragStartPos.y;
        
        const left = w < 0 ? pointer.x : dragStartPos.x;
        const top = h < 0 ? pointer.y : dragStartPos.y;
        const absW = Math.abs(w);
        const absH = Math.abs(h);

        if (currentTool === 'circle') {
          dragRect.set({
            left, top,
            rx: absW / 2,
            ry: absH / 2,
            width: absW,
            height: absH
          });
        } else if (currentTool === 'line') {
          const lineObj = dragRect as fabric.Line;
          let newX = pointer.x;
          let newY = pointer.y;
          
          if (e.e.shiftKey) {
            const dx = pointer.x - dragStartPos.x;
            const dy = pointer.y - dragStartPos.y;
            const angle = Math.atan2(dy, dx);
            const snappedAngle = Math.round(angle / SNAP_ANGLE_RADIANS) * SNAP_ANGLE_RADIANS;
            const dist = Math.sqrt(dx * dx + dy * dy);
            newX = dragStartPos.x + Math.cos(snappedAngle) * dist;
            newY = dragStartPos.y + Math.sin(snappedAngle) * dist;
          }
          
          lineObj.set({
            x2: newX,
            y2: newY
          });
        } else {
          dragRect.set({
            left, top,
            width: absW,
            height: absH
          });
        }
        
        canvas.renderAll();
      }
    });

    canvas.on('mouse:up', (e) => {
      const bridge = CanvasBridge.get(canvas);
      const currentTool = bridge.activeTool;
      if (currentTool === 'eraser') {
        isDragging = false;
        if (erasedAnyInSession) {
          const currentPage = bridge.currentPage;
          setPages(prev => prev.map(p => {
             if (p.index === currentPage.index) {
               const lastSnapshot = p.history[p.historyIndex];
               if (JSON.stringify(lastSnapshot) === JSON.stringify(p.objects)) return p;
               const nextHistory = [...p.history.slice(0, p.historyIndex + 1), p.objects];
               if (nextHistory.length > HISTORY_LIMIT) nextHistory.shift();
               return { ...p, history: nextHistory, historyIndex: nextHistory.length - 1 };
             }
             return p;
          }));
        }
        return;
      }
      
      if (['rect', 'circle', 'line'].includes(currentTool) && !e.target) {
        let isDrag = false;
        let dragW = 0;
        let dragH = 0;
        let finalX = dragStartPos.x;
        let finalY = dragStartPos.y;
        
        let finalX2 = dragStartPos.x;
        let finalY2 = dragStartPos.y;

        if (isDragging && dragRect) {
          if (currentTool === 'line') {
            const lineObj = dragRect as fabric.Line;
            const m = lineObj.calcTransformMatrix();
            const pts = lineObj.calcLinePoints();
            const p1 = fabric.util.transformPoint(new fabric.Point(pts.x1, pts.y1), m);
            const p2 = fabric.util.transformPoint(new fabric.Point(pts.x2, pts.y2), m);
            
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist >= MIN_SHAPE_SIZE) {
              isDrag = true;
              finalX = p1.x;
              finalY = p1.y;
              finalX2 = p2.x;
              finalY2 = p2.y;
            }
          } else {
            if (dragRect.width >= MIN_SHAPE_SIZE || dragRect.height >= MIN_SHAPE_SIZE) {
              isDrag = true;
              dragW = dragRect.width;
              dragH = dragRect.height;
              finalX = dragRect.left;
              finalY = dragRect.top;
            }
          }
          canvas.remove(dragRect);
          dragRect = null;
        }
        isDragging = false;

        const currentPage = bridge.currentPage;
        let finalObjects = currentPage.objects;
        let createdId: string | null = null;
        
        if (isDrag) {
          if (currentTool === 'line') {
            const defaultStrokeProps = bridge.defaultStrokeProps;
            const newLineId = generateCanvasObjectId();
            const newLine: LineObject = {
              id: newLineId, type: 'line',
              x: 0, y: 0,
              points: [finalX, finalY, finalX2, finalY2],
              strokeColor: defaultStrokeProps?.strokeColor || DEFAULT_STROKE_COLOR,
              strokeWidth: defaultStrokeProps?.strokeWidth || 4
            };
            finalObjects = [...currentPage.objects, newLine];
            createdId = newLineId;
          } else {
            const defaultShapeProps = bridge.defaultShapeProps;
            const newShapeId = generateCanvasObjectId();
            const newShape: ShapeObject = {
              id: newShapeId, type: currentTool as 'rect' | 'circle', 
              x: finalX, y: finalY, 
              width: Math.max(MIN_SHAPE_SIZE, dragW), height: Math.max(MIN_SHAPE_SIZE, dragH),
              fillColor: defaultShapeProps.fillColor, fillOpacity: defaultShapeProps.fillOpacity,
              strokeColor: defaultShapeProps.strokeColor, strokeWidth: defaultShapeProps.strokeWidth
            };
            finalObjects = [...currentPage.objects, newShape];
            createdId = newShapeId;
          }
        }

        if (finalObjects !== currentPage.objects) {
          setPages(prev => prev.map(p => p.index === currentPage.index ? { ...p, objects: finalObjects } : p));
          commitPageObjectsToHistory(currentPage.index, finalObjects);
          if (createdId) setSelectedObjectId(createdId);
          setActiveTool('select');
        }
      }
    });

    canvas.on('path:created', (e: any) => {
      const path = e.path;
      const bridge = CanvasBridge.get(canvas);
      const currentTool = bridge.activeTool;
      if (currentTool !== 'pen' && currentTool !== 'highlighter') return;

      const currentPage = bridge.currentPage;
      const newId = generateCanvasObjectId();

      const newObj: FreehandObject = {
        id: newId,
        type: currentTool,
        x: path.left,
        y: path.top,
        points: path.path,
        strokeColor: path.stroke,
        strokeWidth: path.strokeWidth || 1,
        opacity: currentTool === 'highlighter' ? 0.4 : 1,
        scaleX: 1,
        scaleY: 1,
        width: path.width,
        height: path.height,
      };

      const finalObjects = [...currentPage.objects, newObj];
      setPages(prev => prev.map(p => p.index === currentPage.index ? { ...p, objects: finalObjects } : p));
      commitPageObjectsToHistory(currentPage.index, finalObjects);

      canvas.remove(path);

      setSelectedObjectId(newId);
      setActiveTool('select');
    });

    canvas.on('before:render', () => {
      const target = canvas.getActiveObject();
      if (!target) return;
      
      const bound = target.getBoundingRect();
      const currentPage = CanvasBridge.get(canvas).currentPage;
      if (!currentPage) return;
      
      const pWidth = currentPage.width;
      const pHeight = currentPage.height;
      
      let newLeft = target.left || 0;
      let newTop = target.top || 0;
      let changed = false;

      if (bound.left < 0) {
        newLeft = newLeft - bound.left;
        changed = true;
      } else if (bound.left + bound.width > pWidth) {
        newLeft = newLeft - (bound.left + bound.width - pWidth);
        changed = true;
      }
      
      if (bound.top < 0) {
        newTop = newTop - bound.top;
        changed = true;
      } else if (bound.top + bound.height > pHeight) {
        newTop = newTop - (bound.top + bound.height - pHeight);
        changed = true;
      }
      
      if (changed) {
        target.set({ left: newLeft, top: newTop });
        target.setCoords();
      }
    });

    canvas.on('object:modified', (e) => {
      const target = e.target as any;
      if (!target) return;

      if (target.isType && target.isType('ActiveSelection')) {
        try {
          const activeObjects = target.getObjects();
          const currentPage = CanvasBridge.get(canvas).currentPage;
          if (!currentPage) return;
          
          canvas.discardActiveObject();
          
          const updates: any = {};
          
          activeObjects.forEach((obj: any) => {
            if (obj.id) {
              if (obj.type === 'line') {
                const matrix = obj.calcTransformMatrix();
                const pts = (obj as fabric.Line).calcLinePoints();
                const p1 = fabric.util.transformPoint(new fabric.Point(pts.x1, pts.y1), matrix);
                const p2 = fabric.util.transformPoint(new fabric.Point(pts.x2, pts.y2), matrix);
                updates[obj.id] = { type: 'line', points: [p1.x, p1.y, p2.x, p2.y] };
              } else {
                let newFontSize = obj.fontSize;
                let newWidth = obj.width;
                let newHeight = obj.height;
                
                const isText = obj.type && (obj.type.toLowerCase() === 'text' || obj.type.toLowerCase() === 'textbox');
                const isRect = obj.type && obj.type.toLowerCase() === 'rect';
                const isEllipse = obj.type && obj.type.toLowerCase() === 'ellipse';

                const scaleX = obj.scaleX || 1;
                const scaleY = obj.scaleY || 1;
                const scale = Math.max(scaleX, scaleY);
                
                if (isText) {
                  newFontSize = Math.max(1, Math.round((obj.fontSize || 16) * scale * 10) / 10);
                  newWidth = Math.max(MIN_TEXT_WIDTH, (obj.width || MIN_TEXT_WIDTH) * scaleX);
                } else if (isRect || isEllipse) {
                  let calcW = 0;
                  let calcH = 0;
                  if (isRect) {
                     calcW = (obj.width || 1) * scaleX;
                     calcH = (obj.height || 1) * scaleY;
                  } else if (isEllipse) {
                     calcW = (obj.rx * 2 || 1) * scaleX;
                     calcH = (obj.ry * 2 || 1) * scaleY;
                  }
                  newWidth = Math.max(MIN_SHAPE_SIZE, calcW);
                  newHeight = Math.max(MIN_SHAPE_SIZE, calcH);
                }

                updates[obj.id] = { 
                  type: 'other', 
                  x: obj.left || 0, 
                  y: obj.top || 0,
                  angle: obj.angle || 0,
                  width: newWidth,
                  height: newHeight,
                  fontSize: newFontSize,
                  isText,
                  isRect,
                  isEllipse
                };
              }
            }
          });
          
          setPages(prev => prev.map(p => {
            if (p.index !== currentPage.index) return p;
            const newObjects = p.objects.map(o => {
              const up = updates[o.id];
              if (up) {
                 if (up.type === 'line') {
                   return { ...o, points: up.points };
                 } else {
                   const newObj = { ...o, x: up.x, y: up.y, angle: up.angle };
                   if (up.isText) {
                      (newObj as any).fontSize = up.fontSize;
                      (newObj as any).width = up.width;
                   } else if (up.isRect || up.isEllipse) {
                      (newObj as any).width = up.width;
                      (newObj as any).height = up.height;
                   }
                   return newObj;
                 }
              }
              return o;
            });
            return { ...p, objects: newObjects };
          }));

          activeObjects.forEach((obj: any) => {
             const up = updates[obj.id];
             if (up && !up.points) {
                 obj.set({ scaleX: 1, scaleY: 1, width: up.width, height: up.height });
                 if (up.fontSize) obj.set({ fontSize: up.fontSize });
                 obj.setCoords();
             } else if (up && up.points) {
                 obj.set({ scaleX: 1, scaleY: 1, left: 0, top: 0, x1: up.points[0], y1: up.points[1], x2: up.points[2], y2: up.points[3] });
                 obj.setCoords();
             }
          });

          const newSel = new fabric.ActiveSelection(activeObjects, { canvas });
          canvas.setActiveObject(newSel);
          canvas.requestRenderAll();
        } catch (err) {
          console.error("Error in ActiveSelection modified handler:", err);
          if ((canvas as any)._currentTransform) {
            (canvas as any)._currentTransform = null;
          }
        }
        return;
      }

      if (!target.id) return;

      let wasScaled = false;
      const isText = target.type && target.type.toLowerCase() === 'textbox';
      const isRect = target.type && target.type.toLowerCase() === 'rect';
      const isEllipse = target.type && target.type.toLowerCase() === 'ellipse';
      const isLine = target.type && target.type.toLowerCase() === 'line';
      const isPath = target.type && target.type.toLowerCase() === 'path';

      const targetScaleX = target.scaleX || 1;
      const targetScaleY = target.scaleY || 1;

      let newFontSize = target.fontSize;
      let newWidth = target.width;
      let newHeight = target.height;

      if (Math.abs(targetScaleX - 1) > 0.0001 || Math.abs(targetScaleY - 1) > 0.0001) {
        if (!isPath) {
          wasScaled = true;
          const scaleX = targetScaleX;
          const scaleY = targetScaleY;
          const scale = Math.max(scaleX, scaleY);
          
          if (isText) {
            newFontSize = Math.max(1, Math.round(target.fontSize * scale * 10) / 10);
          } else if (isRect || isEllipse) {
            let calcW = 0;
            let calcH = 0;
            if (isRect) {
               calcW = target.width * scaleX;
               calcH = target.height * scaleY;
            } else if (isEllipse) {
               calcW = (target.rx * 2) * scaleX;
               calcH = (target.ry * 2) * scaleY;
            }
            newWidth = Math.max(MIN_SHAPE_SIZE, calcW);
            newHeight = Math.max(MIN_SHAPE_SIZE, calcH);
          }
          
          target.set({ scaleX: 1, scaleY: 1 });
          if (isText) {
             target.set({ fontSize: newFontSize, width: Math.max(MIN_TEXT_WIDTH, newWidth) });
          } else if (isRect) {
             target.set({ width: newWidth, height: newHeight });
          } else if (isEllipse) {
             target.set({ rx: newWidth / 2, ry: newHeight / 2 });
          }
          target.setCoords();
        }
      }

      const postScaleX = target.left;
      const postScaleY = target.top;
      const newAngle = target.angle || 0;

      const bridge = CanvasBridge.get(canvas);
      if (bridge.updateSelectedObject) {
        if (isLine) {
          const m = target.calcTransformMatrix();
          const pts = target.calcLinePoints();
          const p1 = fabric.util.transformPoint(new fabric.Point(pts.x1, pts.y1), m);
          const p2 = fabric.util.transformPoint(new fabric.Point(pts.x2, pts.y2), m);
          
          target.set({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
          
          bridge.updateSelectedObject({
            points: [p1.x, p1.y, p2.x, p2.y]
          }, target.id);
        } else {
          const patch: any = {
            x: postScaleX,
            y: postScaleY,
            angle: newAngle
          };
          
          const isResizeAction = wasScaled || (e.action && ['scale', 'scaleX', 'scaleY', 'resizing'].includes(e.action));
          if (isText) {
             patch.fontSize = newFontSize;
             if (isResizeAction) {
               patch.width = Math.max(MIN_TEXT_WIDTH, newWidth);
             }
          } else if (isRect || isEllipse) {
             patch.width = newWidth;
             patch.height = newHeight;
          } else if (isPath) {
             patch.scaleX = target.scaleX;
             patch.scaleY = target.scaleY;
          }

          bridge.updateSelectedObject(patch, target.id);
        }
      }
    });

    const handleSelectionChange = () => {
      const activeObject = canvas.getActiveObject();
      if (activeObject && activeObject.isType && activeObject.isType('ActiveSelection')) {
        const activeColors = themeColorsRef.current;
        activeObject.set({
          borderColor: activeColors.selectionBorder,
          cornerColor: activeColors.selectionCorner,
          cornerStrokeColor: activeColors.selectionBorder,
          transparentCorners: false,
          cornerSize: CONTROL_CORNER_SIZE,
          borderScaleFactor: 1.5
        });
      }

      const activeObjects = canvas.getActiveObjects();
      if (activeObjects && activeObjects.length === 1) {
        const obj = activeObjects[0] as any;
        if (obj.id) setSelectedObjectId(obj.id);
      } else {
        setSelectedObjectId(null);
      }
    };

    canvas.on('selection:created', handleSelectionChange);
    canvas.on('selection:updated', handleSelectionChange);

    canvas.on('selection:cleared', () => {
      if (fabricRebuildingRef.current) return;
      const currentTool = CanvasBridge.get(canvas).activeTool;
      if (currentTool === 'select') {
        setTimeout(() => {
          if (!canvas.getActiveObject()) {
            setSelectedObjectId(null);
          }
        }, 0);
      }
    });

    canvas.on('text:editing:entered', (e) => {
      fabricEditingRef.current = true;
      const target = e.target as any;
      if (!target || target.text !== TEXT_PLACEHOLDER_LABEL) return;

      const currentPage = CanvasBridge.get(canvas).currentPage;
      const textObject = currentPage.objects.find(o => o.id === target.id && o.type === 'text') as TextObject | undefined;
      if (!textObject || !isEmptyTextState(textObject.text)) return;

      target.set({ text: '', fill: textObject?.color || DEFAULT_STROKE_COLOR });
      if (target.hiddenTextarea) {
        target.hiddenTextarea.value = '';
      }
      canvas.requestRenderAll();
    });

    canvas.on('text:editing:exited', (e) => {
      fabricEditingRef.current = false;
      const target = e.target as any;
      if (!target || !target.id) return;

      const finalText = normalizeTextState(target.text);
      const currentPage = CanvasBridge.get(canvas).currentPage;

      const nextObjs = currentPage.objects.map(o =>
        o.id === target.id ? { ...o, text: finalText } as CanvasObject : o
      );
      setPages(prev => prev.map(p => p.index === currentPage.index ? { ...p, objects: nextObjs } : p));
      commitPageObjectsToHistory(currentPage.index, nextObjs);

      if (finalText === EMPTY_TEXT_SENTINEL) {
        const textObject = currentPage.objects.find(o => o.id === target.id) as TextObject | undefined;
        const presentation = getTextCanvasPresentation(finalText, textObject?.color || DEFAULT_STROKE_COLOR);
        target.set({ text: presentation.text, fill: presentation.fill });
        canvas.requestRenderAll();
      }
    });

    return () => {
      CanvasBridge.disconnect(canvas);
      canvas.dispose();
    };
  }, [page.width, page.height]);

  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const isInteractive = activeTool === 'select';
    canvas.selection = activeTool === 'select';
    
    const svgHeader = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`;
    const svgHeaderGray = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6B7280" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`;
    let customCursor = '';
    
    if (activeTool === 'eraser') {
      const eraserSvg = encodeURIComponent(`${svgHeaderGray}<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`);
      customCursor = `url("data:image/svg+xml;utf8,${eraserSvg}") 0 24, crosshair`;
    } else if (activeTool === 'pen') {
      const penSvg = encodeURIComponent(`${svgHeader}<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`);
      customCursor = `url("data:image/svg+xml;utf8,${penSvg}") 2 22, crosshair`;
    } else if (activeTool === 'highlighter') {
      const highlightSvg = encodeURIComponent(`${svgHeader}<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>`);
      customCursor = `url("data:image/svg+xml;utf8,${highlightSvg}") 3 20, crosshair`;
    } else if (activeTool === 'text') {
      customCursor = 'text';
    } else if (activeTool === 'line' || activeTool === 'rect' || activeTool === 'circle' || activeTool === 'eyedropper') {
      customCursor = 'crosshair';
    }

    if (customCursor) {
      canvas.defaultCursor = customCursor;
      canvas.hoverCursor = customCursor;
    } else {
      canvas.defaultCursor = 'default';
      canvas.hoverCursor = 'move';
    }

    CanvasBridge.update(canvas, { activeTool });
    canvas.getObjects().forEach(obj => {
      obj.selectable = isInteractive;
      obj.evented = isInteractive;
    });

    if (activeTool === 'pen' || activeTool === 'highlighter') {
      canvas.isDrawingMode = true;
      const brush = new fabric.PencilBrush(canvas);
      if (activeTool === 'highlighter') {
        brush.width = 12;
        brush.color = defaultStrokeProps.strokeColor;
      } else {
        brush.width = defaultStrokeProps.strokeWidth || 4;
        brush.color = defaultStrokeProps.strokeColor || DEFAULT_STROKE_COLOR;
      }
      canvas.freeDrawingBrush = brush;
      canvas.freeDrawingCursor = customCursor || 'crosshair';
    } else {
      canvas.isDrawingMode = false;
    }

    canvas.requestRenderAll();
  }, [activeTool, defaultStrokeProps]);

  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    CanvasBridge.connect(canvas, {
      activeTool,
      currentPage: page,
      defaultTextProps,
      defaultShapeProps,
      defaultStrokeProps,
      updateSelectedObject,
      setSelectedObjectId,
      onSampleColor,
    });
  }, [activeTool, page, defaultTextProps, defaultShapeProps, defaultStrokeProps, updateSelectedObject, setSelectedObjectId, onSampleColor]);

  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;

    if (fabricEditingRef.current) return;

    fabricRebuildingRef.current = true;
    canvas.renderOnAddRemove = false;

    const fabricObjects = page.objects.filter(o => ['text', 'rect', 'circle', 'line', 'pen', 'highlighter'].includes(o.type));
    const isInteractive = activeTool === 'select';

    const existingFabricObjects = new Map<string, any>();
    const populateExisting = (objects: any[]) => {
      objects.forEach(obj => {
        if (obj.isType && (obj.isType('ActiveSelection') || obj.isType('group'))) {
          populateExisting(obj.getObjects());
        } else {
          const id = (obj as any).id;
          if (id) {
            existingFabricObjects.set(id, obj);
          }
        }
      });
    };
    populateExisting(canvas.getObjects());

    const currentReactObjectIds = new Set<string>();

    fabricObjects.forEach(obj => {
      currentReactObjectIds.add(obj.id);
      
      let fabricObj = existingFabricObjects.get(obj.id);

      const compensatedCornerSize = Math.max(1, Math.round(6 / finalScale));
      const compensatedTouchSize = Math.max(1, Math.round(24 / finalScale));
      const compensatedPadding = Math.max(1, Math.round(6 / finalScale));

      const activeColors = themeColorsRef.current;
      const commonProps = {
        left: obj.x,
        top: obj.y,
        angle: obj.angle || 0,
        originX: 'left',
        originY: 'top',
        selectable: isInteractive,
        evented: isInteractive,
        snapAngle: SNAP_ANGLE_DEGREES,
        snapThreshold: SNAP_THRESHOLD_DEGREES,
        cornerSize: compensatedCornerSize,
        touchCornerSize: compensatedTouchSize,
        cornerColor: activeColors.selectionCorner,
        cornerStrokeColor: activeColors.selectionBorder,
        borderColor: activeColors.selectionBorder,
        borderScaleFactor: 1.5,
        padding: obj.type === 'rect' ? 0 : compensatedPadding,
        transparentCorners: false,
      };

      if (!fabricObj) {
        if (obj.type === 'text') {
          const textObj = obj as TextObject;
          const fontStyle = textObj.italic ? 'italic' : 'normal';
          const fontWeight = textObj.fontWeight ?? (textObj.bold ? 700 : 400);
          const safeWidth = textObj.width || DEFAULT_TEXT_WIDTH;
          const presentation = getTextCanvasPresentation(textObj.text, textObj.color);
          
          fabricObj = new fabric.Textbox(presentation.text, {
            ...commonProps, 
            id: textObj.id, 
            width: safeWidth,
            charSpacing: normalizeLetterSpacing(textObj.letterSpacing),
            fontSize: textObj.fontSize,
            fontFamily: textObj.fontFamily,
            fill: presentation.fill,
            fontStyle: fontStyle as any,
            fontWeight,
            textAlign: textObj.textAlign || 'left',
            editable: true,
            editingBorderColor: activeColors.selectionBorder,
            splitByGrapheme: true
          } as any);
          fabricObj.setControlsVisibility({ mt: false, mb: false });
        } else if (obj.type === 'rect' || obj.type === 'circle') {
          const shapeObj = obj as ShapeObject;
          const fillVal = shapeObj.fillColor && shapeObj.fillOpacity > 0
            ? hexToRgba(shapeObj.fillColor, shapeObj.fillOpacity)
            : 'transparent';
          
          const shapeProps = {
            ...commonProps,
            id: shapeObj.id,
            fill: fillVal,
            stroke: shapeObj.strokeWidth > 0 ? shapeObj.strokeColor : null,
            strokeWidth: shapeObj.strokeWidth > 0 ? shapeObj.strokeWidth : 0,
            strokeUniform: true,
            objectCaching: false
          };

          if (shapeObj.type === 'rect') {
            fabricObj = new fabric.Rect({
              ...shapeProps,
              width: shapeObj.width,
              height: shapeObj.height
            } as any);
          } else {
            fabricObj = new fabric.Ellipse({
              ...shapeProps,
              rx: Math.abs(shapeObj.width / 2),
              ry: Math.abs(shapeObj.height / 2)
            } as any);
          }
        } else if (obj.type === 'pen' || obj.type === 'highlighter') {
          const freehandObj = obj as FreehandObject;
          fabricObj = new fabric.Path(freehandObj.points as fabric.TComplexPathData, {
            ...commonProps,
            originX: 'center',
            originY: 'center',
            id: freehandObj.id,
            fill: '',
            stroke: freehandObj.strokeColor,
            strokeWidth: freehandObj.strokeWidth,
            opacity: freehandObj.opacity,
            strokeUniform: true,
            objectCaching: false,
            strokeLineCap: 'round',
            strokeLineJoin: 'round',
            scaleX: freehandObj.scaleX || 1,
            scaleY: freehandObj.scaleY || 1,
            globalCompositeOperation: freehandObj.type === 'highlighter' ? 'multiply' : 'source-over',
          } as any);
        } else if (obj.type === 'line') {
          const lineObj = obj as LineObject;
          const lineCommonProps = Object.fromEntries(
            Object.entries(commonProps).filter(([key]) => key !== 'left' && key !== 'top')
          ) as Omit<typeof commonProps, 'left' | 'top'>;
          fabricObj = new fabric.Line([lineObj.points[0], lineObj.points[1], lineObj.points[2], lineObj.points[3]], {
            ...lineCommonProps,
            id: lineObj.id,
            stroke: lineObj.strokeColor,
            strokeWidth: lineObj.strokeWidth,
            strokeUniform: true,
            objectCaching: false,
            fill: 'transparent',
            originX: 'center',
            originY: 'center',
            cornerSize: 12,
            transparentCorners: false,
            hasBorders: false,
          } as any);
          
          fabricObj.controls = {};
          const actionHandler = function(eventData: any, transform: any, x: number, y: number) {
            const target = transform.target;
            let newX = x;
            let newY = y;
            if (eventData.shiftKey) {
              const isP1 = transform.corner === 'p1';
              const m = target.calcTransformMatrix();
              const pts = target.calcLinePoints();
              const fixedPtLocal = isP1 ? new fabric.Point(pts.x2, pts.y2) : new fabric.Point(pts.x1, pts.y1);
              const fixedPt = fabric.util.transformPoint(fixedPtLocal, m);
              const dx = x - fixedPt.x;
              const dy = y - fixedPt.y;
              const angle = Math.atan2(dy, dx);
              const snappedAngle = Math.round(angle / SNAP_ANGLE_RADIANS) * SNAP_ANGLE_RADIANS;
              const dist = Math.sqrt(dx * dx + dy * dy);
              newX = fixedPt.x + Math.cos(snappedAngle) * dist;
              newY = fixedPt.y + Math.sin(snappedAngle) * dist;
            }
            if (transform.corner === 'p1') {
              target.set({ x1: newX, y1: newY });
            } else {
              target.set({ x2: newX, y2: newY });
            }
            return true;
          };
          const positionHandler = function(pointIndex: number) {
            return function(_dim: any, _finalMatrix: any, fabricObject: any) {
              const m = fabricObject.calcTransformMatrix();
              const pts = fabricObject.calcLinePoints();
              const pt = pointIndex === 1 ? new fabric.Point(pts.x1, pts.y1) : new fabric.Point(pts.x2, pts.y2);
              return fabric.util.transformPoint(pt, m);
            };
          };
          fabricObj.controls.p1 = new fabric.Control({
            positionHandler: positionHandler(1),
            actionHandler: actionHandler,
            cursorStyleHandler: () => 'crosshair',
            actionName: 'modifyLine'
          } as any);
          fabricObj.controls.p2 = new fabric.Control({
            positionHandler: positionHandler(2),
            actionHandler: actionHandler,
            cursorStyleHandler: () => 'crosshair',
            actionName: 'modifyLine'
          } as any);
        }

        if (fabricObj) {
          if (fabricObj.controls) {
            if (fabricObj.controls.tl) {
              fabricObj.controls.tl = Object.assign(Object.create(Object.getPrototypeOf(fabricObj.controls.tl)), fabricObj.controls.tl, { cursorStyle: 'nwse-resize' });
              delete (fabricObj.controls.tl as any).cursorStyleHandler;
            }
            if (fabricObj.controls.tr) {
              fabricObj.controls.tr = Object.assign(Object.create(Object.getPrototypeOf(fabricObj.controls.tr)), fabricObj.controls.tr, { cursorStyle: 'nesw-resize' });
              delete (fabricObj.controls.tr as any).cursorStyleHandler;
            }
            if (fabricObj.controls.bl) {
              fabricObj.controls.bl = Object.assign(Object.create(Object.getPrototypeOf(fabricObj.controls.bl)), fabricObj.controls.bl, { cursorStyle: 'nesw-resize' });
              delete (fabricObj.controls.bl as any).cursorStyleHandler;
            }
            if (fabricObj.controls.br) {
              fabricObj.controls.br = Object.assign(Object.create(Object.getPrototypeOf(fabricObj.controls.br)), fabricObj.controls.br, { cursorStyle: 'nwse-resize' });
              delete (fabricObj.controls.br as any).cursorStyleHandler;
            }
          }
          canvas.add(fabricObj);

          if (selectedObjectId === obj.id) {
            canvas.setActiveObject(fabricObj);
            if (obj.type === 'text' && (obj as TextObject).text === EMPTY_TEXT_SENTINEL) {
              fabricObj.enterEditing();
            }
          }
        }
      } else {
        const isActivelyDragging = (canvas as any)._currentTransform && (canvas as any)._currentTransform.target === fabricObj;
        const isInGroup = !!fabricObj.group;
        if (!isActivelyDragging && !isInGroup) {
          if (obj.type !== 'line') {
            fabricObj.set({
              left: commonProps.left,
              top: commonProps.top,
              angle: commonProps.angle,
            });
          } else {
            const lineObj = obj as LineObject;
            fabricObj.set({
              x1: lineObj.points[0],
              y1: lineObj.points[1],
              x2: lineObj.points[2],
              y2: lineObj.points[3],
              angle: commonProps.angle,
            });
          }
        }

        fabricObj.set({
          selectable: commonProps.selectable,
          evented: commonProps.evented,
          cornerSize: commonProps.cornerSize,
          touchCornerSize: commonProps.touchCornerSize,
          padding: commonProps.padding,
        });

        if (obj.type === 'text') {
          const textObj = obj as TextObject;
          const fontStyle = textObj.italic ? 'italic' : 'normal';
          const fontWeight = textObj.fontWeight ?? (textObj.bold ? 700 : 400);
          const presentation = getTextCanvasPresentation(textObj.text, textObj.color);
          fabricObj.set({
            text: presentation.text,
            width: textObj.width || DEFAULT_TEXT_WIDTH,
            charSpacing: normalizeLetterSpacing(textObj.letterSpacing),
            fontSize: textObj.fontSize,
            fontFamily: textObj.fontFamily,
            fill: presentation.fill,
            fontStyle: fontStyle as any,
            fontWeight,
            textAlign: textObj.textAlign || 'left',
          });
        } else if (obj.type === 'rect' || obj.type === 'circle') {
          const shapeObj = obj as ShapeObject;
          const fillVal = shapeObj.fillColor && shapeObj.fillOpacity > 0
            ? hexToRgba(shapeObj.fillColor, shapeObj.fillOpacity)
            : 'transparent';
          fabricObj.set({
            fill: fillVal,
            stroke: shapeObj.strokeWidth > 0 ? shapeObj.strokeColor : null,
            strokeWidth: shapeObj.strokeWidth > 0 ? shapeObj.strokeWidth : 0,
          });
          if (obj.type === 'rect') {
            fabricObj.set({ width: shapeObj.width, height: shapeObj.height });
          } else {
            fabricObj.set({ rx: Math.abs(shapeObj.width / 2), ry: Math.abs(shapeObj.height / 2) });
          }
        } else if (obj.type === 'pen' || obj.type === 'highlighter') {
          const freehandObj = obj as FreehandObject;
          fabricObj.set({
            stroke: freehandObj.strokeColor,
            strokeWidth: freehandObj.strokeWidth,
            opacity: freehandObj.opacity,
            scaleX: freehandObj.scaleX || 1,
            scaleY: freehandObj.scaleY || 1,
          });
        } else if (obj.type === 'line') {
          const lineObj = obj as LineObject;
          fabricObj.set({
            stroke: lineObj.strokeColor,
            strokeWidth: lineObj.strokeWidth,
          });
        }
      }
    });

    existingFabricObjects.forEach((fabObj, id) => {
      if (!currentReactObjectIds.has(id)) {
        canvas.remove(fabObj);
      }
    });

    if (selectedObjectId) {
      const targetObj = canvas.getObjects().find(o => (o as any).id === selectedObjectId);
      if (targetObj) {
         const activeObjects = canvas.getActiveObjects();
         if (!activeObjects.includes(targetObj)) {
            canvas.setActiveObject(targetObj);
         }
      }
    } else {
      if (canvas.getActiveObjects().length <= 1) {
         canvas.discardActiveObject();
      }
    }

    const activeObjectsForLayering = canvas.getActiveObjects();
    if (activeObjectsForLayering.length <= 1) {
      let currentIndex = 0;
      fabricObjects.forEach((obj) => {
        const fabricObj = existingFabricObjects.get(obj.id);
        if (fabricObj && !fabricObj.group) {
          canvas.moveObjectTo(fabricObj, currentIndex++);
        }
      });
    }

    canvas.renderOnAddRemove = true;
    
    canvas.requestRenderAll();
    
    if (fabricRefs) fabricRefs.current[page.index] = canvas;
    fabricRebuildingRef.current = false;
  }, [page.objects, selectedObjectId, activeTool]);
  

  return (
    <div
      className="pdf-page-editor-container"
      style={{
        position: 'relative',
        width: `${page.width}px`,
        height: `${page.height}px`,
        margin: '0 auto',
        background: '#ffffff',
        borderRadius: '6px',
        boxShadow: 'var(--canvas-page-shadow)',
        border: '1px solid var(--canvas-panel-border)',
      }}
    >
      {/* Background Image PDF Page */}
      <img 
        ref={backgroundImageRef}
        src={page.imageUrl} 
        alt={`Page ${page.index}`} 
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          zIndex: 1,
          pointerEvents: 'none'
        }}
      />

      {/* Fabric Canvas */}
      <div 
        style={{ 
          position: 'absolute', 
          top: 0, left: 0, 
          width: '100%', height: '100%', 
          zIndex: 2
        }}
      >
        <canvas ref={fabricContainerRef} />
      </div>

    </div>
  );
});

PageCanvas.displayName = 'PageCanvas';
