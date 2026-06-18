import { useEffect, useState } from 'react';
import { FileSearch } from 'lucide-react';
import { PreviewCanvas } from './PreviewCanvas';
import { PreviewInfo } from './PreviewInfo';
import { PageNavigation } from './PageNavigation';
import { RotationControl } from './RotationControl';
import { ZoomControl } from './ZoomControl';

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
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);

  // Create object URL for imageFile
  useEffect(() => {
    if (imageFile) {
      const url = URL.createObjectURL(imageFile);
      setImgUrl(url);
      setDimensions(null); // Reset dimensions on new image
      return () => {
        URL.revokeObjectURL(url);
      };
    }
    setImgUrl(null);
  }, [imageFile]);

  // Reset dimensions on new PDF page
  useEffect(() => {
    if (pdfFile) {
      setDimensions(null);
    }
  }, [pdfFile, currentPage]);

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
          onFitToPage={() => onZoomChange(1.0)}
        />
      </div>
      
      <PreviewCanvas
        file={pdfFile || undefined}
        pageNumber={isPdf ? currentPage : undefined}
        imageUrl={imgUrl || undefined}
        imageRotation={rotation}
        flipH={flipH}
        zoom={zoom}
        onLoad={(w, h) => setDimensions({ w, h })}
        isHighlighted={isHighlighted}
      />
      
      <PreviewInfo
        filename={filename}
        currentPage={isPdf ? currentPage : undefined}
        totalPages={isPdf ? totalPages : undefined}
        width={dimensions?.w}
        height={dimensions?.h}
      />
      
    </div>
  );
}
