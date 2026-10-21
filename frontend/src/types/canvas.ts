export type CanvasObjectType = 'pen' | 'highlighter' | 'text' | 'rect' | 'circle' | 'line' | 'image';

/** Object kinds that are placed by dragging or clicking with a tool. Images are inserted from a file instead. */
export type DrawingObjectType = Exclude<CanvasObjectType, 'image'>;

export type EditorTool = 'select' | DrawingObjectType | 'eraser' | 'eyedropper';

interface BaseCanvasObject {
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
  letterSpacing?: number;
  fontWeight?: number;
  /** Real face used to draw `fontWeight`; differs when the weight is synthesized. */
  fontFaceWeight?: number;
  /** Outline thickening (em) that synthesizes an in-between weight. */
  syntheticStrokeEm?: number;
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

export interface ImageObject extends BaseCanvasObject {
  type: 'image';
  /** Key into the page's image asset store; the image bytes are not kept in history snapshots. */
  assetId: string;
  /** Displayed size in canvas units. */
  width: number;
  height: number;
  /** 0 to 1. */
  opacity: number;
}

export interface CanvasImageAsset {
  /** Data URL of the original file. */
  src: string;
  element: HTMLImageElement;
  naturalWidth: number;
  naturalHeight: number;
}

export type CanvasObject = FreehandObject | TextObject | ShapeObject | LineObject | ImageObject;

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
  letterSpacing: number;
  fontWeight: number;
  fontFaceWeight?: number;
  syntheticStrokeEm?: number;
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
