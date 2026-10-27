import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePenLine,
  FileText,
  FolderOpen,
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
import { FEATURE_ICONS } from '../components/icons';

import { Filename } from '../components/Filename';
import { PageHeader, StateView } from '../components/ui';
import { BETA_TOOLTIP } from '../config/features';
import { useToast } from '../hooks/useToast';
import { useNativePaths } from '../hooks/useNativePaths';
import { useLeaveGuard } from '../hooks/useLeaveGuard';
import { baseName } from '../utils/paths';
import { openOutputFolder } from '../utils/tauriDialog';
import {
  applyContentDraft,
  cancelContentRequest,
  closeContentSession,
  contentRequestId,
  exportContentOutput,
  hitTestContentObject,
  inspectContentObjects,
  moveContentHistory,
  openContentSession,
  preflightContentEdit,
  renderContentPage,
  saveContentSession,
} from '../features/edit-content/api';
import { EditContentViewport } from '../features/edit-content/EditContentViewport';
import type {
  ContentSessionState,
  NativeDiscovery,
  NativeRender,
  NativeTextObjectDescriptor,
  Point,
} from '../features/edit-content/types';
import {
  buildEditCommand,
  explainGuard,
  explainPreflight,
  keepsDraftAfterRejection,
  replyError,
} from '../features/edit-content/workflow';
import { t } from '../i18n';


type Phase = 'idle' | 'opening' | 'rendering' | 'selecting' | 'applying' | 'saving' | 'history' | 'closing';
type PendingAction =
  | { kind: 'select'; target: NativeTextObjectDescriptor }
  | { kind: 'deselect' }
  | { kind: 'page'; pageIndex: number }
  | { kind: 'history'; action: 'undo' | 'redo' }
  | { kind: 'leave'; path?: string };


/** Shortcuts typed into a text field belong to that field (its own undo, for example). */
function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
}

function EditContentLimits() {
  return (
    <aside className="edit-content-limits" aria-label={t('Edit Content V1 limits')}>
      <strong>{t('Edit Content V1 limits')}</strong>
      <p>{t('Replace, delete, or extend the text of one selectable text object at a time. A longer replacement works only when it fits without reflow. Your original file is never overwritten.')}</p>
      <p>{t('These stay view-only and cannot be edited: scanned pages, outlined text, Type 3 fonts, text split across objects, and invisible text such as the hidden text layer sitting over an image (a letterhead, for example). To change text that is part of an image, edit the image itself.')}</p>
      <p>{t('Every edit is verified after it is regenerated, and a PDF that cannot be verified is rejected instead of changed. Editing a digitally signed PDF invalidates its signature.')}</p>
    </aside>
  );
}


