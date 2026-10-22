import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_FINISHED_EVENT, CORE_PROGRESS_EVENT } from '../api/nativeCore';
import { FileProvider } from '../context/FileContext';
import { ToastProvider } from '../context/ToastContext';
import { ConverterPage } from '../pages/ConverterPage';

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

vi.mock('../components/PdfThumbnail', () => ({
  PdfThumbnail: ({ page = 1 }: { page?: number }) => <span data-testid={`thumb-${page}`} />,
}));

type Handler = (event: { payload: unknown }) => void;
const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
let handlers: Record<string, Handler[]>;
const emit = (event: string, payload: unknown) => act(() => { handlers[event]?.forEach((h) => h({ payload })); });

const PDF = 'C:\\Docs\\document.pdf';
const pic = (name: string) => `C:\\Pics\\${name}`;

let pageCount = 5;
let encrypted = false;
let infoGate: Promise<void> | null = null;

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

/** Drops files on the window, the way the desktop shell reports them. */
async function dropPaths(paths: string[]) {
  // One listener per picker (PDF and images) once both are mounted.
  await waitFor(() => expect(drag.handlers.length, `handlers ${drag.handlers.length}`).toBeGreaterThanOrEqual(2));
  act(() => drag.handlers.forEach((h) => h({ payload: { type: 'drop', paths } })));
}

/** The tab is where the user states the direction, so images are added from Images to PDF. */
function chooseTabFor(paths: string[]) {
  const wantsImages = paths.some((p) => !/\.pdf$/i.test(p));
  const tab = screen.queryByRole('tab', { name: wantsImages ? 'Images to PDF' : 'PDF to Images' });
  if (tab && !tab.hasAttribute('disabled')) fireEvent.click(tab);
}

