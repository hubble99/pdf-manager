import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileSearch } from 'lucide-react';
import { PreviewCanvas } from './PreviewCanvas';
import { PreviewInfo } from './PreviewInfo';
import { PageNavigation } from './PageNavigation';
import { RotationControl } from './RotationControl';
import { ZoomControl } from './ZoomControl';
import { calculatePreviewFitZoom } from '../../utils/previewZoom';
import { StateView } from '../ui';

export interface PreviewPanelProps {
  pdfFile?: File | null;
  totalPages?: number;

  imageFile?: File | null;

  currentPage: number;
  onPageChange: (p: number) => void;
  zoom: number;
  onZoomChange: (z: number) => void;

  rotation?: 0 | 90 | 180 | 270;
  onRotationChange?: (r: 0 | 90 | 180 | 270) => void;
  showRotation?: boolean;
  flipH?: boolean;
  onFlipChange?: () => void;

  topSlot?: React.ReactNode;
  className?: string;
  isHighlighted?: boolean;
}

export function PreviewPanel({
  pdfFile,
  totalPages,
  imageFile,
  currentPage,
  onPageChange,
  zoom,
  onZoomChange,
  rotation = 0,
  onRotationChange,
  showRotation = false,
  flipH = false,
  onFlipChange,
  topSlot,
  className = '',
  isHighlighted = false,
}: PreviewPanelProps) {
  const previewSourceKey = pdfFile
    ? `pdf:${pdfFile.name}:${pdfFile.size}:${pdfFile.lastModified}:${currentPage}`
    : imageFile
      ? `image:${imageFile.name}:${imageFile.size}:${imageFile.lastModified}`
      : 'none';
  const [dimensions, setDimensions] = useState<{ sourceKey: string; w: number; h: number } | null>(null);
  const [viewport, setViewport] = useState<{ w: number; h: number } | null>(null);
  const [isFitMode, setIsFitMode] = useState(true);
  const [draftZoom, setDraftZoom] = useState<number | null>(null);
  const lastFitZoomRef = useRef<number | null>(null);

  const imgUrl = useMemo(
    () => imageFile ? URL.createObjectURL(imageFile) : null,
    [imageFile]
  );

  useEffect(() => {
    return () => {
      if (imgUrl) URL.revokeObjectURL(imgUrl);
    };
  }, [imgUrl]);

  const currentDimensions = dimensions?.sourceKey === previewSourceKey ? dimensions : null;
  const displayDimensions = currentDimensions && (rotation === 90 || rotation === 270)
    ? { w: currentDimensions.h, h: currentDimensions.w }
    : currentDimensions;

  const fitZoom = useMemo(() => {
    if (!currentDimensions || !viewport) return null;

    return calculatePreviewFitZoom({
      sourceWidth: currentDimensions.w,
      sourceHeight: currentDimensions.h,
      viewportWidth: viewport.w,
      viewportHeight: viewport.h,
      rotation,
    });
  }, [currentDimensions, rotation, viewport]);

  const fitToPage = useCallback(() => {
    if (fitZoom === null) return;

    lastFitZoomRef.current = fitZoom;
    setDraftZoom(null);
    setIsFitMode(true);
    onZoomChange(fitZoom);
  }, [fitZoom, onZoomChange]);

  useEffect(() => {
    if (!isFitMode || fitZoom === null || lastFitZoomRef.current === fitZoom) return;

    lastFitZoomRef.current = fitZoom;
    onZoomChange(fitZoom);
  }, [fitZoom, isFitMode, onZoomChange]);

  const handleViewportChange = useCallback((w: number, h: number) => {
    setViewport((previous) => previous?.w === w && previous.h === h ? previous : { w, h });
  }, []);

  const handleManualZoomChange = useCallback((nextZoom: number) => {
    setDraftZoom(nextZoom);
  }, []);

  const commitManualZoomChange = useCallback((nextZoom: number) => {
    lastFitZoomRef.current = null;
    setIsFitMode(false);
    setDraftZoom(null);
    onZoomChange(nextZoom);
  }, [onZoomChange]);

  const beginZoomInteraction = useCallback(() => {
    lastFitZoomRef.current = null;
    setIsFitMode(false);
  }, []);

  const liveZoom = draftZoom ?? (isFitMode && fitZoom !== null ? fitZoom : zoom);

  const handlePreviewLoad = useCallback((w: number, h: number) => {
    setDimensions({ sourceKey: previewSourceKey, w, h });
  }, [previewSourceKey]);

  if (!pdfFile && !imageFile) {
    return (
      <div className={`card preview-panel preview-panel--empty ${className}`}>
        <StateView
          icon={FileSearch}
          title="Select a file to preview"
          description="The document preview will use the available workspace here."
        />
      </div>
    );
  }

  const filename = pdfFile ? pdfFile.name : imageFile?.name || '';
  const isPdf = !!pdfFile;

  return (
    <div className={`card preview-panel ${className}`}>
      {topSlot}
      <div className="preview-toolbar">
        <div className="preview-toolbar-main">
          {isPdf && totalPages !== undefined && (
            <PageNavigation
              currentPage={currentPage}
              totalPages={totalPages}
              onChange={onPageChange}
            />
          )}
          {showRotation && onRotationChange && (
            <>
              <div className="preview-divider" />
              <RotationControl rotation={rotation} onChange={onRotationChange} />
              {onFlipChange && (
                <button
                  className="btn btn-ghost btn-sm btn-icon"
                  onClick={onFlipChange}
                  title="Flip Horizontal"
                  aria-label="Flip Horizontal"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20v-16M8 4L4 12l4 8M16 4l4 8-4 8"/></svg>
                </button>
              )}
            </>
          )}
        </div>
        
        <ZoomControl
          zoom={liveZoom}
          onChange={handleManualZoomChange}
          onCommit={commitManualZoomChange}
          onInteractionStart={beginZoomInteraction}
          onFitToPage={fitToPage}
        />
      </div>
      
      <PreviewCanvas
        file={pdfFile || undefined}
        pageNumber={isPdf ? currentPage : undefined}
        imageUrl={imgUrl || undefined}
        imageRotation={rotation}
        flipH={flipH}
        zoom={liveZoom}
        onLoad={handlePreviewLoad}
        onViewportChange={handleViewportChange}
        viewport={viewport}
        isHighlighted={isHighlighted}
      />
      
      <PreviewInfo
        filename={filename}
        currentPage={isPdf ? currentPage : undefined}
        totalPages={isPdf ? totalPages : undefined}
        width={displayDimensions?.w}
        height={displayDimensions?.h}
      />
      
    </div>
  );
}
