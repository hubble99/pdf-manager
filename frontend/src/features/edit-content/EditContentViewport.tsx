import { FileSearch, Loader2 } from 'lucide-react';
import { StateView } from '../../components/ui';
import type { NativePageDescriptor, NativeRender, NativeTextObjectDescriptor, Point } from './types';
import { selectionPolygon } from './workflow';

interface EditContentViewportProps {
  page?: NativePageDescriptor;
  render: NativeRender | null;
  selected: NativeTextObjectDescriptor | null;
  zoom: number;
  loading: boolean;
  onPoint: (point: Point, viewportSize: Point) => void;
}

export function EditContentViewport({
  page,
  render,
  selected,
  zoom,
  loading,
  onPoint,
}: EditContentViewportProps) {
  if (!page || !render) {
    return (
      <div className="edit-content-viewport edit-content-viewport--empty">
        <StateView
          icon={FileSearch}
          title={loading ? 'Rendering verified PDF…' : 'Open a PDF to begin'}
          description="Native text objects become selectable after the verified page render is ready."
        />
      </div>
    );
  }

  const width = render.widthPx * zoom;
  const height = render.heightPx * zoom;
  const polygon = selectionPolygon(selected, page, width, height);

  return (
    <div className="edit-content-viewport" aria-busy={loading}>
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
          alt={`Native render of page ${page.pageIndex + 1}`}
          draggable={false}
        />
        <svg className="edit-content-selection-layer" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {polygon && <polygon points={polygon} />}
        </svg>
      </div>
      {loading && (
        <div className="edit-content-rendering" role="status" aria-live="polite">
          <Loader2 size={16} aria-hidden="true" /> Refreshing accepted checkpoint…
        </div>
      )}
    </div>
  );
}
