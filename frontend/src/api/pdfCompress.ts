/**
 * Compress PDF through the native core (`ops::pdf_compress`).
 *
 * The result is saved in the Downloads folder. Progress arrives with stage
 * `scanning`, `images` (done/total pictures) and `saving`.
 */
import { invoke } from '@tauri-apps/api/core';
import { NativeCoreError, runCoreJob, type CoreErrorCode, type CoreJobOptions } from './nativeCore';

export const MIN_COMPRESS_QUALITY = 10;
export const MAX_COMPRESS_QUALITY = 95;

export interface PdfProbe {
  sizeBytes: number;
  pages: number;
  /** Encrypted with an open or an owner password; the core refuses these. */
  encrypted: boolean;
}

export interface PdfCompressReport {
  outputPath: string;
  sizeBefore: number;
  sizeAfter: number;
  /** 0 when the file could not be made smaller. */
  reductionPct: number;
  pages: number;
  /** Pictures that could be re-encoded. */
  imagesFound: number;
  /** Pictures replaced by a smaller JPEG. */
  imagesRecompressed: number;
  /** True when nothing got smaller and the original was copied as it was. */
  keptOriginal: boolean;
  durationMs: number;
}

/** Size, page count and protection of a PDF on disk. */
export async function probePdf(path: string): Promise<PdfProbe> {
  try {
    return await invoke<PdfProbe>('core_pdf_probe', { path });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
      const { code, message } = err as { code: CoreErrorCode; message: string };
      throw new NativeCoreError(code, message);
    }
    throw err;
  }
}

/**
 * Compresses a PDF on disk and saves the result in the Downloads folder.
 * `outputName` is the file name without `.pdf`; empty means `compressed_` plus
 * the PDF's name.
 */
export const compressPdf = (
  inputPath: string,
  quality: number,
  outputName?: string,
  options?: CoreJobOptions,
): Promise<PdfCompressReport> =>
  runCoreJob<PdfCompressReport>(
    'core_pdf_compress_start',
    { inputPath, quality, outputName: outputName?.trim() || null },
    options,
  );
