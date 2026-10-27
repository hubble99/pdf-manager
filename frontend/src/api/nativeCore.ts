/**
 * Client for the native Rust core (`native/dokuwu-core`), reached through
 * Tauri commands.
 *
 * Long operations are jobs: a `core_*_start` command returns a job id, then
 * progress and the outcome arrive as `core://job-progress` and
 * `core://job-finished` events. `runCoreJob` hides that and returns a promise.
 * Only available inside the desktop shell (see `isTauri`).
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const CORE_PROGRESS_EVENT = 'core://job-progress';
export const CORE_FINISHED_EVENT = 'core://job-finished';

export type CoreErrorCode =
  | 'cancelled'
  | 'not_found'
  | 'io'
  | 'invalid_input'
  | 'unsupported'
  | 'password_required'
  | 'insufficient_memory'
  | 'busy'
  | 'internal';

export class NativeCoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode, message: string) {
    super(message);
    this.name = 'NativeCoreError';
    this.code = code;
  }
}

export const isCoreCancelled = (err: unknown): boolean =>
  err instanceof NativeCoreError && err.code === 'cancelled';

export interface CoreProgress {
  jobId: number;
  kind: string;
  stage: string;
  done: number;
  total: number | null;
}

type CoreFinished<T> =
  | { jobId: number; kind: string; status: 'succeeded'; result: T }
  | { jobId: number; kind: string; status: 'failed'; error: { code: CoreErrorCode; message: string } }
  | { jobId: number; kind: string; status: 'cancelled' };

export interface CoreInfo {
  version: string;
  cpuThreads: number;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
}

export interface FileDigest {
  path: string;
  sizeBytes: number;
  sha256: string;
}

/** What a PDF to Word conversion produced; see `ops::pdf_to_word` in the core. */
export interface PdfToWordReport {
  outputPath: string;
  outputSizeBytes: number;
  pages: number;
  /** 1-based pages with no text layer (scans); kept as pictures, not editable text. */
  pagesWithoutText: number[];
  /** Pages whose scan picture was replaced by its invisible OCR text. */
  ocrLayerPages: number[];
  tables: number;
  images: number;
  durationMs: number;
}

export interface CoreJobOptions {
  onProgress?: (progress: CoreProgress) => void;
  /** Aborting asks the job to stop; the promise then rejects as cancelled. */
  signal?: AbortSignal;
}

export const toCoreError = (err: unknown): NativeCoreError => {
  if (err instanceof NativeCoreError) return err;
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const { code, message } = err as { code: CoreErrorCode; message: string };
    return new NativeCoreError(code, message);
  }
  return new NativeCoreError('internal', err instanceof Error ? err.message : String(err));
};

const cancelledError = () => new NativeCoreError('cancelled', 'operation cancelled');

export async function getCoreInfo(): Promise<CoreInfo> {
  try {
    return await invoke<CoreInfo>('core_info');
  } catch (err) {
    throw toCoreError(err);
  }
}

/**
 * Starts a core job and resolves with its result.
 *
 * Listeners are attached before the start command, and events that arrive
 * before the job id is known are buffered, so a fast job cannot finish unseen.
 */
