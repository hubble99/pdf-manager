import { useEffect, useMemo, useState, useRef } from 'react';
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
  viewport?: { w: number; h: number } | null;
  className?: string;
  isHighlighted?: boolean; // For extract pages
}

interface LoadedPdfPreview {
  sourceKey: string;
  url: string;
  w: number;
  h: number;
}

function loadImageDimensions(url: string, signal: AbortSignal): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException('Preview load aborted', 'AbortError'));
    };

    image.onload = () => {
      cleanup();
      resolve({ w: image.naturalWidth, h: image.naturalHeight });
    };
    image.onerror = () => {
      cleanup();
      reject(new Error('Failed to decode preview image'));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    image.src = url;
  });
}

export function PreviewCanvas({
  file,
  pageNumber = 1,
  imageUrl,
  imageRotation = 0,
  zoom,
  onLoad,
  onViewportChange,
  viewport,
  className = '',
  isHighlighted = false,
  flipH = false,
}: PreviewCanvasProps) {
  const [url, setUrl] = useState<string | null>(imageUrl || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [imageDimensions, setImageDimensions] = useState<{ sourceKey: string; w: number; h: number } | null>(null);
  const [loadedPdfPreview, setLoadedPdfPreview] = useState<LoadedPdfPreview | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const loadedPdfPreviewRef = useRef<LoadedPdfPreview | null>(null);
  const requestKey = file ? `${file.name}:${file.size}:${file.lastModified}:${pageNumber}` : null;
  const displayUrl = imageUrl || (file ? loadedPdfPreview?.url || url : null);
  const displayKey = imageUrl || loadedPdfPreview?.sourceKey || (file ? requestKey : null) || 'none';
  const displayLoading = Boolean(file) && !imageUrl && (!loadedPdfPreview || loading || loadedPdfPreview.sourceKey !== requestKey);
  const displayError = Boolean(file) && !imageUrl && error;

  useEffect(() => {
    loadedPdfPreviewRef.current = loadedPdfPreview;
  }, [loadedPdfPreview]);

  useEffect(() => () => {
    if (loadedPdfPreviewRef.current?.url) URL.revokeObjectURL(loadedPdfPreviewRef.current.url);
  }, []);

  useEffect(() => {
    if (imageUrl) {
      if (loadedPdfPreviewRef.current?.url) {
        URL.revokeObjectURL(loadedPdfPreviewRef.current.url);
        loadedPdfPreviewRef.current = null;
        setLoadedPdfPreview(null);
      }
      return;
    }

    // If we have a file, fetch preview
    if (file) {
      const abortController = new AbortController();
      let currentUrl: string | null = null;
      let isCurrent = true;
      
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
          if (!isCurrent || abortController.signal.aborted) {
            URL.revokeObjectURL(currentUrl);
            return;
          }
          const { w, h } = await loadImageDimensions(currentUrl, abortController.signal);
          if (!isCurrent || abortController.signal.aborted) {
            URL.revokeObjectURL(currentUrl);
            return;
          }

          const nextPreview: LoadedPdfPreview = { sourceKey: requestKey as string, url: currentUrl, w, h };
          const previousPreview = loadedPdfPreviewRef.current;
          loadedPdfPreviewRef.current = nextPreview;
          setLoadedPdfPreview(nextPreview);
          setUrl(currentUrl);
          setImageDimensions({ sourceKey: nextPreview.sourceKey, w, h });
          onLoad?.(w, h);
          currentUrl = null;
          if (previousPreview?.url && previousPreview.url !== nextPreview.url) {
            URL.revokeObjectURL(previousPreview.url);
          }
        } catch (err: unknown) {
          if (!isCurrent || abortController.signal.aborted || axios.isCancel(err)) return;
          console.error('Failed to load preview', err);
          setError(true);
        } finally {
          if (isCurrent && !abortController.signal.aborted) {
            setLoading(false);
          }
        }
      }

      loadPdfPreview();

      return () => {
        isCurrent = false;
        abortController.abort();
        if (currentUrl) URL.revokeObjectURL(currentUrl);
      };
    }
  }, [file, imageUrl, onLoad, pageNumber, requestKey]);

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
    const img = e.currentTarget;
    setImageDimensions({ sourceKey: displayKey, w: img.naturalWidth, h: img.naturalHeight });
    if (onLoad) {
      onLoad(img.naturalWidth, img.naturalHeight);
    }
  };

  const scaledStage = useMemo(() => {
    if (!imageDimensions || imageDimensions.sourceKey !== displayKey) return null;
    const isQuarterTurn = imageRotation === 90 || imageRotation === 270;
    const displayedWidth = isQuarterTurn ? imageDimensions.h : imageDimensions.w;
    const displayedHeight = isQuarterTurn ? imageDimensions.w : imageDimensions.h;
    return { w: displayedWidth * zoom, h: displayedHeight * zoom };
  }, [displayKey, imageDimensions, imageRotation, zoom]);
  const canCenterHorizontally = !scaledStage || !viewport || scaledStage.w <= viewport.w - 64;
  const canCenterVertically = !scaledStage || !viewport || scaledStage.h <= viewport.h - 64;
  const innerTransform = `translate(-50%, -50%) rotate(${imageRotation}deg) ${flipH ? 'scaleX(-1) ' : ''}scale(${zoom})`;

  return (
    <div
      className={`preview-canvas-container ${className}`}
      ref={containerRef}
      style={{
        flex: 1,
        overflow: 'auto',
        display: 'flex',
        alignItems: canCenterVertically ? 'center' : 'flex-start',
        justifyContent: canCenterHorizontally ? 'center' : 'flex-start',
        padding: '2rem',
        backgroundColor: 'var(--surface-container-lowest)',
        position: 'relative',
      }}
    >
      {!displayUrl && displayLoading ? (
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
            color: 'var(--on-surface-variant)'
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
            color: 'var(--on-surface-variant)',
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
            width: scaledStage?.w ?? 'auto',
            height: scaledStage?.h ?? 'auto',
            minWidth: scaledStage?.w ?? undefined,
            minHeight: scaledStage?.h ?? undefined,
            position: 'relative',
            flex: '0 0 auto',
          }}
        >
          <img
            key={displayKey}
            ref={imgRef}
            src={displayUrl}
            alt="Preview"
            onLoad={handleImageLoad}
            style={{
              display: 'block',
              maxWidth: 'none',
              position: scaledStage ? 'absolute' : 'static',
              left: scaledStage ? '50%' : undefined,
              top: scaledStage ? '50%' : undefined,
              transform: scaledStage ? innerTransform : 'none',
              transformOrigin: 'center center',
              boxShadow: isHighlighted ? '0 0 0 3px #4A9EFF' : '0 4px 12px rgba(0,0,0,0.5)',
              borderRadius: 2,
              backgroundColor: 'white', // ensure PDF page looks like paper
            }}
          />
          {displayLoading && (
            <div
              aria-label="Loading preview"
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'var(--surface-container-lowest)',
                color: 'var(--on-surface-variant)',
              }}
            >
              <Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
          )}
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
