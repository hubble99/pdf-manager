import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePenLine,
  FileText,
  Loader2,
  Redo2,
  RotateCcw,
  Save,
  Undo2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { Filename } from '../components/Filename';
import { PageHeader, StateView } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { triggerBlobDownload } from '../utils/downloadHelper';
import {
  applyContentDraft,
  cancelContentRequest,
  closeContentSession,
  contentRequestId,
  downloadContentOutput,
  hitTestContentObject,
  inspectContentObjects,
  moveContentHistory,
  openContentSession,
  renderContentPage,
  saveContentSession,
} from '../features/edit-content/api';
import { EditContentViewport } from '../features/edit-content/EditContentViewport';
import type {
  ContentReply,
  ContentSessionState,
  NativeDiscovery,
  NativeRender,
  NativeTextObjectDescriptor,
  Point,
} from '../features/edit-content/types';
import { buildEditCommand, explainGuard } from '../features/edit-content/workflow';


type Phase = 'idle' | 'opening' | 'rendering' | 'selecting' | 'applying' | 'saving' | 'history' | 'closing';
type PendingAction =
  | { kind: 'select'; target: NativeTextObjectDescriptor }
  | { kind: 'deselect' }
  | { kind: 'page'; pageIndex: number }
  | { kind: 'history'; action: 'undo' | 'redo' }
  | { kind: 'leave'; path?: string };


function replyError(reply: ContentReply): string {
  return reply.error || explainGuard(reply.guardReason);
}


