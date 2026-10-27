import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openFilePicker: vi.fn(),
  compressPhotos: vi.fn(),
  revealPath: vi.fn(),
  fileSizes: vi.fn(),
  dragDrop: null as null | ((event: { payload: { type: string; paths?: string[] } }) => void),
}));

vi.mock('../utils/tauriDialog', () => ({
  isTauri: () => true,
  openFilePicker: mocks.openFilePicker,
}));

vi.mock('@tauri-apps/api/path', () => ({ downloadDir: async () => 'C:\\Users\\me\\Downloads' }));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: typeof mocks.dragDrop) => {
      mocks.dragDrop = handler;
      return () => { mocks.dragDrop = null; };
    },
  }),
}));

vi.mock('../api/nativeCore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/nativeCore')>();
  return { ...actual, compressPhotos: mocks.compressPhotos, revealPath: mocks.revealPath, fileSizes: mocks.fileSizes };
});

import { NativeCoreError } from '../api/nativeCore';
import { ToastProvider } from '../context/ToastContext';
import { ToastContainer } from '../components/ToastContainer';
import { PhotoCompressPage } from '../pages/PhotoCompressPage';
import { compressErrorText, isPhotoPath, savedPercent } from '../features/photo-compress/helpers';

const renderPage = () => render(<ToastProvider><PhotoCompressPage /><ToastContainer /></ToastProvider>);

const file = (
  source: string,
  output: string | null,
  extra: Partial<{ originalBytes: number; outputBytes: number; keptOriginal: boolean }> = {},
  error: { code: string; message: string } | null = null,
) => ({
  source, output, width: output ? 10 : null, height: output ? 5 : null,
  originalBytes: output ? (extra.originalBytes ?? 4_000_000) : null,
  outputBytes: output ? (extra.outputBytes ?? 1_000_000) : null,
  resized: false, keptOriginal: extra.keptOriginal ?? false, error,
});

const addPhotos = async (names: string[]) => {
  mocks.openFilePicker.mockResolvedValue(names);
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Drop your photos here, or click to pick' }));
  await screen.findByText(names[0].split('\\').pop()!);
  await screen.findByText(names.length === 1 ? '3.81 MB' : '7.63 MB');
};

describe('photo compress helpers', () => {
  it('accepts JPEG and PNG paths only', () => {
    for (const ok of ['a.jpg', 'C:\\x\\B.JPEG', 'c.png', 'd.JFIF']) expect(isPhotoPath(ok), ok).toBe(true);
    for (const no of ['a.webp', 'b.gif', 'c.pdf', 'jpg']) expect(isPhotoPath(no), no).toBe(false);
  });

  it('computes the saved share and never goes negative', () => {
    expect(savedPercent(1000, 250)).toBe(75);
    expect(savedPercent(1000, 1000)).toBe(0);
    expect(savedPercent(1000, 1200)).toBe(0);
    expect(savedPercent(0, 0)).toBe(0);
  });

  it('has a reason for every error code', () => {
    const codes = ['not_found', 'unsupported', 'invalid_input', 'io', 'insufficient_memory', 'internal'] as const;
    expect(new Set(codes.map((code) => compressErrorText(code))).size).toBe(codes.length);
  });
});

