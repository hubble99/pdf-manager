import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { decodeRenderedPage, fetchPagesMeta, readPdfFile, renderPage } from '../features/edit-canvas/pagesApi';
import { NativeCoreError } from '../api/nativeCore';

function frame(width: number, height: number, dpi: number, png: number[]): ArrayBuffer {
  const out = new Uint8Array(12 + png.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, dpi, true);
  out.set(png, 12);
  return out.buffer;
}

describe('Canvas page commands', () => {
  beforeEach(() => {
    invoke.mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:page');
  });

  it('reads the render message: size, dpi and the PNG', () => {
    const page = decodeRenderedPage(frame(1654, 2339, 200, [0x89, 0x50, 0x4e, 0x47]));
    expect(page).toEqual({ width: 1654, height: 2339, dpi: 200, url: 'blob:page' });
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(blob.size).toBe(4);
    expect(blob.type).toBe('image/png');
  });

  it('asks the core with the documented arguments', async () => {
    invoke.mockResolvedValueOnce({ total: 0, pages: [] });
    await fetchPagesMeta('C:\\a.pdf', 200);
    expect(invoke).toHaveBeenLastCalledWith('core_canvas_pages_meta', { path: 'C:\\a.pdf', dpi: 200 });

    invoke.mockResolvedValueOnce(frame(10, 20, 72, [1]));
    const page = await renderPage('C:\\a.pdf', 3, 300);
    expect(invoke).toHaveBeenLastCalledWith('core_canvas_render_page', { path: 'C:\\a.pdf', page: 3, dpi: 300 });
    expect(page.dpi).toBe(72);

    invoke.mockResolvedValueOnce(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer);
    const file = await readPdfFile('C:\\a.pdf', 'a.pdf');
    expect(file.name).toBe('a.pdf');
    expect(file.type).toBe('application/pdf');
    expect(file.size).toBe(4);
  });

  it('keeps the error codes of the core', async () => {
    invoke.mockRejectedValueOnce({ code: 'password_required', message: 'needs a password' });
    const error = await fetchPagesMeta('C:\\locked.pdf', 200).catch((e) => e);
    expect(error).toBeInstanceOf(NativeCoreError);
    expect(error.code).toBe('password_required');
  });
});
