/**
 * Housekeeping from the native core (`ops::housekeeping`): clearing temporary
 * files, opening the Downloads folder, and the readiness check.
 */
import { invoke } from '@tauri-apps/api/core';
import { toCoreError } from './nativeCore';

export interface ClearReport {
  filesDeleted: number;
  bytesFreed: number;
  /** Entries that could not be removed (locked or no permission). */
  skipped: number;
}

export interface CoreHealth {
  appVersion: string;
  coreVersion: string;
}

async function call<T>(command: string): Promise<T> {
  try {
    return await invoke<T>(command);
  } catch (err) {
    throw toCoreError(err);
  }
}

export const getCoreHealth = (): Promise<CoreHealth> => call<CoreHealth>('core_health');

/** Removes temporary and legacy output files; rejects with `busy` while a job runs. */
export const clearTempFiles = (): Promise<ClearReport> => call<ClearReport>('core_clear_temp');

export const openDownloadsFolder = (): Promise<void> => call<void>('core_open_downloads');
