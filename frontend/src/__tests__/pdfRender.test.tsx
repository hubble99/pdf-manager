import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { NativeCoreError } from '../api/nativeCore';
import { fetchPagePreview, getPdfInfo, isAbort, previewKey, renderPdfPage } from '../api/pdfRender';
import { PreviewCanvas } from '../components/preview/PreviewCanvas';

describe('native PDF render client', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it('asks the core for a page and wraps the bytes as a PNG blob', async () => {
    mocks.invoke.mockResolvedValue(new Uint8Array([137, 80, 78, 71]).buffer);
    const blob = await renderPdfPage('C:\\docs\\a.pdf', 3, 72, 'low');
    expect(mocks.invoke).toHaveBeenCalledWith('core_pdf_render_page', {
      path: 'C:\\docs\\a.pdf', page: 3, dpi: 72, qualityHint: 'low',
    });
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(4);
  });

  it('turns a core error into a NativeCoreError', async () => {
    mocks.invoke.mockRejectedValue({ code: 'password_required', message: 'protected' });
    await expect(getPdfInfo('C:\\a.pdf')).rejects.toMatchObject({ code: 'password_required' });
    await expect(getPdfInfo('C:\\a.pdf')).rejects.toBeInstanceOf(NativeCoreError);
  });

  it('reads PDF info from the core', async () => {
    const info = { sizeBytes: 10, pages: 2, encrypted: false, metadata: {} };
    mocks.invoke.mockResolvedValue(info);
    expect(await getPdfInfo('C:\\a.pdf')).toEqual(info);
    expect(mocks.invoke).toHaveBeenCalledWith('core_pdf_info', { path: 'C:\\a.pdf' });
  });

  it('sends the path to the core', async () => {
    mocks.invoke.mockResolvedValue(new ArrayBuffer(2));
    const signal = new AbortController().signal;
    await fetchPagePreview('C:\\a.pdf', { page: 1, dpi: 40, quality: 'low', signal });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('does not ask the core when already aborted, and drops a late answer', async () => {
    const early = new AbortController();
    early.abort();
    await expect(fetchPagePreview('C:\\a.pdf', { page: 1, dpi: 40, quality: 'low', signal: early.signal }))
      .rejects.toSatisfy(isAbort);
    expect(mocks.invoke).not.toHaveBeenCalled();

    const late = new AbortController();
    mocks.invoke.mockImplementation(async () => {
      late.abort();
      return new ArrayBuffer(1);
    });
    await expect(fetchPagePreview('C:\\a.pdf', { page: 1, dpi: 40, quality: 'low', signal: late.signal }))
      .rejects.toSatisfy(isAbort);
  });

  it('keys a path by page', () => {
    expect(previewKey('C:\\a.pdf', 2)).toBe('C:\\a.pdf:2');
  });
});

describe('PreviewCanvas with a path', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    vi.stubGlobal('Image', class {
      naturalWidth = 595;
      naturalHeight = 842;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:native-page');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a page rendered by the core', async () => {
    mocks.invoke.mockResolvedValue(new ArrayBuffer(8));
    const { container } = render(<PreviewCanvas file="C:\docs\a.pdf" pageNumber={2} zoom={1} />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(mocks.invoke).toHaveBeenCalledWith('core_pdf_render_page', {
      path: 'C:\\docs\\a.pdf', page: 2, dpi: 72, qualityHint: 'auto',
    });
  });
});
