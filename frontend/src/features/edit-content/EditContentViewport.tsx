import { useEffect, useRef } from 'react';
import { FileSearch, Loader2 } from 'lucide-react';
import { StateView } from '../../components/ui';
import type { NativePageDescriptor, NativeRender, NativeTextObjectDescriptor, Point } from './types';
import { selectionPolygon } from './workflow';
import { t } from '../../i18n';

interface EditContentViewportProps {
  page?: NativePageDescriptor;
  render: NativeRender | null;
  selected: NativeTextObjectDescriptor | null;
  zoom: number;
  loading: boolean;
  onPoint: (point: Point, viewportSize: Point) => void;
  /** Zoom at which the rendered page exactly fits the viewport width. */
  onFitZoom?: (fitZoom: number) => void;
}

export function EditContentViewport({
  page,
  render,
  selected,
  zoom,
  loading,
  onPoint,
  onFitZoom,
}: EditContentViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const renderWidth = render?.widthPx ?? 0;

  // Report the fit-to-width zoom so a narrow window never opens with a cropped page.
  useEffect(() => {
    const node = viewportRef.current;
    if (!node || !onFitZoom || renderWidth <= 0 || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const style = getComputedStyle(node);
      const inner = node.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
      if (inner > 0) onFitZoom(inner / renderWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [onFitZoom, renderWidth]);

  if (!page || !render) {
    return (
      <div className="edit-content-viewport edit-content-viewport--empty">
        <StateView
          icon={FileSearch}
          title={loading ? t('Rendering verified PDF…') : t('Open a PDF to begin')}
          description={t('Native text objects become selectable after the verified page render is ready.')}
        />
      </div>
    );
  }

  const width = render.widthPx * zoom;
  const height = render.heightPx * zoom;
  const polygon = selectionPolygon(selected, page, width, height);

  return (
    <div className="edit-content-viewport" aria-busy={loading} ref={viewportRef}>
      <div
        className="edit-content-document"
        data-testid="edit-content-page"
        style={{ width, height }}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top }, { x: width, y: height });
        }}
      >
        <img
          src={`data:${render.mimeType};base64,${render.dataBase64}`}
          alt={t('Native render of page {n}', { n: page.pageIndex + 1 })}
          draggable={false}
        />
        <svg className="edit-content-selection-layer" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {polygon && <polygon points={polygon} />}
        </svg>
      </div>
      {loading && (
        <div className="edit-content-rendering" role="status" aria-live="polite">
          <Loader2 size={16} aria-hidden="true" /> {t('Refreshing accepted checkpoint…')}
        </div>
      )}
    </div>
  );
}
