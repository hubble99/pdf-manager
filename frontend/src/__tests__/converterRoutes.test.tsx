import { fireEvent, render, screen } from '@testing-library/react';
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
    // Two tabs; PDF to Images is the default. The browser preview has no file access, so it says so.
    expect(screen.getByRole('tab', { name: 'PDF to Images' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Images to PDF' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Export the pages you choose from one PDF as images')).toBeInTheDocument();
    expect(screen.getByText('PDF & Image runs in the Dokuwu desktop app')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Images to PDF' }));
    expect(screen.getByText('Combine one or more images into a single PDF document')).toBeInTheDocument();
  });

  it.each(['/pdf-to-image', '/image-to-pdf'])('redirects the legacy route %s without forcing a direction', async (path) => {
    window.history.pushState({}, '', path);
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'PDF & Image' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/converter');
    // Nothing is loaded, so neither workflow is active.
    expect(screen.queryByRole('radio', { name: /All pages/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: /Page Size/i })).not.toBeInTheDocument();
  });
});
