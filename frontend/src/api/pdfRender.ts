/**
 * Page previews and PDF facts from the native core (`ops::pdf_render`).
 *
 * A PDF is named by its path on disk; nothing is uploaded. The browser
 * `File` route to the Python sidecar still exists for pages that have not
 * moved to paths yet (see `fetchPagePreview`).
 */
import { invoke } from '@tauri-apps/api/core';
import axios from 'axios';
import apiClient from './client';
import { NativeCoreError, type CoreErrorCode } from './nativeCore';

export type PreviewQuality = 'low' | 'auto' | 'high';

/** A PDF to preview: a path (native core) or a browser file (Python sidecar). */
export type PdfSource = File | string;

export interface PdfMetadata {
  format: string;
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creationDate: string;
  modDate: string;
}

export interface PdfInfo {
  sizeBytes: number;
  /** 0 when the PDF is password protected. */
  pages: number;
  encrypted: boolean;
  metadata: PdfMetadata;
}

function asCoreError(err: unknown): unknown {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const { code, message } = err as { code: CoreErrorCode; message: string };
    return new NativeCoreError(code, message);
  }
  return err;
}

/** Page count, size, protection and metadata of a PDF on disk. */
export async function getPdfInfo(path: string): Promise<PdfInfo> {
  try {
    return await invoke<PdfInfo>('core_pdf_info', { path });
  } catch (err) {
    throw asCoreError(err);
  }
}

/** One page (1-based) as a PNG. */
export async function renderPdfPage(
  path: string,
  page: number,
  dpi: number,
  quality: PreviewQuality = 'auto',
): Promise<Blob> {
  try {
    const bytes = await invoke<ArrayBuffer>('core_pdf_render_page', { path, page, dpi, qualityHint: quality });
    return new Blob([bytes], { type: 'image/png' });
  } catch (err) {
    throw asCoreError(err);
  }
}

/** Stable text for "same PDF, same page", usable as a React key. */
export function previewKey(source: PdfSource, page: number): string {
  return typeof source === 'string'
    ? `${source}:${page}`
    : `${source.name}:${source.size}:${source.lastModified}:${page}`;
}

export const isAbort = (err: unknown): boolean =>
  axios.isCancel(err) || (err instanceof DOMException && err.name === 'AbortError');

/**
 * Loads the preview image of one page for either kind of source. A path goes
 * to the native core; a `File` is uploaded to the Python sidecar, as before.
 * Throws an abort error when `signal` fires first.
 */
export async function fetchPagePreview(
  source: PdfSource,
  options: { page: number; dpi: number; quality: PreviewQuality; signal: AbortSignal },
): Promise<Blob> {
  const { page, dpi, quality, signal } = options;
  if (typeof source === 'string') {
    if (signal.aborted) throw new DOMException('Preview request aborted', 'AbortError');
    const blob = await renderPdfPage(source, page, dpi, quality);
    if (signal.aborted) throw new DOMException('Preview request aborted', 'AbortError');
    return blob;
  }
  const form = new FormData();
  form.append('file', source, source.name || 'preview.pdf');
  form.append('page', String(page));
  form.append('dpi', String(dpi));
  form.append('quality_hint', quality);
  const res = await apiClient.post('/api/v1/preview/', form, { responseType: 'blob', signal });
  return new Blob([res.data], { type: 'image/png' });
}