export function EditContentPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const pickerSearchRef = useRef<HTMLInputElement>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const renderSequence = useRef(0);
  const inspectSequence = useRef(0);

  // The document being edited: the path it was opened from, and its name.
  const [file, setFile] = useState<{ path: string; name: string } | null>(null);
  const [session, setSession] = useState<ContentSessionState | null>(null);
  const [discovery, setDiscovery] = useState<NativeDiscovery | null>(null);
  const [render, setRender] = useState<NativeRender | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(0.75);
  const zoomedByUser = useRef(false);
  const handleFitZoom = useCallback((fit: number) => {
    if (!zoomedByUser.current) setZoom(Math.min(1, Math.max(0.2, Math.floor(fit * 100) / 100)));
  }, []);
  const [selected, setSelected] = useState<NativeTextObjectDescriptor | null>(null);
  const [draft, setDraft] = useState('');
  // The draft a guard just refused for the selected target, and why. Apply waits for a change.
  const [rejection, setRejection] = useState<{ draft: string; message: string } | null>(null);
  const [renderAttempt, setRenderAttempt] = useState(0);
  // A failed render, tagged with the request it belongs to so a newer render ignores it.
  const [renderFailure, setRenderFailure] = useState<{ key: string; message: string } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [activeRequest, setActiveRequest] = useState<{ id: string; label: string } | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [outputName, setOutputName] = useState('');
  const [ambiguous, setAmbiguous] = useState<NativeTextObjectDescriptor[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  // Dry run of the engine's guards for the current draft (read-only, no PDF change).
  const [check, setCheck] = useState<
    { state: 'idle' } | { state: 'checking' } | { state: 'ok' } | { state: 'blocked'; message: string }
  >({ state: 'idle' });

  const currentPage = discovery?.pages.find((page) => page.pageIndex === pageIndex);
  const pageObjects = useMemo(
    () => discovery?.textObjects.filter((object) => object.pageIndex === pageIndex) ?? [],
    [discovery, pageIndex],
  );
  // Whitespace-only and view-only objects (e.g. the empty spacing runs Word emits, hidden text
  // layers) are not meaningful edit targets; listing them only adds noise.
  const pickableObjects = useMemo(
    () => pageObjects.filter((object) => object.editable && object.text.trim() !== ''),
    [pageObjects],
  );
  const filteredPageObjects = useMemo(() => {
    const query = pickerQuery.trim().toLocaleLowerCase();
    return query ? pickableObjects.filter((object) => object.text.toLocaleLowerCase().includes(query)) : pickableObjects;
  }, [pickableObjects, pickerQuery]);
  const draftDirty = Boolean(selected && draft !== selected.text);
  const draftRejected = rejection !== null && rejection.draft === draft;
  // A draft the engine refused, or that the dry run says it will refuse, cannot be
  // applied, so there is nothing to keep or save: moving on needs no question.
  const draftWorthKeeping = draftDirty && !draftRejected && check.state !== 'blocked';
  const defaultStem = file?.name.replace(/\.pdf$/i, '') || 'document';
  const unsaved = draftWorthKeeping || Boolean(session?.dirty);
  // Unsaved work has its own question (save or discard); a clean session just warns that the file goes.
  useLeaveGuard(Boolean(file && session) && !unsaved);
  const busy = phase !== 'idle';
  const sessionId = session?.sessionId;
  const sessionRevision = session?.acceptedRevision;

  useEffect(() => {
    // Any change to the draft or target invalidates the previous advisory check.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCheck({ state: 'idle' });
    if (!sessionId || sessionRevision === undefined || !selected || !draftDirty) return undefined;
    const edit = buildEditCommand(selected.text, draft);
    if (!edit) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setCheck({ state: 'checking' });
      try {
        const reply = await preflightContentEdit(sessionId, sessionRevision, selected.targetId, edit, controller.signal);
        if (controller.signal.aborted) return;
        const result = reply.status === 'accepted' ? reply.result?.preflight : undefined;
        if (!result) setCheck({ state: 'idle' });
        else setCheck(result.eligible ? { state: 'ok' } : { state: 'blocked', message: explainPreflight(result) });
      } catch {
        // The check is advisory; Apply runs the same guards authoritatively.
        if (!controller.signal.aborted) setCheck({ state: 'idle' });
      }
    }, 350);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [draft, draftDirty, selected, sessionId, sessionRevision]);

  const selectTarget = useCallback((target: NativeTextObjectDescriptor | null) => {
    setPickerOpen(false);
    setPickerQuery('');
    setSelected(target);
    setDraft(target?.text ?? '');
    setRejection(null);
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
    setRejection(null);
    setAmbiguous([]);
    setPending(null);
    setPickerOpen(false);
    setPickerQuery('');
    try {
      const reply = await inspectContentObjects(next.sessionId, next.acceptedRevision);
      if (sequence !== inspectSequence.current || reply.status !== 'accepted'
        || reply.acceptedRevision !== next.acceptedRevision) return false;
      setDiscovery(reply.result.discovery);
      setPageIndex((value) => Math.min(value, Math.max(0, reply.result.discovery.pages.length - 1)));
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Could not refresh the accepted checkpoint.'));
      return false;
    } finally {
      if (sequence === inspectSequence.current) setPhase('idle');
    }
  }, []);

  useEffect(() => {
    if (!session || !currentPage) return;
    const sequence = ++renderSequence.current;
    const controller = new AbortController();
    const key = `${session.sessionId}:${session.acceptedRevision}:${pageIndex}:${renderAttempt}`;
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
      if (sequence !== renderSequence.current || controller.signal.aborted) return;
      if (
        reply.status === 'accepted'
        && reply.sessionId === session.sessionId
        && reply.acceptedRevision === session.acceptedRevision
        && reply.result.pageIndex === pageIndex
      ) {
        setRender(reply.result);
      } else if (reply.status !== 'accepted') {
        // Without this the preview would wait for a render that is never coming.
        setRenderFailure({ key, message: replyError(reply) });
      }
    }).catch((caught) => {
      if (!controller.signal.aborted && sequence === renderSequence.current) {
        setRenderFailure({ key, message: caught instanceof Error ? caught.message : t('Native page rendering failed.') });
      }
    });
    return () => controller.abort();
  }, [currentPage, pageIndex, renderAttempt, session]);

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

  const openFile = useCallback(async (path: string) => {
    setPhase('opening');
    setError(null);
    setNotice(null);
    try {
      const reply = await openContentSession(path);
      if (reply.status !== 'accepted') {
        setError(replyError(reply));
        return;
      }
      setFile({ path, name: baseName(path) });
      setSession(reply.result.state);
      setDiscovery(reply.result.discovery);
      setPageIndex(0);
      setZoom(0.75);
      zoomedByUser.current = false;
      selectTarget(null);
      if (reply.result.permissionsRemoved) {
        setNotice(t('This PDF restricts editing. The edited copy will not carry that restriction.'));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Edit Content engine is unavailable.'));
    } finally {
      setPhase('idle');
    }
  }, [selectTarget]);

  const { desktop, isDragOver, pick } = useNativePaths({
    filter: { name: 'PDF', extensions: ['pdf'] },
    multiple: false,
    pickerTitle: t('Choose a PDF'),
    disabled: phase !== 'idle' || session !== null,
    onPaths: (accepted, rejected) => {
      if (accepted.length > 0) void openFile(accepted[0]);
      else if (rejected > 0) setError(t('Edit Content accepts PDF files only.'));
    },
  });

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
      setActiveRequest({ id: requestId, label: action.action === 'undo' ? t('Restoring previous checkpoint') : t('Restoring next checkpoint') });
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
        setNotice(action.action === 'undo' ? t('Previous verified checkpoint restored.') : t('Next verified checkpoint restored.'));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : t('History could not be changed safely.'));
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
      setSavedName(null);
      setOutputName('');
      setSession(null);
      setDiscovery(null);
      setRender(null);
      selectTarget(null);
      setPhase('idle');
      if (action.path) navigate(action.path);
    }
  }, [draftDirty, navigate, refreshAcceptedCheckpoint, selectTarget, session]);

  const requestAction = useCallback((action: PendingAction) => {
    if ((action.kind === 'leave' && unsaved) || (action.kind !== 'leave' && draftWorthKeeping)) {
      setPending(action);
      return;
    }
    void executePending(action);
  }, [draftWorthKeeping, executePending, unsaved]);

  const applyDraft = useCallback(async (after?: PendingAction) => {
    if (!session || !selected || !draftDirty) return false;
    const edit = buildEditCommand(selected.text, draft);
    if (!edit) {
      setError(t('This change could not be converted into a valid edit. Adjust the text and try again.'));
      return false;
    }
    const requestId = contentRequestId('apply');
    setActiveRequest({ id: requestId, label: t('Regenerating and verifying the PDF') });
    setCancelRequested(false);
    setPhase('applying');
    setError(null);
    try {
      const reply = await applyContentDraft(
        session.sessionId, session.acceptedRevision, selected.targetId, edit, requestId,
      );
      if (reply.status !== 'accepted') {
        const reason = replyError(reply);
        if (keepsDraftAfterRejection(reply)) {
          // Only the candidate was discarded: keep the target and the typed text so
          // the user can revise it. A pending page/deselect/history step is dropped.
          setPending(null);
          setNotice(null);
          setRejection({ draft, message: t('{reason} Your text is kept. Change it and apply again.', { reason }) });
          return false;
        }
        const refreshed = await refreshAcceptedCheckpoint(session);
        setError(refreshed
          ? t('{reason} The selection and draft were cleared because the target identity expired. Select the text again before retrying.', { reason })
          : t('{reason} The selection and draft were cleared. Refresh the page, then select the text again before retrying.', { reason }));
        return false;
      }
      setSession(reply.result.state);
      await refreshAcceptedCheckpoint(reply.result.state);
      if (after?.kind === 'select') {
        setNotice(t('Edit accepted and the page was refreshed. Select the next text object again.'));
      } else {
        setNotice(t('Edit accepted after save, close, reopen, and integrity verification.'));
        if (after) await executePending(after, reply.result.state);
      }
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('The edit could not be verified safely.'));
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
      setError(t('This change could not be converted into a valid edit. Adjust the text and try again.'));
      return false;
    }
    const requestId = contentRequestId('save');
    setActiveRequest({ id: requestId, label: t('Verifying and publishing the PDF') });
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
        if (edit && keepsDraftAfterRejection(reply)) {
          setRejection({ draft, message: t('{reason} Your text is kept. Change it and apply again.', { reason: replyError(reply) }) });
        } else {
          setError(replyError(reply));
        }
        return false;
      }
      setSession(reply.result.state);
      if (edit) await refreshAcceptedCheckpoint(reply.result.state);
      setNotice(t('Verified output published.'));
      try {
        const exported = await exportContentOutput(
          session.sessionId, reply.result.outputId, outputName.trim() || `${defaultStem}-edited`,
        );
        const finalName = exported.fileName;
        setSavedName(finalName);
        showToast({
          type: 'success',
          title: t('PDF saved'),
          message: finalName,
          action: { label: t('Open Folder'), onClick: () => openOutputFolder() },
          duration: 8000,
        });
      } catch {
        showToast({
          type: 'info',
          title: t('Output published'),
          message: t('The PDF was created, but the file could not be written to your device. Use Save again to create another output.'),
        });
      }
      if (after) await executePending(after, reply.result.state);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('The verified PDF could not be published.'));
      return false;
    } finally {
      setActiveRequest(null);
      setCancelRequested(false);
      setPhase('idle');
    }
  }, [defaultStem, draft, draftDirty, executePending, outputName, refreshAcceptedCheckpoint, selected, session, showToast]);

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
        // Whitespace-only objects paint nothing; they are never a choice worth offering.
        const candidates = pickableObjects.filter((object) => hit.candidateTargetIds?.includes(object.targetId));
        if (candidates.length === 1) {
          requestAction({ kind: 'select', target: candidates[0] });
        } else if (candidates.length === 0) {
          const hidden = pageObjects.some((object) => hit.candidateTargetIds?.includes(object.targetId)
            && object.viewOnlyReason === 'INVISIBLE_TEXT' && object.text.trim() !== '');
          if (hidden) setNotice(explainGuard('INVISIBLE_TEXT'));
          else requestAction({ kind: 'deselect' });
        } else {
          setAmbiguous(candidates);
          setNotice(t('Several native text objects overlap here. Choose the exact object from the list.'));
        }
      } else if (hit.outcome === 'viewOnly') {
        setNotice(explainGuard(hit.reason));
      } else if (hit.outcome === 'none') {
        requestAction({ kind: 'deselect' });
      } else {
        setError(explainGuard(hit.reason));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Text selection failed.'));
    } finally {
      setPhase('idle');
    }
  }, [busy, currentPage, pageIndex, pageObjects, pickableObjects, requestAction, session]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!session || event.defaultPrevented) return;
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (busy || pending) {
        // A request is running or a decision is open: never start a second one,
        // but still keep the browser's own Save dialog away.
        if (command && key === 's') event.preventDefault();
        return;
      }
      if (command && key === 's') {
        event.preventDefault();
        void saveSession();
      } else if (command && key === 'z') {
        if (isTextField(event.target)) return;
        event.preventDefault();
        requestAction({ kind: 'history', action: event.shiftKey ? 'redo' : 'undo' });
      } else if (event.key === 'Escape' && selected) {
        // Escape in the text picker only closes the picker.
        if (event.target instanceof Element && event.target.closest('.edit-content-object-menu')) return;
        event.preventDefault();
        requestAction({ kind: 'deselect' });
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [busy, pending, requestAction, saveSession, selected, session]);

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
  const renderKey = session ? `${session.sessionId}:${session.acceptedRevision}:${pageIndex}:${renderAttempt}` : '';
  const renderError = renderFailure?.key === renderKey ? renderFailure.message : null;

  // Shown under the Apply button while a text object is selected, so the result
  // of Apply is next to the control that caused it.
  const statusBanners = (
    <>
      {error && <div className="status-banner status-banner--error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}
      {notice && !error && <div className="status-banner status-banner--info" role="status"><Check size={16} aria-hidden="true" />{notice}</div>}
    </>
  );

  return (
    <div className="feature-page edit-content-page">
      <PageHeader
        icon={FEATURE_ICONS['edit-content']}
        title={t('Edit Content')}
        description={t('Correct supported native PDF text with guarded regeneration and verification')}
        badge={{ label: 'BETA', title: BETA_TOOLTIP }}
        actions={session ? (
          <>
            <span className={`badge ${unsaved ? 'badge-warning' : 'badge-success'}`}>
              {unsaved ? t('Unsaved changes') : t('Saved checkpoint')}
            </span>
            <input
              id="edit-content-output-name"
              className="input edit-content-header-name"
              type="text"
              aria-label={t('Output filename')}
              title={t('Output filename. The .pdf extension is added automatically; the original file is never overwritten.')}
              value={outputName}
              onChange={(event) => setOutputName(event.target.value)}
              placeholder={`${defaultStem}-edited`}
            />
            <button className="btn btn-primary" onClick={() => void saveSession()} disabled={busy} id="edit-content-save">
              <Save size={16} aria-hidden="true" /> {t('Save PDF')}
            </button>
          </>
        ) : undefined}
      />

      <div className="page-body page-body--workspace">
        {!file || !session || !discovery ? (
          <div className="edit-content-onboarding">
            {!desktop ? (
              <div className="card status-card" role="note">
                <AlertTriangle size={20} aria-hidden="true" />
                <div className="status-card-copy">
                  <b>{t('Edit Content runs in the Dokuwu desktop app')}</b>
                  <small>{t('It works on the files directly on your computer, which the browser preview cannot do.')}</small>
                </div>
              </div>
            ) : (
            <div
              className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => void pick()}
              onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && void pick()}
              aria-label={t('Open a PDF in Edit Content')}
            >
              {phase === 'opening' ? <Loader2 className="drop-zone-icon spin" aria-hidden="true" /> : <Upload className="drop-zone-icon" aria-hidden="true" />}
              <p className="drop-zone-title">{t('Open one PDF')}</p>
              <p className="drop-zone-sub">{t('Native text stays local. The original file is never overwritten.')}</p>
              <span className="badge badge-neutral">{t('PDF · up to 16 MiB')}</span>
            </div>
            )}
            <div className="edit-content-safety-note">
              <Check size={18} aria-hidden="true" />
              <div>
                <strong>{t('Verified before acceptance')}</strong>
                <p>{t('Every supported edit is regenerated privately, reopened, and checked before it enters history or can be saved.')}</p>
              </div>
            </div>
            <div className="edit-content-limits edit-content-beta-notice" role="note" aria-label={t('Beta feature')}>
              <strong>{t('Beta feature')}</strong>
              <p>{t('Edit Content is still in beta and may be unstable. Some edits can fail or look different from what you expect. Your original file is never overwritten, so check the result before you use it.')}</p>
            </div>
            <EditContentLimits />
            {error && <div className="status-banner status-banner--error" role="alert"><AlertTriangle size={16} />{error}</div>}
          </div>
        ) : (
          <div className="feature-split-layout edit-content-layout">
            <section className="feature-controls edit-content-controls" aria-label={t('Edit Content controls')}>
              <div className="edit-content-file-row">
                <FileText size={20} aria-hidden="true" />
                <div>
                  <Filename name={file.name} className="file-item-name" />
                  <span className="file-item-meta">{t('Revision')} {session.acceptedRevision} · {totalPages} {t('pages')}</span>
                </div>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => requestAction({ kind: 'leave' })} aria-label={t('Close PDF')}>
                  <X size={15} aria-hidden="true" />
                </button>
              </div>

              {pending && (
                <div className="edit-content-decision" role="alert" aria-live="assertive">
                  <strong>{pending.kind === 'leave' ? t('Save changes before leaving?') : t('Keep the current draft?')}</strong>
                  <p>{pending.kind === 'leave' ? t('Save publishes exact verified bytes. Discard closes only this Content session.') : t('Apply verifies the draft. Discard restores the accepted text.')}</p>
                  <div className="edit-content-decision-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => void resolvePendingPrimary()}>
                      {pending.kind === 'leave' ? t('Save & continue') : t('Apply & continue')}
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => void resolvePendingDiscard()}>{t('Discard')}</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setPending(null)}>{t('Cancel')}</button>
                  </div>
                </div>
              )}

              {activeRequest && (
                <div className="edit-content-progress" role="status" aria-live="polite">
                  <Loader2 size={16} aria-hidden="true" />
                  <div><strong>{activeRequest.label}</strong><span>{cancelRequested ? t('Cancellation requested…') : t('Source and last accepted checkpoint remain unchanged until commit.')}</span></div>
                  <button className="btn btn-secondary btn-sm" onClick={() => void cancelActive()} disabled={cancelRequested}>{t('Cancel')}</button>
                </div>
              )}

              {!selected && statusBanners}

              {savedName && !unsaved && (
                <div className="card status-card status-card--ok" id="edit-content-saved">
                  <Check size={22} aria-hidden="true" />
                  <div className="status-card-copy">
                    <p className="merge-result" role="status">{t('Saved')} <span className="merge-tree-name">{savedName}</span></p>
                  </div>
                  <button className="btn btn-ghost btn-sm" id="edit-content-open-folder-btn" onClick={() => openOutputFolder()} title={t('Open folder')}>
                    <FolderOpen size={14} aria-hidden="true" /> {t('Open Folder')}
                  </button>
                </div>
              )}

              {ambiguous.length > 0 && (
                <div className="edit-content-section">
                  <h2>{t('Choose the exact object')}</h2>
                  <div className="edit-content-object-list">
                    {ambiguous.map((object) => (
                      <button key={object.targetId} className="edit-content-object-option" onClick={() => requestAction({ kind: 'select', target: object })}>
                        <span>{object.text || t('Empty text object')}</span>
                        <small>{object.font.family} · {object.fontSizePt.toFixed(1)} pt</small>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="edit-content-section edit-content-editor-section">
                <div className="edit-content-section-heading">
                  <div>
                    <h2>{selected ? t('Selected native text') : t('Select text on the page')}</h2>
                    {!selected && <p>{t('Click a supported native text object in the document.')}</p>}
                  </div>
                  {selected && <span className="badge badge-info">{t('Exact object')}</span>}
                </div>
                {pickableObjects.length > 0 && (
                  <div className="edit-content-object-picker">
                    <span className="input-label">{t('Native text object')}</span>
                    <button
                      ref={pickerTriggerRef}
                      type="button"
                      className="input edit-content-object-trigger"
                      aria-label={t('Native text object')}
                      aria-expanded={pickerOpen && !busy}
                      aria-controls={pickerOpen && !busy ? 'edit-content-object-options' : undefined}
                      onClick={() => {
                        setPickerOpen((open) => !open);
                        setPickerQuery('');
                        if (!pickerOpen) window.setTimeout(() => pickerSearchRef.current?.focus(), 0);
                      }}
                      disabled={busy}
                    >
                      <span>{selected?.text.trim() || t('Choose supported text…')}</span>
                      <ChevronDown size={16} aria-hidden="true" />
                    </button>
                    {pickerOpen && !busy && (
                      <div className="edit-content-object-menu" id="edit-content-object-options" onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setPickerOpen(false);
                          pickerTriggerRef.current?.focus();
                        }
                      }}>
                        <input
                          ref={pickerSearchRef}
                          className="input"
                          type="search"
                          aria-label={t('Filter native text objects')}
                          placeholder={t('Find text on this page ({count})', { count: pickableObjects.length })}
                          value={pickerQuery}
                          onChange={(event) => setPickerQuery(event.target.value)}
                        />
                        <select
                          className="input edit-content-object-listbox"
                          aria-label={t('Native text options')}
                          size={6}
                          value={selected?.targetId ?? ''}
                          onChange={(event) => {
                            const target = pageObjects.find((object) => object.targetId === event.target.value);
                            setPickerOpen(false);
                            setPickerQuery('');
                            if (target) requestAction({ kind: 'select', target });
                          }}
                        >
                          <option value="">{t('Choose supported text…')}</option>
                          {filteredPageObjects.map((object) => (
                            <option key={object.targetId} value={object.targetId}>
                              {object.text.trim()}
                            </option>
                          ))}
                        </select>
                        {filteredPageObjects.length === 0 && <p>{t('No matching text on this page.')}</p>}
                      </div>
                    )}
                  </div>
                )}
                {selected ? (
                  <>
                    <label className="input-label" htmlFor="edit-content-draft">{t('Replacement text')}</label>
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
                    {draftRejected ? (
                      <p
                        id="edit-content-check"
                        className="edit-content-check edit-content-check-blocked"
                        role="alert"
                      >
                        {rejection.message}
                      </p>
                    ) : draftDirty && check.state !== 'idle' && (
                      <p
                        id="edit-content-check"
                        className={`edit-content-check edit-content-check-${check.state}`}
                        role="status"
                        aria-live="polite"
                      >
                        {check.state === 'checking' && t('Checking this edit…')}
                        {check.state === 'ok' && t('This edit passes the engine checks. Final verification runs when you apply.')}
                        {check.state === 'blocked' && check.message}
                      </p>
                    )}
                    <div className="edit-content-editor-actions">
                      <button className="btn btn-primary" onClick={() => void applyDraft()} disabled={!draftDirty || busy || check.state === 'blocked' || draftRejected} id="edit-content-apply">
                        <RotateCcw size={15} aria-hidden="true" /> {t('Apply & verify')}
                      </button>
                      <button className="btn btn-ghost" onClick={() => requestAction({ kind: 'deselect' })} disabled={busy}>{t('Deselect')}</button>
                    </div>
                    {statusBanners}
                  </>
                ) : (
                  <StateView icon={FilePenLine} title={t('No text selected')} description={t('Scanned, outlined, Type 3, split, hidden, or uncertain text remains view-only.')} />
                )}
              </div>

              <div className="edit-content-history-actions" aria-label={t('Edit Content history')}>
                <button className="btn btn-secondary" onClick={() => requestAction({ kind: 'history', action: 'undo' })} disabled={!session.canUndo || busy}>
                  <Undo2 size={15} aria-hidden="true" /> {t('Undo')}
                </button>
                <button className="btn btn-secondary" onClick={() => requestAction({ kind: 'history', action: 'redo' })} disabled={!session.canRedo || busy}>
                  <Redo2 size={15} aria-hidden="true" /> {t('Redo')}
                </button>
              </div>
            </section>

            <section className="feature-preview edit-content-preview" aria-label={t('Native PDF preview')}>
              <div className="edit-content-toolbar">
                <div className="edit-content-toolbar-group" aria-label={t('Page navigation')}>
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={() => requestAction({ kind: 'page', pageIndex: pageIndex - 1 })} disabled={pageIndex <= 0 || busy} aria-label={t('Previous page')}><ChevronLeft size={16} /></button>
                  <span className="text-mono">{t('Page')} {pageIndex + 1} / {totalPages}</span>
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={() => requestAction({ kind: 'page', pageIndex: pageIndex + 1 })} disabled={pageIndex + 1 >= totalPages || busy} aria-label={t('Next page')}><ChevronRight size={16} /></button>
                </div>
                <div className="edit-content-toolbar-group" aria-label={t('Zoom controls')}>
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={() => { zoomedByUser.current = true; setZoom((value) => Math.max(0.2, value - 0.1)); }} aria-label={t('Zoom out')}><ZoomOut size={16} /></button>
                  <span className="text-mono">{Math.round(zoom * 100)}%</span>
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={() => { zoomedByUser.current = true; setZoom((value) => Math.min(1.5, value + 0.1)); }} aria-label={t('Zoom in')}><ZoomIn size={16} /></button>
                </div>
              </div>
              <EditContentViewport
                page={currentPage}
                render={render}
                selected={selected}
                zoom={zoom}
                onFitZoom={handleFitZoom}
                loading={render === null && !renderError}
                error={render === null ? renderError : null}
                onRetry={() => setRenderAttempt((value) => value + 1)}
                onPoint={(point, viewportSize) => void handleViewportPoint(point, viewportSize)}
              />
              <div className="edit-content-preview-footer">
                <span>{t('Native PDFium render')}</span>
                <span>{pageObjects.length} {t('native text objects on this page')}</span>
                {session.lastOutputId && <span><Download size={13} aria-hidden="true" /> {t('Published output available')}</span>}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
