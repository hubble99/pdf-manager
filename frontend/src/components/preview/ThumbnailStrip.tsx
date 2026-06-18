import { Check } from 'lucide-react';
import { PdfThumbnail } from '../PdfThumbnail';

export interface ThumbnailStripProps {
  file: File;
  totalPages: number;
  currentPage: number;
  selectedPages: Set<number>; // pages included in range
  onPageClick: (page: number) => void;
  onTogglePage: (page: number) => void;
}

export function ThumbnailStrip({
  file,
  totalPages,
  currentPage,
  selectedPages,
  onPageClick,
  onTogglePage,
}: ThumbnailStripProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderBottom: '1px solid var(--border)',
        backgroundColor: 'var(--surface-container)',
      }}
    >
      <div style={{ padding: '8px 16px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>
        Page Thumbnails
      </div>
      <div
        style={{
          display: 'flex',
          gap: 12,
          padding: '0 16px 16px 16px',
          overflowX: 'auto',
          alignItems: 'center',
        }}
      >
        {Array.from({ length: totalPages }).map((_, i) => {
          const page = i + 1;
          const isActive = page === currentPage;
          const isSelected = selectedPages.has(page);

          return (
            <div
              key={page}
              style={{
                position: 'relative',
                cursor: 'pointer',
                flexShrink: 0,
                width: 80,
                height: 110,
                borderRadius: 'var(--radius-sm)',
                border: isActive ? '2px solid var(--accent)' : '1px solid var(--border)',
                overflow: 'hidden',
                backgroundColor: 'var(--bg-inset)',
                transition: 'border-color 0.2s',
              }}
              onClick={() => onPageClick(page)}
            >
              {/* Checkbox overlay */}
              <div
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  border: isSelected ? 'none' : '1px solid var(--outline)',
                  backgroundColor: isSelected ? 'var(--accent)' : 'rgba(0,0,0,0.5)',
                  zIndex: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePage(page);
                }}
              >
                {isSelected && <Check size={14} strokeWidth={3} />}
              </div>
              
              {isSelected && (
                <div style={{
                  position: 'absolute', inset: 0, backgroundColor: 'rgba(74, 158, 255, 0.1)', zIndex: 5, pointerEvents: 'none'
                }} />
              )}

              <PdfThumbnail
                file={file}
                page={page}
                dpi={36} // smaller dpi for thumbnail
                style={{ width: '100%', height: '100%' }}
              />
              
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                backgroundColor: 'rgba(0,0,0,0.6)', color: 'white',
                fontSize: 10, padding: '2px 0', textAlign: 'center', zIndex: 10
              }}>
                Page {page}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
