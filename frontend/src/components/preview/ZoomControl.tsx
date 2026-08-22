import { useEffect, useRef } from 'react';
import { Minus, Plus, Maximize } from 'lucide-react';
import { MAX_PREVIEW_ZOOM, MIN_PREVIEW_ZOOM } from '../../utils/previewZoom';

export interface ZoomControlProps {
  zoom: number; // 0.05 - 3.0
  onChange: (zoom: number) => void;
  onCommit?: (zoom: number) => void;
  onInteractionStart?: () => void;
  onFitToPage: () => void;
}

export function ZoomControl({ zoom, onChange, onCommit = onChange, onInteractionStart, onFitToPage }: ZoomControlProps) {
  const MIN_ZOOM = MIN_PREVIEW_ZOOM;
  const MAX_ZOOM = MAX_PREVIEW_ZOOM;
  const pendingZoomRef = useRef(zoom);

  useEffect(() => {
    pendingZoomRef.current = zoom;
  }, [zoom]);

  const previewZoom = (nextZoom: number) => {
    pendingZoomRef.current = nextZoom;
    onInteractionStart?.();
    onChange(nextZoom);
  };

  const commitZoom = () => {
    onCommit(pendingZoomRef.current);
  };

  const handleDecrease = () => {
    const nextZoom = Math.max(MIN_ZOOM, zoom - 0.25);
    pendingZoomRef.current = nextZoom;
    onCommit(nextZoom);
  };

  const handleIncrease = () => {
    const nextZoom = Math.min(MAX_ZOOM, zoom + 0.25);
    pendingZoomRef.current = nextZoom;
    onCommit(nextZoom);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
      <button
        className="btn btn-ghost btn-icon btn-sm"
        onClick={handleDecrease}
        disabled={zoom <= MIN_ZOOM}
      >
        <Minus size={16} />
      </button>
      <input
        type="range"
        min={MIN_ZOOM}
        max={MAX_ZOOM}
        step={0.05}
        value={zoom}
        onPointerDown={onInteractionStart}
        onPointerUp={commitZoom}
        onKeyDown={onInteractionStart}
        onKeyUp={commitZoom}
        onBlur={commitZoom}
        onChange={(e) => previewZoom(parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: 'var(--accent)' }}
      />
      <button
        className="btn btn-ghost btn-icon btn-sm"
        onClick={handleIncrease}
        disabled={zoom >= MAX_ZOOM}
      >
        <Plus size={16} />
      </button>
      <div style={{ width: 40, textAlign: 'right', fontSize: 13, fontWeight: 500 }}>
        {Math.round(zoom * 100)}%
      </div>
      <button
        className="btn btn-secondary btn-sm"
        onClick={onFitToPage}
        style={{ marginLeft: 8 }}
      >
        <Maximize size={14} style={{ marginRight: 6 }} />
        Fit
      </button>
    </div>
  );
}
