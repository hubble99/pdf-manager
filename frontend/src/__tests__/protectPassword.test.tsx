import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('../api/client', () => ({ default: { post } }));
vi.mock('../components/PdfThumbnail', () => ({ PdfThumbnail: () => null }));

import { FileProvider } from '../context/FileContext';
import { ToastProvider } from '../context/ToastContext';
import { ProtectPage } from '../pages/ProtectPage';

function renderPage() {
  return render(
    <ToastProvider>
      <FileProvider>
        <ProtectPage />
      </FileProvider>
    </ToastProvider>
  );
}

function openWithPdf() {
  renderPage();
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' })] } });
}

describe('Protect PDF password confirmation', () => {
  beforeEach(() => post.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('keeps Protect disabled until both passwords match', async () => {
    openWithPdf();
    const protect = await screen.findByRole('button', { name: /Protect & Download/i });
    expect(protect).toBeDisabled();

    fireEvent.change(document.getElementById('protect-user-pw') as HTMLInputElement, { target: { value: 'secret-1' } });
    expect(protect).toBeDisabled();

    fireEvent.change(document.getElementById('protect-confirm-pw') as HTMLInputElement, { target: { value: 'secret-2' } });
    expect(protect).toBeDisabled();
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();

    fireEvent.change(document.getElementById('protect-confirm-pw') as HTMLInputElement, { target: { value: 'secret-1' } });
    expect(protect).toBeEnabled();
    expect(screen.queryByText('Passwords do not match.')).not.toBeInTheDocument();
  });

  it('lets the password be revealed with an accessible toggle', async () => {
    openWithPdf();
    const field = (await screen.findByLabelText('User Password (Required to Open)')) as HTMLInputElement;
    expect(field.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'Show User Password (Required to Open)' }));
    expect(field.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide User Password (Required to Open)' })).toHaveAttribute('aria-pressed', 'true');
  });
});
