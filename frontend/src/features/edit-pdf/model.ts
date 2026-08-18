export type CanvasObjectType = 'pen' | 'highlighter' | 'text' | 'rect' | 'circle' | 'line';

export type EditorTool = 'select' | CanvasObjectType | 'eraser' | 'eyedropper';

export interface BaseCanvasObject {
  id: string;
  type: CanvasObjectType;
  x: number;
  y: number;
  angle?: number;
}

export interface FreehandObject extends BaseCanvasObject {
  type: 'pen' | 'highlighter';
  points: unknown[];
  strokeColor: string;
  strokeWidth: number;
  opacity: number;
  scaleX?: number;
  scaleY?: number;
  width?: number;
  height?: number;
}

export interface TextObject extends BaseCanvasObject {
  type: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  textAlign?: 'left' | 'center' | 'right';
  width: number | null;
  visible?: boolean;
  lineHeight?: number;
  lines?: string[];
  lineWidths?: number[];
}

export interface ShapeObject extends BaseCanvasObject {
  type: 'rect' | 'circle';
  width: number;
  height: number;
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeWidth: number;
}

export interface LineObject extends BaseCanvasObject {
  type: 'line';
  points: number[];
  strokeColor: string;
  strokeWidth: number;
}

export type CanvasObject = FreehandObject | TextObject | ShapeObject | LineObject;

export interface PageData {
  index: number;
  width: number;
  height: number;
  imageUrl: string;
  previewDpi?: number;
  objects: CanvasObject[];
  history: CanvasObject[][];
  historyIndex: number;
}

export interface DefaultTextProps {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  textAlign: 'left' | 'center' | 'right';
}

export interface DefaultShapeProps {
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeWidth: number;
}

export interface DefaultStrokeProps {
  strokeColor: string;
  strokeWidth: number;
}

export function generateCanvasObjectId(): string {
  return Math.random().toString(36).slice(2, 10);
}