import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NativeCoreError, convertPdfToWord } from '../api/nativeCore';
import { PdfToWordPage } from '../pages/PdfToWordPage';
import { baseName, errorMessage, stemOf } from '../utils/pdfToWord';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

describe('PDF to Word page', () => {
  it('derives names from Windows and POSIX paths', () => {
    expect(baseName('C:\\Users\\a\\Docs\\Report.PDF')).toBe('Report.PDF');
    expect(stemOf('C:\\Users\\a\\Docs\\Report.PDF')).toBe('Report');
    expect(stemOf('/home/a/my file.pdf')).toBe('my file');
  });

  it('explains core errors in plain words', () => {
    expect(errorMessage(new NativeCoreError('password_required', 'x'))).toMatch(/password/i);
    expect(errorMessage(new NativeCoreError('not_found', 'x'))).toMatch(/could not be found/);
    expect(errorMessage(new NativeCoreError('internal', 'boom'))).toBe('boom');
  });

  it('asks for the desktop app outside Tauri', () => {
    render(<PdfToWordPage />);
    expect(screen.getByText('PDF to Word runs in the Dokuwu desktop app')).toBeTruthy();
  });

  it('shows the BETA badge and the note about pictures and letterheads', () => {
    const { container } = render(<PdfToWordPage />);
    expect(container.querySelector('.page-header-badge')).toHaveTextContent('BETA');
    expect(container.querySelector('#pdf-to-word-beta-note')).toHaveTextContent(/pictures or a letterhead/);
  });

  it('passes the output name to the core command', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockRejectedValueOnce({ code: 'invalid_input', message: 'bad' });
    await expect(convertPdfToWord('C:/a.pdf', '  Report  ')).rejects.toBeInstanceOf(NativeCoreError);
    expect(invokeMock).toHaveBeenCalledWith('core_pdf_to_word_start', { inputPath: 'C:/a.pdf', outputName: 'Report' });
    invokeMock.mockRejectedValueOnce({ code: 'invalid_input', message: 'bad' });
    await convertPdfToWord('C:/a.pdf', '').catch(() => undefined);
    expect(invokeMock).toHaveBeenLastCalledWith('core_pdf_to_word_start', { inputPath: 'C:/a.pdf', outputName: null });
  });
});
