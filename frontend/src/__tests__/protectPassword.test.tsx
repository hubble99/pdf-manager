import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_FINISHED_EVENT, CORE_PROGRESS_EVENT } from '../api/nativeCore';
import { FileProvider } from '../context/FileContext';
import { ProtectPage } from '../pages/ProtectPage';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ showToast }) }));
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
vi.mock('../components/PdfThumbnail', () => ({ PdfThumbnail: () => null }));

type Handler = (event: { payload: unknown }) => void;
const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
let handlers: Record<string, Handler[]>;
const emit = (event: string, payload: unknown) => act(() => { handlers[event]?.forEach((h) => h({ payload })); });
const calls = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

const PDF = 'C:\\Docs\\doc.pdf';
let encrypted = false;

function renderPage() {
  return render(
    <FileProvider>
      <ProtectPage />
    </FileProvider>,
  );
}

async function drop(paths: string[]) {
  await waitFor(() => expect(drag.handlers.length).toBeGreaterThanOrEqual(1));
  act(() => drag.handlers.forEach((h) => h({ payload: { type: 'drop', paths } })));
}

async function openWithPdf() {
  renderPage();
  await drop([PDF]);
  await screen.findByText('doc.pdf');
  await waitFor(() => expect(calls('core_pdf_info')).toHaveLength(1));
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const type = (id: string, value: string) => fireEvent.change(field(id), { target: { value } });
const addButton = () => document.getElementById('protect-add-btn') as HTMLButtonElement;
const removeButton = () => document.getElementById('protect-remove-btn') as HTMLButtonElement;
const fillAdd = () => { type('protect-user-pw', 'secret-1'); type('protect-confirm-pw', 'secret-1'); };

describe('Protect PDF', () => {
  beforeEach(() => {
    handlers = {};
    drag.handlers = [];
    desktop.on = true;
    encrypted = false;
    showToast.mockReset();
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockImplementation(async (event, handler) => {
      (handlers[event] ??= []).push(handler as unknown as Handler);
      return () => undefined;
    });
    invokeMock.mockImplementation(async (cmd) => {
      switch (cmd) {
        case 'core_pdf_info':
          return { sizeBytes: 2048, pages: encrypted ? 0 : 5, encrypted, metadata: {} };
        case 'core_pdf_protect_start':
          return 41;
        case 'core_pdf_unprotect_start':
          return 42;
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
    renderPage();
    expect(screen.getByText('Protect PDF runs in the Dokuwu desktop app')).toBeInTheDocument();
  });

  it('shows the dropped PDF with its size and pages', async () => {
    await openWithPdf();
    expect(await screen.findByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('5 pages')).toBeInTheDocument();
  });

  it('keeps Protect disabled until both passwords match', async () => {
    await openWithPdf();
    expect(addButton()).toBeDisabled();
    type('protect-user-pw', 'secret-1');
    expect(addButton()).toBeDisabled();
    type('protect-confirm-pw', 'secret-2');
    expect(addButton()).toBeDisabled();
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    type('protect-confirm-pw', 'secret-1');
    expect(addButton()).toBeEnabled();
    expect(screen.queryByText('Passwords do not match.')).not.toBeInTheDocument();
  });

  it('lets the password be revealed with an accessible toggle', async () => {
    await openWithPdf();
    const userField = screen.getByLabelText('User Password (Required to Open)') as HTMLInputElement;
    expect(userField.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show User Password (Required to Open)' }));
    expect(userField.type).toBe('text');
  });

  it('protects with the chosen passwords and permissions, then clears the passwords', async () => {
    await openWithPdf();
    fillAdd();
    type('protect-output-name', 'Rahasia');
    fireEvent.click(screen.getByLabelText('Allow Copying'));
    fireEvent.click(addButton());

    await waitFor(() => expect(calls('core_pdf_protect_start')).toHaveLength(1));
    expect(calls('core_pdf_protect_start')[0][1]).toEqual({
      inputPath: PDF,
      options: {
        userPassword: 'secret-1', allowPrint: true, allowCopy: false, allowModify: true, outputName: 'Rahasia',
      },
    });
    emit(CORE_PROGRESS_EVENT, { jobId: 41, kind: 'pdf_protect', stage: 'checking', done: 0 });
    expect(await screen.findByText('Checking the new file…')).toBeInTheDocument();

    emit(CORE_FINISHED_EVENT, {
      jobId: 41,
      kind: 'pdf_protect',
      status: 'succeeded',
      result: { outputPath: 'C:\\Users\\a\\Downloads\\Rahasia.pdf', outputSizeBytes: 3000, pages: 5, durationMs: 10 },
    });
    expect(await screen.findByText('PDF encrypted and saved')).toBeInTheDocument();
    expect(field('protect-user-pw').value).toBe('');
    expect(field('protect-confirm-pw').value).toBe('');
    fireEvent.click(document.getElementById('protect-open-folder-btn') as HTMLButtonElement);
    await waitFor(() => expect(calls('core_reveal_path')[0][1]).toEqual({ path: 'C:\\Users\\a\\Downloads\\Rahasia.pdf' }));
  });

  it('cancels without showing an error and keeps what was typed', async () => {
    await openWithPdf();
    fillAdd();
    fireEvent.click(addButton());
    await waitFor(() => expect(calls('core_pdf_protect_start')).toHaveLength(1));
    fireEvent.click(document.getElementById('protect-cancel-btn') as HTMLButtonElement);
    await waitFor(() => expect(calls('core_job_cancel')[0][1]).toEqual({ jobId: 41 }));
    emit(CORE_FINISHED_EVENT, { jobId: 41, kind: 'pdf_protect', status: 'cancelled' });
    await waitFor(() => expect(addButton()).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(field('protect-user-pw').value).toBe('secret-1');
  });

  it('refuses to protect a PDF that already has a password', async () => {
    encrypted = true;
    await openWithPdf();
    expect(await screen.findByText('This PDF already has a password. Use Remove Password first.')).toBeInTheDocument();
    fillAdd();
    expect(addButton()).toBeDisabled();
  });

  it('removes a password and explains a wrong one', async () => {
    encrypted = true;
    await openWithPdf();
    fireEvent.click(document.getElementById('protect-tab-remove') as HTMLElement);
    expect(removeButton()).toBeDisabled();
    type('protect-remove-pw', 'nope');
    expect(removeButton()).toBeEnabled();
    fireEvent.click(removeButton());

    await waitFor(() => expect(calls('core_pdf_unprotect_start')).toHaveLength(1));
    expect(calls('core_pdf_unprotect_start')[0][1]).toEqual({ inputPath: PDF, options: { password: 'nope', outputName: null } });
    emit(CORE_FINISHED_EVENT, {
      jobId: 42, kind: 'pdf_unprotect', status: 'failed', error: { code: 'password_required', message: 'the document is password protected' },
    });
    expect(await screen.findByText('Incorrect password. Please provide the correct user password.')).toBeInTheDocument();
    expect(field('protect-remove-pw').value).toBe('nope');

    type('protect-remove-pw', 'right');
    fireEvent.click(removeButton());
    await waitFor(() => expect(calls('core_pdf_unprotect_start')).toHaveLength(2));
    emit(CORE_FINISHED_EVENT, {
      jobId: 42,
      kind: 'pdf_unprotect',
      status: 'succeeded',
      result: { outputPath: 'C:\\Users\\a\\Downloads\\doc_unlocked.pdf', outputSizeBytes: 100, pages: 5, durationMs: 5 },
    });
    expect(await screen.findByText('Password removed and saved')).toBeInTheDocument();
    expect(field('protect-remove-pw').value).toBe('');
  });

  it('has nothing to remove on a PDF without a password', async () => {
    await openWithPdf();
    fireEvent.click(document.getElementById('protect-tab-remove') as HTMLElement);
    expect(await screen.findByText('This PDF has no password to remove.')).toBeInTheDocument();
    type('protect-remove-pw', 'x');
    expect(removeButton()).toBeDisabled();
  });

  it('turns away files that are not PDFs and starts clean with a new file', async () => {
    renderPage();
    await drop(['C:\\Docs\\notes.txt']);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Only PDF files are accepted.' })));
    await drop([PDF]);
    await screen.findByText('doc.pdf');
    fillAdd();
    await drop(['C:\\Docs\\other.pdf']);
    await screen.findByText('other.pdf');
    expect(field('protect-user-pw').value).toBe('');
    expect(field('protect-output-name').placeholder).toBe('other_protected');
  });
});
