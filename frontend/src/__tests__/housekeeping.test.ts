import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { clearTempFiles, getCoreHealth, openDownloadsFolder } from '../api/housekeeping';
import { NativeCoreError } from '../api/nativeCore';
import { openOutputFolder } from '../utils/tauriDialog';

describe('housekeeping client', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('clears temporary files and returns the report', async () => {
    const report = { filesDeleted: 3, bytesFreed: 60, skipped: 0 };
    mocks.invoke.mockResolvedValue(report);
    expect(await clearTempFiles()).toEqual(report);
    expect(mocks.invoke).toHaveBeenCalledWith('core_clear_temp');
  });

  it('turns a busy refusal into a NativeCoreError', async () => {
    mocks.invoke.mockRejectedValue({ code: 'busy', message: 'busy: a job is still running' });
    await expect(clearTempFiles()).rejects.toBeInstanceOf(NativeCoreError);
    await expect(clearTempFiles()).rejects.toMatchObject({ code: 'busy' });
  });

  it('reads the health of the core', async () => {
    const health = { appVersion: '1.11.0', coreVersion: '0.1.0' };
    mocks.invoke.mockResolvedValue(health);
    expect(await getCoreHealth()).toEqual(health);
  });

  it('opens the Downloads folder through the core inside the desktop shell', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mocks.invoke.mockResolvedValue(undefined);
    expect(await openOutputFolder()).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('core_open_downloads');
    await expect(openDownloadsFolder()).resolves.toBeUndefined();
  });

  it('reports false when the folder cannot be opened or there is no desktop shell', async () => {
    expect(await openOutputFolder()).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mocks.invoke.mockRejectedValue({ code: 'internal', message: 'no folder' });
    expect(await openOutputFolder()).toBe(false);
  });
});
