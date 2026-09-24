import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../context/ToastContext';
import { EditContentPage } from '../pages/EditContentPage';
import type { ContentSessionState, NativeDiscovery } from '../features/edit-content/types';
import * as contentApi from '../features/edit-content/api';


vi.mock('../features/edit-content/api', () => ({
  contentRequestId: vi.fn((prefix: string) => `${prefix}-request`),
  openContentSession: vi.fn(),
  inspectContentObjects: vi.fn(),
  hitTestContentObject: vi.fn(),
  renderContentPage: vi.fn(),
  applyContentDraft: vi.fn(),
  saveContentSession: vi.fn(),
  moveContentHistory: vi.fn(),
  closeContentSession: vi.fn(),
  cancelContentRequest: vi.fn(),
  downloadContentOutput: vi.fn(),
}));


const state: ContentSessionState = {
  sessionId: 'session-1',
  acceptedRevision: 0,
  checkpointId: 'source',
  dirty: false,
  canUndo: false,
  canRedo: false,
  savedHash: 'a'.repeat(64),
  lastOutputId: null,
};

const discovery: NativeDiscovery = {
  schemaVersion: 'edit-content-inspection/v1',
  readOnly: true,
  pages: [{
    pageIndex: 0,
    widthPt: 612,
    heightPt: 792,
    cropBox: { left: 0, bottom: 0, right: 612, top: 792 },
    rotation: 0,
  }],
  textObjects: [{
    targetId: 'target-0',
    pageIndex: 0,
    nativeObjectIdentity: 'native-0',
    text: 'Press A to continue',
    unicodeScalarLength: 19,
    bounds: { left: 72, bottom: 700, right: 180, top: 714 },
    rotatedQuad: { points: [
      { x: 72, y: 700 }, { x: 180, y: 700 }, { x: 180, y: 714 }, { x: 72, y: 714 },
    ] },
    font: { name: 'Helvetica', family: 'Helvetica', weight: 'Normal', embedded: true },
    fontSizePt: 12,
    rotation: 0,
    renderMode: 'Fill',
    editable: true,
    viewOnlyReason: null,
  }],
  viewOnlyObjects: [],
};


function accepted<T>(requestId: string, result: T, revision = 0) {
  return {
    schemaVersion: 'edit-content-reply/v1' as const,
    requestId,
    sessionId: 'session-1',
    status: 'accepted' as const,
    acceptedRevision: revision,
    result,
  };
}


function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/edit-content']}>
      <ToastProvider>
        <EditContentPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}


beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(contentApi.openContentSession).mockResolvedValue(accepted('open-request', { state, discovery }));
  vi.mocked(contentApi.renderContentPage).mockResolvedValue(accepted('render-request', {
    pageIndex: 0,
    widthPx: 1082,
    heightPx: 1400,
    mimeType: 'image/jpeg' as const,
    dataBase64: '/9j/2Q==',
    sha256: 'b'.repeat(64),
  }));
  vi.mocked(contentApi.hitTestContentObject).mockResolvedValue(accepted('hit-request', {
    hitTest: { outcome: 'selected' as const, targetId: 'target-0', mutationCommandCreated: false as const },
  }));
  vi.mocked(contentApi.inspectContentObjects).mockResolvedValue(accepted('inspect-request', { discovery }, 1));
});


