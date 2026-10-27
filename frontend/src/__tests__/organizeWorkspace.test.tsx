import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../context/ToastContext';
import { ToastContainer } from '../components/ToastContainer';
import { NativeCoreError } from '../api/nativeCore';
import { OrganizePage } from '../pages/OrganizePage';

const { uploadMock, thumbsMock, assembleMock, releaseMock, pickerMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(),
  thumbsMock: vi.fn(),
  assembleMock: vi.fn(),
  releaseMock: vi.fn(),
  pickerMock: vi.fn(),
}));

vi.mock('../features/organize/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/organize/api')>();
  return {
    ...actual,
    openDocument: uploadMock,
    fetchThumbnails: thumbsMock,
    assembleDocument: assembleMock,
    releaseDocument: releaseMock,
  };
});

vi.mock('../utils/tauriDialog', () => ({
  isTauri: () => true,
  openFilePicker: pickerMock,
  openOutputFolder: vi.fn(async () => true),
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }),
}));

const PAGE_WIDTH = 150;
const BLANK_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DOCS = 'C:\\Docs\\';

function uploaded(documentId: string, name: string, pageCount: number, kind: 'pdf' | 'image' = 'pdf') {
  return { documentId, name, kind, pageCount };
}

/** Serve the uploaded documents the workspace asks for. */
function stubUploads(mainPageCount: number) {
  uploadMock.mockImplementation(async (path: string) => {
    const name = path.split('\\').pop() as string;
    if (name === 'doc.pdf') return uploaded('doc-main', 'doc.pdf', mainPageCount);
    if (name === 'other.pdf') return uploaded('doc-2', 'other.pdf', 12);
    if (name === 'single.pdf') return uploaded('doc-4', 'single.pdf', 1);
    if (name === 'photo.png') return uploaded('doc-3', 'photo.png', 1, 'image');
    return uploaded(`doc-${name}`, name, 1);
  });
}

/** Upload the main document and wait for the grid to appear. */
async function openDocument(pageCount = 5) {
  stubUploads(pageCount);
  render(
    <MemoryRouter>
      <ToastProvider>
        <OrganizePage />
        <ToastContainer />
      </ToastProvider>
    </MemoryRouter>,
  );

  pickerMock.mockResolvedValueOnce([`${DOCS}doc.pdf`]);
  fireEvent.click(document.getElementById('organize-drop-zone') as HTMLElement);
  await waitFor(() => expect(uploadMock).toHaveBeenCalled());
  await waitFor(() => expect(document.querySelectorAll('.organize-cell')).toHaveLength(pageCount));
}

/** The cell body button, matched exactly so it cannot be confused with actions. */
function cellBody(cell: Element, position: number): HTMLElement {
  return within(cell as HTMLElement).getByRole('button', { name: `Page at position ${position}` });
}

const cells = () => [...document.querySelectorAll('.organize-cell')];
const positions = () => cells().map((cell) => cell.querySelector('.organize-cell-position')?.textContent);
const thumbKeys = () =>
  cells().map((cell) => (cell.querySelector('img') as HTMLImageElement | null)?.src ?? 'placeholder');
/** A cell's own action button, e.g. "Rotate page at position 2". */
const cellAction = (cell: Element, label: string) =>
  within(cell as HTMLElement).getByRole('button', { name: new RegExp(`^${label} page at position`, 'i') });

function selectCell(index: number, modifiers: Partial<MouseEventInit> = {}) {
  fireEvent.click(cellBody(cells()[index], index + 1), modifiers);
}

/** Click a header insert button; the system dialog answers with the named file. */
async function insertFrom(fileName: string, buttonLabel: 'PDF' | 'Image') {
  pickerMock.mockResolvedValueOnce([`${DOCS}${fileName}`]);
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`Insert ${buttonLabel}$`, 'i') }));
  await waitFor(() => expect(screen.getByLabelText('Insert pages')).toBeInTheDocument());
}

