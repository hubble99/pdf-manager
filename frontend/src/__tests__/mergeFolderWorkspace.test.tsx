import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_FINISHED_EVENT, CORE_PROGRESS_EVENT } from '../api/nativeCore';
import { FileProvider } from '../context/FileContext';
import { ToastProvider } from '../context/ToastContext';
import { ToastContainer } from '../components/ToastContainer';
import { MergePage } from '../pages/MergePage';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }),
}));

const tauriState = vi.hoisted(() => ({ available: true, chosen: 'C:\\Docs\\Reports' as string | null }));
vi.mock('../utils/tauriDialog', () => ({
  isTauri: () => tauriState.available,
  chooseFolderDialog: vi.fn(async () => tauriState.chosen),
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

const folder = (name: string, relativePath: string, pdfCount: number, files: string[], folders: unknown[] = []) =>
  ({ name, relativePath, pdfCount, folders, files });

const listing = {
  root: folder('Reports', '', 4, ['summary.pdf'], [
    folder('Q1', 'Q1', 3, ['report-jan.pdf', 'report-feb.pdf', 'report10.pdf']),
  ]),
  pdfCount: 4,
  skipped: 0,
  depthCapped: false,
  entryCapped: false,
};

let scanResult: unknown;
let inspection: { usable: number; problems: Array<{ index: number; reason: string }> };
let describeFiles: (paths: string[]) => Array<{ sizeBytes: number; pages: number | null }>;

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <FileProvider>
          <MergePage />
          <ToastContainer />
        </FileProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function openFolderMode() {
  renderPage();
  fireEvent.click(screen.getByRole('tab', { name: 'Folder' }));
  fireEvent.click(document.getElementById('merge-choose-folder') as HTMLButtonElement);
  await screen.findByText('Q1');
}

const queueItems = () => [...document.querySelectorAll('.merge-queue-name')].map((n) => n.textContent);
const calls = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);
const mergeArgs = () => calls('core_pdf_merge_start')[0][1] as Record<string, unknown>;

/** Top-level folders arrive already expanded. */
const openFolderRow = async (name: string, file: string) => {
  const expand = screen.queryByRole('button', { name: new RegExp(`^Expand ${name}$`) });
  if (expand) fireEvent.click(expand);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: new RegExp(`Add ${file}`, 'i') })).toBeTruthy());
};

const mergeReport = (overrides: Record<string, unknown> = {}) => ({
  outputPath: 'C:\\Users\\a\\Downloads\\merged_output.pdf',
  outputSizeBytes: 3_000_000,
  totalPages: 4,
  mergedFiles: 4,
  skipped: [],
  durationMs: 900,
  ...overrides,
});

const finishMerge = (result: unknown) =>
  emit(CORE_FINISHED_EVENT, { jobId: 11, kind: 'pdf_merge', status: 'succeeded', result });

