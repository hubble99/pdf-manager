import { useState } from 'react';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileProvider } from '../context/FileContext';
import { ToastProvider } from '../context/ToastContext';
import { ConverterPage } from '../pages/ConverterPage';

const { postMock, downloadMock } = vi.hoisted(() => ({ postMock: vi.fn(), downloadMock: vi.fn() }));

vi.mock('../api/client', () => ({
  default: { post: postMock },
  checkHealth: vi.fn(async () => false),
}));

vi.mock('../utils/downloadHelper', () => ({
  triggerBlobDownload: downloadMock,
  getFilenameFromHeaders: (_headers: unknown, fallback: string) => fallback,
}));

vi.mock('../components/PdfThumbnail', () => ({
  PdfThumbnail: ({ page = 1 }: { page?: number }) => <span data-testid={`thumb-${page}`} />,
}));

vi.mock('../utils/tauriDialog', () => ({
  isTauri: () => false,
  openFilePicker: vi.fn(async () => null),
  openOutputFolder: vi.fn(async () => true),
}));

const pdfInfoResponse = (totalPages: number) => ({
  data: { status: 'success', data: { filename: 'doc.pdf', total_pages: totalPages, file_size_bytes: 512 } },
  headers: {},
});

function pdf(name = 'document.pdf') {
  return new File(['pdf-bytes'], name, { type: 'application/pdf' });
}

function image(name = 'photo.png', type = 'image/png') {
  return new File(['image-bytes'], name, { type });
}

function renderConverter() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <FileProvider>
          <ConverterPage />
        </FileProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function addFiles(files: File[]) {
  const input = document.getElementById('converter-file-input') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
  await waitFor(() => expect(postMock).toHaveBeenCalled());
}

function pageMode(name: 'All pages' | 'Selected pages') {
  return screen.getByRole('radio', { name: new RegExp(name, 'i') });
}

function rangeInput() {
  return screen.getByLabelText('Selected pages') as HTMLInputElement;
}

/** One thumbnail cell in the page picker; its name is "Page N" plus ", selected" when chosen. */
function pageCell(page: number) {
  return screen.getByRole('button', { name: new RegExp(`^Page ${page}(,|$)`) });
}

function pageCells() {
  return screen.getAllByRole('button', { name: /^Page \d+(,|$)/ });
}

function selectedPageCells() {
  return pageCells().filter((cell) => cell.getAttribute('aria-pressed') === 'true' || /selected/.test(cell.getAttribute('aria-label') ?? ''));
}

function convertButton() {
  return document.getElementById('converter-run') as HTMLButtonElement;
}

