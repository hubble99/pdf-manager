import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('../api/client', () => ({
  default: { post: postMock },
  checkHealth: vi.fn(async () => true),
}));

vi.mock('../components/PdfThumbnail', () => ({
  PdfThumbnail: ({ page = 1 }: { page?: number }) => <span data-testid={`thumb-${page}`} />,
}));

vi.mock('../utils/tauriDialog', () => ({
  isTauri: () => false,
  openFilePicker: vi.fn(async () => null),
  openOutputFolder: vi.fn(async () => true),
}));

describe('converter routes', () => {
  beforeEach(() => {
    postMock.mockReset();
    postMock.mockImplementation(async (url: string) => {
      if (url === '/api/v1/preview/') return { data: new Blob(['png']), headers: {} };
      throw new Error(`Unexpected request: ${url}`);
    });
    window.history.pushState({}, '', '/');
  });

  it('serves the consolidated converter at /converter', async () => {
    window.history.pushState({}, '', '/converter');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'PDF & Image' })).toBeInTheDocument();
    expect(screen.getByText('Add one PDF to export pages as images, or add images to build a PDF')).toBeInTheDocument();
    expect(screen.getByText('No files yet')).toBeInTheDocument();
    expect(screen.getByLabelText('Drop one PDF or image files here, or press Enter to browse')).toBeInTheDocument();
  });

  it.each(['/pdf-to-image', '/image-to-pdf'])('redirects the legacy route %s without forcing a direction', async (path) => {
    window.history.pushState({}, '', path);
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'PDF & Image' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/converter');
    // No direction is preselected: the shared uploader is empty and neither workflow is active.
    expect(screen.getByLabelText('Drop one PDF or image files here, or press Enter to browse')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /All pages/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: /Page Size/i })).not.toBeInTheDocument();
  });
});
