import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_FINISHED_EVENT, CORE_PROGRESS_EVENT } from '../api/nativeCore';
import { FileProvider } from '../context/FileContext';
import { ToastProvider } from '../context/ToastContext';
import { ExtractPage } from '../pages/ExtractPage';

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
  openFilePicker: vi.fn(async () => null),
  openOutputFolder: vi.fn(async () => true),
}));

type Handler = (event: { payload: unknown }) => void;
const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
let handlers: Record<string, Handler[]>;
const emit = (event: string, payload: unknown) => act(() => { handlers[event]?.forEach((h) => h({ payload })); });
const calls = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

const PDF = 'C:\\Docs\\report.pdf';
let pageCount = 6;
let encrypted = false;

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <FileProvider>
          <ExtractPage />
        </FileProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function drop(paths: string[]) {
  await waitFor(() => expect(drag.handlers.length).toBeGreaterThanOrEqual(1));
  act(() => drag.handlers.forEach((h) => h({ payload: { type: 'drop', paths } })));
}

const runButton = () => document.getElementById('extract-run-btn') as HTMLButtonElement;
const rangeInput = () => document.getElementById('extract-page-ranges') as HTMLInputElement;
const nameInput = () => document.getElementById('extract-output-name') as HTMLInputElement;
const mode = (value: string) => document.getElementById(`extract-mode-${value}`) as HTMLInputElement;
const pageCell = (page: number) => screen.getByRole('button', { name: new RegExp(`^Page ${page}(,|$)`) });

