/**
 * Organize through the native core (`ops::organize`).
 *
 * A file is named by its path on disk and added once; the core answers with a
 * handle that later calls use. Thumbnails come in bounded batches as one raw
 * binary message, and saving is a job that writes the new PDF to the Downloads
 * folder under a free name.
 */
import { invoke } from '@tauri-apps/api/core';
import { runCoreJob, toCoreError, type CoreJobOptions } from '../../api/nativeCore';
import type { SourceKind } from './types';

export interface OpenedDocument {
  documentId: string;
  name: string;
  kind: SourceKind;
  pageCount: number;
}

export interface Thumbnail {
  page: number;
  width: number;
  height: number;
  png: Uint8Array;
}

export interface ThumbnailBatch {
  start: number;
  total: number;
  pages: Thumbnail[];
}

export interface AssemblePagePayload {
  source: string;
  page: number;
  rotation: number;
  flip: boolean;
}

export interface AssembleReport {
  outputPath: string;
  outputSizeBytes: number;
  pages: number;
  durationMs: number;
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toCoreError(err);
  }
}

/** Adds one PDF or image; later calls reference the returned handle. */
export const openDocument = (path: string): Promise<OpenedDocument> => call('core_organize_open', { path });

/**
 * Reads the batch message of the core: little endian `start, total, count`,
 * then per page `page, width, height, length` and that many PNG bytes.
 */
export function decodeThumbnailBatch(buffer: ArrayBuffer): ThumbnailBatch {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const word = (offset: number) => view.getUint32(offset, true);
  const count = word(8);
  const pages: Thumbnail[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const length = word(offset + 12);
    pages.push({
      page: word(offset),
      width: word(offset + 4),
      height: word(offset + 8),
      png: bytes.slice(offset + 16, offset + 16 + length),
    });
    offset += 16 + length;
  }
  return { start: word(0), total: word(4), pages };
}

/** One bounded batch of thumbnails (page `start` onward) for a handle. */
export async function fetchThumbnails(
  documentId: string,
  start: number,
  count: number,
  width: number,
): Promise<ThumbnailBatch> {
  const buffer = await call<ArrayBuffer>('core_organize_thumbnails', { documentId, start, count, width });
  return decodeThumbnailBatch(buffer);
}

/** Forgets a file of the workspace; the file itself is left alone. */
export const releaseDocument = (documentId: string): Promise<boolean> =>
  call('core_organize_release', { documentId });

/** Builds one PDF from the page list in the Downloads folder. */
export const assembleDocument = (
  pages: AssemblePagePayload[],
  outputName: string,
  jobOptions?: CoreJobOptions,
): Promise<AssembleReport> =>
  runCoreJob<AssembleReport>(
    'core_organize_assemble_start',
    { pages, outputName: outputName.trim() || null },
    jobOptions,
  );

/** An object URL for a PNG; the caller revokes it. */
export function thumbnailUrl(png: Uint8Array): string {
  return URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
}

export function thumbnailKey(sourceId: string, page: number): string {
  return `${sourceId}:${page}`;
}