export async function runCoreJob<T>(
  startCommand: string,
  args: Record<string, unknown>,
  options: CoreJobOptions = {},
): Promise<T> {
  const { onProgress, signal } = options;
  if (signal?.aborted) throw cancelledError();

  let jobId: number | null = null;
  const early: Array<{ type: 'progress'; payload: CoreProgress } | { type: 'finished'; payload: CoreFinished<T> }> = [];
  let settle: { resolve: (value: T) => void; reject: (err: unknown) => void } | null = null;
  const done = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const handleFinished = (payload: CoreFinished<T>) => {
    if (payload.status === 'succeeded') settle!.resolve(payload.result);
    else if (payload.status === 'cancelled') settle!.reject(cancelledError());
    else settle!.reject(toCoreError(payload.error));
  };

  const unlisteners: UnlistenFn[] = [];
  const onAbort = () => {
    if (jobId !== null) void invoke('core_job_cancel', { jobId }).catch(() => undefined);
  };

  try {
    unlisteners.push(
      await listen<CoreProgress>(CORE_PROGRESS_EVENT, ({ payload }) => {
        if (jobId === null) early.push({ type: 'progress', payload });
        else if (payload.jobId === jobId) onProgress?.(payload);
      }),
    );
    unlisteners.push(
      await listen<CoreFinished<T>>(CORE_FINISHED_EVENT, ({ payload }) => {
        if (jobId === null) early.push({ type: 'finished', payload });
        else if (payload.jobId === jobId) handleFinished(payload);
      }),
    );

    try {
      jobId = await invoke<number>(startCommand, args);
    } catch (err) {
      throw toCoreError(err);
    }

    for (const event of early.splice(0)) {
      if (event.payload.jobId !== jobId) continue;
      if (event.type === 'progress') onProgress?.(event.payload);
      else handleFinished(event.payload);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    return await done;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    unlisteners.forEach((unlisten) => unlisten());
  }
}

/** SHA-256 of a file on disk, computed by the native core. */
export const computeFileChecksum = (path: string, options?: CoreJobOptions): Promise<FileDigest> =>
  runCoreJob<FileDigest>('core_checksum_start', { path }, options);

export type ImageTargetFormat = 'png' | 'jpg' | 'jpeg';

export interface ImageConvertOptions {
  format: ImageTargetFormat;
  /** JPEG quality, 1 to 100. Ignored for PNG. */
  quality?: number;
  /** Existing folder the converted files are written to. */
  outputDir: string;
}

export interface ConvertedImage {
  source: string;
  /** `null` when this file failed; see `error`. */
  output: string | null;
  width: number | null;
  height: number | null;
  outputBytes: number | null;
  /** The source was an animated WEBP; only its first frame was kept. */
  animated: boolean;
  error: { code: CoreErrorCode; message: string } | null;
}

export interface ImageConvertReport {
  /** One entry per input, in input order. */
  files: ConvertedImage[];
  succeeded: number;
  failed: number;
}

/**
 * Converts WEBP files to PNG, JPG or JPEG on disk. Progress counts finished
 * files. One bad file does not stop the batch: it is reported in `files` with
 * its error. Cancelling keeps the files already written.
 */
export const convertWebpImages = (
  inputs: string[],
  options: ImageConvertOptions,
  jobOptions?: CoreJobOptions,
): Promise<ImageConvertReport> =>
  runCoreJob<ImageConvertReport>('core_image_convert_start', { inputs, options }, jobOptions);

export type PhotoOutputFormat = 'keep' | 'jpeg';

export interface PhotoCompressOptions {
  /** JPEG quality, 1 to 100. PNG stays lossless whatever the value. */
  quality?: number;
  /** Longest side in pixels; larger photos are shrunk, smaller ones are untouched. */
  maxSide?: number | null;
  /** `keep` leaves JPEG as JPEG and PNG as PNG; `jpeg` turns every photo into a JPEG. */
  format?: PhotoOutputFormat;
  /** Existing folder the compressed files are written to. */
  outputDir: string;
}

export interface CompressedPhoto {
  source: string;
  /** `null` when this file failed; see `error`. */
  output: string | null;
  width: number | null;
  height: number | null;
  originalBytes: number | null;
  outputBytes: number | null;
  /** The photo was shrunk to fit `maxSide`. */
  resized: boolean;
  /** Compressing would not have made it smaller, so the output is a copy of the original. */
  keptOriginal: boolean;
  error: { code: CoreErrorCode; message: string } | null;
}

export interface PhotoCompressReport {
  /** One entry per input, in input order. */
  files: CompressedPhoto[];
  succeeded: number;
  failed: number;
  /** Sizes summed over the files that succeeded. */
  originalBytes: number;
  outputBytes: number;
}

/**
 * Compresses JPEG and PNG photos on disk. Progress counts finished photos.
 * One bad file does not stop the batch: it is reported in `files` with its
 * error. Cancelling keeps the files already written.
 */
export const compressPhotos = (
  inputs: string[],
  options: PhotoCompressOptions,
  jobOptions?: CoreJobOptions,
): Promise<PhotoCompressReport> =>
  runCoreJob<PhotoCompressReport>('core_photo_compress_start', { inputs, options }, jobOptions);

/** Size in bytes of each file, in order; `null` for a path that cannot be read. */
export async function fileSizes(paths: string[]): Promise<Array<number | null>> {
  try {
    return await invoke<Array<number | null>>('core_file_sizes', { paths });
  } catch (err) {
    throw toCoreError(err);
  }
}

/** Opens the system file manager with `path` selected. */
export async function revealPath(path: string): Promise<void> {
  try {
    await invoke('core_reveal_path', { path });
  } catch (err) {
    throw toCoreError(err);
  }
}

/**
 * Converts a PDF on disk to a Word document saved in the Downloads folder.
 * `outputName` is the file name without `.docx`; empty means the PDF's name.
 * Progress arrives with stage `page` (done/total pages), then `saving`.
 */
export const convertPdfToWord = (
  inputPath: string,
  outputName?: string,
  options?: CoreJobOptions,
): Promise<PdfToWordReport> =>
  runCoreJob<PdfToWordReport>('core_pdf_to_word_start', { inputPath, outputName: outputName?.trim() || null }, options);
