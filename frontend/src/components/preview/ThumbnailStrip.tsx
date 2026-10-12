import { Check } from 'lucide-react';
import { PdfThumbnail } from '../PdfThumbnail';

export interface ThumbnailStripProps {
  file: File;
  totalPages: number;
  currentPage: number;
  selectedPages: Set<number>; // pages included in range
  onPageClick: (page: number) => void;
  onTogglePage: (page: number) => void;
  /** Disables membership editing while keeping preview navigation available. */
  selectionDisabled?: boolean;
}

export function ThumbnailStrip({
  file,
  totalPages,
  currentPage,
  selectedPages,
  onPageClick,
  onTogglePage,
  selectionDisabled = false,
}: ThumbnailStripProps) {
  return (
    <div className="thumbnail-strip">
      <div className="thumbnail-strip-title">Page Thumbnails</div>
      <div className="thumbnail-strip-track">
        {Array.from({ length: totalPages }).map((_, i) => {
          const page = i + 1;
          const isActive = page === currentPage;
          const isSelected = selectedPages.has(page);

          return (
            <div key={page} className="thumbnail-item">
              <button
                type="button"
                className={`thumbnail-nav${isActive ? ' thumbnail-nav--active' : ''}`}
                onClick={() => onPageClick(page)}
                aria-label={`Preview page ${page}`}
                aria-current={isActive ? 'page' : undefined}
              >
                {isSelected && <span className="thumbnail-overlay" aria-hidden="true" />}
                <PdfThumbnail file={file} page={page} dpi={36} className="thumbnail-image" />
                <span className="thumbnail-label" aria-hidden="true">Page {page}</span>
              </button>

              <label
                className={`thumbnail-select${isSelected ? ' thumbnail-select--checked' : ''}`}
                title={selectionDisabled
                  ? 'Switch to Selected pages to choose pages'
                  : isSelected ? `Remove page ${page} from the export` : `Include page ${page} in the export`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={selectionDisabled}
                  onChange={() => {
                    if (!selectionDisabled) onTogglePage(page);
                  }}
                  aria-label={`Include page ${page} in the export`}
                />
                {isSelected && <Check size={14} strokeWidth={3} aria-hidden="true" />}
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