describe('unified converter workspace', () => {
  beforeAll(() => {
    URL.createObjectURL = vi.fn(() => 'blob:mock-preview');
    URL.revokeObjectURL = vi.fn();
  });

  beforeEach(() => {
    postMock.mockReset();
    downloadMock.mockReset();
    vi.mocked(URL.createObjectURL).mockClear();
    vi.mocked(URL.revokeObjectURL).mockClear();
    postMock.mockImplementation(async (url: string) => {
      if (url === '/api/v1/pdf-info/') return pdfInfoResponse(5);
      if (url === '/api/v1/pdf-to-image/') {
        return { data: new Blob(['img']), headers: { 'x-pages-exported': '1', 'x-format': 'PNG', 'x-dpi': '150' } };
      }
      if (url === '/api/v1/image-to-pdf/') {
        return { data: new Blob(['pdf']), headers: { 'x-total-pages': '2', 'x-page-size': 'A4' } };
      }
      if (url === '/api/v1/preview/') {
        return { data: new Blob(['png']), headers: {} };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it('derives PDF direction and keeps the page field disabled in All pages mode', async () => {
    renderConverter();
    expect(screen.queryByRole('radio', { name: /All pages/i })).not.toBeInTheDocument();

    await addFiles([pdf()]);
    await screen.findByText(/Total: 5 pages/);

    expect(pageMode('All pages')).toBeChecked();
    expect(rangeInput()).toBeDisabled();
    expect(rangeInput()).toHaveValue('');
    expect(screen.getByText('All 5 pages will be exported.')).toBeInTheDocument();
    expect(convertButton()).toBeEnabled();

    const cells = pageCells();
    expect(cells).toHaveLength(5);
    cells.forEach((cell) => expect(cell).toBeDisabled());
    expect(selectedPageCells()).toHaveLength(5);
  });

  it('derives image direction and shows only image controls', async () => {
    renderConverter();
    const input = document.getElementById('converter-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [image(), image('second.jpg', 'image/jpeg')] } });

    await screen.findByText('2 files');
    expect(screen.getByRole('radiogroup', { name: /Page Size/i })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /All pages/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Selected pages')).not.toBeInTheDocument();
    expect(convertButton()).toBeEnabled();
  });

  it('enables page selection in Selected pages mode and reports the count', async () => {
    renderConverter();
    await addFiles([pdf()]);
    await screen.findByText(/Total: 5 pages/);

    fireEvent.click(pageMode('Selected pages'));
    expect(rangeInput()).toBeEnabled();
    expect(screen.getByText('Choose at least one page. Enter a page or range, such as 2, 4-7.')).toBeInTheDocument();
    expect(convertButton()).toBeDisabled();

    fireEvent.change(rangeInput(), { target: { value: '1, 3-5, 4' } });
    expect(screen.getByText('Selected: 4 of 5 pages')).toBeInTheDocument();
    expect(convertButton()).toBeEnabled();
    expect(selectedPageCells()).toHaveLength(4);
  });

  it.each(['', '0', '9', '4-2', '1,wrong'])('blocks conversion for the invalid draft %j', async (draft) => {
    renderConverter();
    await addFiles([pdf()]);
    await screen.findByText(/Total: 5 pages/);
    fireEvent.click(pageMode('Selected pages'));
    fireEvent.change(rangeInput(), { target: { value: draft } });

    expect(convertButton()).toBeDisabled();
    expect(rangeInput()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('keeps zero selected after the final page is cleared', async () => {
    renderConverter();
    await addFiles([pdf()]);
    await screen.findByText(/Total: 5 pages/);
    fireEvent.click(pageMode('Selected pages'));
    fireEvent.change(rangeInput(), { target: { value: '3' } });

    expect(pageCell(3)).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(pageCell(3));

    expect(rangeInput()).toHaveValue('');
    expect(convertButton()).toBeDisabled();
    expect(pageMode('Selected pages')).toBeChecked();
    expect(screen.getByText(/Choose at least one page/)).toBeInTheDocument();
  });

  it('synchronizes range text, page cells, and count from a grid edit', async () => {
    renderConverter();
    await addFiles([pdf()]);
    await screen.findByText(/Total: 5 pages/);
    fireEvent.click(pageMode('Selected pages'));

    fireEvent.click(pageCell(2));
    fireEvent.click(pageCell(5));

    expect(rangeInput()).toHaveValue('2, 5');
    expect(screen.getByText('Selected: 2 of 5 pages')).toBeInTheDocument();
    expect(pageCell(2)).toHaveAttribute('aria-pressed', 'true');
    expect(pageCell(3)).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not let the grid change the export while All pages is chosen', async () => {
    renderConverter();
    await addFiles([pdf()]);
    await screen.findByText(/Total: 5 pages/);

    fireEvent.click(pageCell(4));

    expect(pageMode('All pages')).toBeChecked();
    expect(rangeInput()).toHaveValue('');
    expect(screen.getByText('All 5 pages will be exported.')).toBeInTheDocument();
    expect(selectedPageCells()).toHaveLength(5);
  });

  it('retains a custom draft when toggling modes and ignores it for All pages', async () => {
    renderConverter();
    await addFiles([pdf()]);
    await screen.findByText(/Total: 5 pages/);
    fireEvent.click(pageMode('Selected pages'));
    fireEvent.change(rangeInput(), { target: { value: '2-3' } });

    fireEvent.click(pageMode('All pages'));
    expect(rangeInput()).toBeDisabled();
    expect(rangeInput()).toHaveValue('2-3');
    expect(screen.getByText('All 5 pages will be exported.')).toBeInTheDocument();

    fireEvent.click(pageMode('Selected pages'));
    expect(rangeInput()).toBeEnabled();
    expect(screen.getByText('Selected: 2 of 5 pages')).toBeInTheDocument();
  });

  it('sends the empty request range for All pages and the canonical range for Selected pages', async () => {
    renderConverter();
    await addFiles([pdf()]);
    await screen.findByText(/Total: 5 pages/);

    fireEvent.click(convertButton());
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/v1/pdf-to-image/', expect.any(FormData), expect.anything()));
    let body = postMock.mock.calls.find(([url]) => url === '/api/v1/pdf-to-image/')?.[1] as FormData;
    expect(body.get('page_ranges')).toBe('');
    expect(body.get('format')).toBe('PNG');
    expect(body.get('dpi')).toBe('150');

    postMock.mockClear();
    fireEvent.click(pageMode('Selected pages'));
    fireEvent.change(rangeInput(), { target: { value: '2, 4-5' } });
    fireEvent.click(convertButton());
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/v1/pdf-to-image/', expect.any(FormData), expect.anything()));
    body = postMock.mock.calls.find(([url]) => url === '/api/v1/pdf-to-image/')?.[1] as FormData;
    expect(body.get('page_ranges')).toBe('2, 4-5');
  });

  it('rejects a conflicting addition without losing the existing image batch', async () => {
    renderConverter();
    const input = document.getElementById('converter-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [image('keep.png')] } });
    await screen.findByText('1 file');

    fireEvent.change(input, { target: { files: [pdf('other.pdf')] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot share a batch/i);
    expect(screen.getByText('1 file')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Images to Convert')).getByText('keep.png')).toBeInTheDocument();
  });

  it('rejects mixed categories and multiple PDFs atomically', async () => {
    renderConverter();
    const input = document.getElementById('converter-file-input') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [pdf(), image()] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot share a batch/i);
    expect(screen.queryByText(/Total:/)).not.toBeInTheDocument();

    fireEvent.change(input, { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/one PDF at a time/i);
    expect(screen.queryByText(/Total:/)).not.toBeInTheDocument();
  });

  it('instructs the user to clear before changing direction from a PDF', async () => {
    renderConverter();
    await addFiles([pdf()]);
    await screen.findByText(/Total: 5 pages/);

    expect(screen.queryByText(/Add more images/i)).not.toBeInTheDocument();
    expect(document.getElementById('converter-replace-file')).toBeInTheDocument();
    fireEvent.click(document.getElementById('converter-remove-file') as HTMLButtonElement);
    expect(await screen.findByText('No files yet')).toBeInTheDocument();
  });

  it('prevents duplicate submissions while a conversion is running', async () => {
    let resolveRequest: (value: unknown) => void = () => {};
    postMock.mockImplementation(async (url: string) => {
      if (url === '/api/v1/pdf-info/') return pdfInfoResponse(3);
      if (url === '/api/v1/preview/') return { data: new Blob(['png']), headers: {} };
      return new Promise((resolve) => { resolveRequest = resolve; });
    });

    renderConverter();
    await addFiles([pdf()]);
    await screen.findByText(/Total: 3 pages/);

    const button = convertButton();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(postMock.mock.calls.filter(([url]) => url === '/api/v1/pdf-to-image/')).toHaveLength(1);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Exporting…');

    resolveRequest({
      data: new Blob(['img']),
      headers: { 'x-pages-exported': '3', 'x-format': 'PNG', 'x-dpi': '150' },
    });
    await screen.findByText('Download started automatically');
  });

  it('discards a late PDF page-count response after the batch is cleared', async () => {
    let resolveInfo: (value: unknown) => void = () => {};
    postMock.mockImplementation(async (url: string) => {
      if (url === '/api/v1/pdf-info/') return new Promise((resolve) => { resolveInfo = resolve; });
      throw new Error(`Unexpected request: ${url}`);
    });

    renderConverter();
    const input = document.getElementById('converter-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdf()] } });
    await waitFor(() => expect(document.getElementById('converter-replace-file')).toBeInTheDocument());

    fireEvent.click(document.getElementById('converter-clear') as HTMLButtonElement);
    expect(await screen.findByText('No files yet')).toBeInTheDocument();

    resolveInfo(pdfInfoResponse(9));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText('No files yet')).toBeInTheDocument();
    expect(screen.queryByText(/Total: 9 pages/)).not.toBeInTheDocument();
    expect(convertButton()).toBeNull();
  });

  it('does not publish a conversion result after the converter unmounts', async () => {
    let resolveConversion: (value: unknown) => void = () => {};
    postMock.mockImplementation(async (url: string) => {
      if (url === '/api/v1/pdf-info/') return pdfInfoResponse(3);
      if (url === '/api/v1/preview/') return { data: new Blob(['png']), headers: {} };
      return new Promise((resolve) => { resolveConversion = resolve; });
    });

    const view = renderConverter();
    await addFiles([pdf()]);
    await screen.findByText(/Total: 3 pages/);
    fireEvent.click(convertButton());

    view.unmount();
    resolveConversion({
      data: new Blob(['img']),
      headers: { 'x-pages-exported': '3', 'x-format': 'PNG', 'x-dpi': '150' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('keeps the batch and a retry path after a failed conversion', async () => {
    postMock.mockImplementation(async (url: string) => {
      if (url === '/api/v1/pdf-info/') return pdfInfoResponse(3);
      throw new Error('Backend unavailable');
    });

    renderConverter();
    await addFiles([pdf('retry-me.pdf')]);
    await screen.findByText(/Total: 3 pages/);
    fireEvent.click(convertButton());

    expect(await screen.findByText('Backend unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('retry-me.pdf').length).toBeGreaterThan(0);
    expect(convertButton()).toBeEnabled();
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('aligns image request arrays with the displayed order and per-image transforms', async () => {
    renderConverter();
    const input = document.getElementById('converter-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [image('first.png'), image('second.png')] } });
    await screen.findByText('2 files');

    const list = screen.getByLabelText('Images to Convert');
    const rows = within(list).getAllByRole('button', { name: /Preview|Rotate|Mirror|Move|Remove/ });
    expect(rows.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /Rotate second.png 90 degrees/i }));
    fireEvent.click(screen.getByRole('button', { name: /Mirror second.png horizontally/i }));
    fireEvent.click(screen.getByRole('button', { name: /Move second.png up/i }));

    fireEvent.click(convertButton());
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/v1/image-to-pdf/', expect.any(FormData), expect.anything()));
    const body = postMock.mock.calls.find(([url]) => url === '/api/v1/image-to-pdf/')?.[1] as FormData;
    const files = body.getAll('files') as File[];
    expect(files.map((file) => file.name)).toEqual(['second.png', 'first.png']);
    expect(JSON.parse(body.get('rotations') as string)).toEqual([90, 0]);
    expect(JSON.parse(body.get('flips') as string)).toEqual([true, false]);
  });

  it('sends A5/F4 preset values from the single batch page-size control', async () => {
    renderConverter();
    const input = document.getElementById('converter-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [image()] } });
    await screen.findByText('1 file');

    const f4 = screen.getByRole('radio', { name: /F4/i });
    expect(f4.closest('label')).toHaveTextContent('210 × 330 mm');
    fireEvent.click(f4);
    fireEvent.click(convertButton());

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/v1/image-to-pdf/', expect.any(FormData), expect.anything()));
    const body = postMock.mock.calls.find(([url]) => url === '/api/v1/image-to-pdf/')?.[1] as FormData;
    expect(body.get('page_size')).toBe('f4');
  });

  it('keeps preview resources valid when the converter is left and re-entered', async () => {
    function Harness() {
      const [visible, setVisible] = useState(true);
      return (
        <MemoryRouter>
          <ToastProvider>
            <FileProvider>
              {visible ? <ConverterPage /> : null}
              <button type="button" onClick={() => setVisible((value) => !value)}>toggle-view</button>
            </FileProvider>
          </ToastProvider>
        </MemoryRouter>
      );
    }

    const createObjectURL = vi.mocked(URL.createObjectURL);
    const revokeObjectURL = vi.mocked(URL.revokeObjectURL);

    render(<Harness />);
    const input = document.getElementById('converter-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [image('keep.png')] } });
    await screen.findByText('1 file');
    expect(document.querySelector('.converter-image-pick img')).toHaveAttribute('src', 'blob:mock-preview');
    const createdAfterAdd = createObjectURL.mock.calls.length;
    const revokedAfterAdd = revokeObjectURL.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'toggle-view' }));
    expect(screen.queryByText('1 file')).not.toBeInTheDocument();
    const revokedAfterLeave = revokeObjectURL.mock.calls.length;
    expect(revokedAfterLeave).toBeGreaterThan(revokedAfterAdd);

    fireEvent.click(screen.getByRole('button', { name: 'toggle-view' }));
    await screen.findByText('1 file');
    expect(document.querySelector('.converter-image-pick img')).toHaveAttribute('src', 'blob:mock-preview');
    expect(createObjectURL.mock.calls.length).toBeGreaterThan(createdAfterAdd);
    expect(revokeObjectURL.mock.calls.length).toBe(revokedAfterLeave);
  });
});
