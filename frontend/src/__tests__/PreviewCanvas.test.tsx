import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('../api/client', () => ({
  default: { post },
}));

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
    post.mockReset();
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
    const pageOne = deferred<{ data: Blob }>();
    const pageTwo = deferred<{ data: Blob }>();
    post.mockReturnValueOnce(pageOne.promise).mockReturnValueOnce(pageTwo.promise);

    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:page-one')
      .mockReturnValueOnce('blob:page-two');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const file = new File(['pdf'], 'two-pages.pdf', { type: 'application/pdf' });
    const { rerender, queryByAltText, queryByText } = render(
      <PreviewCanvas file={file} pageNumber={1} zoom={1} />,
    );

    rerender(<PreviewCanvas file={file} pageNumber={2} zoom={1} />);

    await act(async () => {
      pageOne.resolve({ data: new Blob(['page one']) });
      pageTwo.resolve({ data: new Blob(['page two']) });
    });

    await waitFor(() => {
      expect(queryByAltText('Preview')).toHaveAttribute('src', 'blob:page-two');
    });
    expect(queryByText('Preview unavailable')).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:page-one');
  });

  it('keeps the committed page stage while the next page is loading', async () => {
    const pageOne = deferred<{ data: Blob }>();
    const pageTwo = deferred<{ data: Blob }>();
    post.mockReturnValueOnce(pageOne.promise).mockReturnValueOnce(pageTwo.promise);

    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:page-one')
      .mockReturnValueOnce('blob:page-two');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const file = new File(['pdf'], 'two-pages.pdf', { type: 'application/pdf' });
    const { rerender, getByAltText, getByLabelText, queryByLabelText } = render(
      <PreviewCanvas file={file} pageNumber={1} zoom={1} />,
    );

    await act(async () => {
      pageOne.resolve({ data: new Blob(['page one']) });
    });
    await waitFor(() => expect(getByAltText('Preview')).toHaveAttribute('src', 'blob:page-one'));

    rerender(<PreviewCanvas file={file} pageNumber={2} zoom={1} />);
    expect(getByAltText('Preview')).toHaveAttribute('src', 'blob:page-one');
    expect(getByLabelText('Loading preview')).toBeInTheDocument();

    await act(async () => {
      pageTwo.resolve({ data: new Blob(['page two']) });
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
