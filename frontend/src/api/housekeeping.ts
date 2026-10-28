/**
 * Housekeeping from the native core: opening the Downloads folder and the
 * readiness check.
 */
import { invoke } from '@tauri-apps/api/core';
import { toCoreError } from './nativeCore';

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

export const openDownloadsFolder = (): Promise<void> => call<void>('core_open_downloads');
