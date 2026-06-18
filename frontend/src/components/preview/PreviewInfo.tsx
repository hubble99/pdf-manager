import { Filename } from '../Filename';

export interface PreviewInfoProps {
  filename: string;
  currentPage?: number; // undefined if not PDF
  totalPages?: number;
  width?: number; // pixel dimension
  height?: number;
}

export function PreviewInfo({
  filename,
  currentPage,
  totalPages,
  width,
  height,
}: PreviewInfoProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0, fontWeight: 500, fontSize: 14 }}>
        <Filename name={filename} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 13, color: 'var(--text-muted)' }}>
        {currentPage !== undefined && totalPages !== undefined && (
          <span>Page {currentPage}/{totalPages}</span>
        )}
        {width !== undefined && height !== undefined && (
          <span>{width}×{height}px</span>
        )}
      </div>
    </div>
  );
}
