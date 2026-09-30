import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('../api/client', () => ({
  default: { post },
}));

import { ToastProvider } from '../context/ToastContext';
import { QrBarcodePage } from '../pages/QrBarcodePage';

function renderPage() {
  return render(
    <ToastProvider>
      <QrBarcodePage />
    </ToastProvider>
  );
}

describe('QrBarcodePage', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: new Blob(['png'], { type: 'image/png' }), headers: {} });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generates the preview once per content change instead of re-requesting in a loop', async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'hello world' } });

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(post).toHaveBeenCalledWith(
      '/api/v1/qr-barcode/qr',
      expect.objectContaining({ content: 'hello world' }),
      expect.anything()
    );

    // A runaway regeneration loop would keep issuing requests after the
    // preview is committed, flickering the spinner and the download button.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(post).toHaveBeenCalledTimes(1);

    expect(screen.getByAltText('Preview')).toHaveAttribute('src', 'blob:preview');
    expect(screen.queryByText('Generating...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download PNG/i })).toBeEnabled();
  }, 20000);

  it('replaces the preview once when the format changes and releases the old blob URL', async () => {
    let created = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:preview-${++created}`);
    post
      .mockResolvedValueOnce({ data: new Blob(['png'], { type: 'image/png' }), headers: {} })
      .mockResolvedValueOnce({ data: '<svg xmlns="http://www.w3.org/2000/svg" />', headers: {} });

    renderPage();

    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'hello' } });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1), { timeout: 3000 });

    fireEvent.click(screen.getByLabelText('SVG'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await waitFor(() => expect(screen.getByAltText('Preview')).toHaveAttribute('src', 'blob:preview-2'));

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(post).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  }, 20000);
});
