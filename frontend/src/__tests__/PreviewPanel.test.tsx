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

  it('re-fits while Fit mode is active when the preview viewport is resized', () => {
    const onZoomChange = vi.fn();
    render(
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
    expect(onZoomChange).toHaveBeenLastCalledWith(536 / 842);

    act(() => {
      (canvasProps?.onViewportChange as ((width: number, height: number) => void))(900, 700);
    });
    expect(onZoomChange).toHaveBeenLastCalledWith(636 / 842);
  });

  it('fits each page using its own dimensions in a mixed-size document', () => {
    const onZoomChange = vi.fn();
    const file = new File(['pdf'], 'mixed.pdf', { type: 'application/pdf' });
    const { rerender } = render(
      <PreviewPanel
        pdfFile={file}
        totalPages={2}
        currentPage={1}
        onPageChange={vi.fn()}
        zoom={1}
        onZoomChange={onZoomChange}
      />,
    );

    act(() => {
      (canvasProps?.onViewportChange as ((width: number, height: number) => void))(900, 700);
      (canvasProps?.onLoad as ((width: number, height: number) => void))(595, 842);
    });
    expect(onZoomChange).toHaveBeenLastCalledWith(636 / 842);

    rerender(
      <PreviewPanel
        pdfFile={file}
        totalPages={2}
        currentPage={2}
        onPageChange={vi.fn()}
        zoom={1}
        onZoomChange={onZoomChange}
      />,
    );
    act(() => {
      (canvasProps?.onLoad as ((width: number, height: number) => void))(842, 595);
    });
    expect(onZoomChange).toHaveBeenLastCalledWith(836 / 842);
  });

  it('keeps rapid slider updates local until the interaction commits', () => {
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

    const slider = getByRole('slider');
    fireEvent.change(slider, { target: { value: '1.1' } });
    fireEvent.change(slider, { target: { value: '1.2' } });

    expect(onZoomChange).not.toHaveBeenCalled();
    expect(canvasProps?.zoom).toBe(1.2);

    fireEvent.pointerUp(slider);
    expect(onZoomChange).toHaveBeenLastCalledWith(1.2);
  });
});
