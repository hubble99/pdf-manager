import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openFilePicker: vi.fn(),
  chooseFolderDialog: vi.fn(),
  convertWebpImages: vi.fn(),
  revealPath: vi.fn(),
  dragDrop: null as null | ((event: { payload: { type: string; paths?: string[] } }) => void),
}));

vi.mock('../utils/tauriDialog', () => ({
  isTauri: () => true,
  openFilePicker: mocks.openFilePicker,
  chooseFolderDialog: mocks.chooseFolderDialog,
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
  return { ...actual, convertWebpImages: mocks.convertWebpImages, revealPath: mocks.revealPath };
});

import { NativeCoreError } from '../api/nativeCore';
import { ToastProvider } from '../context/ToastContext';
import { ToastContainer } from '../components/ToastContainer';
import { ImageFormatPage } from '../pages/ImageFormatPage';
import { baseName, convertErrorText, isWebpPath, mergePaths } from '../features/image-format/helpers';

const renderPage = () => render(<ToastProvider><ImageFormatPage /><ToastContainer /></ToastProvider>);

const file = (source: string, output: string | null, error: { code: string; message: string } | null = null) => ({
  source, output, width: output ? 10 : null, height: output ? 5 : null,
  outputBytes: output ? 2048 : null, animated: false, error,
});

describe('image format helpers', () => {
  it('handles Windows and POSIX paths', () => {
    expect(baseName('C:\\pics\\cat.webp')).toBe('cat.webp');
    expect(baseName('/home/me/dog.webp')).toBe('dog.webp');
    expect(isWebpPath('C:\\a.WEBP')).toBe(true);
    expect(isWebpPath('C:\\a.png')).toBe(false);
  });

  it('skips duplicate paths, ignoring case and slash style', () => {
    const { paths, skipped } = mergePaths(['C:\\Pics\\a.webp'], ['c:/pics/A.webp', 'C:\\pics\\b.webp']);
    expect(paths).toEqual(['C:\\Pics\\a.webp', 'C:\\pics\\b.webp']);
    expect(skipped).toBe(1);
  });

  it('has a reason for every error code', () => {
    const codes = ['not_found', 'unsupported', 'invalid_input', 'io', 'insufficient_memory', 'internal'] as const;
    const texts = codes.map((code) => convertErrorText(code));
    expect(new Set(texts).size).toBe(codes.length);
  });
});

describe('ImageFormatPage', () => {
  beforeEach(() => {
    mocks.openFilePicker.mockReset();
    mocks.chooseFolderDialog.mockReset();
    mocks.convertWebpImages.mockReset();
    mocks.revealPath.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it('converts picked files into the Downloads folder by default', async () => {
    mocks.openFilePicker.mockResolvedValue(['C:\\pics\\a.webp', 'C:\\pics\\b.webp']);
    mocks.convertWebpImages.mockImplementation(async (_inputs, _options, job) => {
      job.onProgress({ jobId: 1, kind: 'image_convert', stage: 'converting', done: 1, total: 2 });
      return {
        files: [file('C:\\pics\\a.webp', 'C:\\Users\\me\\Downloads\\a.jpg'), file('C:\\pics\\b.webp', 'C:\\Users\\me\\Downloads\\b.jpg')],
        succeeded: 2,
        failed: 0,
      };
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Drop WEBP images here or click to browse' }));
    await screen.findByText('a.webp');
    expect(screen.getByText('b.webp')).toBeInTheDocument();
    await screen.findByText('C:\\Users\\me\\Downloads');

    fireEvent.click(screen.getByRole('button', { name: 'JPG' }));
    expect(screen.getByLabelText(/Quality/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Convert 2 images' }));

    await screen.findByText('2 images converted');
    expect(mocks.convertWebpImages).toHaveBeenCalledWith(
      ['C:\\pics\\a.webp', 'C:\\pics\\b.webp'],
      { format: 'jpg', quality: 90, outputDir: 'C:\\Users\\me\\Downloads' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Open Folder/ }));
    await waitFor(() => expect(mocks.revealPath).toHaveBeenCalledWith('C:\\Users\\me\\Downloads\\a.jpg'));
  });

  it('adds dropped WEBP files and skips other types', async () => {
    renderPage();
    await waitFor(() => expect(mocks.dragDrop).not.toBeNull());

    mocks.dragDrop!({ payload: { type: 'drop', paths: ['C:\\x\\one.webp', 'C:\\x\\two.png'] } });

    await screen.findByText('one.webp');
    expect(screen.queryByText('two.png')).not.toBeInTheDocument();
    expect(await screen.findByText('1 file is not a .webp image.')).toBeInTheDocument();
  });

  it('lists the files that failed with a reason', async () => {
    mocks.openFilePicker.mockResolvedValue(['C:\\pics\\good.webp', 'C:\\pics\\bad.webp']);
    mocks.convertWebpImages.mockResolvedValue({
      files: [
        file('C:\\pics\\good.webp', 'C:\\Users\\me\\Downloads\\good.png'),
        file('C:\\pics\\bad.webp', null, { code: 'unsupported', message: 'not a WEBP image' }),
      ],
      succeeded: 1,
      failed: 1,
    });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Drop WEBP images here or click to browse' }));
    await screen.findByText('good.webp');
    await screen.findByText('C:\\Users\\me\\Downloads');

    fireEvent.click(screen.getByRole('button', { name: 'Convert 2 images' }));

    expect(await screen.findByText('1 image was not converted')).toBeInTheDocument();
    expect(screen.getByText('This is not a WEBP image.')).toBeInTheDocument();
    expect(screen.getByText('1 image converted')).toBeInTheDocument();
  });

  it('cancels a running conversion', async () => {
    mocks.openFilePicker.mockResolvedValue(['C:\\pics\\a.webp']);
    mocks.convertWebpImages.mockImplementation((_inputs, _options, job) => new Promise((_resolve, reject) => {
      job.signal.addEventListener('abort', () => reject(new NativeCoreError('cancelled', 'operation cancelled')));
    }));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Drop WEBP images here or click to browse' }));
    await screen.findByText('a.webp');
    await screen.findByText('C:\\Users\\me\\Downloads');

    fireEvent.click(screen.getByRole('button', { name: 'Convert 1 image' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Conversion cancelled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Convert 1 image' })).toBeEnabled();
  });

  it('uses the folder the user picks', async () => {
    mocks.openFilePicker.mockResolvedValue(['C:\\pics\\a.webp']);
    mocks.chooseFolderDialog.mockResolvedValue('D:\\Out');
    mocks.convertWebpImages.mockResolvedValue({ files: [file('C:\\pics\\a.webp', 'D:\\Out\\a.png')], succeeded: 1, failed: 0 });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Drop WEBP images here or click to browse' }));
    await screen.findByText('a.webp');

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await screen.findByText('D:\\Out');
    fireEvent.click(screen.getByRole('button', { name: 'Convert 1 image' }));

    await waitFor(() => expect(mocks.convertWebpImages).toHaveBeenCalledWith(
      ['C:\\pics\\a.webp'], { format: 'png', quality: 90, outputDir: 'D:\\Out' }, expect.anything(),
    ));
  });
});