describe('merge folder mode', () => {
  beforeEach(() => {
    handlers = {};
    tauriState.available = true;
    tauriState.chosen = 'C:\\Docs\\Reports';
    scanResult = listing;
    inspection = { usable: 3, problems: [] };
    describeFiles = (paths) => paths.map(() => ({ sizeBytes: 1024, pages: 2 }));
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockImplementation(async (event, handler) => {
      (handlers[event] ??= []).push(handler as unknown as Handler);
      return () => undefined;
    });
    invokeMock.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case 'core_folder_scan':
          if (scanResult instanceof Error) throw scanResult;
          return scanResult;
        case 'core_pdf_inspect':
          return inspection;
        case 'core_pdf_describe':
          return describeFiles((args as { paths: string[] }).paths);
        case 'core_pdf_merge_start':
          return 11;
        case 'core_job_cancel':
        case 'core_reveal_path':
          return undefined;
        default:
          throw new Error(`unexpected ${cmd}`);
      }
    });
  });

  it('disables folder mode without the desktop shell', () => {
    tauriState.available = false;
    renderPage();
    expect(screen.getByRole('tab', { name: 'Folder' })).toBeDisabled();
    expect(screen.getByText('Folder mode requires the desktop app')).toBeInTheDocument();
  });

  it('indents PDFs inside a folder deeper than PDFs at the root of the chosen folder', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    const indent = (name: string) => parseFloat(
      (screen.getByRole('button', { name: new RegExp(`Add ${name}`, 'i') }) as HTMLElement).style.paddingLeft || '32');
    // Root PDFs use the stylesheet default (aligned with top-level folders); folder PDFs sit deeper.
    expect(indent('report-jan.pdf')).toBeGreaterThan(indent('summary.pdf'));
  });

  it('keeps quick mode state when switching modes', async () => {
    renderPage();
    // Folder mode adds a second page body, so identify Quick's by its drop zone.
    const quickBody = (document.getElementById('merge-drop-zone') as HTMLElement)
      .closest('.page-body') as HTMLElement;
    expect(quickBody.hidden).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: 'Folder' }));
    // Quick mode stays mounted, so its work is not discarded.
    expect((document.getElementById('merge-drop-zone') as HTMLElement).closest('.page-body')).toBe(quickBody);
    expect(quickBody.hidden).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Quick' }));
    expect(quickBody.hidden).toBe(false);
    expect(quickBody.contains(document.getElementById('merge-drop-zone'))).toBe(true);
  });

  it('lists the chosen folder without filling the queue', async () => {
    await openFolderMode();
    expect(calls('core_folder_scan')[0][1]).toEqual({ root: 'C:\\Docs\\Reports' });
    expect(screen.getByText('C:\\Docs\\Reports')).toBeInTheDocument();
    expect(queueItems()).toEqual([]);
    expect(screen.getByText('Add files from the folder on the left.')).toBeInTheDocument();
  });

  it('shows folders with their subtree counts before expanding', async () => {
    await openFolderMode();
    const row = screen.getByRole('button', { name: /Collapse Q1/ });
    expect(row).toHaveTextContent('Q1');
    expect(row).toHaveTextContent('3');
  });

  it('adds a single file and requires two files to merge', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add report-jan\.pdf/i }));

    expect(queueItems()).toEqual(['report-jan.pdf']);
    expect(document.getElementById('merge-folder-run')).toBeDisabled();
    expect(screen.getByText('Add at least 2 files.')).toBeInTheDocument();
  });

  it('adds a whole folder in tree order and marks what is queued', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add all 3 PDFs under Q1/ }));

    // The order is the tree's display order, which the listing already sorted.
    expect(queueItems()).toEqual(['report-jan.pdf', 'report-feb.pdf', 'report10.pdf']);
    expect(screen.getByRole('button', { name: /report-feb\.pdf is already queued/ })).toBeDisabled();
    expect(document.getElementById('merge-folder-run')).toBeEnabled();
  });

  it('does not add the same file twice', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add report-jan\.pdf/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add all 3 PDFs under Q1/ }));
    expect(queueItems()).toEqual(['report-jan.pdf', 'report-feb.pdf', 'report10.pdf']);
  });

  it('reorders, moves and clears the queue', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add all 3 PDFs under Q1/ }));

    fireEvent.click(screen.getByRole('button', { name: /Move report-jan\.pdf down/ }));
    expect(queueItems()[1]).toBe('report-jan.pdf');

    fireEvent.click(screen.getByRole('button', { name: /Remove report10\.pdf/ }));
    expect(queueItems()).toHaveLength(2);

    fireEvent.click(screen.getByText('Clear'));
    expect(queueItems()).toEqual([]);
  });

  it('shows the relative folder on every queue row', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add report-jan\.pdf/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add summary\.pdf/i }));

    const folders = [...document.querySelectorAll('.merge-queue-folder')].map((n) => n.textContent);
    // Both rows carry a folder line, so heights match and duplicates stay clear.
    expect(folders).toHaveLength(2);
    expect(folders[0]).toBe('Q1/');
    expect(folders[1]?.trim()).toBe('');
  });

  it('shows page count and size on queued files, like quick mode', async () => {
    describeFiles = (paths) => paths.map((path) => (
      path === 'summary.pdf' ? { sizeBytes: 2048, pages: 1 } : { sizeBytes: 1_536_000, pages: 12 }
    ));
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add report-jan\.pdf/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add summary\.pdf/i }));

    await waitFor(() => {
      const meta = [...document.querySelectorAll('.merge-queue-meta')].map((n) => n.textContent);
      expect(meta).toEqual(['12 pages · 1.46 MB', '1 page · 2.0 KB']);
    });
    // The names are sent relative to the chosen folder.
    expect(calls('core_pdf_describe').at(-1)![1]).toMatchObject({ root: 'C:\\Docs\\Reports' });
  });

  it('merges directly when nothing is wrong, with progress and a result', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add all 3 PDFs under Q1/ }));
    fireEvent.click(document.getElementById('merge-folder-run') as HTMLButtonElement);

    await waitFor(() => expect(calls('core_pdf_merge_start')).toHaveLength(1));
    expect(calls('core_pdf_inspect')).toHaveLength(1);
    expect(mergeArgs()).toEqual({
      paths: ['Q1/report-jan.pdf', 'Q1/report-feb.pdf', 'Q1/report10.pdf'],
      root: 'C:\\Docs\\Reports',
      skipInvalid: false,
      outputName: 'merged_output.pdf',
    });

    emit(CORE_PROGRESS_EVENT, { jobId: 11, kind: 'pdf_merge', stage: 'files', done: 1, total: 3 });
    expect(await screen.findByText('Merging file 2 of 3…')).toBeInTheDocument();
    emit(CORE_PROGRESS_EVENT, { jobId: 11, kind: 'pdf_merge', stage: 'saving', done: 0, total: null });
    expect(await screen.findByText('Saving the merged PDF…')).toBeInTheDocument();

    finishMerge(mergeReport());
    expect(await screen.findByText(/4 files merged successfully/)).toBeInTheDocument();
    expect(screen.queryByText('Saving the merged PDF…')).not.toBeInTheDocument();
    fireEvent.click(document.getElementById('merge-folder-open-folder-btn') as HTMLButtonElement);
    await waitFor(() => expect(calls('core_reveal_path')[0][1]).toEqual({ path: 'C:\\Users\\a\\Downloads\\merged_output.pdf' }));
  });

  it('cancels a running merge', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add all 3 PDFs under Q1/ }));
    fireEvent.click(document.getElementById('merge-folder-run') as HTMLButtonElement);
    await waitFor(() => expect(calls('core_pdf_merge_start')).toHaveLength(1));

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls('core_job_cancel')[0][1]).toEqual({ jobId: 11 }));
    emit(CORE_FINISHED_EVENT, { jobId: 11, kind: 'pdf_merge', status: 'cancelled' });
    await waitFor(() => expect(document.getElementById('merge-folder-run')).toBeEnabled());
    // Cancelling is not a failure.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Merged/)).not.toBeInTheDocument();
  });

  it('reports problems and merges only the files the user keeps', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add all 3 PDFs under Q1/ }));
    inspection = { usable: 2, problems: [{ index: 1, reason: 'encrypted' }] };

    fireEvent.click(document.getElementById('merge-folder-run') as HTMLButtonElement);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('1 file cannot be merged')).toBeInTheDocument();
    expect(within(dialog).getByText('Q1/report-feb.pdf')).toBeInTheDocument();
    expect(within(dialog).getByText('(password protected)')).toBeInTheDocument();
    expect(calls('core_pdf_merge_start')).toHaveLength(0);

    fireEvent.click(document.getElementById('merge-skip-and-merge') as HTMLButtonElement);
    await waitFor(() => expect(calls('core_pdf_merge_start')).toHaveLength(1));
    expect(mergeArgs().paths).toEqual(['Q1/report-jan.pdf', 'Q1/report10.pdf']);
    expect(mergeArgs().skipInvalid).toBe(true);

    finishMerge(mergeReport({ mergedFiles: 2, totalPages: 2 }));
    expect(await screen.findByText(/2 files merged successfully/)).toBeInTheDocument();
  });

  it('blocks the merge when skipping would leave too few files', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add report-jan\.pdf/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add report-feb\.pdf/i }));
    inspection = { usable: 1, problems: [{ index: 1, reason: 'encrypted' }] };

    fireEvent.click(document.getElementById('merge-folder-run') as HTMLButtonElement);
    await screen.findByRole('alertdialog');
    fireEvent.click(document.getElementById('merge-skip-and-merge') as HTMLButtonElement);

    expect(await screen.findByText(/Fewer than 2 files can be merged/)).toBeInTheDocument();
    expect(calls('core_pdf_merge_start')).toHaveLength(0);
  });

  it('cancels the preflight without merging', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add all 3 PDFs under Q1/ }));
    inspection = { usable: 2, problems: [{ index: 0, reason: 'damaged or unreadable' }] };

    fireEvent.click(document.getElementById('merge-folder-run') as HTMLButtonElement);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('(damaged or unreadable)')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText('Cancel'));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls('core_pdf_merge_start')).toHaveLength(0);
    expect(queueItems()).toHaveLength(3);
  });

  it('explains why a merge failed in plain words', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add all 3 PDFs under Q1/ }));
    fireEvent.click(document.getElementById('merge-folder-run') as HTMLButtonElement);
    await waitFor(() => expect(calls('core_pdf_merge_start')).toHaveLength(1));

    emit(CORE_FINISHED_EVENT, {
      jobId: 11,
      kind: 'pdf_merge',
      status: 'failed',
      error: { code: 'invalid_input', message: "invalid input: Cannot open 'report-feb.pdf': broken" },
    });
    expect(await screen.findByText('report-feb.pdf could not be opened. It may be damaged.')).toBeInTheDocument();
  });

  it('shows why a folder could not be read and goes back to the clean state', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Folder' }));
    scanResult = Object.assign(new Error('x'), { code: 'invalid_input', message: 'invalid input: That folder does not exist or is not a folder.' });
    fireEvent.click(document.getElementById('merge-choose-folder') as HTMLButtonElement);
    expect(await screen.findByText('That folder could not be read.')).toBeInTheDocument();
    expect(screen.getByText('Choose a folder')).toBeInTheDocument();
  });

  it('refreshes the listing', async () => {
    await openFolderMode();
    fireEvent.click(document.getElementById('merge-refresh-folder') as HTMLButtonElement);
    await waitFor(() => expect(calls('core_folder_scan')).toHaveLength(2));
  });

  it('reports how many items could not be read', async () => {
    scanResult = { ...listing, skipped: 2 };
    await openFolderMode();
    expect(screen.getByText('2 items could not be read')).toBeInTheDocument();
  });
});
