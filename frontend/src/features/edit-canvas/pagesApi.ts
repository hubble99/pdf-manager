/**
 * Page images of the Canvas editor through the native core.
 *
 * The editor names a PDF by its path. `fetchPagesMeta` gives every page's size
 * at once (nothing is rendered); `renderPage` then gives one page as a PNG at
 * the dpi the zoom needs, as a raw binary reply. `saveCanvas` writes the edited
 * PDF.
 */
import { invoke } from '@tauri-apps/api/core';
import { runCoreJob, toCoreError, type CoreJobOptions } from '../../api/nativeCore';

export interface PageMeta {
  /** 0-based page index. */
  index: number;
  widthPt: number;
  heightPt: number;
  /** Pixel size of the page rendered at `dpi`. */
  width: number;
  height: number;
  dpi: number;
}

export interface PagesMeta {
  total: number;
  pages: PageMeta[];
}

export interface RenderedPage {
  width: number;
  height: number;
  dpi: number;
  /** An object URL of the PNG; the caller revokes it. */
  url: string;
}

/** A 1x1 transparent picture shown until the page's real image has arrived. */
export const BLANK_PAGE_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toCoreError(err);
  }
}

/** Sizes of all pages as rendered at `dpi`; refuses a protected PDF with `password_required`. */
export const fetchPagesMeta = (path: string, dpi: number): Promise<PagesMeta> =>
  call('core_canvas_pages_meta', { path, dpi });

/**
 * Reads the render message of the core: little endian `width, height, dpi`,
 * then the PNG bytes.
 */
export function decodeRenderedPage(buffer: ArrayBuffer): RenderedPage {
  const view = new DataView(buffer);
  const png = new Blob([buffer.slice(12)], { type: 'image/png' });
  return {
    width: view.getUint32(0, true),
    height: view.getUint32(4, true),
    dpi: view.getUint32(8, true),
    url: URL.createObjectURL(png),
  };
}

/** Renders `page` (1-based) at `dpi` (72 to 500; the core lowers it for huge pages). */
export async function renderPage(path: string, page: number, dpi: number): Promise<RenderedPage> {
  const buffer = await call<ArrayBuffer>('core_canvas_render_page', { path, page, dpi });
  return decodeRenderedPage(buffer);
}

export interface SaveReport {
  /** The saved PDF, in the Downloads folder. */
  outputPath: string;
  outputSizeBytes: number;
  pages: number;
  /** Pages that had annotations stamped onto them. */
  stampedPages: number;
  durationMs: number;
}

/**
 * Stamps the annotations (one entry per page, as the editor builds them) onto
 * the PDF at `path` and writes the result to the Downloads folder.
 *
 * The annotations can hold a lot of picture data, so they go over as one raw
 * message into a scratch file that the save job reads and deletes.
 */
export async function saveCanvas(
  path: string,
  annotations: unknown[],
  outputName: string,
  jobOptions?: CoreJobOptions,
): Promise<SaveReport> {
  const bytes = new TextEncoder().encode(JSON.stringify(annotations));
  let annotationsPath: string;
  try {
    annotationsPath = await invoke<string>('core_canvas_stash_annotations', bytes);
  } catch (err) {
    throw toCoreError(err);
  }
  return runCoreJob<SaveReport>(
    'core_canvas_save_start',
    { source: path, annotationsPath, outputName: outputName.trim() || null },
    jobOptions,
  );
}
