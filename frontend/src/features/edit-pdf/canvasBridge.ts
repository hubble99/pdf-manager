import type * as fabric from 'fabric';
import type {
  CanvasObject,
  DefaultShapeProps,
  DefaultStrokeProps,
  DefaultTextProps,
  EditorTool,
  PageData,
} from './model';

export interface CanvasBridgeState {
  activeTool: EditorTool;
  currentPage: PageData;
  defaultTextProps: DefaultTextProps;
  defaultShapeProps: DefaultShapeProps;
  defaultStrokeProps: DefaultStrokeProps;
  updateSelectedObject: (patch: Partial<CanvasObject>, overrideId?: string) => void;
  setSelectedObjectId: (id: string | null) => void;
  onSampleColor: (color: string) => void;
}

const bridgeByCanvas = new WeakMap<fabric.Canvas, CanvasBridgeState>();

export const CanvasBridge = {
  connect(canvas: fabric.Canvas, state: CanvasBridgeState): void {
    bridgeByCanvas.set(canvas, state);
  },

  update(canvas: fabric.Canvas, patch: Partial<CanvasBridgeState>): void {
    bridgeByCanvas.set(canvas, { ...this.get(canvas), ...patch });
  },

  get(canvas: fabric.Canvas): CanvasBridgeState {
    const state = bridgeByCanvas.get(canvas);
    if (!state) {
      throw new Error('Canvas bridge is not connected.');
    }
    return state;
  },

  disconnect(canvas: fabric.Canvas): void {
    bridgeByCanvas.delete(canvas);
  },
};