export function EditContentPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const renderSequence = useRef(0);
  const inspectSequence = useRef(0);

  const [file, setFile] = useState<File | null>(null);
  const [session, setSession] = useState<ContentSessionState | null>(null);
  const [discovery, setDiscovery] = useState<NativeDiscovery | null>(null);
  const [render, setRender] = useState<NativeRender | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(0.75);
  const [selected, setSelected] = useState<NativeTextObjectDescriptor | null>(null);
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [activeRequest, setActiveRequest] = useState<{ id: string; label: string } | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState<NativeTextObjectDescriptor[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const currentPage = discovery?.pages.find((page) => page.pageIndex === pageIndex);
  const pageObjects = useMemo(
    () => discovery?.textObjects.filter((object) => object.pageIndex === pageIndex) ?? [],
    [discovery, pageIndex],
  );
  const draftDirty = Boolean(selected && draft !== selected.text);
  const unsaved = draftDirty || Boolean(session?.dirty);
  const busy = phase !== 'idle';

  const selectTarget = useCallback((target: NativeTextObjectDescriptor | null) => {
    setSelected(target);
    setDraft(target?.text ?? '');
    setAmbiguous([]);
    setError(null);
    if (target) window.setTimeout(() => editorRef.current?.focus(), 0);
  }, []);

  const refreshAcceptedCheckpoint = useCallback(async (next: ContentSessionState) => {
    const sequence = ++inspectSequence.current;
    setPhase('rendering');
    setRender(null);
    setSelected(null);
    setDraft('');
    setAmbiguous([]);
    setPending(null);
    try {
      const reply = await inspectContentObjects(next.sessionId, next.acceptedRevision);
      if (sequence !== inspectSequence.current || reply.status !== 'accepted'
        || reply.acceptedRevision !== next.acceptedRevision) return false;
      setDiscovery(reply.result.discovery);
      setPageIndex((value) => Math.min(value, Math.max(0, reply.result.discovery.pages.length - 1)));
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not refresh the accepted checkpoint.');
      return false;
    } finally {
      if (sequence === inspectSequence.current) setPhase('idle');
    }
  }, []);

  useEffect(() => {
    if (!session || !currentPage) return;
    const sequence = ++renderSequence.current;
    const controller = new AbortController();
    const aspect = currentPage.widthPt / currentPage.heightPt;
    const width = aspect >= 1 ? 1400 : Math.round(1400 * aspect);
    const height = aspect >= 1 ? Math.round(1400 / aspect) : 1400;
    void renderContentPage(
      session.sessionId,
      session.acceptedRevision,
      pageIndex,
      Math.max(320, width),
      Math.max(320, height),
      controller.signal,
    ).then((reply) => {
      if (
        sequence === renderSequence.current
        && reply.status === 'accepted'
        && reply.sessionId === session.sessionId
        && reply.acceptedRevision === session.acceptedRevision
        && reply.result.pageIndex === pageIndex
      ) {
        setRender(reply.result);
      }
    }).catch((caught) => {
      if (!controller.signal.aborted && sequence === renderSequence.current) {
        setError(caught instanceof Error ? caught.message : 'Native page rendering failed.');
      }
    });
    return () => controller.abort();
  }, [currentPage, pageIndex, session]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!unsaved) return;
      event.preventDefault();
    };
    const handleLink = (event: MouseEvent) => {
      if (!unsaved || event.defaultPrevented || event.button !== 0) return;
      const link = (event.target as Element | null)?.closest('a[href]') as HTMLAnchorElement | null;
      if (!link || link.target || link.origin !== window.location.origin || link.pathname === window.location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      setPending({ kind: 'leave', path: `${link.pathname}${link.search}${link.hash}` });
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleLink, true);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleLink, true);
    };
  }, [unsaved]);

  const openFile = useCallback(async (nextFile: File) => {
    if (!nextFile.name.toLowerCase().endsWith('.pdf')) {
      setError('Edit Content accepts PDF files only.');
      return;
    }
    setPhase('opening');
    setError(null);
    setNotice(null);
    try {
      const reply = await openContentSession(nextFile);
      if (reply.status !== 'accepted') {
        setError(replyError(reply));
        return;
      }
      setFile(nextFile);
      setSession(reply.result.state);
      setDiscovery(reply.result.discovery);
      setPageIndex(0);
      setZoom(0.75);
      selectTarget(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Edit Content engine is unavailable.');
    } finally {
      setPhase('idle');
    }
  }, [selectTarget]);

  const executePending = useCallback(async (action: PendingAction, currentSession = session) => {
    setPending(null);
    if (action.kind === 'select') selectTarget(action.target);
    if (action.kind === 'deselect') selectTarget(null);
    if (action.kind === 'page') {
      selectTarget(null);
      setRender(null);
      setPageIndex(action.pageIndex);
    }
    if (action.kind === 'history' && currentSession) {
      const requestId = contentRequestId(action.action);
      setActiveRequest({ id: requestId, label: action.action === 'undo' ? 'Restoring previous checkpoint' : 'Restoring next checkpoint' });
      setPhase('history');
      setError(null);
      try {
        const reply = await moveContentHistory(
          currentSession.sessionId,
          currentSession.acceptedRevision,
          action.action,
          requestId,
        );
        if (reply.status !== 'accepted') {
          setError(replyError(reply));
          return;
        }
        setSession(reply.result.state);
        await refreshAcceptedCheckpoint(reply.result.state);
        setNotice(action.action === 'undo' ? 'Previous verified checkpoint restored.' : 'Next verified checkpoint restored.');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'History could not be changed safely.');
      } finally {
        setActiveRequest(null);
        setPhase('idle');
      }
    }
    if (action.kind === 'leave') {
      if (currentSession) {
        setPhase('closing');
        try {
          const discarding = draftDirty || currentSession.dirty;
          await closeContentSession(
            currentSession.sessionId,
            currentSession.acceptedRevision,
            draftDirty,
            discarding ? 'discard' : 'none',
          );
        } catch {
          // Closing is best effort after the user explicitly discards the private session.
        }
      }
      setFile(null);
      setSession(null);
      setDiscovery(null);
      setRender(null);
      selectTarget(null);
      setPhase('idle');
      if (action.path) navigate(action.path);
    }
  }, [draftDirty, navigate, refreshAcceptedCheckpoint, selectTarget, session]);

  const requestAction = useCallback((action: PendingAction) => {
    if ((action.kind === 'leave' && unsaved) || (action.kind !== 'leave' && draftDirty)) {
      setPending(action);
      return;
    }
    void executePending(action);
  }, [draftDirty, executePending, unsaved]);

  const applyDraft = useCallback(async (after?: PendingAction) => {
    if (!session || !selected || !draftDirty) return false;
    const edit = buildEditCommand(selected.text, draft);
    if (!edit) {
      setError('Insert-only changes are outside Edit Content V1. Replace or remove existing text instead.');
      return false;
    }
    const requestId = contentRequestId('apply');
    setActiveRequest({ id: requestId, label: 'Regenerating and verifying the PDF' });
    setCancelRequested(false);
    setPhase('applying');
    setError(null);
    try {
      const reply = await applyContentDraft(
        session.sessionId, session.acceptedRevision, selected.targetId, edit, requestId,
      );
      if (reply.status !== 'accepted') {
        const reason = replyError(reply);
        const refreshed = await refreshAcceptedCheckpoint(session);
        setError(refreshed
          ? `${reason} The selection and draft were cleared because the target identity expired. Select the text again before retrying.`
          : `${reason} The selection and draft were cleared. Refresh the page, then select the text again before retrying.`);
        return false;
      }
      setSession(reply.result.state);
      await refreshAcceptedCheckpoint(reply.result.state);
      if (after?.kind === 'select') {
        setNotice('Edit accepted and the page was refreshed. Select the next text object again.');
      } else {
        setNotice('Edit accepted after save, close, reopen, and integrity verification.');
        if (after) await executePending(after, reply.result.state);
      }
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The edit could not be verified safely.');
      return false;
    } finally {
      setActiveRequest(null);
      setCancelRequested(false);
      setPhase('idle');
    }
  }, [draft, draftDirty, executePending, refreshAcceptedCheckpoint, selected, session]);

  const saveSession = useCallback(async (after?: PendingAction) => {
    if (!session) return false;
    const edit = selected && draftDirty ? buildEditCommand(selected.text, draft) ?? undefined : undefined;
    if (selected && draftDirty && !edit) {
      setError('Insert-only changes are outside Edit Content V1. Replace or remove existing text instead.');
      return false;
    }
    const requestId = contentRequestId('save');
    setActiveRequest({ id: requestId, label: 'Verifying and publishing the PDF' });
    setCancelRequested(false);
    setPhase('saving');
    setError(null);
    try {
      const reply = await saveContentSession(
        session.sessionId,
        session.acceptedRevision,
        requestId,
        edit ? selected?.targetId : undefined,
        edit,
      );
      if (reply.status !== 'accepted') {
        setError(replyError(reply));
        return false;
      }
      setSession(reply.result.state);
      if (edit) await refreshAcceptedCheckpoint(reply.result.state);
      setNotice('Verified output published.');
      showToast({ type: 'success', title: 'PDF saved', message: 'A verified app-owned output is ready.' });
      try {
        const blob = await downloadContentOutput(session.sessionId, reply.result.outputId);
        triggerBlobDownload(blob, `${file?.name.replace(/\.pdf$/i, '') || 'document'}-edited.pdf`);
      } catch {
        showToast({
          type: 'info',
          title: 'Output published',
          message: 'The PDF is saved, but the browser download could not start. Use Save again to create another output.',
        });
      }
      if (after) await executePending(after, reply.result.state);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The verified PDF could not be published.');
      return false;
    } finally {
      setActiveRequest(null);
      setCancelRequested(false);
      setPhase('idle');
    }
  }, [draft, draftDirty, executePending, file, refreshAcceptedCheckpoint, selected, session, showToast]);

  const handleViewportPoint = useCallback(async (point: Point, viewportSize: Point) => {
    if (!session || !currentPage || busy) return;
    const expectedSession = session.sessionId;
    const expectedRevision = session.acceptedRevision;
    setPhase('selecting');
    setError(null);
    try {
      const reply = await hitTestContentObject({
        sessionId: expectedSession,
        acceptedRevision: expectedRevision,
        pageIndex,
        point,
        cropBox: currentPage.cropBox,
        rotation: currentPage.rotation,
        viewportSize,
      });
      if (reply.sessionId !== expectedSession || reply.acceptedRevision !== expectedRevision || reply.status !== 'accepted') return;
      const hit = reply.result.hitTest;
      if (hit.outcome === 'selected' && hit.targetId) {
        const target = pageObjects.find((object) => object.targetId === hit.targetId);
        if (target) requestAction({ kind: 'select', target });
      } else if (hit.outcome === 'ambiguous') {
        setAmbiguous(pageObjects.filter((object) => hit.candidateTargetIds?.includes(object.targetId)));
        setNotice('Several native text objects overlap here. Choose the exact object from the list.');
      } else if (hit.outcome === 'viewOnly') {
        setNotice(explainGuard(hit.reason));
      } else if (hit.outcome === 'none') {
        requestAction({ kind: 'deselect' });
      } else {
        setError(explainGuard(hit.reason));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Text selection failed.');
    } finally {
      setPhase('idle');
    }
  }, [busy, currentPage, pageIndex, pageObjects, requestAction, session]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!session || event.defaultPrevented) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveSession();
      } else if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        requestAction({ kind: 'history', action: event.shiftKey ? 'redo' : 'undo' });
      } else if (event.key === 'Escape' && selected) {
        event.preventDefault();
        requestAction({ kind: 'deselect' });
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [requestAction, saveSession, selected, session]);

  const cancelActive = async () => {
    if (!session || !activeRequest || cancelRequested) return;
    setCancelRequested(true);
    await cancelContentRequest(session.sessionId, activeRequest.id).catch(() => undefined);
  };

  const resolvePendingPrimary = async () => {
    if (!pending) return;
    if (pending.kind === 'leave') await saveSession(pending);
    else await applyDraft(pending);
  };

  const resolvePendingDiscard = async () => {
    if (!pending) return;
    setDraft(selected?.text ?? '');
    await executePending(pending);
  };

  const totalPages = discovery?.pages.length ?? 0;

  return (
    <div className="feature-page edit-content-page">
      <PageHeader
        icon={FilePenLine}
        title="Edit Content"
        description="Correct supported native PDF text with guarded regeneration and verification"
        actions={session ? (
          <>
            <span className={`badge ${unsaved ? 'badge-warning' : 'badge-success'}`}>
              {unsaved ? 'Unsaved changes' : 'Saved checkpoint'}
            </span>
            <button className="btn btn-primary" onClick={() => void saveSession()} disabled={busy} id="edit-content-save">
              <Save size={16} aria-hidden="true" /> Save verified PDF
            </button>
          </>
        ) : undefined}
      />

      <div className="page-body page-body--workspace">
        {!file || !session || !discovery ? (
          <div className="edit-content-onboarding">
            <div
              className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && fileInputRef.current?.click()}
              onDragOver={(event) => { event.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragOver(false);
                const next = event.dataTransfer.files[0];
                if (next) void openFile(next);
              }}
              aria-label="Open a PDF in Edit Content"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                hidden
                onChange={(event) => {
                  const next = event.target.files?.[0];
                  event.target.value = '';
                  if (next) void openFile(next);
                }}
              />
              {phase === 'opening' ? <Loader2 className="drop-zone-icon spin" aria-hidden="true" /> : <Upload className="drop-zone-icon" aria-hidden="true" />}
              <p className="drop-zone-title">Open one PDF</p>
              <p className="drop-zone-sub">Native text stays local. The original file is never overwritten.</p>
              <span className="badge badge-neutral">PDF · up to 16 MiB</span>
            </div>
            <div className="edit-content-safety-note">
              <Check size={18} aria-hidden="true" />
              <div>
                <strong>Verified before acceptance</strong>
                <p>Every supported edit is regenerated privately, reopened, and checked before it enters history or becomes downloadable.</p>
              </div>
            </div>
            {error && <div className="status-banner status-banner--error" role="alert"><AlertTriangle size={16} />{error}</div>}
          </div>
        ) : (
          <div className="feature-split-layout edit-content-layout">
            <section className="feature-controls edit-content-controls" aria-label="Edit Content controls">
              <div className="edit-content-file-row">
                <FileText size={20} aria-hidden="true" />
                <div>
                  <Filename name={file.name} className="file-item-name" />
                  <span className="file-item-meta">Revision {session.acceptedRevision} · {totalPages} pages</span>
                </div>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => requestAction({ kind: 'leave' })} aria-label="Close PDF">
                  <X size={15} aria-hidden="true" />
                </button>
              </div>

              {pending && (
                <div className="edit-content-decision" role="alert" aria-live="assertive">
                  <strong>{pending.kind === 'leave' ? 'Save changes before leaving?' : 'Keep the current draft?'}</strong>
                  <p>{pending.kind === 'leave' ? 'Save publishes exact verified bytes. Discard closes only this Content session.' : 'Apply verifies the draft. Discard restores the accepted text.'}</p>
                  <div className="edit-content-decision-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => void resolvePendingPrimary()}>
                      {pending.kind === 'leave' ? 'Save & continue' : 'Apply & continue'}
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => void resolvePendingDiscard()}>Discard</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setPending(null)}>Cancel</button>
                  </div>
                </div>
              )}

              {activeRequest && (
                <div className="edit-content-progress" role="status" aria-live="polite">
                  <Loader2 size={16} aria-hidden="true" />
                  <div><strong>{activeRequest.label}</strong><span>{cancelRequested ? 'Cancellation requested…' : 'Source and last accepted checkpoint remain unchanged until commit.'}</span></div>
                  <button className="btn btn-secondary btn-sm" onClick={() => void cancelActive()} disabled={cancelRequested}>Cancel</button>
                </div>
              )}

              {error && <div className="status-banner status-banner--error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}
              {notice && !error && <div className="status-banner status-banner--info" role="status"><Check size={16} aria-hidden="true" />{notice}</div>}

              {ambiguous.length > 0 && (
                <div className="edit-content-section">
                  <h2>Choose the exact object</h2>
                  <div className="edit-content-object-list">
                    {ambiguous.map((object) => (
                      <button key={object.targetId} className="edit-content-object-option" onClick={() => requestAction({ kind: 'select', target: object })}>
                        <span>{object.text || 'Empty text object'}</span>
                        <small>{object.font.family} · {object.fontSizePt.toFixed(1)} pt</small>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="edit-content-section edit-content-editor-section">
                <div className="edit-content-section-heading">
                  <div>
                    <h2>{selected ? 'Selected native text' : 'Select text on the page'}</h2>
                    <p>{selected ? 'Edit the text only. Position, font, and styling remain owned by the PDF.' : 'Click a supported native text object in the document.'}</p>
                  </div>
                  {selected && <span className="badge badge-info">Exact object</span>}
                </div>
                {pageObjects.length > 0 && (
                  <div className="edit-content-object-picker">
                    <label className="input-label" htmlFor="edit-content-object">Native text object</label>
                    <select
                      id="edit-content-object"
                      className="input"
                      value={selected?.targetId ?? ''}
                      onChange={(event) => {
                        const target = pageObjects.find((object) => object.targetId === event.target.value);
                        requestAction(target ? { kind: 'select', target } : { kind: 'deselect' });
                      }}
                      disabled={busy}
                    >
                      <option value="">Choose supported text…</option>
                      {pageObjects.map((object) => (
                        <option key={object.targetId} value={object.targetId}>
                          {object.text || 'Empty text object'}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {selected ? (
                  <>
                    <label className="input-label" htmlFor="edit-content-draft">Replacement text</label>
                    <textarea
                      ref={editorRef}
                      id="edit-content-draft"
                      className="input edit-content-textarea"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      disabled={busy}
                      spellCheck={false}
                    />
                    <div className="edit-content-object-meta">
                      <span>{selected.font.family || selected.font.name}</span>
                      <span>{selected.fontSizePt.toFixed(1)} pt</span>
                      {selected.rotation !== 0 && <span>{Math.round(selected.rotation)}°</span>}
                    </div>
                    <div className="edit-content-editor-actions">
                      <button className="btn btn-primary" onClick={() => void applyDraft()} disabled={!draftDirty || busy} id="edit-content-apply">
                        <RotateCcw size={15} aria-hidden="true" /> Apply & verify
                      </button>
                      <button className="btn btn-ghost" onClick={() => requestAction({ kind: 'deselect' })} disabled={busy}>Deselect</button>
                    </div>
                    <p className="edit-content-hint">Typing changes this draft only. The PDF is regenerated once when you Apply or Save.</p>
                  </>
                ) : (
                  <StateView icon={FilePenLine} title="No text selected" description="Scanned, outlined, Type 3, split, or uncertain text remains view-only." />
                )}
              </div>

              <div className="edit-content-history-actions" aria-label="Edit Content history">
                <button className="btn btn-secondary" onClick={() => requestAction({ kind: 'history', action: 'undo' })} disabled={!session.canUndo || busy}>
                  <Undo2 size={15} aria-hidden="true" /> Undo
                </button>
                <button className="btn btn-secondary" onClick={() => requestAction({ kind: 'history', action: 'redo' })} disabled={!session.canRedo || busy}>
                  <Redo2 size={15} aria-hidden="true" /> Redo
                </button>
              </div>
            </section>

            <section className="feature-preview edit-content-preview" aria-label="Native PDF preview">
              <div className="edit-content-toolbar">
                <div className="edit-content-toolbar-group" aria-label="Page navigation">
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={() => requestAction({ kind: 'page', pageIndex: pageIndex - 1 })} disabled={pageIndex <= 0 || busy} aria-label="Previous page"><ChevronLeft size={16} /></button>
                  <span className="text-mono">Page {pageIndex + 1} / {totalPages}</span>
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={() => requestAction({ kind: 'page', pageIndex: pageIndex + 1 })} disabled={pageIndex + 1 >= totalPages || busy} aria-label="Next page"><ChevronRight size={16} /></button>
                </div>
                <div className="edit-content-toolbar-group" aria-label="Zoom controls">
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setZoom((value) => Math.max(0.35, value - 0.1))} aria-label="Zoom out"><ZoomOut size={16} /></button>
                  <span className="text-mono">{Math.round(zoom * 100)}%</span>
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))} aria-label="Zoom in"><ZoomIn size={16} /></button>
                </div>
              </div>
              <EditContentViewport
                page={currentPage}
                render={render}
                selected={selected}
                zoom={zoom}
                loading={render === null}
                onPoint={(point, viewportSize) => void handleViewportPoint(point, viewportSize)}
              />
              <div className="edit-content-preview-footer">
                <span>Native PDFium render</span>
                <span>{pageObjects.length} native text objects on this page</span>
                {session.lastOutputId && <span><Download size={13} aria-hidden="true" /> Published output available</span>}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
