import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileProvider } from '../context/FileContext';
import { ToastProvider } from '../context/ToastContext';
import { ToastContainer } from '../components/ToastContainer';
import { NativeCoreError } from '../api/nativeCore';
import { EditCanvasPage } from '../pages/EditCanvasPage';

const { metaMock, renderMock, sizesMock, pickerMock, fontsMock } = vi.hoisted(() => ({
  metaMock: vi.fn(),
  renderMock: vi.fn(),
  sizesMock: vi.fn(),
  pickerMock: vi.fn(),
  fontsMock: vi.fn(),
}));

vi.mock('../features/edit-canvas/pagesApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/edit-canvas/pagesApi')>();
  return { ...actual, fetchPagesMeta: metaMock, renderPage: renderMock };
});

vi.mock('../api/nativeCore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/nativeCore')>();
  return { ...actual, fileSizes: sizesMock };
});

vi.mock('../features/edit-canvas/fontLibrary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/edit-canvas/fontLibrary')>();
  return { ...actual, loadApplicationFontLibrary: fontsMock };
});

vi.mock('../utils/tauriDialog', () => ({
  isTauri: () => true,
  openFilePicker: pickerMock,
  openOutputFolder: vi.fn(async () => true),
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }),
}));

// Fabric needs a real canvas; the page images are what matters here.
vi.mock('../components/PageCanvas', () => ({
  PageCanvas: ({ page }: { page: { index: number; imageUrl: string } }) => (
    <img data-testid={`page-${page.index}`} src={page.imageUrl} alt="" />
  ),
}));

const PATH = 'C:\\Docs\\report.pdf';

function pageMeta(index: number) {
  return { index, widthPt: 595, heightPt: 842, width: 1654, height: 2339, dpi: 200 };
}

function image(page: number, dpi = 200) {
  return { width: 1654, height: 2339, dpi, url: `blob:page-${page}-${dpi}` };
}

function mount() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <FileProvider>
          <EditCanvasPage />
          <ToastContainer />
        </FileProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function openPdf() {
  pickerMock.mockResolvedValueOnce([PATH]);
  fireEvent.click(screen.getByText('Click here or drag in a file to start editing.'));
  await waitFor(() => expect(metaMock).toHaveBeenCalled());
}

describe('Canvas PDF opens a PDF by path', () => {
  beforeEach(() => {
    metaMock.mockReset();
    renderMock.mockReset();
    sizesMock.mockReset().mockResolvedValue([2048]);
    pickerMock.mockReset();
    fontsMock.mockReset().mockResolvedValue({ families: [], entries: [] });
    URL.revokeObjectURL = vi.fn();
  });

  it('lays out every page at once and fills in the images', async () => {
    metaMock.mockResolvedValue({ total: 3, pages: [pageMeta(0), pageMeta(1), pageMeta(2)] });
    renderMock.mockImplementation(async (_path: string, page: number, dpi: number) => image(page, dpi));
    mount();
    await openPdf();

    expect(metaMock).toHaveBeenCalledWith(PATH, 200);
    await waitFor(() => expect(screen.getByTestId('page-2').getAttribute('src')).toBe('blob:page-3-200'));
    expect(screen.getByTestId('page-0').getAttribute('src')).toBe('blob:page-1-200');
    expect(screen.getByTestId('page-1').getAttribute('src')).toBe('blob:page-2-200');
    expect(renderMock).toHaveBeenCalledWith(PATH, 1, 200);
    expect(screen.getByText('report.pdf')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
  });

  it('shows the page boxes before any image has arrived', async () => {
    metaMock.mockResolvedValue({ total: 2, pages: [pageMeta(0), pageMeta(1)] });
    renderMock.mockImplementation(() => new Promise(() => undefined));
    mount();
    await openPdf();

    await waitFor(() => expect(screen.getByTestId('page-1')).toBeTruthy());
    expect(screen.getByTestId('page-0').getAttribute('src')).toMatch(/^data:image\/gif/);
  });

  it('refuses a protected PDF with a readable message', async () => {
    metaMock.mockRejectedValue(new NativeCoreError('password_required', 'needs a password'));
    mount();
    await openPdf();

    await waitFor(() => expect(screen.getByText(/password protected/)).toBeTruthy());
    expect(screen.queryByTestId('page-0')).toBeNull();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it('frees the page images when the PDF is cleared', async () => {
    metaMock.mockResolvedValue({ total: 1, pages: [pageMeta(0)] });
    renderMock.mockImplementation(async (_path: string, page: number, dpi: number) => image(page, dpi));
    mount();
    await openPdf();
    await waitFor(() => expect(screen.getByTestId('page-0').getAttribute('src')).toBe('blob:page-1-200'));

    await act(async () => {
      fireEvent.click(screen.getByTitle('Clear PDF'));
    });

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:page-1-200');
    expect(screen.queryByTestId('page-0')).toBeNull();
  });
});
