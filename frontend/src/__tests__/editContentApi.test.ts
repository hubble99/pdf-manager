import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EditContentError,
  applyContentDraft,
  cancelContentRequest,
  exportContentOutput,
  openContentSession,
  renderContentPage,
} from '../features/edit-content/api';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

describe('Edit Content api', () => {
  beforeEach(() => invokeMock.mockReset());

  it('opens by path and sends every command as one envelope', async () => {
    invokeMock.mockResolvedValue({ status: 'accepted' });
    await openContentSession('C:\\Docs\\a.pdf');
    expect(invokeMock).toHaveBeenLastCalledWith('core_edit_content_open', { path: 'C:\\Docs\\a.pdf' });

    await renderContentPage('s1', 3, 0, 800, 1000);
    const [command, args] = invokeMock.mock.lastCall as [string, { sessionId: string; envelope: Record<string, unknown> }];
    expect(command).toBe('core_edit_content_command');
    expect(args.sessionId).toBe('s1');
    expect(args.envelope).toMatchObject({
      schemaVersion: 'edit-content-request/v1', sessionId: 's1', command: 'render',
      expectedAcceptedRevision: 3, payload: { pageIndex: 0, widthPx: 800, heightPx: 1000 },
    });
    expect(args.envelope).not.toHaveProperty('targetId');

    const edit = { expectedText: 'ab', expectedOldText: 'a', replacementText: 'c', utf16Start: 0, utf16End: 1 };
    await applyContentDraft('s1', 3, 't1', edit, 'apply-1');
    const applied = (invokeMock.mock.lastCall as [string, { envelope: Record<string, unknown> }])[1].envelope;
    expect(applied).toMatchObject({ command: 'apply', requestId: 'apply-1', targetId: 't1', payload: { edit } });
  });

  it('cancels and exports through their own commands', async () => {
    invokeMock.mockResolvedValue({ status: 'accepted' });
    await cancelContentRequest('s1', 'r1');
    expect(invokeMock).toHaveBeenLastCalledWith('core_edit_content_cancel', { sessionId: 's1', requestId: 'r1' });
    invokeMock.mockResolvedValue({ path: 'C:\\Downloads\\out.pdf', fileName: 'out.pdf' });
    await expect(exportContentOutput('s1', 'o1', 'out')).resolves.toEqual({ path: 'C:\\Downloads\\out.pdf', fileName: 'out.pdf' });
    expect(invokeMock).toHaveBeenLastCalledWith('core_edit_content_export', { sessionId: 's1', outputId: 'o1', name: 'out' });
  });

  it('keeps the stable error code and gives a message for it', async () => {
    invokeMock.mockRejectedValue({ code: 'PDF_ENCRYPTED', message: 'engine text' });
    const caught = await openContentSession('C:\\Docs\\a.pdf').catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(EditContentError);
    expect((caught as EditContentError).code).toBe('PDF_ENCRYPTED');
    expect((caught as EditContentError).message).toContain('encrypted or permission-protected');

    invokeMock.mockRejectedValue({ code: 'SOMETHING_NEW', message: 'the engine said this' });
    const odd = await openContentSession('C:\\Docs\\a.pdf').catch((error: unknown) => error);
    expect((odd as EditContentError).message).toBe('the engine said this');
    invokeMock.mockReset();
  });

  it('does not start a request that was dropped before it began', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(renderContentPage('s1', 0, 0, 10, 10, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
