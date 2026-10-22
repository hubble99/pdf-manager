import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  CORE_FINISHED_EVENT,
  CORE_PROGRESS_EVENT,
  NativeCoreError,
  compressPhotos,
  computeFileChecksum,
  convertWebpImages,
  getCoreInfo,
  isCoreCancelled,
  revealPath,
  fileSizes,
  type CoreProgress,
} from '../api/nativeCore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

type Handler = (event: { payload: unknown }) => void;

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
let handlers: Record<string, Handler[]>;
let unlistenCount: number;

const emit = (event: string, payload: unknown) => handlers[event]?.forEach((h) => h({ payload }));

beforeEach(() => {
  handlers = {};
  unlistenCount = 0;
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockImplementation(async (event, handler) => {
    (handlers[event] ??= []).push(handler as unknown as Handler);
    return () => {
      unlistenCount += 1;
    };
  });
});

const digest = { path: 'C:/a.pdf', sizeBytes: 3, sha256: 'abc' };

describe('nativeCore', () => {
  it('resolves with the result and forwards only its own progress', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd !== 'core_checksum_start') throw new Error(`unexpected ${cmd}`);
      setTimeout(() => {
        emit(CORE_PROGRESS_EVENT, { jobId: 99, kind: 'checksum', stage: 'hashing', done: 1, total: 2 });
        emit(CORE_PROGRESS_EVENT, { jobId: 7, kind: 'checksum', stage: 'hashing', done: 3, total: 3 });
        emit(CORE_FINISHED_EVENT, { jobId: 7, kind: 'checksum', status: 'succeeded', result: digest });
      });
      return 7;
    });
    const seen: CoreProgress[] = [];

    await expect(computeFileChecksum('C:/a.pdf', { onProgress: (p) => seen.push(p) })).resolves.toEqual(digest);

    expect(invokeMock).toHaveBeenCalledWith('core_checksum_start', { path: 'C:/a.pdf' });
    expect(seen.map((p) => p.jobId)).toEqual([7]);
    expect(unlistenCount).toBe(2);
  });

  it('handles a job that finishes before the start command returns', async () => {
    invokeMock.mockImplementation(async () => {
      emit(CORE_PROGRESS_EVENT, { jobId: 3, kind: 'checksum', stage: 'hashing', done: 3, total: 3 });
      emit(CORE_FINISHED_EVENT, { jobId: 3, kind: 'checksum', status: 'succeeded', result: digest });
      return 3;
    });
    const onProgress = vi.fn();

    await expect(computeFileChecksum('C:/a.pdf', { onProgress })).resolves.toEqual(digest);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('rejects with the core error code when the job fails', async () => {
    invokeMock.mockImplementation(async () => {
      setTimeout(() =>
        emit(CORE_FINISHED_EVENT, {
          jobId: 1,
          kind: 'checksum',
          status: 'failed',
          error: { code: 'not_found', message: 'file not found: C:/a.pdf' },
        }),
      );
      return 1;
    });

    const err = await computeFileChecksum('C:/a.pdf').catch((e) => e);
    expect(err).toBeInstanceOf(NativeCoreError);
    expect(err.code).toBe('not_found');
  });

  it('rejects with the core error when the start command fails', async () => {
    invokeMock.mockRejectedValue({ code: 'invalid_input', message: 'invalid input: path is empty' });

    const err = await computeFileChecksum('').catch((e) => e);
    expect(err.code).toBe('invalid_input');
    expect(unlistenCount).toBe(2);
  });

  it('cancels the job when the signal aborts', async () => {
    const controller = new AbortController();
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'core_checksum_start') {
        setTimeout(() => controller.abort());
        return 5;
      }
      if (cmd === 'core_job_cancel') {
        expect(args).toEqual({ jobId: 5 });
        setTimeout(() => emit(CORE_FINISHED_EVENT, { jobId: 5, kind: 'checksum', status: 'cancelled' }));
        return true;
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const err = await computeFileChecksum('C:/a.pdf', { signal: controller.signal }).catch((e) => e);
    expect(isCoreCancelled(err)).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('core_job_cancel', { jobId: 5 });
  });

  it('does not start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const err = await computeFileChecksum('C:/a.pdf', { signal: controller.signal }).catch((e) => e);
    expect(isCoreCancelled(err)).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('reads core info', async () => {
    const info = { version: '0.1.0', cpuThreads: 8, totalMemoryBytes: 1, availableMemoryBytes: 1 };
    invokeMock.mockResolvedValue(info);
    await expect(getCoreInfo()).resolves.toEqual(info);
    expect(invokeMock).toHaveBeenCalledWith('core_info');
  });

  it('converts WEBP images with paths and options', async () => {
    const report = { files: [], succeeded: 2, failed: 0 };
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd !== 'core_image_convert_start') throw new Error(`unexpected ${cmd}`);
      setTimeout(() => emit(CORE_FINISHED_EVENT, { jobId: 3, kind: 'image_convert', status: 'succeeded', result: report }));
      return 3;
    });
    const options = { format: 'jpg' as const, quality: 85, outputDir: 'C:/out' };

    await expect(convertWebpImages(['C:/a.webp', 'C:/b.webp'], options)).resolves.toEqual(report);
    expect(invokeMock).toHaveBeenCalledWith('core_image_convert_start', { inputs: ['C:/a.webp', 'C:/b.webp'], options });
  });

  it('compresses photos with paths and options', async () => {
    const report = { files: [], succeeded: 1, failed: 0, originalBytes: 100, outputBytes: 40 };
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd !== 'core_photo_compress_start') throw new Error(`unexpected ${cmd}`);
      setTimeout(() => emit(CORE_FINISHED_EVENT, { jobId: 4, kind: 'photo_compress', status: 'succeeded', result: report }));
      return 4;
    });
    const options = { quality: 70, maxSide: 1920, format: 'jpeg' as const, outputDir: 'C:/out' };

    await expect(compressPhotos(['C:/a.jpg'], options)).resolves.toEqual(report);
    expect(invokeMock).toHaveBeenCalledWith('core_photo_compress_start', { inputs: ['C:/a.jpg'], options });
  });

  it('reads file sizes in order', async () => {
    invokeMock.mockResolvedValueOnce([1200, null]);
    await expect(fileSizes(['C:/a.jpg', 'C:/missing.jpg'])).resolves.toEqual([1200, null]);
    expect(invokeMock).toHaveBeenCalledWith('core_file_sizes', { paths: ['C:/a.jpg', 'C:/missing.jpg'] });
  });

  it('reveals a path and maps its errors', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await revealPath('C:/out/a.png');
    expect(invokeMock).toHaveBeenCalledWith('core_reveal_path', { path: 'C:/out/a.png' });

    invokeMock.mockRejectedValueOnce({ code: 'not_found', message: 'file not found: x' });
    const err = await revealPath('x').catch((e) => e);
    expect(err).toBeInstanceOf(NativeCoreError);
    expect(err.code).toBe('not_found');
  });
});
