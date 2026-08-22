import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileSearch } from 'lucide-react';
import { PreviewCanvas } from './PreviewCanvas';
import { PreviewInfo } from './PreviewInfo';
import { PageNavigation } from './PageNavigation';
import { RotationControl } from './RotationControl';
import { ZoomControl } from './ZoomControl';
import { calculatePreviewFitZoom } from '../../utils/previewZoom';

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
  const lastFittedPreviewRef = useRef<string | null>(null);

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

  const fitToPage = useCallback(() => {
    if (!currentDimensions || !viewport) return;

    onZoomChange(calculatePreviewFitZoom({
      sourceWidth: currentDimensions.w,
      sourceHeight: currentDimensions.h,
      viewportWidth: viewport.w,
      viewportHeight: viewport.h,
      rotation,
    }));
  }, [currentDimensions, onZoomChange, rotation, viewport]);

  const fitKey = `${previewSourceKey}:${rotation}`;
  useEffect(() => {
    if (!currentDimensions || !viewport || lastFittedPreviewRef.current === fitKey) return;

    fitToPage();
    lastFittedPreviewRef.current = fitKey;
  }, [currentDimensions, fitKey, fitToPage, viewport]);

  const handleViewportChange = useCallback((w: number, h: number) => {
    setViewport((previous) => previous?.w === w && previous.h === h ? previous : { w, h });
  }, []);

  if (!pdfFile && !imageFile) {
    return (
      <div className={`card ${className}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 400, color: 'var(--text-muted)' }}>
        <FileSearch size={48} style={{ marginBottom: 16, opacity: 0.5 }} />
        <span style={{ fontSize: 16, fontWeight: 500 }}>Select a file to preview</span>
      </div>
    );
  }

  const filename = pdfFile ? pdfFile.name : imageFile?.name || '';
  const isPdf = !!pdfFile;

  return (
    <div className={`card ${className}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
      {topSlot}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-container-high)', gap: 16 }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 16 }}>
          {isPdf && totalPages !== undefined && (
            <PageNavigation
              currentPage={currentPage}
              totalPages={totalPages}
              onChange={onPageChange}
            />
          )}
          {showRotation && onRotationChange && (
            <>
              <div style={{ width: 1, height: 24, background: 'var(--border)' }} />
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
          zoom={zoom}
          onChange={onZoomChange}
          onFitToPage={fitToPage}
        />
      </div>
      
      <PreviewCanvas
        file={pdfFile || undefined}
        pageNumber={isPdf ? currentPage : undefined}
        imageUrl={imgUrl || undefined}
        imageRotation={rotation}
        flipH={flipH}
        zoom={zoom}
        onLoad={(w, h) => setDimensions({ sourceKey: previewSourceKey, w, h })}
        onViewportChange={handleViewportChange}
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
