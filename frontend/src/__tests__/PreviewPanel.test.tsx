import { act, fireEvent, render } from '@testing-library/react';
import { vi } from 'vitest';
import { PreviewPanel } from '../components/preview/PreviewPanel';

let canvasProps: Record<string, unknown> | undefined;

vi.mock('../components/preview/PreviewCanvas', () => ({
  PreviewCanvas: (props: Record<string, unknown>) => {
    canvasProps = props;
    return <div data-testid="preview-canvas" />;
  },
}));

describe('PreviewPanel', () => {
  it('fits the current preview to its available canvas area', () => {
    const onZoomChange = vi.fn();
    const { getByRole } = render(
      <PreviewPanel
        imageFile={new File(['image'], 'portrait.png', { type: 'image/png' })}
        currentPage={1}
        onPageChange={vi.fn()}
        zoom={1}
        onZoomChange={onZoomChange}
      />,
    );

    act(() => {
      (canvasProps?.onLoad as ((width: number, height: number) => void))(595, 842);
      (canvasProps?.onViewportChange as ((width: number, height: number) => void))(600, 600);
    });
    fireEvent.click(getByRole('button', { name: /fit/i }));

    expect(onZoomChange).toHaveBeenLastCalledWith(536 / 842);
  });
});
