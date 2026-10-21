import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { CORE_FINISHED_EVENT, CORE_PROGRESS_EVENT, NativeCoreError } from '../api/nativeCore';
import { compressPdf, probePdf } from '../api/pdfCompress';
import { CompressPage } from '../pages/CompressPage';
import { baseName, compressErrorMessage, formatBytes, stemOf } from '../utils/compressPdf';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }),
}));
const showToast = vi.fn();
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ showToast }) }));

const desktop = vi.hoisted(() => ({ on: false }));
vi.mock('../utils/tauriDialog', () => ({
  isTauri: () => desktop.on,
  openFilePicker: vi.fn(async () => ['C:\\Docs\\Annual Report.pdf']),
  openOutputFolder: vi.fn(async () => true),
}));

type Handler = (event: { payload: unknown }) => void;
const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
let handlers: Record<string, Handler[]>;
const emit = (event: string, payload: unknown) => handlers[event]?.forEach((h) => h({ payload }));

const report = {
  outputPath: 'C:\\Users\\a\\Downloads\\compressed_Annual Report.pdf',
  sizeBefore: 5_000_000,
  sizeAfter: 1_000_000,
  reductionPct: 80,
  pages: 3,
  imagesFound: 4,
  imagesRecompressed: 4,
  keptOriginal: false,
  durationMs: 900,
};

beforeEach(() => {
  handlers = {};
  desktop.on = false;
  showToast.mockReset();
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockImplementation(async (event, handler) => {
    (handlers[event] ??= []).push(handler as unknown as Handler);
    return () => undefined;
  });
});

describe('Compress PDF helpers', () => {
  it('derives names from Windows and POSIX paths', () => {
    expect(baseName('C:\\Users\\a\\Docs\\Report.PDF')).toBe('Report.PDF');
    expect(stemOf('C:\\Users\\a\\Docs\\Report.PDF')).toBe('Report');
    expect(stemOf('/home/a/my file.pdf')).toBe('my file');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('explains core errors in plain words', () => {
    expect(compressErrorMessage(new NativeCoreError('password_required', 'x'))).toMatch(/protected/);
    expect(compressErrorMessage(new NativeCoreError('not_found', 'x'))).toMatch(/could not be found/);
    expect(compressErrorMessage(new NativeCoreError('insufficient_memory', 'x'))).toMatch(/low on memory/);
    expect(compressErrorMessage(new NativeCoreError('internal', 'boom'))).toBe('boom');
  });
});

describe('Compress PDF commands', () => {
  it('sends the quality and the trimmed output name', async () => {
    invokeMock.mockRejectedValue({ code: 'invalid_input', message: 'bad' });
    await expect(compressPdf('C:/a.pdf', 55, '  Small  ')).rejects.toBeInstanceOf(NativeCoreError);
    expect(invokeMock).toHaveBeenCalledWith('core_pdf_compress_start', { inputPath: 'C:/a.pdf', quality: 55, outputName: 'Small' });
    await compressPdf('C:/a.pdf', 55, '').catch(() => undefined);
    expect(invokeMock).toHaveBeenLastCalledWith('core_pdf_compress_start', { inputPath: 'C:/a.pdf', quality: 55, outputName: null });
  });

  it('turns a probe failure into a NativeCoreError', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'not_found', message: 'gone' });
    await expect(probePdf('C:/missing.pdf')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('Compress PDF page', () => {
  it('asks for the desktop app outside Tauri', () => {
    render(<CompressPage />);
    expect(screen.getByText('Compress PDF runs in the Dokuwu desktop app')).toBeTruthy();
  });

  it('picks a file, compresses it with progress, and shows the saved result', async () => {
    desktop.on = true;
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'core_pdf_probe') return { sizeBytes: 5_000_000, pages: 3, encrypted: false };
      if (cmd === 'core_pdf_compress_start') return 11;
      throw new Error(`unexpected ${cmd}`);
    });
    render(<CompressPage />);

    fireEvent.click(screen.getByRole('button', { name: /drop a pdf file here/i }));
    await screen.findByText('Annual Report.pdf');
    expect(screen.getAllByText('4.77 MB').length).toBeGreaterThan(0);
    expect((screen.getByLabelText('Output Filename') as HTMLInputElement).value).toBe('compressed_Annual Report');

    fireEvent.click(screen.getByRole('button', { name: /^compress pdf$/i }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('core_pdf_compress_start', {
      inputPath: 'C:\\Docs\\Annual Report.pdf',
      quality: 70,
      outputName: 'compressed_Annual Report',
    }));
    await waitFor(() => expect(handlers[CORE_FINISHED_EVENT]?.length).toBeGreaterThan(0));

    act(() => emit(CORE_PROGRESS_EVENT, { jobId: 11, kind: 'pdf_compress', stage: 'images', done: 1, total: 4 }));
    expect(await screen.findByText('Compressing picture 2 of 4…')).toBeTruthy();

    act(() => emit(CORE_FINISHED_EVENT, { jobId: 11, kind: 'pdf_compress', status: 'succeeded', result: report }));
    expect(await screen.findByText('Saved to your Downloads folder')).toBeTruthy();
    expect(screen.getByText('−80%')).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('refuses a protected PDF before compressing', async () => {
    desktop.on = true;
    invokeMock.mockResolvedValue({ sizeBytes: 100, pages: 0, encrypted: true });
    render(<CompressPage />);
    fireEvent.click(screen.getByRole('button', { name: /drop a pdf file here/i }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(screen.queryByText('Annual Report.pdf')).toBeNull();
  });

  it('says so when the file could not get smaller', async () => {
    desktop.on = true;
    invokeMock.mockImplementation(async (cmd) => (cmd === 'core_pdf_probe' ? { sizeBytes: 900, pages: 1, encrypted: false } : 5));
    render(<CompressPage />);
    fireEvent.click(screen.getByRole('button', { name: /drop a pdf file here/i }));
    await screen.findByText('Annual Report.pdf');
    fireEvent.click(screen.getByRole('button', { name: /^compress pdf$/i }));
    await waitFor(() => expect(handlers[CORE_FINISHED_EVENT]?.length).toBeGreaterThan(0));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('core_pdf_compress_start', expect.anything()));
    act(() => emit(CORE_FINISHED_EVENT, {
      jobId: 5, kind: 'pdf_compress', status: 'succeeded',
      result: { ...report, sizeBefore: 900, sizeAfter: 900, reductionPct: 0, imagesFound: 0, imagesRecompressed: 0, keptOriginal: true },
    }));
    expect(await screen.findByText('Already as small as it gets')).toBeTruthy();
  });
});
