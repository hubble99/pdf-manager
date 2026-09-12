import apiClient from '../../api/client';
import type {
  ContentReply,
  ContentSessionState,
  EditCommand,
  HitTestResult,
  NativeDiscovery,
  NativeRender,
  Point,
} from './types';

const SCHEMA = 'edit-content-request/v1' as const;

export function contentRequestId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
    ?? `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`.slice(0, 128);
}

function envelope(
  sessionId: string,
  requestId: string,
  command: 'inspect' | 'render' | 'apply' | 'history' | 'save' | 'close',
  acceptedRevision: number,
  payload: Record<string, unknown>,
  targetId?: string,
) {
  return {
    schemaVersion: SCHEMA,
    requestId,
    sessionId,
    command,
    expectedAcceptedRevision: acceptedRevision,
    ...(targetId ? { targetId } : {}),
    payload,
  };
}

export async function openContentSession(file: File, signal?: AbortSignal) {
  const requestId = contentRequestId('open');
  const form = new FormData();
  form.append('file', file);
  form.append('schemaVersion', SCHEMA);
  form.append('requestId', requestId);
  form.append('command', 'open');
  const response = await apiClient.post<ContentReply<{ state: ContentSessionState; discovery: NativeDiscovery }>>(
    '/api/v1/edit-content/sessions', form, { signal },
  );
  return response.data;
}

export async function inspectContentObjects(sessionId: string, acceptedRevision: number, signal?: AbortSignal) {
  const requestId = contentRequestId('inspect');
  const response = await apiClient.post<ContentReply<{ discovery: NativeDiscovery }>>(
    `/api/v1/edit-content/sessions/${sessionId}/objects`,
    envelope(sessionId, requestId, 'inspect', acceptedRevision, {}),
    { signal },
  );
  return response.data;
}

export async function hitTestContentObject(args: {
  sessionId: string;
  acceptedRevision: number;
  pageIndex: number;
  point: Point;
  cropBox: { left: number; bottom: number; right: number; top: number };
  rotation: number;
  viewportSize: Point;
  signal?: AbortSignal;
}) {
  const requestId = contentRequestId('hit');
  const payload = {
    operation: 'hitTest',
    pageIndex: args.pageIndex,
    coordinateSpace: 'viewportCss',
    point: args.point,
    viewportTransform: {
      cropBox: args.cropBox,
      rotation: String(args.rotation),
      zoom: 1,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollCss: { x: 0, y: 0 },
      viewportOriginCss: { x: 0, y: 0 },
      viewportSizeCss: args.viewportSize,
    },
  };
  const response = await apiClient.post<ContentReply<{ hitTest: HitTestResult }>>(
    `/api/v1/edit-content/sessions/${args.sessionId}/objects`,
    envelope(args.sessionId, requestId, 'inspect', args.acceptedRevision, payload),
    { signal: args.signal },
  );
  return response.data;
}

export async function renderContentPage(
  sessionId: string,
  acceptedRevision: number,
  pageIndex: number,
  widthPx: number,
  heightPx: number,
  signal?: AbortSignal,
) {
  const requestId = contentRequestId('render');
  const response = await apiClient.post<ContentReply<NativeRender>>(
    `/api/v1/edit-content/sessions/${sessionId}/render`,
    envelope(sessionId, requestId, 'render', acceptedRevision, { pageIndex, widthPx, heightPx }),
    { signal },
  );
  return response.data;
}

export async function applyContentDraft(
  sessionId: string,
  acceptedRevision: number,
  targetId: string,
  edit: EditCommand,
  requestId: string,
  signal?: AbortSignal,
) {
  const response = await apiClient.post<ContentReply<{ state: ContentSessionState; clearDraft: boolean }>>(
    `/api/v1/edit-content/sessions/${sessionId}/apply`,
    envelope(sessionId, requestId, 'apply', acceptedRevision, { edit }, targetId),
    { signal },
  );
  return response.data;
}

export async function saveContentSession(
  sessionId: string,
  acceptedRevision: number,
  requestId: string,
  targetId?: string,
  draft?: EditCommand,
  signal?: AbortSignal,
) {
  const response = await apiClient.post<ContentReply<{ state: ContentSessionState; outputId: string; clearDraft: boolean }>>(
    `/api/v1/edit-content/sessions/${sessionId}/save`,
    envelope(sessionId, requestId, 'save', acceptedRevision, draft ? { draft } : {}, targetId),
    { signal },
  );
  return response.data;
}

export async function moveContentHistory(
  sessionId: string,
  acceptedRevision: number,
  action: 'undo' | 'redo',
  requestId: string,
  signal?: AbortSignal,
) {
  const response = await apiClient.post<ContentReply<{ state: ContentSessionState }>>(
    `/api/v1/edit-content/sessions/${sessionId}/history`,
    envelope(sessionId, requestId, 'history', acceptedRevision, { action, pendingDraft: false }),
    { signal },
  );
  return response.data;
}

export async function closeContentSession(
  sessionId: string,
  acceptedRevision: number,
  pendingDraft: boolean,
  decision: 'discard' | 'none',
) {
  const requestId = contentRequestId('close');
  const response = await apiClient.post<ContentReply<{ closed: boolean }>>(
    `/api/v1/edit-content/sessions/${sessionId}/close`,
    envelope(sessionId, requestId, 'close', acceptedRevision, { pendingDraft, decision }),
  );
  return response.data;
}

export async function cancelContentRequest(sessionId: string, requestId: string) {
  await apiClient.post(`/api/v1/edit-content/sessions/${sessionId}/requests/${requestId}/cancel`);
}

export async function downloadContentOutput(sessionId: string, outputId: string) {
  const response = await apiClient.get<Blob>(
    `/api/v1/edit-content/sessions/${sessionId}/outputs/${outputId}`,
    { responseType: 'blob' },
  );
  return response.data;
}
