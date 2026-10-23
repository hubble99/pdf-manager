import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, handlers } = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  }),
}));

import { decodeRenderedPage, fetchPagesMeta, renderPage, saveCanvas } from '../features/edit-canvas/pagesApi';
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
  });

  it('keeps the error codes of the core', async () => {
    invoke.mockRejectedValueOnce({ code: 'password_required', message: 'needs a password' });
    const error = await fetchPagesMeta('C:\\locked.pdf', 200).catch((e) => e);
    expect(error).toBeInstanceOf(NativeCoreError);
    expect(error.code).toBe('password_required');
  });

  it('saves by handing the annotations over as raw bytes, then starting the job', async () => {
    const report = { outputPath: 'C:\\Downloads\\Hasil.pdf', outputSizeBytes: 10, pages: 2, stampedPages: 1, durationMs: 5 };
    invoke.mockImplementation(async (command: string) => {
      if (command === 'core_canvas_stash_annotations') return 'C:\\Temp\\dokuwu-canvas-annotations\\x.json';
      if (command === 'core_canvas_save_start') {
        setTimeout(() => handlers.get('core://job-finished')?.({ payload: { jobId: 7, kind: 'canvas_save', status: 'succeeded', result: report } }), 0);
        return 7;
      }
      throw new Error(`unexpected ${command}`);
    });
    const annotations = ['', { canvas_width: 100, canvas_height: 100, native_objects: [] }];
    const result = await saveCanvas('C:\\a.pdf', annotations, '  Hasil ');
    expect(result).toEqual(report);

    const [stashCommand, bytes] = invoke.mock.calls[0];
    expect(stashCommand).toBe('core_canvas_stash_annotations');
    expect(ArrayBuffer.isView(bytes)).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(bytes as Uint8Array))).toEqual(annotations);
    expect(invoke).toHaveBeenLastCalledWith('core_canvas_save_start', {
      source: 'C:\\a.pdf',
      annotationsPath: 'C:\\Temp\\dokuwu-canvas-annotations\\x.json',
      outputName: 'Hasil',
    });
  });

  it('keeps the error codes of a failed hand-over', async () => {
    invoke.mockReset();
    invoke.mockRejectedValueOnce({ code: 'io', message: 'disk full' });
    const error = await saveCanvas('C:\\a.pdf', [''], 'x').catch((e) => e);
    expect(error).toBeInstanceOf(NativeCoreError);
    expect(error.code).toBe('io');
  });
});