async function addPaths(paths: string[]) {
  chooseTabFor(paths);
  await dropPaths(paths);
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

const startCalls = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

const pdfReport = (overrides: Record<string, unknown> = {}) => ({
  outputPath: 'C:\\Users\\a\\Downloads\\document_images.zip',
  outputSizeBytes: 1_500_000,
  pages: 3,
  isZip: true,
  format: 'png',
  dpi: 150,
  reducedPages: [],
  durationMs: 800,
  ...overrides,
});

const pdfFromImagesReport = (overrides: Record<string, unknown> = {}) => ({
  outputPath: 'C:\\Users\\a\\Downloads\\output.pdf',
  outputSizeBytes: 900_000,
  pages: 2,
  pageSize: 'a4',
  skipped: [],
  durationMs: 300,
  ...overrides,
});

describe('unified converter workspace', () => {
  beforeAll(() => {
    URL.createObjectURL = vi.fn(() => 'blob:mock-preview');
    URL.revokeObjectURL = vi.fn();
  });

  beforeEach(() => {
    handlers = {};
    drag.handlers = [];
    desktop.on = true;
    pageCount = 5;
    encrypted = false;
    infoGate = null;
    invokeMock.mockReset();
    listenMock.mockReset();
    vi.mocked(URL.createObjectURL).mockClear();
    vi.mocked(URL.revokeObjectURL).mockClear();
    listenMock.mockImplementation(async (event, handler) => {
      (handlers[event] ??= []).push(handler as unknown as Handler);
      return () => undefined;
    });
    invokeMock.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case 'core_pdf_info':
          if (infoGate) await infoGate;
          return { sizeBytes: 524_288, pages: encrypted ? 0 : pageCount, encrypted, metadata: {} };
        case 'core_file_sizes':
          return ((args as { paths: string[] }).paths).map(() => 2048);
        case 'core_image_thumbnail':
          return new ArrayBuffer(4);
        case 'core_pdf_render_page':
          return new ArrayBuffer(4);
        case 'core_pdf_to_image_start':
          return 7;
        case 'core_image_to_pdf_start':
          return 8;
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
    renderConverter();
    expect(screen.getByText('PDF & Image runs in the Dokuwu desktop app')).toBeInTheDocument();
    expect(screen.queryByLabelText('Drop a PDF here, or press Enter to browse')).not.toBeInTheDocument();
  });

  it('derives PDF direction and keeps the page field disabled in All pages mode', async () => {
    renderConverter();
    expect(screen.queryByRole('radio', { name: /All pages/i })).not.toBeInTheDocument();

    await addPaths([PDF]);
    await screen.findByText(/Total: 5 pages/);

    expect(screen.getByText('document.pdf')).toBeInTheDocument();
    expect(screen.getByText('512.0 KB')).toBeInTheDocument();
    expect(pageMode('All pages')).toBeChecked();
    expect(rangeInput()).toBeDisabled();
    expect(rangeInput()).toHaveValue('');
    expect(screen.getByText('All 5 pages will be exported.')).toBeInTheDocument();
    expect(convertButton()).toBeEnabled();

    const cells = pageCells();
    expect(cells).toHaveLength(5);
    cells.forEach((cell) => expect(cell).toBeDisabled());
    expect(selectedPageCells()).toHaveLength(5);
    // The page previews come from the PDF's path, not from an upload.
    await waitFor(() => expect(startCalls('core_pdf_info')).toHaveLength(1));
    expect(startCalls('core_pdf_info')[0][1]).toEqual({ path: PDF });
  });

  it('derives image direction, shows file sizes and only image controls', async () => {
    renderConverter();
    await addPaths([pic('photo.png'), pic('second.JPG')]);

    await screen.findByText('2 files');
    expect(screen.getByRole('radiogroup', { name: /Page Size/i })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /All pages/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Selected pages')).not.toBeInTheDocument();
    expect(convertButton()).toBeEnabled();
    expect((await screen.findAllByText('2.0 KB')).length).toBe(2);
    expect(startCalls('core_file_sizes')[0][1]).toEqual({ paths: [pic('photo.png'), pic('second.JPG')] });
    await waitFor(() => expect(document.querySelectorAll('.sort-card img')).toHaveLength(2));
  });

  it('refuses a password-protected PDF with a plain explanation', async () => {
    encrypted = true;
    renderConverter();
    await addPaths([PDF]);

    expect(await screen.findByText('Password protected')).toBeInTheDocument();
    expect(convertButton()).toBeDisabled();
    expect(convertButton()).toHaveAttribute('title', expect.stringContaining('protected'));
  });

  it('enables page selection in Selected pages mode and reports the count', async () => {
    renderConverter();
    await addPaths([PDF]);
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
    await addPaths([PDF]);
    await screen.findByText(/Total: 5 pages/);
    fireEvent.click(pageMode('Selected pages'));
    fireEvent.change(rangeInput(), { target: { value: draft } });

    expect(convertButton()).toBeDisabled();
    expect(rangeInput()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('keeps zero selected after the final page is cleared', async () => {
    renderConverter();
    await addPaths([PDF]);
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
    await addPaths([PDF]);
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
    await addPaths([PDF]);
    await screen.findByText(/Total: 5 pages/);

    fireEvent.click(pageCell(4));

    expect(pageMode('All pages')).toBeChecked();
    expect(rangeInput()).toHaveValue('');
    expect(screen.getByText('All 5 pages will be exported.')).toBeInTheDocument();
    expect(selectedPageCells()).toHaveLength(5);
  });

  it('retains a custom draft when toggling modes and ignores it for All pages', async () => {
    renderConverter();
    await addPaths([PDF]);
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

  it('sends the empty range for All pages and the canonical range for Selected pages', async () => {
    renderConverter();
    await addPaths([PDF]);
    await screen.findByText(/Total: 5 pages/);

    fireEvent.click(convertButton());
    await waitFor(() => expect(startCalls('core_pdf_to_image_start')).toHaveLength(1));
    expect(startCalls('core_pdf_to_image_start')[0][1]).toEqual({
      inputPath: PDF,
      options: { format: 'png', dpi: 150, pageRanges: '', outputName: 'document' },
    });
    await waitFor(() => expect(handlers[CORE_FINISHED_EVENT]?.length).toBeGreaterThan(0));
    emit(CORE_FINISHED_EVENT, { jobId: 7, kind: 'pdf_to_image', status: 'succeeded', result: pdfReport() });
    await screen.findByText('Saved to your Downloads folder');

    invokeMock.mockClear();
    fireEvent.click(pageMode('Selected pages'));
    fireEvent.change(rangeInput(), { target: { value: '2, 4-5' } });
    fireEvent.click(convertButton());
    await waitFor(() => expect(startCalls('core_pdf_to_image_start')).toHaveLength(1));
    expect(startCalls('core_pdf_to_image_start')[0][1]).toMatchObject({ options: { pageRanges: '2, 4-5' } });
  });

  it('sends the chosen format, resolution and output name', async () => {
    renderConverter();
    await addPaths([PDF]);
    await screen.findByText(/Total: 5 pages/);

    fireEvent.click(screen.getByRole('button', { name: 'JPEG' }));
    fireEvent.click(screen.getByRole('button', { name: '300' }));
    fireEvent.change(screen.getByLabelText('Output Filename'), { target: { value: 'scan' } });
    fireEvent.click(convertButton());

    await waitFor(() => expect(startCalls('core_pdf_to_image_start')).toHaveLength(1));
    expect(startCalls('core_pdf_to_image_start')[0][1]).toEqual({
      inputPath: PDF,
      options: { format: 'jpeg', dpi: 300, pageRanges: '', outputName: 'scan' },
    });
  });

  it('shows progress, can be cancelled, and saves nothing', async () => {
    renderConverter();
    await addPaths([PDF]);
    await screen.findByText(/Total: 5 pages/);
    fireEvent.click(convertButton());
    await waitFor(() => expect(handlers[CORE_FINISHED_EVENT]?.length).toBeGreaterThan(0));
    await waitFor(() => expect(startCalls('core_pdf_to_image_start')).toHaveLength(1));

    emit(CORE_PROGRESS_EVENT, { jobId: 7, kind: 'pdf_to_image', stage: 'pages', done: 2, total: 5 });
    expect(await screen.findByText('Exporting page 3 of 5…')).toBeInTheDocument();

    fireEvent.click(document.getElementById('converter-cancel') as HTMLButtonElement);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('core_job_cancel', { jobId: 7 }));
    emit(CORE_FINISHED_EVENT, { jobId: 7, kind: 'pdf_to_image', status: 'cancelled' });

    await waitFor(() => expect(convertButton()).toBeEnabled());
    expect(screen.queryByText('Saved to your Downloads folder')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('prevents duplicate submissions while a conversion is running', async () => {
    renderConverter();
    await addPaths([PDF]);
    await screen.findByText(/Total: 5 pages/);

    const button = convertButton();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(startCalls('core_pdf_to_image_start')).toHaveLength(1));
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Exporting…');

    await waitFor(() => expect(handlers[CORE_FINISHED_EVENT]?.length).toBeGreaterThan(0));
    emit(CORE_FINISHED_EVENT, { jobId: 7, kind: 'pdf_to_image', status: 'succeeded', result: pdfReport() });
    await screen.findByText('Saved to your Downloads folder');
    expect(screen.getByText('document_images.zip')).toBeInTheDocument();
    expect(screen.getByText(/3 pages · PNG · 150 DPI \(ZIP archive\) · 1\.43 MB/)).toBeInTheDocument();
    expect(startCalls('core_pdf_to_image_start')).toHaveLength(1);
  });

  it('notes pages that were rendered at a lower resolution', async () => {
    renderConverter();
    await addPaths([PDF]);
    await screen.findByText(/Total: 5 pages/);
    fireEvent.click(convertButton());
    await waitFor(() => expect(handlers[CORE_FINISHED_EVENT]?.length).toBeGreaterThan(0));
    await waitFor(() => expect(startCalls('core_pdf_to_image_start')).toHaveLength(1));
    emit(CORE_FINISHED_EVENT, {
      jobId: 7, kind: 'pdf_to_image', status: 'succeeded', result: pdfReport({ pages: 1, isZip: false, reducedPages: [1] }),
    });
    expect(await screen.findByText(/1 large page used a lower DPI/)).toBeInTheDocument();
  });

  it('shows the saved file in its folder', async () => {
    renderConverter();
    await addPaths([PDF]);
    await screen.findByText(/Total: 5 pages/);
    fireEvent.click(convertButton());
    await waitFor(() => expect(handlers[CORE_FINISHED_EVENT]?.length).toBeGreaterThan(0));
    await waitFor(() => expect(startCalls('core_pdf_to_image_start')).toHaveLength(1));
    emit(CORE_FINISHED_EVENT, { jobId: 7, kind: 'pdf_to_image', status: 'succeeded', result: pdfReport() });
    await screen.findByText('Saved to your Downloads folder');

    fireEvent.click(document.getElementById('converter-open-folder') as HTMLButtonElement);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('core_reveal_path', { path: 'C:\\Users\\a\\Downloads\\document_images.zip' }));
  });

  it('rejects a conflicting addition without losing the existing image batch', async () => {
    renderConverter();
    await addPaths([pic('keep.png')]);
    await screen.findByText('1 file');

    await dropPaths([PDF]);

    expect(await screen.findByRole('alert')).toHaveTextContent(/This tab takes images/i);
    expect(screen.getByText('1 file')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Images to Convert')).getByText('keep.png')).toBeInTheDocument();
  });

  it('rejects mixed categories and multiple PDFs atomically', async () => {
    renderConverter();

    await dropPaths([PDF, pic('image.png')]);
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot share a batch/i);
    expect(screen.queryByText(/Total:/)).not.toBeInTheDocument();

    await dropPaths(['C:\\Docs\\a.pdf', 'C:\\Docs\\b.pdf']);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/one PDF at a time/i));
    expect(screen.queryByText(/Total:/)).not.toBeInTheDocument();
  });

  it('instructs the user to clear before changing direction from a PDF', async () => {
    renderConverter();
    await addPaths([PDF]);
    await screen.findByText(/Total: 5 pages/);

    expect(screen.queryByText(/Add more images/i)).not.toBeInTheDocument();
    expect(document.getElementById('converter-replace-file')).toBeInTheDocument();
    fireEvent.click(document.getElementById('converter-remove-file') as HTMLButtonElement);
    expect(await screen.findByText('Every page will appear here so you can choose which ones to convert.')).toBeInTheDocument();
  });

  it('discards a late PDF page-count response after the batch is cleared', async () => {
    let open: () => void = () => {};
    infoGate = new Promise<void>((resolve) => { open = resolve; });
    pageCount = 9;

    renderConverter();
    await dropPaths([PDF]);
    await waitFor(() => expect(document.getElementById('converter-replace-file')).toBeInTheDocument());

    fireEvent.click(document.getElementById('converter-clear') as HTMLButtonElement);
    expect(await screen.findByText('Every page will appear here so you can choose which ones to convert.')).toBeInTheDocument();

    open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText('Every page will appear here so you can choose which ones to convert.')).toBeInTheDocument();
    expect(screen.queryByText(/Total: 9 pages/)).not.toBeInTheDocument();
    expect(convertButton()).toBeNull();
  });

  it('stops the job and publishes nothing after the converter unmounts', async () => {
    const view = renderConverter();
    await addPaths([PDF]);
    await screen.findByText(/Total: 5 pages/);
    fireEvent.click(convertButton());
    await waitFor(() => expect(handlers[CORE_FINISHED_EVENT]?.length).toBeGreaterThan(0));
    await waitFor(() => expect(startCalls('core_pdf_to_image_start')).toHaveLength(1));

    view.unmount();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('core_job_cancel', { jobId: 7 }));
    emit(CORE_FINISHED_EVENT, { jobId: 7, kind: 'pdf_to_image', status: 'succeeded', result: pdfReport() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Saved to your Downloads folder')).not.toBeInTheDocument();
  });

  it('keeps the batch and a retry path after a failed conversion', async () => {
    renderConverter();
    await addPaths([PDF]);
    await screen.findByText(/Total: 5 pages/);
    fireEvent.click(convertButton());
    await waitFor(() => expect(handlers[CORE_FINISHED_EVENT]?.length).toBeGreaterThan(0));
    await waitFor(() => expect(startCalls('core_pdf_to_image_start')).toHaveLength(1));

    emit(CORE_FINISHED_EVENT, {
      jobId: 7, kind: 'pdf_to_image', status: 'failed', error: { code: 'io', message: 'disk full' },
    });

    expect(await screen.findByText(/could not be saved/)).toBeInTheDocument();
    expect(screen.getAllByText('document.pdf').length).toBeGreaterThan(0);
    expect(convertButton()).toBeEnabled();
    expect(screen.queryByText('Saved to your Downloads folder')).not.toBeInTheDocument();
  });

  it('aligns image requests with the displayed order and per-image transforms', async () => {
    renderConverter();
    await addPaths([pic('first.png'), pic('second.png')]);
    await screen.findByText('2 files');

    fireEvent.click(screen.getByRole('button', { name: /Rotate second.png 90 degrees/i }));
    fireEvent.click(screen.getByRole('button', { name: /Mirror second.png horizontally/i }));
    fireEvent.click(screen.getByRole('button', { name: /Move second.png earlier/i }));

    fireEvent.click(convertButton());
    await waitFor(() => expect(startCalls('core_image_to_pdf_start')).toHaveLength(1));
    expect(startCalls('core_image_to_pdf_start')[0][1]).toEqual({
      images: [
        { path: pic('second.png'), rotation: 90, flipH: true },
        { path: pic('first.png'), rotation: 0, flipH: false },
      ],
      pageSize: 'a4',
      outputName: 'output.pdf',
    });
  });

  it('sends A5/F4 preset values from the single batch page-size control', async () => {
    renderConverter();
    await addPaths([pic('photo.png')]);
    await screen.findByText('1 file');

    const f4 = screen.getByRole('radio', { name: /F4/i });
    expect(f4.closest('label')).toHaveTextContent('210 × 330 mm');
    fireEvent.click(f4);
    fireEvent.click(convertButton());

    await waitFor(() => expect(startCalls('core_image_to_pdf_start')).toHaveLength(1));
    expect(startCalls('core_image_to_pdf_start')[0][1]).toMatchObject({ pageSize: 'f4' });
  });

  it('reports images the PDF had to leave out', async () => {
    renderConverter();
    await addPaths([pic('good.png'), pic('broken.jpg')]);
    await screen.findByText('2 files');
    fireEvent.click(convertButton());
    await waitFor(() => expect(handlers[CORE_FINISHED_EVENT]?.length).toBeGreaterThan(0));
    await waitFor(() => expect(startCalls('core_image_to_pdf_start')).toHaveLength(1));

    emit(CORE_PROGRESS_EVENT, { jobId: 8, kind: 'image_to_pdf', stage: 'images', done: 1, total: 2 });
    expect(await screen.findByText('Adding image 2 of 2…')).toBeInTheDocument();
    emit(CORE_FINISHED_EVENT, {
      jobId: 8,
      kind: 'image_to_pdf',
      status: 'succeeded',
      result: pdfFromImagesReport({
        pages: 1,
        skipped: [{ source: pic('broken.jpg'), error: { code: 'unsupported', message: 'cannot read image' } }],
      }),
    });

    await screen.findByText('Saved to your Downloads folder');
    expect(screen.getByText(/Skipped because they could not be read: broken\.jpg/)).toBeInTheDocument();
    expect(screen.getByText(/1 page · A4 · 878\.9 KB/)).toBeInTheDocument();
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
    await addPaths([pic('keep.png')]);
    await screen.findByText('1 file');
    await waitFor(() => expect(document.querySelector('.sort-card img')).toHaveAttribute('src', 'blob:mock-preview'));
    const createdAfterAdd = createObjectURL.mock.calls.length;
    const revokedAfterAdd = revokeObjectURL.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'toggle-view' }));
    expect(screen.queryByText('1 file')).not.toBeInTheDocument();
    const revokedAfterLeave = revokeObjectURL.mock.calls.length;
    expect(revokedAfterLeave).toBeGreaterThan(revokedAfterAdd);

    fireEvent.click(screen.getByRole('button', { name: 'toggle-view' }));
    await screen.findByText('1 file');
    await waitFor(() => expect(document.querySelector('.sort-card img')).toHaveAttribute('src', 'blob:mock-preview'));
    expect(createObjectURL.mock.calls.length).toBeGreaterThan(createdAfterAdd);
    expect(revokeObjectURL.mock.calls.length).toBe(revokedAfterLeave);
  });
});