describe('organize workspace', () => {
  beforeAll(() => {
    URL.createObjectURL = vi.fn(() => `blob:thumb-${Math.random().toString(36).slice(2)}`);
    URL.revokeObjectURL = vi.fn();
  });

  beforeEach(() => {
    uploadMock.mockReset();
    thumbsMock.mockReset();
    assembleMock.mockReset();
    releaseMock.mockReset();
    pickerMock.mockReset();
    releaseMock.mockResolvedValue(undefined);

    thumbsMock.mockImplementation(async (_id: string, start: number, count: number) => ({
      start,
      total: 99,
      pages: Array.from({ length: count }, (_, index) => ({
        page: start + index, png: BLANK_PNG, width: PAGE_WIDTH, height: 200,
      })),
    }));
    assembleMock.mockResolvedValue({
      outputPath: 'C:\\Users\\Dhoni\\Downloads\\organized.pdf',
      outputSizeBytes: 2048,
      pages: 2,
      durationMs: 5,
    });
  });

  it('shows every page of the opened document with live position numbers', async () => {
    await openDocument(5);
    expect(positions()).toEqual(['1', '2', '3', '4', '5']);
    expect(within(screen.getByLabelText('Main PDF')).getByText(/5 pages/)).toBeInTheDocument();
  });

  it('loads thumbnails in bounded batches and shows progress, then hides it', async () => {
    await openDocument(60);

    // 60 pages in batches of 24 -> three requests, not sixty.
    await waitFor(() => expect(thumbsMock.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(thumbsMock.mock.calls.length).toBeLessThanOrEqual(4);
    expect(thumbsMock.mock.calls.map((call) => call[1])).toEqual([1, 25, 49]);
    await waitFor(() => expect(document.querySelectorAll('.organize-cell img')).toHaveLength(60));
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
  });

  it('renders placeholders immediately and stays editable while thumbnails load', async () => {
    let release: (value: unknown) => void = () => {};
    thumbsMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await openDocument(3);

    await waitFor(() => expect(document.querySelectorAll('.organize-cell-placeholder')).toHaveLength(3));
    // Editing works while rendering is still in flight.
    fireEvent.click(cellAction(cells()[0], 'Rotate'));
    // The edit registered even though no thumbnail has arrived yet.
    expect(screen.getByRole('button', { name: /^Undo$/i })).toBeEnabled();
    expect(cells()[0].querySelector('img')).toBeNull();
    release({ total: 3, pages: [] });
  });

  it('does not assemble the document while editing', async () => {
    await openDocument(5);
    selectCell(0);
    fireEvent.click(screen.getByRole('button', { name: /^Rotate$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Flip$/i }));
    fireEvent.click(cellAction(cells()[2], 'Duplicate'));
    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('selects one page, toggles with ctrl, and selects a range with shift', async () => {
    await openDocument(6);
    selectCell(1);
    expect(document.querySelector('.organize-selection-bar')).toHaveTextContent('1 selected');

    selectCell(3, { ctrlKey: true });
    expect(document.querySelector('.organize-selection-bar')).toHaveTextContent('2 selected');

    selectCell(5, { shiftKey: true });
    // The anchor is the last clicked page (index 3), so 3-5 is three pages.
    expect(document.querySelector('.organize-selection-bar')).toHaveTextContent('3 selected');
  });

  it('applies rotate and flip to only the clicked cell', async () => {
    await openDocument(3);
    fireEvent.click(cellAction(cells()[1], 'Rotate'));
    fireEvent.click(cellAction(cells()[1], 'Mirror'));
    const styled = cells().map((cell) => (cell.querySelector('img') as HTMLImageElement).getAttribute('style'));
    expect(styled[1]).toContain('rotate(90deg)');
    expect(styled[1]).toContain('scaleX(-1)');
    expect(styled[0]).toContain('rotate(0deg)');
    expect(styled[0]).not.toContain('scaleX(-1)');
  });

  it('duplicates a page next to the original with its own orientation', async () => {
    await openDocument(3);
    fireEvent.click(cellAction(cells()[0], 'Rotate'));
    fireEvent.click(cellAction(cells()[0], 'Duplicate'));
    expect(positions()).toEqual(['1', '2', '3', '4']);
    const styled = cells().map((cell) => (cell.querySelector('img') as HTMLImageElement).getAttribute('style'));
    expect(styled[1]).toContain('rotate(90deg)');
    expect(styled[2]).toContain('rotate(0deg)');
  });

  it('removes a single page from its own cell action', async () => {
    await openDocument(4);
    fireEvent.click(cellAction(cells()[1], 'Delete'));
    expect(positions()).toEqual(['1', '2', '3']);
  });

  it('previews a bulk deletion with a live count and highlights the affected cells', async () => {
    await openDocument(6);
    fireEvent.click(screen.getByRole('button', { name: /Delete pages/i }));
    fireEvent.change(screen.getByLabelText('Pages'), { target: { value: '2-4, 6' } });

    expect(screen.getByText(/Will delete 4 pages/)).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll('.organize-cell--highlighted')).toHaveLength(4));
  });

  it('blocks bulk deletion with an inline error for an out-of-range expression', async () => {
    await openDocument(4);
    fireEvent.click(screen.getByRole('button', { name: /Delete pages/i }));
    fireEvent.change(screen.getByLabelText('Pages'), { target: { value: '9' } });

    expect(await screen.findByRole('alert')).toHaveTextContent('between 1 and 4');
    expect(document.getElementById('organize-delete-confirm')).toBeDisabled();
  });

  it('treats one confirmed bulk deletion as a single undo step', async () => {
    await openDocument(6);
    fireEvent.click(screen.getByRole('button', { name: /Delete pages/i }));
    fireEvent.change(screen.getByLabelText('Pages'), { target: { value: '2-4' } });
    fireEvent.click(document.getElementById('organize-delete-confirm') as HTMLButtonElement);
    expect(positions()).toEqual(['1', '2', '3']);

    fireEvent.click(screen.getByRole('button', { name: /^Undo$/i }));
    expect(positions()).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('undoes a single rotation without disturbing other pages, and redoes it', async () => {
    await openDocument(3);
    fireEvent.click(cellAction(cells()[1], 'Rotate'));
    fireEvent.click(screen.getByRole('button', { name: /^Undo$/i }));
    const afterUndo = cells().map((cell) => cell.querySelector('img')?.getAttribute('style'));
    expect(afterUndo[1]).toContain('rotate(0deg)');

    fireEvent.click(screen.getByRole('button', { name: /^Redo$/i }));
    expect(cells()[1].querySelector('img')?.getAttribute('style')).toContain('rotate(90deg)');
  });

  it('does not create separate thumbnail requests for duplicates or orientation changes', async () => {
    await openDocument(3);
    await waitFor(() => expect(document.querySelectorAll('.organize-cell img')).toHaveLength(3));
    const before = thumbsMock.mock.calls.length;

    fireEvent.click(cellAction(cells()[0], 'Rotate'));
    fireEvent.click(cellAction(cells()[0], 'Duplicate'));
    expect(thumbsMock.mock.calls.length).toBe(before);
    expect(thumbKeys()[0]).toBe(thumbKeys()[1]);
  });

  it('inserts a source after the selected page, preserving pick order and duplicates', async () => {
    await openDocument(7);
    selectCell(4);
    await insertFrom('other.pdf', 'PDF');
    fireEvent.click(screen.getByRole('radio', { name: 'Pick' }));
    fireEvent.change(screen.getByLabelText('Pages to insert from the source file'), {
      target: { value: '7, 1, 3' },
    });
    fireEvent.click(document.getElementById('organize-insert-confirm') as HTMLButtonElement);

    expect(positions()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    // Inserted cells carry a source badge; the main document does not.
    expect(cells()[5].querySelector('.organize-cell-source')).toHaveTextContent('B');
    expect(cells()[0].querySelector('.organize-cell-source')).toBeNull();
  });

  it('inserts an image at the end when nothing is selected', async () => {
    await openDocument(3);
    await insertFrom('photo.png', 'Image');
    // An image always contributes one page and offers no page picking.
    expect(screen.queryByText('Pick')).not.toBeInTheDocument();
    // With no selection the reference defaults to the last page of the grid.
    expect((screen.getByLabelText('Reference page') as HTMLInputElement).value).toBe('3');
    fireEvent.click(document.getElementById('organize-insert-confirm') as HTMLButtonElement);
    expect(positions()).toEqual(['1', '2', '3', '4']);
  });

  it('hides the Pages option for a single-page source', async () => {
    await openDocument(3);
    await insertFrom('single.pdf', 'PDF');
    expect(screen.queryByText('All')).not.toBeInTheDocument();
    expect(screen.queryByText('Pick')).not.toBeInTheDocument();
    // The panel still offers positioning for the one page it can add.
    expect(screen.getByLabelText('Reference page')).toBeInTheDocument();
  });

  it('states where the pages will land using the current grid', async () => {
    await openDocument(7);
    selectCell(4);
    await insertFrom('other.pdf', 'PDF');
    expect((screen.getByLabelText('Reference page') as HTMLInputElement).value).toBe('5');
    expect(screen.getByText('Will be inserted after page 5 (of 7).')).toBeInTheDocument();
    expect(screen.queryByText(/end of the document/i)).not.toBeInTheDocument();
  });

  it('inserts at the typed reference page rather than at the document end', async () => {
    await openDocument(6);
    selectCell(5);
    await insertFrom('single.pdf', 'PDF');
    fireEvent.change(screen.getByLabelText('Reference page'), { target: { value: '2' } });
    expect(screen.getByText('Will be inserted after page 2 (of 6).')).toBeInTheDocument();
    fireEvent.click(document.getElementById('organize-insert-confirm') as HTMLButtonElement);

    // The source page lands between grid pages 2 and 3, not at the end.
    expect(positions()).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    const badges = cells().map((cell) => cell.querySelector('.organize-cell-source')?.textContent ?? '');
    expect(badges[2]).toBe('B');
  });

  it('inserts before the reference page when Before is chosen', async () => {
    await openDocument(5);
    selectCell(2);
    await insertFrom('single.pdf', 'PDF');
    fireEvent.click(screen.getByRole('radio', { name: 'Before' }));
    // "Before" re-derives the reference from the first selected page.
    expect((screen.getByLabelText('Reference page') as HTMLInputElement).value).toBe('3');
    expect(screen.getByText('Will be inserted before page 3 (of 5).')).toBeInTheDocument();
    fireEvent.click(document.getElementById('organize-insert-confirm') as HTMLButtonElement);

    const badges = cells().map((cell) => cell.querySelector('.organize-cell-source')?.textContent ?? '');
    expect(badges[2]).toBe('B');
  });

  it('keeps a typed reference page when the active side is chosen again', async () => {
    await openDocument(6);
    await insertFrom('single.pdf', 'PDF');
    fireEvent.change(screen.getByLabelText('Reference page'), { target: { value: '2' } });
    // After is already active, so this must not re-derive the reference.
    fireEvent.click(screen.getByRole('radio', { name: 'After' }));
    expect((screen.getByLabelText('Reference page') as HTMLInputElement).value).toBe('2');

    // Switching to the other side does re-derive it from the selection.
    fireEvent.click(screen.getByRole('radio', { name: 'Before' }));
    expect((screen.getByLabelText('Reference page') as HTMLInputElement).value).toBe('6');
  });

  it('clicking a cell while the panel is open moves the reference page', async () => {
    await openDocument(8);
    await insertFrom('other.pdf', 'PDF');
    selectCell(6);
    expect((screen.getByLabelText('Reference page') as HTMLInputElement).value).toBe('7');
    expect(screen.getByText('Will be inserted after page 7 (of 8).')).toBeInTheDocument();
  });

  it('marks where the insertion will land in the grid', async () => {
    await openDocument(5);
    selectCell(1);
    await insertFrom('other.pdf', 'PDF');
    const marked = cells().filter((cell) => cell.className.includes('organize-cell--marker-'));
    expect(marked).toHaveLength(1);
    expect(marked[0].className).toContain('organize-cell--marker-after');
    expect(marked[0].getAttribute('data-position')).toBe('2');
  });

  it('blocks insertion with an inline error when the reference page is out of range', async () => {
    await openDocument(4);
    await insertFrom('other.pdf', 'PDF');
    fireEvent.change(screen.getByLabelText('Reference page'), { target: { value: '9' } });

    expect(await screen.findByRole('alert')).toHaveTextContent('Reference page must be between 1 and 4');
    expect(document.getElementById('organize-insert-confirm')).toBeDisabled();
  });

  it('shows why a file could not be added and keeps the workspace as it was', async () => {
    await openDocument(3);
    uploadMock.mockRejectedValueOnce(new NativeCoreError('invalid_input', 'invalid input: Cannot open PDF: broken'));
    pickerMock.mockResolvedValueOnce([`${DOCS}broken.pdf`]);
    fireEvent.click(screen.getByRole('button', { name: /Insert PDF$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('does not look like a valid PDF');
    expect(screen.queryByLabelText('Insert pages')).not.toBeInTheDocument();
    expect(positions()).toEqual(['1', '2', '3']);
  });

  it('does not add the same file twice, whatever the case of its path', async () => {
    await openDocument(3);
    await insertFrom('other.pdf', 'PDF');
    fireEvent.click(document.getElementById('organize-insert-confirm') as HTMLButtonElement);
    const opened = uploadMock.mock.calls.length;

    pickerMock.mockResolvedValueOnce([`${DOCS.toLowerCase()}OTHER.pdf`]);
    fireEvent.click(screen.getByRole('button', { name: /Insert PDF$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already in Sources');
    expect(uploadMock.mock.calls.length).toBe(opened);
  });

  it('reports an invalid insert pick inline and disables Insert', async () => {
    await openDocument(3);
    await insertFrom('other.pdf', 'PDF');
    fireEvent.click(screen.getByRole('radio', { name: 'Pick' }));
    fireEvent.change(screen.getByLabelText('Pages to insert from the source file'), {
      target: { value: '99' },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('between 1 and 12');
    expect(document.getElementById('organize-insert-confirm')).toBeDisabled();
  });

  it('resolves before/after against the current grid after earlier inserts', async () => {
    await openDocument(7);
    selectCell(4);
    await insertFrom('photo.png', 'Image');
    fireEvent.click(document.getElementById('organize-insert-confirm') as HTMLButtonElement);
    expect(positions()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);

    // The page that was 7 now sits at position 7 (index 6): insert after it.
    selectCell(6);
    await insertFrom('other.pdf', 'PDF');
    fireEvent.click(screen.getByRole('radio', { name: 'Pick' }));
    fireEvent.change(screen.getByLabelText('Pages to insert from the source file'), {
      target: { value: '2-3' },
    });
    fireEvent.click(document.getElementById('organize-insert-confirm') as HTMLButtonElement);

    expect(positions()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    const badges = cells().map((cell) => cell.querySelector('.organize-cell-source')?.textContent ?? '');
    expect(badges[5], JSON.stringify(badges)).toBe('B');   // image inserted after position 5
    expect(badges[7], JSON.stringify(badges)).toBe('C');   // then PDF pages after the page now at 7
    expect(badges[8], JSON.stringify(badges)).toBe('C');
  });

  it('lists inserted sources and removes a source together with its pages', async () => {
    await openDocument(3);
    await insertFrom('photo.png', 'Image');
    fireEvent.click(document.getElementById('organize-insert-confirm') as HTMLButtonElement);
    fireEvent.click(screen.getByRole('button', { name: /^Sources/ }));

    const panel = screen.getByLabelText('Sources');
    expect(within(panel).getByText(/photo\.png/)).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: /Remove photo\.png/i }));
    fireEvent.click(within(panel).getByRole('button', { name: /^Confirm$/ }));

    expect(positions()).toEqual(['1', '2', '3']);
    await waitFor(() => expect(releaseMock).toHaveBeenCalledWith('doc-3'));
  });

  it('resets back to the initial document and drops the inserted sources', async () => {
    await openDocument(3);
    await insertFrom('photo.png', 'Image');
    fireEvent.click(document.getElementById('organize-insert-confirm') as HTMLButtonElement);
    fireEvent.click(cellAction(cells()[0], 'Rotate'));
    expect(positions()).toHaveLength(4);

    fireEvent.click(screen.getByRole('button', { name: /^Reset$/i }));
    expect(positions()).toEqual(['1', '2', '3']);
    expect(cells()[0].querySelector('img')?.getAttribute('style')).toContain('rotate(0deg)');

    fireEvent.click(screen.getByRole('button', { name: /^Sources/ }));
    const panel = within(screen.getByLabelText('Sources'));
    // The released file is gone; the main document lives in the header bar.
    expect(panel.queryByText(/photo\.png/)).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Main PDF')).getByText(/doc\.pdf/)).toBeInTheDocument();
  });

  it('removing the document the workspace started from clears it back to the drop zone', async () => {
    await openDocument(3);
    fireEvent.click(document.getElementById('organize-close-document') as HTMLButtonElement);
    const confirm = document.getElementById('organize-close-confirm');
    if (confirm) fireEvent.click(confirm);

    expect(document.querySelectorAll('.organize-cell')).toHaveLength(0);
    expect(screen.getByLabelText('Drop your PDF here, or press Enter to pick one')).toBeInTheDocument();
    await waitFor(() => expect(releaseMock).toHaveBeenCalledWith('doc-main'));
  });

  it('saves the final list in grid order and reports the result', async () => {
    await openDocument(4);
    selectCell(1);
    fireEvent.click(screen.getByRole('button', { name: /^Rotate$/i }));
    fireEvent.click(cellAction(cells()[2], 'Mirror'));
    fireEvent.click(cellAction(cells()[0], 'Duplicate'));

    fireEvent.click(document.getElementById('organize-save') as HTMLButtonElement);
    await waitFor(() => expect(assembleMock).toHaveBeenCalled());

    const [payload, filename] = assembleMock.mock.calls[0];
    expect(filename).toBe('organized');
    expect(payload).toHaveLength(5);
    expect(payload[0]).toMatchObject({ page: 1, rotation: 0, flip: false });
    expect(payload[1]).toMatchObject({ page: 1, rotation: 0, flip: false }); // the duplicate
    expect(payload[2]).toMatchObject({ page: 2, rotation: 90, flip: false });
    expect(payload[3]).toMatchObject({ page: 3, rotation: 0, flip: true });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('keeps the working list and reports an inline error when saving fails', async () => {
    await openDocument(3);
    assembleMock.mockRejectedValue(new Error('Assembly failed'));
    fireEvent.click(document.getElementById('organize-save') as HTMLButtonElement);

    // The message appears inline and as a toast; the inline one is what keeps
    // the list recoverable, so assert on that container specifically.
    await waitFor(() => expect(document.querySelector('.converter-message--error'))
      .toHaveTextContent('Assembly failed'));
    expect(positions()).toEqual(['1', '2', '3']);
    expect(document.getElementById('organize-save')).toBeEnabled();
  });
});

describe('thumbnail batch message', () => {
  it('is read back page by page', async () => {
    const { decodeThumbnailBatch } = await import('../features/organize/api');
    const frame: number[] = [];
    const word = (value: number) => frame.push(value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255);
    [3, 10, 2].forEach(word);
    [3, 150, 200, 3].forEach(word);
    frame.push(1, 2, 3);
    [4, 150, 210, 1].forEach(word);
    frame.push(9);
    const batch = decodeThumbnailBatch(new Uint8Array(frame).buffer);
    expect(batch.start).toBe(3);
    expect(batch.total).toBe(10);
    expect(batch.pages.map((p) => [p.page, p.width, p.height, [...p.png]])).toEqual([
      [3, 150, 200, [1, 2, 3]],
      [4, 150, 210, [9]],
    ]);
  });
});
