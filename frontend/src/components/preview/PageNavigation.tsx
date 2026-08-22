import { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface PageNavigationProps {
  currentPage: number; // 1-indexed
  totalPages: number;
  onChange: (page: number) => void;
  disabled?: boolean;
}

export function PageNavigation({
  currentPage,
  totalPages,
  onChange,
  disabled = false,
}: PageNavigationProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePrev = () => {
    if (currentPage > 1 && !disabled) {
      onChange(currentPage - 1);
    }
  };

  const handleNext = () => {
    if (currentPage < totalPages && !disabled) {
      onChange(currentPage + 1);
    }
  };

  const commitValue = () => {
    const val = parseInt(inputRef.current?.value ?? '', 10);
    if (!isNaN(val) && val >= 1 && val <= totalPages) {
      onChange(val);
    } else if (inputRef.current) {
      inputRef.current.value = String(currentPage);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitValue();
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', padding: '12px 0' }}>
      <button
        className="btn btn-ghost btn-icon btn-sm"
        onClick={handlePrev}
        disabled={currentPage <= 1 || disabled}
      >
        <ChevronLeft size={16} />
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
        <span className="text-muted">Page:</span>
        <input
          key={currentPage}
          ref={inputRef}
          type="text"
          defaultValue={currentPage}
          onBlur={commitValue}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          className="input"
          style={{ width: 48, textAlign: 'center', padding: '4px' }}
        />
        <span className="text-muted">/ {totalPages}</span>
      </div>
      <button
        className="btn btn-ghost btn-icon btn-sm"
        onClick={handleNext}
        disabled={currentPage >= totalPages || disabled}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
