import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_FINISHED_EVENT, CORE_PROGRESS_EVENT } from '../api/nativeCore';
import { FileProvider } from '../context/FileContext';
import { ToastProvider } from '../context/ToastContext';
import { MergePage } from '../pages/MergePage';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ showToast }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

type DragHandler = (event: { payload: { type: string; paths?: string[] } }) => void;
const drag = vi.hoisted(() => ({ handlers: [] as DragHandler[] }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: DragHandler) => {
      drag.handlers.push(handler);
      return () => { drag.handlers = drag.handlers.filter((h) => h !== handler); };
    },
  }),
}));

const desktop = vi.hoisted(() => ({ on: true }));
vi.mock('../utils/tauriDialog', () => ({
  isTauri: () => desktop.on,
  chooseFolderDialog: vi.fn(async () => null),
  openFilePicker: vi.fn(async () => null),
  openOutputFolder: vi.fn(async () => true),
}));

vi.mock('../components/PdfThumbnail', () => ({
  PdfThumbnail: () => <span data-testid="thumb" />,
}));

type Handler = (event: { payload: unknown }) => void;
const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
let handlers: Record<string, Handler[]>;
const emit = (event: string, payload: unknown) => act(() => { handlers[event]?.forEach((h) => h({ payload })); });
const calls = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

const A = 'C:\\Docs\\a.pdf';
const B = 'C:\\Docs\\b.pdf';
const LOCKED = 'C:\\Docs\\locked.pdf';

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <FileProvider>
          <MergePage />
        </FileProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function drop(paths: string[]) {
  await waitFor(() => expect(drag.handlers.length).toBeGreaterThanOrEqual(1));
  act(() => drag.handlers.forEach((h) => h({ payload: { type: 'drop', paths } })));
}

const cardTitles = () => [...document.querySelectorAll('.sort-card-title')].map((n) => n.textContent);
const runButton = () => document.getElementById('merge-run-btn') as HTMLButtonElement;

