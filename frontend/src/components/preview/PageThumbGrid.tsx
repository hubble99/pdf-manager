import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { fetchPagePreview, isAbort, type PdfSource } from '../../api/pdfRender';
import { t } from '../../i18n';

/**
 * A grid of page thumbnails the user can pick from.
 *
 * Every cell fetches its own low-resolution preview, but only once it scrolls
 * into view, and at most a few requests run at a time. A long document therefore
 * costs a handful of requests instead of one per page up front.
 */

const MAX_CONCURRENT = 4;
let active = 0;
const waiting: Array<() => void> = [];

function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      active += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          waiting.shift()?.();
        });
    };
    if (active < MAX_CONCURRENT) run();
    else waiting.push(run);
  });
}

interface PageThumbProps {
  file: PdfSource;
  page: number;
  selected: boolean;
  interactive: boolean;
  dpi: number;
  onToggle: (page: number) => void;
}

function PageThumb({ file, page, selected, interactive, dpi, onToggle }: PageThumbProps) {
  const holder = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (visible) return undefined;
    const node = holder.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const controller = new AbortController();
    let created: string | null = null;
    void limited(async () => {
      if (controller.signal.aborted) return;
      try {
        const blob = await fetchPagePreview(file, { page, dpi, quality: 'low', signal: controller.signal });
        if (controller.signal.aborted) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      } catch (error) {
        if (!isAbort(error)) console.error('Failed to load page thumbnail', error);
      }
    });
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [visible, file, page, dpi]);

  return (
    <button
      ref={holder}
      type="button"
      className={`thumb${selected ? ' active' : ''}${interactive ? '' : ' thumb--fixed'}`}
      aria-pressed={interactive ? selected : undefined}
      aria-label={selected ? t('Page {n}, selected', { n: page }) : t('Page {n}', { n: page })}
      disabled={!interactive}
      onClick={() => onToggle(page)}
    >
      <span className={`thumb-page${url ? ' has-image' : ''}`}>
        {url && <img src={url} alt="" draggable={false} />}
        <span className="thumb-check" aria-hidden="true"><Check size={11} strokeWidth={3} /></span>
      </span>
      <span className="thumb-label">{page}</span>
    </button>
  );
}

export interface PageThumbGridProps {
  file: PdfSource;
  totalPages: number;
  selected: ReadonlySet<number>;
  /** When false the grid only displays the selection (it cannot be edited). */
  interactive?: boolean;
  onToggle: (page: number) => void;
  dpi?: number;
}

export function PageThumbGrid({
  file, totalPages, selected, interactive = true, onToggle, dpi = 40,
}: PageThumbGridProps) {
  return (
    <div className="thumb-grid" role="group" aria-label={t('Pages')}>
      {Array.from({ length: totalPages }, (_, index) => index + 1).map((page) => (
        <PageThumb
          key={page}
          file={file}
          page={page}
          selected={selected.has(page)}
          interactive={interactive}
          dpi={dpi}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}
