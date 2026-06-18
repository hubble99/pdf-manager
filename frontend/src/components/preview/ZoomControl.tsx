import { Minus, Plus, Maximize } from 'lucide-react';

export interface ZoomControlProps {
  zoom: number; // 0.25 - 3.0
  onChange: (zoom: number) => void;
  onFitToPage: () => void;
}

export function ZoomControl({ zoom, onChange, onFitToPage }: ZoomControlProps) {
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 3.0;

  const handleDecrease = () => {
    onChange(Math.max(MIN_ZOOM, zoom - 0.25));
  };

  const handleIncrease = () => {
    onChange(Math.min(MAX_ZOOM, zoom + 0.25));
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
        onChange={(e) => onChange(parseFloat(e.target.value))}
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