describe('merge quick mode', () => {
  beforeEach(() => {
    handlers = {};
    drag.handlers = [];
    desktop.on = true;
    showToast.mockReset();
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockImplementation(async (event, handler) => {
      (handlers[event] ??= []).push(handler as unknown as Handler);
      return () => undefined;
    });
    invokeMock.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case 'core_pdf_describe':
          return (args as { paths: string[] }).paths.map((p) => (
            p === LOCKED ? { sizeBytes: 4096, pages: null } : { sizeBytes: 2_097_152, pages: 3 }
          ));
        case 'core_pdf_merge_start':
          return 21;
        case 'core_job_cancel':
        case 'core_reveal_path':
          return undefined;
        default:
          throw new Error(`unexpected ${cmd}`);
      }
    });
  });

  it('asks for the desktop app outside Tauri', () => {
    desktop.on = false;
    renderPage();
    expect(screen.getByText('Merge PDF runs in the Dokuwu desktop app')).toBeInTheDocument();
    expect(document.getElementById('merge-drop-zone')).toBeNull();
  });

  it('takes dropped PDFs, shows size and pages, and keeps the order', async () => {
    renderPage();
    await drop([A, B]);
    await waitFor(() => expect(cardTitles()).toEqual(['a.pdf', 'b.pdf']));
    expect(await screen.findAllByText('3 pages')).toHaveLength(2);
    expect(screen.getAllByText('2.00 MB')).toHaveLength(2);
    expect(calls('core_pdf_describe')[0][1]).toEqual({ paths: [A, B], root: null });
    expect(runButton()).toBeEnabled();
  });

  it('turns away files that are not PDFs', async () => {
    renderPage();
    await drop(['C:\\Docs\\notes.txt']);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Only PDF files are accepted.' })));
    expect(document.getElementById('merge-drop-zone')).not.toBeNull();
    expect(cardTitles()).toEqual([]);
  });

  it('needs two files and marks a file added twice', async () => {
    renderPage();
    await drop([A]);
    await waitFor(() => expect(cardTitles()).toEqual(['a.pdf']));
    expect(runButton()).toBeDisabled();

    await drop([A.replace(/\\/g, '/').toLowerCase()]);
    await waitFor(() => expect(cardTitles()).toHaveLength(2));
    expect(screen.getByText('1 duplicate added')).toBeInTheDocument();
    expect(screen.getByTitle(/This is the same file as #1/)).toBeInTheDocument();
    expect(runButton()).toBeEnabled();
  });

  it('warns about a file that cannot be read', async () => {
    renderPage();
    await drop([A, LOCKED]);
    expect(await screen.findByTitle('This file cannot be read. It may be damaged or password protected.')).toBeInTheDocument();
  });

  it('merges in the shown order with progress, then offers the folder', async () => {
    renderPage();
    await drop([A, B]);
    await waitFor(() => expect(cardTitles()).toHaveLength(2));
    fireEvent.change(document.getElementById('merge-output-name') as HTMLInputElement, { target: { value: 'Gabungan.pdf' } });
    fireEvent.click(runButton());

    await waitFor(() => expect(calls('core_pdf_merge_start')).toHaveLength(1));
    expect(calls('core_pdf_merge_start')[0][1]).toEqual({
      paths: [A, B], root: null, skipInvalid: false, outputName: 'Gabungan.pdf',
    });
    emit(CORE_PROGRESS_EVENT, { jobId: 21, kind: 'pdf_merge', stage: 'files', done: 1, total: 2 });
    expect(await screen.findByText('Merging file 2 of 2…')).toBeInTheDocument();

    emit(CORE_FINISHED_EVENT, {
      jobId: 21,
      kind: 'pdf_merge',
      status: 'succeeded',
      result: {
        outputPath: 'C:\\Users\\a\\Downloads\\Gabungan.pdf', outputSizeBytes: 3_145_728,
        totalPages: 6, mergedFiles: 2, skipped: [], durationMs: 100,
      },
    });
    expect(await screen.findByText('Your file is in Downloads!')).toBeInTheDocument();
    expect(screen.getByText(/6 pages · 3\.00 MB/)).toBeInTheDocument();
    fireEvent.click(document.getElementById('merge-open-folder-btn') as HTMLButtonElement);
    await waitFor(() => expect(calls('core_reveal_path')[0][1]).toEqual({ path: 'C:\\Users\\a\\Downloads\\Gabungan.pdf' }));
  });

  it('cancels without showing an error', async () => {
    renderPage();
    await drop([A, B]);
    await waitFor(() => expect(cardTitles()).toHaveLength(2));
    fireEvent.click(runButton());
    await waitFor(() => expect(calls('core_pdf_merge_start')).toHaveLength(1));
    fireEvent.click(document.getElementById('merge-cancel-btn') as HTMLButtonElement);
    await waitFor(() => expect(calls('core_job_cancel')[0][1]).toEqual({ jobId: 21 }));
    emit(CORE_FINISHED_EVENT, { jobId: 21, kind: 'pdf_merge', status: 'cancelled' });
    await waitFor(() => expect(runButton()).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names the protected file when the merge is refused', async () => {
    renderPage();
    await drop([A, LOCKED]);
    await waitFor(() => expect(cardTitles()).toHaveLength(2));
    fireEvent.click(runButton());
    await waitFor(() => expect(calls('core_pdf_merge_start')).toHaveLength(1));
    emit(CORE_FINISHED_EVENT, {
      jobId: 21,
      kind: 'pdf_merge',
      status: 'failed',
      error: { code: 'invalid_input', message: "invalid input: 'locked.pdf' is encrypted and cannot be merged." },
    });
    expect(await screen.findByText('locked.pdf is password protected and cannot be merged. Remove its protection first.')).toBeInTheDocument();
    expect(runButton()).toBeEnabled();
  });

  it('removes a file and clears all', async () => {
    renderPage();
    await drop([A, B]);
    await waitFor(() => expect(cardTitles()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: /Remove a\.pdf/i }));
    expect(cardTitles()).toEqual(['b.pdf']);
    fireEvent.click(document.getElementById('merge-clear-btn') as HTMLButtonElement);
    expect(document.getElementById('merge-drop-zone')).not.toBeNull();
  });
});
