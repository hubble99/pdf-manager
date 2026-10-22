import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
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
  onPick: (page: number, shift: boolean) => void;
}

function PageThumb({ file, page, selected, interactive, dpi, onPick }: PageThumbProps) {
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
      onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        onPick(page, event.shiftKey);
        // A mouse click leaves no focus ring behind: pressing Shift for a
        // range would otherwise turn it into a thick keyboard focus outline.
        if (event.detail > 0) event.currentTarget.blur();
      }}
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
  /**
   * Shift + click: every page from the last page clicked to this one, inclusive,
   * is set to what that last click did (selected or cleared). Without this the
   * grid treats a shift-click like a plain click.
   */
  onSelectRange?: (from: number, to: number, selected: boolean) => void;
  dpi?: number;
}

export function PageThumbGrid({
  file, totalPages, selected, interactive = true, onToggle, onSelectRange, dpi = 40,
}: PageThumbGridProps) {
  // The page a shift-click extends from, and whether that click selected it.
  const anchor = useRef<{ page: number; selected: boolean } | null>(null);
  useEffect(() => {
    anchor.current = null;
  }, [file, totalPages]);

  const pick = (page: number, shift: boolean) => {
    const from = anchor.current;
    if (shift && onSelectRange && from) {
      onSelectRange(Math.min(from.page, page), Math.max(from.page, page), from.selected);
      return;
    }
    anchor.current = { page, selected: !selected.has(page) };
    onToggle(page);
  };

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
          onPick={pick}
        />
      ))}
    </div>
  );
}