describe('PhotoCompressPage', () => {
  beforeEach(() => {
    mocks.openFilePicker.mockReset();
    mocks.fileSizes.mockReset();
    mocks.fileSizes.mockImplementation(async (paths: string[]) => paths.map(() => 4_000_000));
    mocks.compressPhotos.mockReset();
    mocks.revealPath.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it('compresses with the balanced level into Downloads by default', async () => {
    mocks.compressPhotos.mockImplementation(async (_inputs, _options, job) => {
      job.onProgress({ jobId: 1, kind: 'photo_compress', stage: 'compressing', done: 1, total: 2 });
      return {
        files: [
          file('C:\\p\\a.jpg', 'C:\\Users\\me\\Downloads\\a (compressed).jpg'),
          file('C:\\p\\b.png', 'C:\\Users\\me\\Downloads\\b (compressed).png', { keptOriginal: true, outputBytes: 4_000_000 }),
        ],
        succeeded: 2, failed: 0, originalBytes: 8_000_000, outputBytes: 5_000_000,
      };
    });
    await addPhotos(['C:\\p\\a.jpg', 'C:\\p\\b.png']);

    fireEvent.click(screen.getByRole('button', { name: 'Compress 2 photos' }));

    await screen.findByText('2 photos compressed');
    expect(mocks.compressPhotos).toHaveBeenCalledWith(
      ['C:\\p\\a.jpg', 'C:\\p\\b.png'],
      { quality: 75, maxSide: 2560, format: 'keep', outputDir: 'C:\\Users\\me\\Downloads' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByText('4.77 MB')).toBeInTheDocument();
    expect(screen.getByText('−38%')).toBeInTheDocument();
    expect(screen.getByText('Already as small as possible')).toBeInTheDocument();
    expect(screen.getByText('3.81 MB → 976.6 KB')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Open Downloads/ }));
    await waitFor(() => expect(mocks.revealPath).toHaveBeenCalledWith('C:\\Users\\me\\Downloads\\a (compressed).jpg'));
  });

  it('applies a level, then custom values and the JPG format', async () => {
    mocks.compressPhotos.mockResolvedValue({ files: [file('C:\\p\\a.png', 'D:\\Out\\a.jpg')], succeeded: 1, failed: 0, originalBytes: 4_000_000, outputBytes: 1_000_000 });
    await addPhotos(['C:\\p\\a.png']);

    fireEvent.click(screen.getByRole('button', { name: 'Strong' }));
    expect(screen.getByText(/JPEG quality 60/)).toHaveTextContent('longest side up to 1600 px');

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText(/Quality/), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('Longest side'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Convert all to JPG' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compress 1 photo' }));

    await waitFor(() => expect(mocks.compressPhotos).toHaveBeenCalledWith(
      ['C:\\p\\a.png'],
      { quality: 40, maxSide: null, format: 'jpeg', outputDir: 'C:\\Users\\me\\Downloads' },
      expect.anything(),
    ));
  });

  it('adds dropped photos and skips other types', async () => {
    renderPage();
    await waitFor(() => expect(mocks.dragDrop).not.toBeNull());

    mocks.dragDrop!({ payload: { type: 'drop', paths: ['C:\\x\\one.jpg', 'C:\\x\\two.webp', 'C:\\x\\three.gif'] } });

    await screen.findByText('one.jpg');
    expect(screen.queryByText('two.webp')).not.toBeInTheDocument();
    expect(await screen.findByText('2 files are not JPEG or PNG photos.')).toBeInTheDocument();
  });

  it('lists the photos that failed with a reason', async () => {
    mocks.compressPhotos.mockResolvedValue({
      files: [
        file('C:\\p\\good.jpg', 'C:\\Users\\me\\Downloads\\good (compressed).jpg'),
        file('C:\\p\\bad.jpg', null, {}, { code: 'invalid_input', message: 'the file is incomplete' }),
      ],
      succeeded: 1, failed: 1, originalBytes: 4_000_000, outputBytes: 1_000_000,
    });
    await addPhotos(['C:\\p\\good.jpg', 'C:\\p\\bad.jpg']);

    fireEvent.click(screen.getByRole('button', { name: 'Compress 2 photos' }));

    expect(await screen.findByText('1 photo was not compressed')).toBeInTheDocument();
    expect(screen.getByText('Sorry, this image is damaged or cannot be read.')).toBeInTheDocument();
    expect(screen.getByText('1 photo compressed')).toBeInTheDocument();
  });

  it('cancels a running compression', async () => {
    mocks.compressPhotos.mockImplementation((_inputs, _options, job) => new Promise((_resolve, reject) => {
      job.signal.addEventListener('abort', () => reject(new NativeCoreError('cancelled', 'operation cancelled')));
    }));
    await addPhotos(['C:\\p\\a.jpg']);

    fireEvent.click(screen.getByRole('button', { name: 'Compress 1 photo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Compression cancelled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compress 1 photo' })).toBeEnabled();
  });

  it('shows the size before compressing and has no output folder choice', async () => {
    await addPhotos(['C:\\p\\a.jpg', 'C:\\p\\b.png']);

    expect(mocks.fileSizes).toHaveBeenCalledWith(['C:\\p\\a.jpg', 'C:\\p\\b.png']);
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('7.63 MB')).toBeInTheDocument();
    expect(screen.queryByText('Output folder')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
  });

  it('shows a progress bar while compressing', async () => {
    let finish!: (value: unknown) => void;
    mocks.compressPhotos.mockImplementation((_inputs, _options, job) => new Promise((resolve) => {
      job.onProgress({ jobId: 1, kind: 'photo_compress', stage: 'compressing', done: 1, total: 2 });
      finish = resolve;
    }));
    await addPhotos(['C:\\p\\a.jpg', 'C:\\p\\b.png']);

    fireEvent.click(screen.getByRole('button', { name: 'Compress 2 photos' }));

    expect(await screen.findByText('Compressing… 50%')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 photos')).toBeInTheDocument();
    finish({ files: [], succeeded: 0, failed: 0, originalBytes: 0, outputBytes: 0 });
    await waitFor(() => expect(screen.queryByText('Compressing… 50%')).not.toBeInTheDocument());
  });
});
