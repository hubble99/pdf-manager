import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { PreviewCanvas } from '../components/preview/PreviewCanvas';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('PreviewCanvas', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.stubGlobal('Image', class {
      naturalWidth = 595;
      naturalHeight = 842;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not commit a late response for a page that is no longer current', async () => {
    const pageOne = deferred<ArrayBuffer>();
    const pageTwo = deferred<ArrayBuffer>();
    invoke.mockReturnValueOnce(pageOne.promise).mockReturnValueOnce(pageTwo.promise);

    // The stale page is dropped before it gets an object URL.
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:page-two');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const file = 'C:\\docs\\two-pages.pdf';
    const { rerender, queryByAltText, queryByText } = render(
      <PreviewCanvas file={file} pageNumber={1} zoom={1} />,
    );

    rerender(<PreviewCanvas file={file} pageNumber={2} zoom={1} />);

    await act(async () => {
      pageOne.resolve(new ArrayBuffer(1));
      pageTwo.resolve(new ArrayBuffer(2));
    });

    await waitFor(() => {
      expect(queryByAltText('Preview')).toHaveAttribute('src', 'blob:page-two');
    });
    expect(queryByText('Preview unavailable')).not.toBeInTheDocument();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('keeps the committed page stage while the next page is loading', async () => {
    const pageOne = deferred<ArrayBuffer>();
    const pageTwo = deferred<ArrayBuffer>();
    invoke.mockReturnValueOnce(pageOne.promise).mockReturnValueOnce(pageTwo.promise);

    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:page-one')
      .mockReturnValueOnce('blob:page-two');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const file = 'C:\\docs\\two-pages.pdf';
    const { rerender, getByAltText, getByLabelText, queryByLabelText } = render(
      <PreviewCanvas file={file} pageNumber={1} zoom={1} />,
    );

    await act(async () => {
      pageOne.resolve(new ArrayBuffer(1));
    });
    await waitFor(() => expect(getByAltText('Preview')).toHaveAttribute('src', 'blob:page-one'));

    rerender(<PreviewCanvas file={file} pageNumber={2} zoom={1} />);
    expect(getByAltText('Preview')).toHaveAttribute('src', 'blob:page-one');
    expect(getByLabelText('Loading preview')).toBeInTheDocument();

    await act(async () => {
      pageTwo.resolve(new ArrayBuffer(2));
    });
    await waitFor(() => expect(getByAltText('Preview')).toHaveAttribute('src', 'blob:page-two'));
    expect(queryByLabelText('Loading preview')).not.toBeInTheDocument();
  });

  it('updates zoom without a CSS transition on the image or stage', () => {
    const { getByAltText, rerender } = render(
      <PreviewCanvas imageUrl="blob:image" zoom={1} />,
    );
    const image = getByAltText('Preview');
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 595 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 842 });
    fireEvent.load(image);

    rerender(<PreviewCanvas imageUrl="blob:image" zoom={1.5} />);
    expect(image.parentElement).toHaveStyle({ transition: '' });
    expect(image).toHaveStyle({ transition: '' });
  });
});
