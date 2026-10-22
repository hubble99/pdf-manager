/**
 * Merge PDF, Extract pages and the Merge folder workspace through the native
 * core (`ops::pdf_merge`, `ops::pdf_extract`, `ops::folder_scan`).
 *
 * Files are paths on disk and results are saved in the Downloads folder under
 * a free name. In folder mode the list holds names relative to the chosen
 * folder and `root` is that folder; the core refuses anything outside it.
 * Problems and skipped files are reported as positions in the list that was
 * sent.
 */
import { invoke } from '@tauri-apps/api/core';
import { NativeCoreError, runCoreJob, type CoreErrorCode, type CoreJobOptions } from './nativeCore';

/** Why a file cannot be merged; these are the core's words, shown through `reasonLabel`. */
export type MergeReason =
  | 'not a PDF file'
  | 'file not found'
  | 'not a file'
  | 'encrypted'
  | 'no pages'
  | 'damaged or unreadable'
  | 'could not be read while merging';

export interface FolderNode {
  name: string;
  /** Path from the chosen folder with `/` between names; empty for the folder itself. */
  relativePath: string;
  /** PDFs in this folder and below. */
  pdfCount: number;
  folders: FolderNode[];
  files: string[];
}

export interface FolderListing {
  root: FolderNode;
  pdfCount: number;
  /** Entries that could not be read. */
  skipped: number;
  depthCapped: boolean;
  entryCapped: boolean;
}

export interface MergeProblem {
  /** Position in the list that was sent. */
  index: number;
  reason: MergeReason | string;
}

export interface Inspection {
  usable: number;
  problems: MergeProblem[];
}

export interface FileDescription {
  sizeBytes: number;
  /** `null` when the file cannot be read or is password protected. */
  pages: number | null;
}

export interface MergeReport {
  outputPath: string;
  outputSizeBytes: number;
  totalPages: number;
  mergedFiles: number;
  skipped: MergeProblem[];
  durationMs: number;
}

export interface MergeOptions {
  /** Folder mode: the chosen folder; the list then holds names inside it. */
  root?: string;
  /** Leave unusable files out and report them instead of failing. */
  skipInvalid: boolean;
  /** File name without extension; empty means `merged_output`. */
  outputName?: string;
}

export type ExtractMode = 'combine' | 'separate_page' | 'separate_range' | 'split_all';

export interface ExtractOptions {
  mode: ExtractMode;
  /** `1-3,5,7-9`; ignored by `split_all`. */
  pageRanges: string;
  /** File name without extension; empty means `extracted_<name>`. */
  outputName?: string;
}

export interface ExtractReport {
  outputPath: string;
  outputSizeBytes: number;
  /** Pages written, over all files. */
  pagesExtracted: number;
  /** PDFs in the output: 1 for `combine`, the ZIP's entries otherwise. */
  files: number;
  isZip: boolean;
  durationMs: number;
}

function asCoreError(err: unknown): unknown {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const { code, message } = err as { code: CoreErrorCode; message: string };
    return new NativeCoreError(code, message);
  }
  return err;
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw asCoreError(err);
  }
}

/** The PDFs of a folder and its sub-folders, as a tree in natural order. */
export const scanFolder = (root: string): Promise<FolderListing> => call('core_folder_scan', { root });

/** Why each file cannot be merged, without merging anything. */
export const inspectPdfs = (paths: string[], root?: string): Promise<Inspection> =>
  call('core_pdf_inspect', { paths, root: root ?? null });

/** Size and page count of each file, in order. */
export const describePdfs = (paths: string[], root?: string): Promise<FileDescription[]> =>
  call('core_pdf_describe', { paths, root: root ?? null });

export const mergePdfs = (
  paths: string[],
  options: MergeOptions,
  jobOptions?: CoreJobOptions,
): Promise<MergeReport> =>
  runCoreJob<MergeReport>(
    'core_pdf_merge_start',
    {
      paths,
      root: options.root ?? null,
      skipInvalid: options.skipInvalid,
      outputName: options.outputName?.trim() || null,
    },
    jobOptions,
  );

export const extractPages = (
  inputPath: string,
  options: ExtractOptions,
  jobOptions?: CoreJobOptions,
): Promise<ExtractReport> =>
  runCoreJob<ExtractReport>(
    'core_pdf_extract_start',
    {
      inputPath,
      options: { ...options, outputName: options.outputName?.trim() || null },
    },
    jobOptions,
  );
