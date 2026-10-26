import { invoke } from '@tauri-apps/api/core';
import { t } from '../../i18n';
import type {
  ContentReply,
  ContentSessionState,
  EditCommand,
  HitTestResult,
  NativeDiscovery,
  NativeRender,
  Point,
  PreflightResult,
} from './types';

const SCHEMA = 'edit-content-request/v1' as const;

/** A failure that came with no reply of its own: a stable `code` and a message in the user's language. */
export class EditContentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EditContentError';
    this.code = code;
  }
}

/** The message for each stable failure code, in the current language; the engine's own text is the fallback. */
function messageFor(code: string, fallback: string): string {
  switch (code) {
    case 'PDF_ENCRYPTED':
      return t('This PDF is encrypted or permission-protected, so Edit Content cannot inspect its fonts safely. Remove the protection first (Protect PDF > Remove Password), then open it again.');
    case 'PDF_UNREADABLE':
      return t('Edit Content could not read the structure of this PDF. The file may be damaged or malformed.');
    case 'REJECTED_UNSUPPORTED_STRUCTURE':
      return t('Edit Content V1 cannot safely edit this PDF because its font or page resources are outside the supported structure.');
    case 'ENGINE_START_FAILED':
      return t('The editing engine could not be started. Please try again; if it keeps failing, restart the app.');
    case 'OPEN_TIMEOUT':
      return t('The editing engine took too long to open this PDF. Please try again.');
    case 'INSPECT_TIMEOUT':
      return t('The editing engine took too long to analyse this PDF. Please try again.');
    case 'ENGINE_UNAVAILABLE':
      return t('Edit Content engine is unavailable.');
    case 'UNSUPPORTED_FILE':
      return t('Edit Content accepts PDF files only.');
    case 'FILE_TOO_LARGE':
      return t('This PDF is larger than the 16 MiB Edit Content limit.');
    case 'FILE_EMPTY':
      return t('This PDF file is empty.');
    case 'SESSION_NOT_FOUND':
      return t('Content session was not found.');
    case 'SESSION_UNVERIFIED':
      return t('Content recovery could not be verified.');
    case 'OUTPUT_NOT_FOUND':
      return t('Published output was not found.');
    case 'OUTPUT_UNVERIFIED':
      return t('Published output could not be verified.');
    case 'EXPORT_FAILED':
      return t('The PDF could not be saved to your Downloads folder.');
    default:
      return fallback;
  }
}

/** What a rejected command carries: `{ code, message }` from the core, or a plain string. */
function toEditContentError(raw: unknown): EditContentError {
  if (raw instanceof EditContentError) return raw;
  if (typeof raw === 'object' && raw !== null && 'code' in raw && typeof (raw as { code: unknown }).code === 'string') {
    const { code, message } = raw as { code: string; message?: unknown };
    return new EditContentError(code, messageFor(code, typeof message === 'string' ? message : t('Edit Content engine is unavailable.')));
  }
  return new EditContentError('ENGINE_UNAVAILABLE', typeof raw === 'string' && raw ? raw : t('Edit Content engine is unavailable.'));
}

async function call<T>(command: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  // A started request cannot be taken back; one that was dropped before it started never runs.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    throw toEditContentError(raw);
  }
}

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

/** Opens the PDF at `path`. The original file is never changed. */
export async function openContentSession(path: string, signal?: AbortSignal) {
  return call<ContentReply<{ state: ContentSessionState; discovery: NativeDiscovery; permissionsRemoved?: boolean }>>(
    'core_edit_content_open', { path }, signal,
  );
}

function command<T>(sessionId: string, body: ReturnType<typeof envelope>, signal?: AbortSignal) {
  return call<ContentReply<T>>('core_edit_content_command', { sessionId, envelope: body }, signal);
}

export async function inspectContentObjects(sessionId: string, acceptedRevision: number, signal?: AbortSignal) {
  const requestId = contentRequestId('inspect');
  return command<{ discovery: NativeDiscovery }>(
    sessionId, envelope(sessionId, requestId, 'inspect', acceptedRevision, {}), signal,
  );
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
  return command<{ hitTest: HitTestResult }>(
    args.sessionId, envelope(args.sessionId, requestId, 'inspect', args.acceptedRevision, payload), args.signal,
  );
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
  return command<NativeRender>(
    sessionId, envelope(sessionId, requestId, 'render', acceptedRevision, { pageIndex, widthPx, heightPx }), signal,
  );
}

export async function applyContentDraft(
  sessionId: string,
  acceptedRevision: number,
  targetId: string,
  edit: EditCommand,
  requestId: string,
  signal?: AbortSignal,
) {
  return command<{ state: ContentSessionState; clearDraft: boolean }>(
    sessionId, envelope(sessionId, requestId, 'apply', acceptedRevision, { edit }, targetId), signal,
  );
}

export async function saveContentSession(
  sessionId: string,
  acceptedRevision: number,
  requestId: string,
  targetId?: string,
  draft?: EditCommand,
  signal?: AbortSignal,
) {
  return command<{ state: ContentSessionState; outputId: string; clearDraft: boolean }>(
    sessionId, envelope(sessionId, requestId, 'save', acceptedRevision, draft ? { draft } : {}, targetId), signal,
  );
}

export async function moveContentHistory(
  sessionId: string,
  acceptedRevision: number,
  action: 'undo' | 'redo',
  requestId: string,
  signal?: AbortSignal,
) {
  return command<{ state: ContentSessionState }>(
    sessionId, envelope(sessionId, requestId, 'history', acceptedRevision, { action, pendingDraft: false }), signal,
  );
}

export async function closeContentSession(
  sessionId: string,
  acceptedRevision: number,
  pendingDraft: boolean,
  decision: 'discard' | 'none',
) {
  const requestId = contentRequestId('close');
  return command<{ closed: boolean }>(
    sessionId, envelope(sessionId, requestId, 'close', acceptedRevision, { pendingDraft, decision }),
  );
}

export async function cancelContentRequest(sessionId: string, requestId: string) {
  await call('core_edit_content_cancel', { sessionId, requestId });
}

/** Where an exported PDF was written. */
export interface ExportedPdf {
  path: string;
  fileName: string;
}

/**
 * Copies a saved output to the Downloads folder as `<name>.pdf` (or the next
 * free name, never over an existing file) and says where it went.
 */
export async function exportContentOutput(sessionId: string, outputId: string, name: string) {
  return call<ExportedPdf>('core_edit_content_export', { sessionId, outputId, name });
}

/** Read-only dry run of the engine's guards for one proposed edit. */
export async function preflightContentEdit(
  sessionId: string,
  acceptedRevision: number,
  targetId: string,
  edit: EditCommand,
  signal?: AbortSignal,
) {
  const requestId = contentRequestId('preflight');
  return command<{ preflight: PreflightResult }>(
    sessionId, envelope(sessionId, requestId, 'inspect', acceptedRevision, { operation: 'preflight', edit }, targetId), signal,
  );
}
