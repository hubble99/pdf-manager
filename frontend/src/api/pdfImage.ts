/**
 * PDF to image and image to PDF through the native core
 * (`ops::pdf_to_image`, `ops::image_to_pdf`).
 *
 * Inputs are paths on disk; the result is saved in the Downloads folder under
 * a free name. Progress counts finished pages (stage `pages`) or images
 * (stage `images`).
 */
import { invoke } from '@tauri-apps/api/core';
import { NativeCoreError, runCoreJob, type CoreErrorCode, type CoreJobOptions } from './nativeCore';

export type PdfImageFormat = 'png' | 'jpeg' | 'webp';

export interface PdfToImageReport {
  outputPath: string;
  outputSizeBytes: number;
  pages: number;
  /** Several pages are packed in a ZIP; one page is a plain image file. */
  isZip: boolean;
  format: PdfImageFormat;
  dpi: number;
  /** 1-based pages rendered at a lower dpi than asked for (very large sheets). */
  reducedPages: number[];
  durationMs: number;
}

export interface PdfToImageOptions {
  format: PdfImageFormat;
  dpi: number;
  /** `1-3,5`; empty means every page. */
  pageRanges: string;
  /** File name without extension; empty means the PDF's name. */
  outputName?: string;
}

export interface ImageToPdfItem {
  path: string;
  /** Clockwise quarter turns in degrees. */
  rotation: number;
  flipH: boolean;
}

export interface SkippedImage {
  source: string;
  error: { code: CoreErrorCode; message: string };
}

export interface ImageToPdfReport {
  outputPath: string;
  outputSizeBytes: number;
  pages: number;
  pageSize: string;
  /** Images that could not be read; the PDF was made without them. */
  skipped: SkippedImage[];
  durationMs: number;
}

export const exportPdfImages = (
  inputPath: string,
  options: PdfToImageOptions,
  jobOptions?: CoreJobOptions,
): Promise<PdfToImageReport> =>
  runCoreJob<PdfToImageReport>(
    'core_pdf_to_image_start',
    { inputPath, options: { ...options, outputName: options.outputName?.trim() || null } },
    jobOptions,
  );

export const imagesToPdf = (
  images: ImageToPdfItem[],
  pageSize: string,
  outputName?: string,
  jobOptions?: CoreJobOptions,
): Promise<ImageToPdfReport> =>
  runCoreJob<ImageToPdfReport>(
    'core_image_to_pdf_start',
    { images, pageSize, outputName: outputName?.trim() || null },
    jobOptions,
  );

/** A small JPEG preview of a picture file, turned the way the PDF page will show it. */
export async function imageThumbnail(path: string, size = 192): Promise<Blob> {
  try {
    const bytes = await invoke<ArrayBuffer>('core_image_thumbnail', { path, size });
    return new Blob([bytes], { type: 'image/jpeg' });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
      const { code, message } = err as { code: CoreErrorCode; message: string };
      throw new NativeCoreError(code, message);
    }
    throw err;
  }
}
