export type ContentStatus = 'accepted' | 'rejected' | 'stale' | 'duplicate' | 'unknown';

export interface ContentSessionState {
  sessionId: string;
  acceptedRevision: number;
  checkpointId: string;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  savedHash: string;
  lastOutputId: string | null;
}

export interface Point {
  x: number;
  y: number;
}

export interface NativePageDescriptor {
  pageIndex: number;
  widthPt: number;
  heightPt: number;
  cropBox: { left: number; bottom: number; right: number; top: number };
  rotation: number;
}

export interface NativeTextObjectDescriptor {
  targetId: string;
  pageIndex: number;
  nativeObjectIdentity: string;
  text: string;
  unicodeScalarLength: number;
  bounds: { left: number; bottom: number; right: number; top: number };
  rotatedQuad: { points: [Point, Point, Point, Point] };
  font: {
    name: string;
    family: string;
    weight: string;
    embedded: boolean;
    resourceSubtype?: string | null;
  };
  fontSizePt: number;
  rotation: number;
  renderMode: string;
  editable: boolean;
  viewOnlyReason: string | null;
}

export interface NativeDiscovery {
  schemaVersion: 'edit-content-inspection/v1';
  readOnly: true;
  pages: NativePageDescriptor[];
  textObjects: NativeTextObjectDescriptor[];
  viewOnlyObjects: Array<{
    pageIndex: number;
    nativeType: string;
    reason: string;
    rendered: boolean;
    fabricatedTextObject: false;
  }>;
}

export interface NativeRender {
  pageIndex: number;
  widthPx: number;
  heightPx: number;
  mimeType: 'image/jpeg';
  dataBase64: string;
  sha256: string;
}

export interface ContentReply<T = Record<string, unknown>> {
  schemaVersion: 'edit-content-reply/v1';
  requestId: string;
  sessionId: string;
  status: ContentStatus;
  acceptedRevision: number;
  result: T;
  guardReason?: string;
  error?: string;
}

export interface EditCommand {
  expectedText: string;
  expectedOldText: string;
  replacementText: string;
  utf16Start: number;
  utf16End: number;
}

export interface HitTestResult {
  outcome: 'none' | 'selected' | 'viewOnly' | 'ambiguous' | 'stale';
  targetId?: string;
  reason?: string;
  candidateTargetIds?: string[];
  mutationCommandCreated: false;
}
