import { RotateCcw, RotateCw } from 'lucide-react';

export interface RotationControlProps {
  rotation: 0 | 90 | 180 | 270;
  onChange: (r: 0 | 90 | 180 | 270) => void;
}

export function RotationControl({ rotation, onChange }: RotationControlProps) {
  const handleRotateLeft = () => {
    onChange(((rotation - 90 + 360) % 360) as 0 | 90 | 180 | 270);
  };

  const handleRotateRight = () => {
    onChange(((rotation + 90) % 360) as 0 | 90 | 180 | 270);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px', borderBottom: '1px solid var(--border)', justifyContent: 'center' }}>
      <button className="btn btn-secondary btn-sm" onClick={handleRotateLeft}>
        <RotateCcw size={14} style={{ marginRight: 6 }} />
        90°
      </button>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        Current: <span style={{ fontWeight: 500, color: 'var(--text)' }}>{rotation}°</span>
      </div>
      <button className="btn btn-secondary btn-sm" onClick={handleRotateRight}>
        90°
        <RotateCw size={14} style={{ marginLeft: 6 }} />
      </button>
    </div>
  );
}