describe('Edit Content page', () => {
  it('keeps progress and cancellation interactive while verification is pending', async () => {
    let finish!: (reply: Awaited<ReturnType<typeof contentApi.applyContentDraft>>) => void;
    vi.mocked(contentApi.applyContentDraft).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(contentApi.cancelContentRequest).mockResolvedValue(undefined);
    const { container } = renderPage();
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['%PDF'], 'source.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.change(await screen.findByLabelText('Native text object'), { target: { value: 'target-0' } });
    const editor = await screen.findByLabelText('Replacement text');
    for (const value of ['P', 'Press', 'Press B to continue']) {
      fireEvent.change(editor, { target: { value } });
      expect(editor).toHaveValue(value);
    }
    expect(contentApi.applyContentDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Apply & verify/i }));
    expect(await screen.findByText('Source and last accepted checkpoint remain unchanged until commit.')).toBeInTheDocument();
    expect(editor).toBeDisabled();
    expect(screen.getByRole('button', { name: /Apply & verify/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(contentApi.cancelContentRequest).toHaveBeenCalledWith('session-1', 'apply-request'));
    expect(await screen.findByText('Cancellation requested…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    finish({ schemaVersion: 'edit-content-reply/v1', requestId: 'apply-request', sessionId: 'session-1',
      status: 'rejected', acceptedRevision: 0, result: { state, clearDraft: false }, error: 'Cancelled safely.' });
    await screen.findByText(/Cancelled safely\..*selection and draft were cleared/i);
    expect(screen.queryByLabelText('Replacement text')).not.toBeInTheDocument();
    expect(contentApi.applyContentDraft).toHaveBeenCalledTimes(1);
  });

  it('invalidates a rejected target and requires fresh selection before a valid retry', async () => {
    const refreshedDiscovery = {
      ...discovery,
      textObjects: [{ ...discovery.textObjects[0], targetId: 'target-1', nativeObjectIdentity: 'native-1' }],
    };
    const committedDiscovery = {
      ...discovery,
      textObjects: [{ ...discovery.textObjects[0], targetId: 'target-2', nativeObjectIdentity: 'native-2', text: 'Press B to continue' }],
    };
    const nextState = { ...state, acceptedRevision: 1, dirty: true, canUndo: true };
    vi.mocked(contentApi.inspectContentObjects)
      .mockResolvedValueOnce(accepted('inspect-rejected', { discovery: refreshedDiscovery }))
      .mockResolvedValueOnce(accepted('inspect-accepted', { discovery: committedDiscovery }, 1));
    vi.mocked(contentApi.applyContentDraft)
      .mockResolvedValueOnce({
      schemaVersion: 'edit-content-reply/v1',
      requestId: 'apply-request',
      sessionId: 'session-1',
      status: 'rejected',
      acceptedRevision: 0,
      guardReason: 'REJECTED_UNSUPPORTED_GLYPH',
      error: 'The existing PDF font cannot represent the replacement text.',
      result: { state, clearDraft: false },
      })
      .mockResolvedValueOnce(accepted('apply-request', { state: nextState, clearDraft: true }, 1));
    const { container } = renderPage();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'source.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(contentApi.renderContentPage).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const viewport = await screen.findByTestId('edit-content-page', {}, { timeout: 3000 });
    fireEvent.click(viewport, { clientX: 10, clientY: 10 });
    const editor = await screen.findByLabelText('Replacement text');
    fireEvent.change(editor, { target: { value: 'Press É to continue' } });
    expect(contentApi.applyContentDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Apply & verify/i }));
    await screen.findByText(/The existing PDF font cannot represent the replacement text\..*selection and draft were cleared.*select the text again/i);
    expect(screen.queryByLabelText('Replacement text')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply & verify/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Revision 0/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Undo/i })).toBeDisabled();
    expect(contentApi.inspectContentObjects).toHaveBeenCalledWith('session-1', 0);
    expect(contentApi.applyContentDraft).toHaveBeenCalledTimes(1);

    fireEvent.change(await screen.findByLabelText('Native text object'), { target: { value: 'target-1' } });
    const freshEditor = await screen.findByLabelText('Replacement text');
    fireEvent.change(freshEditor, { target: { value: 'Press B to continue' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply & verify/i }));

    await screen.findByText('Edit accepted after save, close, reopen, and integrity verification.');
    expect(contentApi.applyContentDraft).toHaveBeenCalledTimes(2);
    expect(vi.mocked(contentApi.applyContentDraft).mock.calls[0][2]).toBe('target-0');
    expect(vi.mocked(contentApi.applyContentDraft).mock.calls[1][2]).toBe('target-1');
    expect(await screen.findByText(/Revision 1/)).toBeInTheDocument();
  });

  it('does not restore an expired selection from the old discovery while rejection refreshes', async () => {
    let finishInspection!: (reply: Awaited<ReturnType<typeof contentApi.inspectContentObjects>>) => void;
    const refreshedDiscovery = {
      ...discovery,
      textObjects: [{ ...discovery.textObjects[0], targetId: 'target-1', nativeObjectIdentity: 'native-1' }],
    };
    const committedDiscovery = {
      ...discovery,
      textObjects: [{ ...discovery.textObjects[0], targetId: 'target-2', nativeObjectIdentity: 'native-2', text: 'Press B to continue' }],
    };
    const nextState = { ...state, acceptedRevision: 1, dirty: true, canUndo: true };
    vi.mocked(contentApi.inspectContentObjects)
      .mockImplementationOnce(() => new Promise((resolve) => { finishInspection = resolve; }))
      .mockResolvedValueOnce(accepted('inspect-accepted', { discovery: committedDiscovery }, 1));
    vi.mocked(contentApi.applyContentDraft)
      .mockResolvedValueOnce({
        schemaVersion: 'edit-content-reply/v1', requestId: 'apply-request', sessionId: 'session-1',
        status: 'rejected', acceptedRevision: 0,
        error: 'The regenerated PDF did not preserve untouched content exactly enough.',
        result: { state, clearDraft: false },
      })
      .mockResolvedValueOnce(accepted('apply-request', { state: nextState, clearDraft: true }, 1));

    const { container } = renderPage();
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['%PDF'], 'source.pdf', { type: 'application/pdf' })] },
    });
    const picker = await screen.findByLabelText('Native text object');
    fireEvent.change(picker, { target: { value: 'target-0' } });
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press É to continue' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply & verify/i }));
    await waitFor(() => expect(contentApi.inspectContentObjects).toHaveBeenCalledWith('session-1', 0));

    // The old discovery is still rendered until inspection returns. A user action
    // during that window must not recreate the expired selection or draft.
    if (!(picker as HTMLSelectElement).disabled) {
      fireEvent.change(picker, { target: { value: 'target-0' } });
      fireEvent.change(screen.getByLabelText('Replacement text'), { target: { value: 'Press C to continue' } });
    }
    finishInspection(accepted('inspect-rejected', { discovery: refreshedDiscovery }));

    expect(await screen.findByText(/The regenerated PDF did not preserve untouched content exactly enough\..*Select the text again before retrying\./i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Select text on the page' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Selected native text' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Replacement text')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply & verify/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Native text object')).toHaveValue('');
    expect(contentApi.applyContentDraft).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Native text object'), { target: { value: 'target-1' } });
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press B to continue' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply & verify/i }));
    expect(await screen.findByText('Edit accepted after save, close, reopen, and integrity verification.')).toBeInTheDocument();
    expect(vi.mocked(contentApi.applyContentDraft).mock.calls.map((call) => call[2])).toEqual(['target-0', 'target-1']);
    expect(screen.queryByLabelText('Replacement text')).not.toBeInTheDocument();
  });

  it('drops a pending selection when a guarded Apply rejects', async () => {
    vi.mocked(contentApi.applyContentDraft).mockResolvedValue({
      schemaVersion: 'edit-content-reply/v1', requestId: 'apply-request', sessionId: 'session-1',
      status: 'rejected', acceptedRevision: 0,
      error: 'The regenerated PDF did not preserve untouched content exactly enough.',
      result: { state, clearDraft: false },
    });
    const { container } = renderPage();
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['%PDF'], 'source.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.change(await screen.findByLabelText('Native text object'), { target: { value: 'target-0' } });
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press B to continue' } });
    fireEvent.click(await screen.findByTestId('edit-content-page'));
    expect(await screen.findByText('Keep the current draft?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply & continue' }));

    expect(await screen.findByText(/The regenerated PDF did not preserve untouched content exactly enough\..*Select the text again before retrying\./i)).toBeInTheDocument();
    expect(screen.queryByText('Keep the current draft?')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Replacement text')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply & verify/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Native text object')).toHaveValue('');
  });

  it('offers apply, discard, and cancel before page deselection', async () => {
    const { container } = renderPage();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF'], 'source.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(await screen.findByTestId('edit-content-page'));
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press B to continue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deselect' }));
    expect(await screen.findByText('Keep the current draft?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply & continue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('never reselects a revision-scoped target after applying a draft', async () => {
    const nextState = { ...state, acceptedRevision: 1, dirty: true, canUndo: true };
    vi.mocked(contentApi.applyContentDraft).mockResolvedValue(accepted(
      'apply-request',
      { state: nextState, clearDraft: true },
      1,
    ));
    const { container } = renderPage();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF'], 'source.pdf', { type: 'application/pdf' })] } });
    const viewport = await screen.findByTestId('edit-content-page');
    fireEvent.click(viewport);
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press B to continue' } });

    fireEvent.click(viewport);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply & continue' }));

    await screen.findByText('Edit accepted and the page was refreshed. Select the next text object again.');
    expect(screen.queryByLabelText('Replacement text')).not.toBeInTheDocument();
  });

  it('provides keyboard-accessible exact-object selection', async () => {
    const { container } = renderPage();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF'], 'source.pdf', { type: 'application/pdf' })] } });

    const picker = await screen.findByLabelText('Native text object');
    fireEvent.change(picker, { target: { value: 'target-0' } });

    expect(await screen.findByLabelText('Replacement text')).toHaveValue('Press A to continue');
  });
});
