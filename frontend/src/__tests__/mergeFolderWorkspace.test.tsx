import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileProvider } from '../context/FileContext';
import { ToastProvider } from '../context/ToastContext';
import { ToastContainer } from '../components/ToastContainer';
import { MergePage } from '../pages/MergePage';

const { registerMock, listMock, inspectMock, mergeMock, releaseMock, downloadMock, tauriState } = vi.hoisted(() => ({
  registerMock: vi.fn(),
  listMock: vi.fn(),
  inspectMock: vi.fn(),
  mergeMock: vi.fn(),
  releaseMock: vi.fn(),
  downloadMock: vi.fn(),
  tauriState: { available: true, chosen: 'C:/Docs/Reports' as string | null },
}));

vi.mock('../features/merge/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/merge/api')>();
  return {
    ...actual,
    registerFolder: registerMock,
    listFolder: listMock,
    inspectFiles: inspectMock,
    mergeFolderFiles: mergeMock,
    releaseFolder: releaseMock,
  };
});

vi.mock('../utils/tauriDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/tauriDialog')>();
  return {
    ...actual,
    isTauri: () => tauriState.available,
    chooseFolderDialog: vi.fn(async () => tauriState.chosen),
    openOutputFolder: vi.fn(async () => true),
  };
});

vi.mock('../utils/downloadHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/downloadHelper')>();
  return { ...actual, triggerBlobDownload: downloadMock };
});

const listing = {
  root: {
    name: 'Reports',
    relative_path: '',
    pdf_count: 4,
    folders: [
      {
        name: 'Q1', relative_path: 'Q1', pdf_count: 3,
        folders: [], files: ['report-jan.pdf', 'report-feb.pdf', 'report10.pdf'],
      },
    ],
    files: ['summary.pdf'],
  },
  pdf_count: 4,
  skipped: 0,
  depth_capped: false,
  entry_capped: false,
};

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
/** Ensure a folder is open. Top-level folders arrive already expanded. */
const openFolderRow = async (name: string, file: string) => {
  const expand = screen.queryByRole('button', { name: new RegExp(`^Expand ${name}$`) });
  if (expand) fireEvent.click(expand);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: new RegExp(`Add ${file}`, 'i') })).toBeTruthy());
};

describe('merge folder mode', () => {
  beforeEach(() => {
    registerMock.mockReset(); listMock.mockReset(); inspectMock.mockReset();
    mergeMock.mockReset(); releaseMock.mockReset(); downloadMock.mockReset();
    tauriState.available = true;
    tauriState.chosen = 'C:/Docs/Reports';

    registerMock.mockResolvedValue({ rootId: 'root-1', path: 'C:/Docs/Reports', name: 'Reports' });
    listMock.mockResolvedValue(listing);
    inspectMock.mockResolvedValue([]);
    mergeMock.mockResolvedValue({
      blob: new Blob(['pdf'], { type: 'application/pdf' }),
      filename: 'merged_output.pdf', totalPages: 4, merged: 4, skipped: 0,
    });
    releaseMock.mockResolvedValue(undefined);
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
    expect(registerMock).toHaveBeenCalledWith('C:/Docs/Reports');
    expect(screen.getByText('C:/Docs/Reports')).toBeInTheDocument();
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

  it('merges directly when nothing is wrong', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add all 3 PDFs under Q1/ }));
    fireEvent.click(document.getElementById('merge-folder-run') as HTMLButtonElement);

    await waitFor(() => expect(mergeMock).toHaveBeenCalled());
    expect(inspectMock).toHaveBeenCalled();
    expect(mergeMock.mock.calls[0][3]).toBe(false);
    expect(downloadMock).toHaveBeenCalled();
    expect(await screen.findByText(/Merged 4 files/)).toBeInTheDocument();
  });

  it('reports problems and merges only the files the user keeps', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add all 3 PDFs under Q1/ }));
    inspectMock.mockResolvedValue([{ path: 'Q1/report-feb.pdf', reason: 'encrypted' }]);

    fireEvent.click(document.getElementById('merge-folder-run') as HTMLButtonElement);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('1 file cannot be merged')).toBeInTheDocument();
    expect(within(dialog).getByText('(encrypted)')).toBeInTheDocument();
    expect(mergeMock).not.toHaveBeenCalled();

    fireEvent.click(document.getElementById('merge-skip-and-merge') as HTMLButtonElement);
    await waitFor(() => expect(mergeMock).toHaveBeenCalled());
    expect(mergeMock.mock.calls[0][1]).toEqual(['Q1/report-jan.pdf', 'Q1/report10.pdf']);
    expect(mergeMock.mock.calls[0][3]).toBe(true);
  });

  it('blocks the merge when skipping would leave too few files', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add report-jan\.pdf/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add report-feb\.pdf/i }));
    inspectMock.mockResolvedValue([{ path: 'Q1/report-feb.pdf', reason: 'encrypted' }]);

    fireEvent.click(document.getElementById('merge-folder-run') as HTMLButtonElement);
    await screen.findByRole('alertdialog');
    fireEvent.click(document.getElementById('merge-skip-and-merge') as HTMLButtonElement);

    expect(await screen.findByText(/Fewer than 2 files can be merged/)).toBeInTheDocument();
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it('cancels the preflight without merging', async () => {
    await openFolderMode();
    await openFolderRow('Q1', 'report-jan.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Add all 3 PDFs under Q1/ }));
    inspectMock.mockResolvedValue([{ path: 'a', reason: 'encrypted' }]);

    fireEvent.click(document.getElementById('merge-folder-run') as HTMLButtonElement);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('Cancel'));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mergeMock).not.toHaveBeenCalled();
    expect(queueItems()).toHaveLength(3);
  });

  it('explains a lapsed registration instead of showing a raw error', async () => {
    await openFolderMode();
    listMock.mockRejectedValue(new Error('Choose folder again.'));

    fireEvent.click(document.getElementById('merge-refresh-folder') as HTMLButtonElement);
    expect(await screen.findByText('Choose folder again.')).toBeInTheDocument();
    // The root is forgotten so the user is back at a clean folder state.
    expect(screen.getByText('Choose a folder')).toBeInTheDocument();
  });

  it('reports how many items could not be read', async () => {
    listMock.mockResolvedValue({ ...listing, skipped: 2 });
    await openFolderMode();
    expect(screen.getByText('2 items could not be read')).toBeInTheDocument();
  });
});
