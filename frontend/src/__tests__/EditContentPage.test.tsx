import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../context/ToastContext';
import { EditContentPage } from '../pages/EditContentPage';
import type { ContentSessionState, NativeDiscovery } from '../features/edit-content/types';
import * as contentApi from '../features/edit-content/api';

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
vi.mock('../utils/tauriDialog', () => ({
  isTauri: () => true,
  openFilePicker: vi.fn(async () => null),
  openOutputFolder: vi.fn(async () => true),
}));


vi.mock('../features/edit-content/api', () => ({
  contentRequestId: vi.fn((prefix: string) => `${prefix}-request`),
  openContentSession: vi.fn(),
  inspectContentObjects: vi.fn(),
  hitTestContentObject: vi.fn(),
  renderContentPage: vi.fn(),
  applyContentDraft: vi.fn(),
  preflightContentEdit: vi.fn(),
  saveContentSession: vi.fn(),
  moveContentHistory: vi.fn(),
  closeContentSession: vi.fn(),
  cancelContentRequest: vi.fn(),
  exportContentOutput: vi.fn(),
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

/** Drops a PDF on the window, which is how the desktop shell hands the page a path. */
async function dropPdf(path = 'C:\\Docs\\source.pdf') {
  await waitFor(() => expect(drag.handlers.length).toBeGreaterThanOrEqual(1));
  act(() => drag.handlers.forEach((handler) => handler({ payload: { type: 'drop', paths: [path] } })));
}

async function chooseNativeText(targetId: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Native text object' }));
  fireEvent.change(screen.getByRole('listbox', { name: 'Native text options' }), {
    target: { value: targetId },
  });
}


beforeEach(() => {
  vi.clearAllMocks();
  drag.handlers = [];
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
  vi.mocked(contentApi.preflightContentEdit).mockResolvedValue(accepted('preflight-request', {
    preflight: { eligible: true, guardReasons: [], primaryGuardReason: null, detailCodes: [], unsupportedCodePoints: [] },
  }));
});


describe('Edit Content page', () => {
  it('shows the engine verdict before Apply and blocks an edit the guards will reject', async () => {
    vi.mocked(contentApi.preflightContentEdit).mockResolvedValue(accepted('preflight-request', {
      preflight: {
        eligible: false,
        guardReasons: ['REJECTED_UNSUPPORTED_GLYPH'],
        primaryGuardReason: 'REJECTED_UNSUPPORTED_GLYPH',
        detailCodes: ['MISSING_GLYPH'],
        unsupportedCodePoints: [0x71],
      },
    }));
    renderPage();
    await dropPdf();
    await chooseNativeText('target-0');
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press q to continue' } });
    const message = await screen.findByText(/has no glyph for "q"/);
    expect(message).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: /Apply & verify/i })).toBeDisabled();
    expect(contentApi.preflightContentEdit).toHaveBeenCalledWith(
      'session-1', 0, 'target-0',
      { expectedText: 'Press A to continue', expectedOldText: 'A', replacementText: 'q', utf16Start: 6, utf16End: 7 },
      expect.anything(),
    );
    expect(contentApi.applyContentDraft).not.toHaveBeenCalled();

    // Fixing the text re-runs the check and re-enables Apply.
    vi.mocked(contentApi.preflightContentEdit).mockResolvedValue(accepted('preflight-request', {
      preflight: { eligible: true, guardReasons: [], primaryGuardReason: null, detailCodes: [], unsupportedCodePoints: [] },
    }));
    fireEvent.change(screen.getByLabelText('Replacement text'), { target: { value: 'Press B to continue' } });
    await screen.findByText(/passes the engine checks/);
    expect(screen.getByRole('button', { name: /Apply & verify/i })).toBeEnabled();
  });

  it('does not block Apply when the advisory check itself fails', async () => {
    vi.mocked(contentApi.preflightContentEdit).mockRejectedValue(new Error('network'));
    renderPage();
    await dropPdf();
    await chooseNativeText('target-0');
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press B to continue' } });
    await waitFor(() => expect(contentApi.preflightContentEdit).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Apply & verify/i })).toBeEnabled();
    expect(screen.queryByRole('status', { name: '' })).toBeNull();
  });

  it('sends an insertion such as ayam -> bayam as a one-character replacement', async () => {
    const insertDiscovery = {
      ...discovery,
      textObjects: [{ ...discovery.textObjects[0], text: 'ayam', unicodeScalarLength: 4 }],
    };
    vi.mocked(contentApi.openContentSession).mockResolvedValue(accepted('open-request', { state, discovery: insertDiscovery }));
    vi.mocked(contentApi.applyContentDraft).mockResolvedValue(accepted(
      'apply-request', { state: { ...state, acceptedRevision: 1, dirty: true, canUndo: true }, clearDraft: true }, 1,
    ));
    renderPage();
    await dropPdf();
    await chooseNativeText('target-0');
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'bayam' } });
    await screen.findByText(/passes the engine checks/);
    fireEvent.click(screen.getByRole('button', { name: /Apply & verify/i }));
    await waitFor(() => expect(contentApi.applyContentDraft).toHaveBeenCalledWith(
      'session-1', 0, 'target-0',
      { expectedText: 'ayam', expectedOldText: 'a', replacementText: 'ba', utf16Start: 0, utf16End: 1 },
      'apply-request',
    ));
  });

  it('does not list whitespace-only text objects as choices', async () => {
    const blankDiscovery = {
      ...discovery,
      textObjects: [
        discovery.textObjects[0],
        { ...discovery.textObjects[0], targetId: 'target-blank', nativeObjectIdentity: 'native-blank', text: '', unicodeScalarLength: 0 },
        { ...discovery.textObjects[0], targetId: 'target-space', nativeObjectIdentity: 'native-space', text: '  ', unicodeScalarLength: 2 },
      ],
    };
    vi.mocked(contentApi.openContentSession).mockResolvedValue(accepted('open-request', { state, discovery: blankDiscovery }));
    renderPage();
    await dropPdf();
    await screen.findByRole('heading', { name: 'Select text on the page' });
    fireEvent.click(screen.getByRole('button', { name: 'Native text object' }));
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Choose supported text…', 'Press A to continue']);
    expect(screen.getByPlaceholderText('Find text on this page (1)')).toBeInTheDocument();
  });

  it('tells the user when the opened PDF restricted editing and the copy will not', async () => {
    vi.mocked(contentApi.openContentSession).mockResolvedValue(accepted('open-request', {
      state, discovery, permissionsRemoved: true,
    }) as never);
    renderPage();
    await dropPdf();
    expect(await screen.findByText(/restricts editing/i)).toBeInTheDocument();
  });

  it('offers Open Folder once the verified PDF has been saved', async () => {
    vi.mocked(contentApi.openContentSession).mockResolvedValue(accepted('open-request', {
      state: { ...state, dirty: true, canUndo: true, acceptedRevision: 1 }, discovery,
    }));
    vi.mocked(contentApi.saveContentSession).mockResolvedValue(accepted('save-request', {
      state: { ...state, dirty: false, acceptedRevision: 1 }, outputId: 'output-1', clearDraft: true,
    }, 1) as never);
    vi.mocked(contentApi.exportContentOutput).mockResolvedValue({ path: 'C:\\Users\\me\\Downloads\\source-edited.pdf', fileName: 'source-edited.pdf' });
    renderPage();
    await dropPdf();
    fireEvent.click(await screen.findByRole('button', { name: /Save PDF/i }));
    expect(await screen.findByText(/source-edited\.pdf/)).toBeInTheDocument();
    expect(document.getElementById('edit-content-open-folder-btn')).not.toBeNull();
  });

  it('ignores whitespace-only objects when a click overlaps several objects', async () => {
    const overlapDiscovery = {
      ...discovery,
      textObjects: [
        discovery.textObjects[0],
        { ...discovery.textObjects[0], targetId: 'target-blank', nativeObjectIdentity: 'native-blank', text: '', unicodeScalarLength: 0 },
      ],
    };
    vi.mocked(contentApi.openContentSession).mockResolvedValue(accepted('open-request', { state, discovery: overlapDiscovery }));
    vi.mocked(contentApi.hitTestContentObject).mockResolvedValue(accepted('hit-request', {
      hitTest: { outcome: 'ambiguous' as const, candidateTargetIds: ['target-0', 'target-blank'], mutationCommandCreated: false as const },
    }) as never);
    renderPage();
    await dropPdf();
    fireEvent.click(await screen.findByTestId('edit-content-page'));
    // The one real object is selected outright; no "Choose the exact object" list appears.
    expect(await screen.findByLabelText('Replacement text')).toHaveValue('Press A to continue');
    expect(screen.queryByText('Choose the exact object')).not.toBeInTheDocument();
    expect(screen.queryByText('Empty text object')).not.toBeInTheDocument();
  });

  it('explains hidden text layers instead of silently ignoring the click', async () => {
    const hiddenDiscovery = {
      ...discovery,
      textObjects: [
        { ...discovery.textObjects[0], targetId: 'target-hidden', text: 'Gedung E Jalan Harsono', editable: false, viewOnlyReason: 'INVISIBLE_TEXT' },
        { ...discovery.textObjects[0], targetId: 'target-blank', nativeObjectIdentity: 'native-blank', text: '', unicodeScalarLength: 0, editable: false, viewOnlyReason: 'INVISIBLE_TEXT' },
      ],
    };
    vi.mocked(contentApi.openContentSession).mockResolvedValue(accepted('open-request', { state, discovery: hiddenDiscovery }));
    vi.mocked(contentApi.hitTestContentObject).mockResolvedValue(accepted('hit-request', {
      hitTest: { outcome: 'ambiguous' as const, candidateTargetIds: ['target-hidden', 'target-blank'], mutationCommandCreated: false as const },
    }) as never);
    renderPage();
    await dropPdf();
    fireEvent.click(await screen.findByTestId('edit-content-page'));
    expect(await screen.findByText(/invisible \(a hidden layer over an image\)/)).toBeInTheDocument();
  });

  it('opens text choices below the picker and shows V1 limits before editing', async () => {
    renderPage();
    expect(screen.getByText('Edit Content V1 limits')).toBeInTheDocument();
    await dropPdf();
    await screen.findByRole('heading', { name: 'Select text on the page' });
    expect(screen.getByText('Edit Content V1 limits')).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'Native text object' });
    fireEvent.click(trigger);
    const choices = screen.getByRole('listbox', { name: 'Native text options' });
    expect(choices).toHaveAttribute('size', '6');
    expect(trigger.compareDocumentPosition(choices) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter native text objects' }), {
      target: { value: 'missing' },
    });
    expect(screen.getByText('No matching text on this page.')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Filter native text objects' }), { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Native text options' })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'Press A to continue' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('listbox', { name: 'Native text options' }), { target: { value: 'target-0' } });
    expect(screen.queryByRole('listbox', { name: 'Native text options' })).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Replacement text')).toHaveValue('Press A to continue');
  });

  it('keeps the native trailing separator when replacing a word without typing its space', async () => {
    const spacedDiscovery = {
      ...discovery,
      textObjects: [{ ...discovery.textObjects[0], text: 'Nomor ', unicodeScalarLength: 6 }],
    };
    const nextState = { ...state, acceptedRevision: 1, dirty: true, canUndo: true };
    vi.mocked(contentApi.openContentSession).mockResolvedValue(accepted('open-request', {
      state, discovery: spacedDiscovery,
    }));
    vi.mocked(contentApi.applyContentDraft).mockResolvedValue(accepted(
      'apply-request', { state: nextState, clearDraft: true }, 1,
    ));
    renderPage();
    await dropPdf();
    await chooseNativeText('target-0');
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Nomoo' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply & verify/i }));

    await waitFor(() => expect(contentApi.applyContentDraft).toHaveBeenCalledWith(
      'session-1', 0, 'target-0', {
        expectedText: 'Nomor ', expectedOldText: 'r', replacementText: 'o', utf16Start: 4, utf16End: 5,
      }, 'apply-request',
    ));
    expect(await screen.findByText('Edit accepted after save, close, reopen, and integrity verification.')).toBeInTheDocument();
  });

  it('keeps progress and cancellation interactive while verification is pending', async () => {
    let finish!: (reply: Awaited<ReturnType<typeof contentApi.applyContentDraft>>) => void;
    vi.mocked(contentApi.applyContentDraft).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(contentApi.cancelContentRequest).mockResolvedValue(undefined);
    renderPage();
    await dropPdf();
    await chooseNativeText('target-0');
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

  it('keeps the target and draft after a guard rejection so the user can revise it', async () => {
    const nextState = { ...state, acceptedRevision: 1, dirty: true, canUndo: true };
    vi.mocked(contentApi.applyContentDraft)
      .mockResolvedValueOnce({
        schemaVersion: 'edit-content-reply/v1', requestId: 'apply-request', sessionId: 'session-1',
        status: 'rejected', acceptedRevision: 0, guardReason: 'REJECTED_UNSUPPORTED_GLYPH',
        error: 'The existing font cannot represent the replacement text.',
        result: { state, clearDraft: false },
      })
      .mockResolvedValueOnce(accepted('apply-request', { state: nextState, clearDraft: true }, 1));
    renderPage();
    await dropPdf();
    fireEvent.click(await screen.findByTestId('edit-content-page', {}, { timeout: 3000 }), { clientX: 10, clientY: 10 });
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press É to continue' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply & verify/i }));

    // The page's own (translatable) guard text is shown, not the engine's English text.
    expect(await screen.findByText(
      'The existing PDF font cannot represent the replacement. Your text is kept. Change it and apply again.',
    )).toBeInTheDocument();
    expect(screen.getByLabelText('Replacement text')).toHaveValue('Press É to continue');
    expect(screen.getByRole('heading', { name: 'Selected native text' })).toBeInTheDocument();
    // The identical draft would be refused again, so Apply waits for a change.
    expect(screen.getByRole('button', { name: /Apply & verify/i })).toBeDisabled();
    expect(contentApi.inspectContentObjects).not.toHaveBeenCalled();
    expect(screen.getByText(/Revision 0/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Replacement text'), { target: { value: 'Press B to continue' } });
    const apply = screen.getByRole('button', { name: /Apply & verify/i });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);

    await screen.findByText('Edit accepted after save, close, reopen, and integrity verification.');
    expect(vi.mocked(contentApi.applyContentDraft).mock.calls.map((call) => call[2])).toEqual(['target-0', 'target-0']);
    expect(await screen.findByText(/Revision 1/)).toBeInTheDocument();
  });

  it('asks for a fresh selection when a kept target has expired after all', async () => {
    const refreshedDiscovery = {
      ...discovery,
      textObjects: [{ ...discovery.textObjects[0], targetId: 'target-1', nativeObjectIdentity: 'native-1' }],
    };
    vi.mocked(contentApi.inspectContentObjects).mockResolvedValueOnce(accepted('inspect-stale', { discovery: refreshedDiscovery }));
    vi.mocked(contentApi.applyContentDraft)
      .mockResolvedValueOnce({
        schemaVersion: 'edit-content-reply/v1', requestId: 'apply-request', sessionId: 'session-1',
        status: 'rejected', acceptedRevision: 0, guardReason: 'REJECTED_LAYOUT',
        result: { state, clearDraft: false },
      })
      .mockResolvedValueOnce({
        schemaVersion: 'edit-content-reply/v1', requestId: 'apply-request', sessionId: 'session-1',
        status: 'stale', acceptedRevision: 0, guardReason: 'REJECTED_STALE_TARGET',
        error: 'The selected text is no longer current. Select it again.',
        result: { state, clearDraft: false },
      });
    renderPage();
    await dropPdf();
    await chooseNativeText('target-0');
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press A to continue now' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply & verify/i }));
    await screen.findByText(/unsupported layout changes\. Your text is kept/);

    fireEvent.change(screen.getByLabelText('Replacement text'), { target: { value: 'Press A to go' } });
    const apply = screen.getByRole('button', { name: /Apply & verify/i });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);

    await screen.findByText(/This selection is no longer current\. Select the text again\..*selection and draft were cleared/);
    expect(screen.queryByLabelText('Replacement text')).not.toBeInTheDocument();
    expect(contentApi.inspectContentObjects).toHaveBeenCalledWith('session-1', 0);
    await chooseNativeText('target-1');
    expect(await screen.findByLabelText('Replacement text')).toHaveValue('Press A to continue');
  });

  it('keeps the draft but drops the pending step when Apply & continue is refused by a guard', async () => {
    vi.mocked(contentApi.applyContentDraft).mockResolvedValue({
      schemaVersion: 'edit-content-reply/v1', requestId: 'apply-request', sessionId: 'session-1',
      status: 'rejected', acceptedRevision: 0, guardReason: 'REJECTED_COLLATERAL_INTEGRITY',
      result: { state, clearDraft: false },
    });
    renderPage();
    await dropPdf();
    await chooseNativeText('target-0');
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press B to continue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deselect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply & continue' }));

    await screen.findByText(/unexpected change elsewhere in the PDF\. Your text is kept/);
    expect(screen.queryByText('Keep the current draft?')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Replacement text')).toHaveValue('Press B to continue');
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

    renderPage();
    await dropPdf();
    const picker = await screen.findByRole('button', { name: 'Native text object' });
    await chooseNativeText('target-0');
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press É to continue' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply & verify/i }));
    await waitFor(() => expect(contentApi.inspectContentObjects).toHaveBeenCalledWith('session-1', 0));

    // The old discovery is still rendered until inspection returns. A user action
    // during that window must not recreate the expired selection or draft.
    if (!(picker as HTMLSelectElement).disabled) {
      fireEvent.click(picker);
      fireEvent.change(screen.getByRole('listbox', { name: 'Native text options' }), { target: { value: 'target-0' } });
      fireEvent.change(screen.getByLabelText('Replacement text'), { target: { value: 'Press C to continue' } });
    }
    finishInspection(accepted('inspect-rejected', { discovery: refreshedDiscovery }));

    expect(await screen.findByText(/The regenerated PDF did not preserve untouched content exactly enough\..*Select the text again before retrying\./i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Select text on the page' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Selected native text' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Replacement text')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply & verify/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Native text object' })).toHaveTextContent('Choose supported text…');
    expect(contentApi.applyContentDraft).toHaveBeenCalledTimes(1);

    await chooseNativeText('target-1');
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
    renderPage();
    await dropPdf();
    await chooseNativeText('target-0');
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press B to continue' } });
    fireEvent.click(await screen.findByTestId('edit-content-page'));
    expect(await screen.findByText('Keep the current draft?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply & continue' }));

    expect(await screen.findByText(/The regenerated PDF did not preserve untouched content exactly enough\..*Select the text again before retrying\./i)).toBeInTheDocument();
    expect(screen.queryByText('Keep the current draft?')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Replacement text')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply & verify/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Native text object' })).toHaveTextContent('Choose supported text…');
  });

  it('offers apply, discard, and cancel before page deselection', async () => {
    renderPage();
    await dropPdf();
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
    renderPage();
    await dropPdf();
    const viewport = await screen.findByTestId('edit-content-page');
    fireEvent.click(viewport);
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press B to continue' } });

    fireEvent.click(viewport);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply & continue' }));

    await screen.findByText('Edit accepted and the page was refreshed. Select the next text object again.');
    expect(screen.queryByLabelText('Replacement text')).not.toBeInTheDocument();
  });

  it('opens the editor after choosing an exact text object', async () => {
    renderPage();
    await dropPdf();

    await chooseNativeText('target-0');

    expect(await screen.findByLabelText('Replacement text')).toHaveValue('Press A to continue');
  });
  it('does not start Save or Undo from the keyboard while Apply is running', async () => {
    let finish!: (reply: Awaited<ReturnType<typeof contentApi.applyContentDraft>>) => void;
    vi.mocked(contentApi.applyContentDraft).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderPage();
    await dropPdf();
    await chooseNativeText('target-0');
    fireEvent.change(await screen.findByLabelText('Replacement text'), { target: { value: 'Press B to continue' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply & verify/i }));
    await screen.findByText('Regenerating and verifying the PDF');

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(contentApi.saveContentSession).not.toHaveBeenCalled();
    expect(contentApi.moveContentHistory).not.toHaveBeenCalled();
    expect(screen.queryByText('Keep the current draft?')).not.toBeInTheDocument();

    finish(accepted('apply-request', { state: { ...state, acceptedRevision: 1, dirty: true, canUndo: true }, clearDraft: true }, 1));
    await screen.findByText('Edit accepted after save, close, reopen, and integrity verification.');
  });

  it('leaves Ctrl+Z in the text box to the text box', async () => {
    renderPage();
    await dropPdf();
    await chooseNativeText('target-0');
    const editor = await screen.findByLabelText('Replacement text');
    fireEvent.change(editor, { target: { value: 'Press B to continue' } });
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expect(screen.queryByText('Keep the current draft?')).not.toBeInTheDocument();
    expect(contentApi.moveContentHistory).not.toHaveBeenCalled();

    // Outside a text field the shortcut still reaches the document history.
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(await screen.findByText('Keep the current draft?')).toBeInTheDocument();
  });

  it('closes only the text picker when Escape is pressed in its search', async () => {
    renderPage();
    await dropPdf();
    await chooseNativeText('target-0');
    await screen.findByLabelText('Replacement text');
    fireEvent.click(screen.getByRole('button', { name: 'Native text object' }));
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Filter native text objects' }), { key: 'Escape' });
    expect(screen.queryByRole('searchbox', { name: 'Filter native text objects' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Replacement text')).toHaveValue('Press A to continue');
  });

  it('shows a failed page render with a way to try again', async () => {
    vi.mocked(contentApi.renderContentPage)
      .mockResolvedValueOnce({
        schemaVersion: 'edit-content-reply/v1', requestId: 'render-request', sessionId: 'session-1',
        status: 'rejected', acceptedRevision: 0, guardReason: 'REJECTED_UNSUPPORTED_STRUCTURE',
        result: {} as never,
      });
    renderPage();
    await dropPdf();
    expect(await screen.findByText('This page could not be shown')).toBeInTheDocument();
    expect(screen.queryByText('Rendering verified PDF…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByTestId('edit-content-page')).toBeInTheDocument();
    expect(contentApi.renderContentPage).toHaveBeenCalledTimes(2);
  });

  it('opens the PDF by its path and names the exported file after the output name', async () => {
    vi.mocked(contentApi.saveContentSession).mockResolvedValue(accepted('save-request', {
      state: { ...state, dirty: false, acceptedRevision: 1 }, outputId: 'output-1', clearDraft: true,
    }, 1) as never);
    vi.mocked(contentApi.exportContentOutput).mockResolvedValue({ path: 'C:\\Users\\me\\Downloads\\source-edited.pdf', fileName: 'source-edited.pdf' });
    renderPage();
    await dropPdf('C:\\Docs\\source.pdf');
    await screen.findByTestId('edit-content-page');
    expect(contentApi.openContentSession).toHaveBeenCalledWith('C:\\Docs\\source.pdf');
    fireEvent.click(await screen.findByRole('button', { name: /Save PDF/i }));
    await screen.findByText(/source-edited\.pdf/);
    expect(contentApi.exportContentOutput).toHaveBeenCalledWith('session-1', 'output-1', 'source-edited');
  });

  it('says why a PDF could not be opened', async () => {
    vi.mocked(contentApi.openContentSession).mockRejectedValue(new Error('This PDF is larger than the 16 MiB Edit Content limit.'));
    renderPage();
    await dropPdf('C:\\Docs\\large.pdf');
    expect(await screen.findByText('This PDF is larger than the 16 MiB Edit Content limit.')).toBeInTheDocument();
  });

  it('turns away a dropped file that is not a PDF', async () => {
    renderPage();
    await dropPdf('C:\\Docs\\notes.txt');
    expect(await screen.findByText('Edit Content accepts PDF files only.')).toBeInTheDocument();
    expect(contentApi.openContentSession).not.toHaveBeenCalled();
  });
});
