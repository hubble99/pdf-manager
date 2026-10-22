/**
 * Protect PDF through the native core (`ops::pdf_protect`): add an AES-256
 * password or remove one. The file is a path on disk; the copy is saved in the
 * Downloads folder under a free name. The passwords travel only in the call
 * and are not part of any result or progress event.
 */
import { runCoreJob, type CoreJobOptions } from './nativeCore';

export interface ProtectOptions {
  userPassword: string;
  allowPrint: boolean;
  allowCopy: boolean;
  allowModify: boolean;
  /** File name without extension; empty means `<name>_protected`. */
  outputName?: string;
}

export interface UnprotectOptions {
  /** The password the PDF opens with. */
  password: string;
  /** File name without extension; empty means `<name>_unlocked`. */
  outputName?: string;
}

export interface ProtectReport {
  outputPath: string;
  outputSizeBytes: number;
  pages: number;
  durationMs: number;
}

export const protectPdf = (
  inputPath: string,
  options: ProtectOptions,
  jobOptions?: CoreJobOptions,
): Promise<ProtectReport> =>
  runCoreJob<ProtectReport>(
    'core_pdf_protect_start',
    { inputPath, options: { ...options, outputName: options.outputName?.trim() || null } },
    jobOptions,
  );

export const unprotectPdf = (
  inputPath: string,
  options: UnprotectOptions,
  jobOptions?: CoreJobOptions,
): Promise<ProtectReport> =>
  runCoreJob<ProtectReport>(
    'core_pdf_unprotect_start',
    { inputPath, options: { ...options, outputName: options.outputName?.trim() || null } },
    jobOptions,
  );
