export const MIN_PREVIEW_ZOOM = 0.05;
export const MAX_PREVIEW_ZOOM = 3;
export const PREVIEW_PADDING = 32;

interface PreviewFitInput {
  sourceWidth: number;
  sourceHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  rotation?: 0 | 90 | 180 | 270;
}

export function calculatePreviewFitZoom({
  sourceWidth,
  sourceHeight,
  viewportWidth,
  viewportHeight,
  rotation = 0,
}: PreviewFitInput): number {
  if (sourceWidth <= 0 || sourceHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return 1;
  }

  const isQuarterTurn = rotation === 90 || rotation === 270;
  const displayedWidth = isQuarterTurn ? sourceHeight : sourceWidth;
  const displayedHeight = isQuarterTurn ? sourceWidth : sourceHeight;
  const availableWidth = Math.max(1, viewportWidth - PREVIEW_PADDING * 2);
  const availableHeight = Math.max(1, viewportHeight - PREVIEW_PADDING * 2);
  const fitZoom = Math.min(availableWidth / displayedWidth, availableHeight / displayedHeight);

  return Math.max(MIN_PREVIEW_ZOOM, Math.min(fitZoom, MAX_PREVIEW_ZOOM));
}
