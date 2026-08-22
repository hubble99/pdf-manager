import { useEffect, useState, useRef } from 'react';
import { FileX, Loader2 } from 'lucide-react';
import axios from 'axios';
import apiClient from '../../api/client';

export interface PreviewCanvasProps {
  file?: File;
  pageNumber?: number; // 1-indexed
  imageUrl?: string; // object URL
  imageRotation?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  zoom: number; // 0.25 - 3.0 (1.0 = 100%)
  onLoad?: (width: number, height: number) => void;
  onViewportChange?: (width: number, height: number) => void;
  className?: string;
  isHighlighted?: boolean; // For extract pages
}

export function PreviewCanvas({
  file,
  pageNumber = 1,
  imageUrl,
  imageRotation = 0,
  zoom,
  onLoad,
  onViewportChange,
  className = '',
  isHighlighted = false,
  flipH = false,
}: PreviewCanvasProps) {
  const [url, setUrl] = useState<string | null>(imageUrl || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const displayUrl = imageUrl || (file ? url : null);
  const displayLoading = Boolean(file) && !imageUrl && loading;
  const displayError = Boolean(file) && !imageUrl && error;

  useEffect(() => {
    if (imageUrl) return;

    // If we have a file, fetch preview
    if (file) {
      const abortController = new AbortController();
      let currentUrl: string | null = null;
      
      const isLargeFile = file.size > 50 * 1024 * 1024; // >50MB
      const qualityHint = isLargeFile ? 'low' : 'auto';

      async function loadPdfPreview() {
        setLoading(true);
        setError(false);
        try {
          const form = new FormData();
          form.append('file', file as Blob, file!.name || 'preview.pdf');
          form.append('page', String(pageNumber));
          form.append('dpi', '72'); // ≈ 600px width for A4
          form.append('quality_hint', qualityHint);

          const res = await apiClient.post('/api/v1/preview/', form, {
            responseType: 'blob',
            signal: abortController.signal
          });
          
          const blob = new Blob([res.data], { type: 'image/png' });
          currentUrl = URL.createObjectURL(blob);
          setUrl(currentUrl);
        } catch (err: unknown) {
          if (axios.isCancel(err)) return;
          console.error('Failed to load preview', err);
          setError(true);
        } finally {
          if (!abortController.signal.aborted) {
            setLoading(false);
          }
        }
      }

      loadPdfPreview();

      return () => {
        abortController.abort();
        if (currentUrl) URL.revokeObjectURL(currentUrl);
      };
    }
  }, [file, pageNumber, imageUrl]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onViewportChange) return;

    const reportViewport = () => onViewportChange(container.clientWidth, container.clientHeight);
    reportViewport();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', reportViewport);
      return () => window.removeEventListener('resize', reportViewport);
    }

    const observer = new ResizeObserver(reportViewport);
    observer.observe(container);
    return () => observer.disconnect();
  }, [onViewportChange]);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (onLoad) {
      const img = e.currentTarget;
      onLoad(img.naturalWidth, img.naturalHeight);
    }
  };

  const outerTransform = `scale(${zoom})`;
  const innerTransform = `rotate(${imageRotation}deg) ${flipH ? 'scaleX(-1)' : ''}`;

  return (
    <div
      className={`preview-canvas-container ${className}`}
      ref={containerRef}
      style={{
        flex: 1,
        overflow: 'auto',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '2rem',
        backgroundColor: 'var(--bg-inset, #111)',
        position: 'relative',
      }}
    >
      {displayLoading ? (
        <div
          className="preview-skeleton"
          style={{
            width: 600,
            height: 800,
            backgroundColor: 'var(--surface-dim)',
            animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)'
          }}
        >
          {file && file.size > 50 * 1024 * 1024 ? (
            <div style={{ textAlign: 'center' }}>
              <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
              <p style={{ fontWeight: 500 }}>Large file detected</p>
              <p style={{ fontSize: 13, opacity: 0.7 }}>Rendering preview may take longer...</p>
            </div>
          ) : null}
        </div>
      ) : displayError || !displayUrl ? (
        <div
          style={{
            width: 600,
            height: 800,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            backgroundColor: 'var(--surface-dim)',
            borderRadius: 4,
          }}
        >
          <FileX size={48} style={{ marginBottom: 16, opacity: 0.5 }} />
          <span>Preview unavailable</span>
        </div>
      ) : (
        <div
          style={{
            transform: outerTransform,
            transformOrigin: 'top center',
            transition: 'transform 0.2s ease-out',
            // To ensure the parent container scrollbars behave correctly with scaling
          }}
        >
          <img
            ref={imgRef}
            src={displayUrl}
            alt="Preview"
            onLoad={handleImageLoad}
            style={{
              display: 'block',
              maxWidth: 'none',
              transform: innerTransform,
              transformOrigin: 'center center',
              transition: 'transform 0.2s ease-out',
              boxShadow: isHighlighted ? '0 0 0 3px #4A9EFF' : '0 4px 12px rgba(0,0,0,0.5)',
              borderRadius: 2,
              backgroundColor: 'white', // ensure PDF page looks like paper
            }}
          />
        </div>
      )}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: .5; }
        }
      `}</style>
    </div>
  );
}
