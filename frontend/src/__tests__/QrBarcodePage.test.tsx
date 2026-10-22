import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { generateQr, generateBarcode } = vi.hoisted(() => ({
  generateQr: vi.fn(),
  generateBarcode: vi.fn(),
}));

vi.mock('../api/qrBarcode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/qrBarcode')>();
  return { ...actual, generateQr, generateBarcode };
});

import { NativeCoreError } from '../api/nativeCore';
import { ToastProvider } from '../context/ToastContext';
import { QrBarcodePage } from '../pages/QrBarcodePage';

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
const svg = () => new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" />').buffer;

function renderPage() {
  return render(
    <ToastProvider>
      <QrBarcodePage />
    </ToastProvider>
  );
}

describe('QrBarcodePage', () => {
  beforeEach(() => {
    generateQr.mockReset();
    generateBarcode.mockReset();
    generateQr.mockResolvedValue(png());
    generateBarcode.mockResolvedValue(png());
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generates the preview once per content change instead of re-requesting in a loop', async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'hello world' } });

    await waitFor(() => expect(generateQr).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(generateQr).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hello world', size: 10, errorCorrection: 'M', format: 'png', border: 4 })
    );

    // A runaway regeneration loop would keep issuing requests after the
    // preview is committed, flickering the spinner and the download button.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(generateQr).toHaveBeenCalledTimes(1);

    expect(screen.getByAltText('Preview')).toHaveAttribute('src', 'blob:preview');
    expect(screen.queryByText('Generating...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save PNG/i })).toBeEnabled();
  }, 20000);

  it('replaces the preview once when the format changes and releases the old blob URL', async () => {
    let created = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:preview-${++created}`);
    generateQr.mockResolvedValueOnce(png()).mockResolvedValueOnce(svg());

    renderPage();

    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'hello' } });
    await waitFor(() => expect(generateQr).toHaveBeenCalledTimes(1), { timeout: 3000 });

    fireEvent.click(screen.getByRole('radio', { name: /^SVG/ }));
    await waitFor(() => expect(generateQr).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(generateQr).toHaveBeenLastCalledWith(expect.objectContaining({ format: 'svg' }));
    await waitFor(() => expect(screen.getByAltText('Preview')).toHaveAttribute('src', 'blob:preview-2'));

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(generateQr).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  }, 20000);

  it('sends the barcode type and content to the barcode command', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Barcode/ }));

    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Dokuwu-2026' } });
    await waitFor(() => expect(generateBarcode).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(generateBarcode).toHaveBeenCalledWith({ content: 'Dokuwu-2026', barcodeType: 'code128', format: 'png' });
    expect(generateQr).not.toHaveBeenCalled();
  }, 20000);

  it('tells the user why a barcode could not be made instead of staying blank', async () => {
    generateBarcode.mockRejectedValue(
      new NativeCoreError('invalid_input', 'invalid input: The following characters are not valid for Code 39: @')
    );
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Barcode/ }));
    fireEvent.click(screen.getByRole('radio', { name: /CODE 39/ }));

    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'a@b' } });

    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('Code 39 cannot contain: @');
    expect(screen.queryByAltText('Preview')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save PNG/i })).toBeDisabled();
  }, 20000);

  it('ignores an answer that arrives after the content changed', async () => {
    let finishFirst: (bytes: ArrayBuffer) => void = () => {};
    generateQr
      .mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(png());
    let created = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:preview-${++created}`);

    renderPage();
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'first' } });
    await waitFor(() => expect(generateQr).toHaveBeenCalledTimes(1), { timeout: 3000 });
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'second' } });
    await waitFor(() => expect(generateQr).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await waitFor(() => expect(screen.getByAltText('Preview')).toHaveAttribute('src', 'blob:preview-1'));

    finishFirst(png());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(created).toBe(1);
    expect(screen.getByAltText('Preview')).toHaveAttribute('src', 'blob:preview-1');
  }, 20000);
});