describe('extract page', () => {
  beforeAll(() => {
    URL.createObjectURL = vi.fn(() => 'blob:mock-preview');
    URL.revokeObjectURL = vi.fn();
  });

  beforeEach(() => {
    handlers = {};
    drag.handlers = [];
    desktop.on = true;
    showToast.mockReset();
    pageCount = 6;
    encrypted = false;
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockImplementation(async (event, handler) => {
      (handlers[event] ??= []).push(handler as unknown as Handler);
      return () => undefined;
    });
    invokeMock.mockImplementation(async (cmd) => {
      switch (cmd) {
        case 'core_pdf_info':
          return { sizeBytes: 1024, pages: encrypted ? 0 : pageCount, encrypted, metadata: {} };
        case 'core_pdf_render_page':
          return new ArrayBuffer(4);
        case 'core_pdf_extract_start':
          return 31;
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
    expect(screen.getByText('Split PDF runs in the Dokuwu desktop app')).toBeInTheDocument();
  });

  it('shows the pages of a dropped PDF and keeps the grid and the field in step', async () => {
    renderPage();
    await drop([PDF]);
    await screen.findByText('6 pages');
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(nameInput().placeholder).toBe('extracted_report');

    fireEvent.click(pageCell(2));
    fireEvent.click(pageCell(3));
    fireEvent.click(pageCell(5));
    expect(rangeInput().value).toBe('2-3, 5');

    fireEvent.change(rangeInput(), { target: { value: '1, 6' } });
    expect(screen.getByText('2 of 6 pages selected')).toBeInTheDocument();
  });

  it('selects a range of pages with Shift + click', async () => {
    pageCount = 10;
    renderPage();
    await drop([PDF]);
    await screen.findByText('10 pages');
    expect(screen.getByText('Tip: hold Shift and click to select a range of pages.')).toBeInTheDocument();

    // A plain click sets the starting point, Shift + click selects up to the page.
    fireEvent.click(pageCell(3));
    fireEvent.click(pageCell(6), { shiftKey: true });
    expect(rangeInput().value).toBe('3-6');

    // Another Shift + click extends from the same page, in either direction.
    fireEvent.click(pageCell(9), { shiftKey: true });
    expect(rangeInput().value).toBe('3-9');
    fireEvent.click(pageCell(1), { shiftKey: true });
    expect(rangeInput().value).toBe('1-9');

    // After deselecting a page, Shift + click deselects the range.
    fireEvent.change(rangeInput(), { target: { value: '1-10' } });
    fireEvent.click(pageCell(4));
    expect(rangeInput().value).toBe('1-3, 5-10');
    fireEvent.click(pageCell(7), { shiftKey: true });
    expect(rangeInput().value).toBe('1-3, 8-10');
  });

  it('treats Shift + click as a plain click when nothing was clicked before', async () => {
    renderPage();
    await drop([PDF]);
    await screen.findByText('6 pages');
    fireEvent.click(pageCell(4), { shiftKey: true });
    expect(rangeInput().value).toBe('4');
    fireEvent.click(pageCell(6), { shiftKey: true });
    expect(rangeInput().value).toBe('4-6');
  });

  it('extracts the typed ranges and reports the result', async () => {
    renderPage();
    await drop([PDF]);
    await screen.findByText('6 pages');
    fireEvent.change(rangeInput(), { target: { value: '1-3,5' } });
    fireEvent.click(mode('separate_range'));
    fireEvent.change(nameInput(), { target: { value: 'bagian' } });
    fireEvent.click(runButton());

    await waitFor(() => expect(calls('core_pdf_extract_start')).toHaveLength(1));
    expect(calls('core_pdf_extract_start')[0][1]).toEqual({
      inputPath: PDF,
      options: { mode: 'separate_range', pageRanges: '1-3,5', outputName: 'bagian' },
    });
    emit(CORE_PROGRESS_EVENT, { jobId: 31, kind: 'pdf_extract', stage: 'pages', done: 1, total: 2 });
    expect(await screen.findByText('Writing file 2 of 2…')).toBeInTheDocument();

    emit(CORE_FINISHED_EVENT, {
      jobId: 31,
      kind: 'pdf_extract',
      status: 'succeeded',
      result: {
        outputPath: 'C:\\Users\\a\\Downloads\\bagian.zip', outputSizeBytes: 5000,
        pagesExtracted: 4, files: 2, isZip: true, durationMs: 50,
      },
    });
    expect(await screen.findByText('Saved to your Downloads folder')).toBeInTheDocument();
    expect(screen.getByText(/4 pages extracted/)).toBeInTheDocument();
    expect(screen.getByText(/ZIP archive/)).toBeInTheDocument();
    fireEvent.click(document.getElementById('extract-open-folder-btn') as HTMLButtonElement);
    await waitFor(() => expect(calls('core_reveal_path')[0][1]).toEqual({ path: 'C:\\Users\\a\\Downloads\\bagian.zip' }));
  });

  it('splits every page without asking for ranges', async () => {
    renderPage();
    await drop([PDF]);
    await screen.findByText('6 pages');
    fireEvent.click(mode('split_all'));
    expect(rangeInput()).toBeDisabled();
    expect(screen.getByText('Every page becomes its own PDF')).toBeInTheDocument();
    fireEvent.click(runButton());
    await waitFor(() => expect(calls('core_pdf_extract_start')).toHaveLength(1));
    expect(calls('core_pdf_extract_start')[0][1]).toMatchObject({ options: { mode: 'split_all', outputName: null } });
  });

  it('asks for pages before starting', async () => {
    renderPage();
    await drop([PDF]);
    await screen.findByText('6 pages');
    fireEvent.click(runButton());
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'No pages specified' })));
    expect(calls('core_pdf_extract_start')).toHaveLength(0);
  });

  it('explains a page range the core refused', async () => {
    renderPage();
    await drop([PDF]);
    await screen.findByText('6 pages');
    fireEvent.change(rangeInput(), { target: { value: '9' } });
    fireEvent.click(runButton());
    await waitFor(() => expect(calls('core_pdf_extract_start')).toHaveLength(1));
    emit(CORE_FINISHED_EVENT, {
      jobId: 31,
      kind: 'pdf_extract',
      status: 'failed',
      error: { code: 'invalid_input', message: 'invalid input: page 9 is out of range (document has 6 pages)' },
    });
    expect(await screen.findByText('Page 9 is out of range. The document has 6 pages.')).toBeInTheDocument();
    expect(runButton()).toBeEnabled();
  });

  it('cancels without showing an error', async () => {
    renderPage();
    await drop([PDF]);
    await screen.findByText('6 pages');
    fireEvent.change(rangeInput(), { target: { value: '1' } });
    fireEvent.click(runButton());
    await waitFor(() => expect(calls('core_pdf_extract_start')).toHaveLength(1));
    fireEvent.click(document.getElementById('extract-cancel-btn') as HTMLButtonElement);
    await waitFor(() => expect(calls('core_job_cancel')[0][1]).toEqual({ jobId: 31 }));
    emit(CORE_FINISHED_EVENT, { jobId: 31, kind: 'pdf_extract', status: 'cancelled' });
    await waitFor(() => expect(runButton()).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not offer a protected PDF for splitting', async () => {
    encrypted = true;
    renderPage();
    await drop([PDF]);
    expect(await screen.findByText('Password protected')).toBeInTheDocument();
    expect(runButton()).toBeDisabled();
  });

  it('removes the file and starts clean with the next one', async () => {
    renderPage();
    await drop([PDF]);
    await screen.findByText('6 pages');
    fireEvent.change(rangeInput(), { target: { value: '1-2' } });
    fireEvent.click(document.getElementById('extract-remove-file') as HTMLButtonElement);
    expect(document.getElementById('extract-drop-zone')).not.toBeNull();

    await drop(['C:\\Docs\\other.pdf']);
    await screen.findByText('6 pages');
    expect(rangeInput().value).toBe('');
    expect(nameInput().placeholder).toBe('extracted_other');
  });
});
