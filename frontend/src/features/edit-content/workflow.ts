import type {
  ContentReply,
  EditCommand,
  NativePageDescriptor,
  NativeTextObjectDescriptor,
  Point,
} from './types';

export function buildEditCommand(original: string, draft: string): EditCommand | null {
  if (original === draft) return null;
  const before = Array.from(original);
  const after = Array.from(draft);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = before.slice(prefix, before.length - suffix).join('');
  if (!removed) return null;
  const replacement = after.slice(prefix, after.length - suffix).join('');
  const prefixUtf16 = before.slice(0, prefix).join('').length;
  return {
    expectedText: original,
    expectedOldText: removed,
    replacementText: replacement,
    utf16Start: prefixUtf16,
    utf16End: prefixUtf16 + removed.length,
  };
}

export function isCurrentReply(
  reply: ContentReply,
  sessionId: string,
  acceptedRevision: number,
  requestId: string,
): boolean {
  return reply.requestId === requestId
    && reply.sessionId === sessionId
    && reply.acceptedRevision === acceptedRevision;
}

export function projectNativePoint(
  point: Point,
  page: NativePageDescriptor,
  viewportWidth: number,
  viewportHeight: number,
): Point {
  const crop = page.cropBox;
  const width = crop.right - crop.left;
  const height = crop.top - crop.bottom;
  const x = point.x - crop.left;
  const y = point.y - crop.bottom;
  let rotated: Point;
  switch (page.rotation) {
    case 90:
      rotated = { x: y, y: x };
      break;
    case 180:
      rotated = { x: width - x, y };
      break;
    case 270:
      rotated = { x: height - y, y: width - x };
      break;
    default:
      rotated = { x, y: height - y };
  }
  const rotatedWidth = page.rotation === 90 || page.rotation === 270 ? height : width;
  const rotatedHeight = page.rotation === 90 || page.rotation === 270 ? width : height;
  const scale = Math.min(viewportWidth / rotatedWidth, viewportHeight / rotatedHeight);
  return { x: rotated.x * scale, y: rotated.y * scale };
}

export function selectionPolygon(
  target: NativeTextObjectDescriptor | null,
  page: NativePageDescriptor | undefined,
  viewportWidth: number,
  viewportHeight: number,
): string {
  if (!target || !page) return '';
  return target.rotatedQuad.points
    .map((point) => projectNativePoint(point, page, viewportWidth, viewportHeight))
    .map((point) => `${point.x},${point.y}`)
    .join(' ');
}

export function explainGuard(reason?: string): string {
  const messages: Record<string, string> = {
    REJECTED_STALE_REVISION: 'The document changed. Refresh and select the text again.',
    REJECTED_STALE_TARGET: 'This selection is no longer current. Select the text again.',
    REJECTED_SPLIT_TEXT_OBJECT: 'This word spans multiple native text objects and is view-only.',
    REJECTED_TYPE3: 'Text using a Type 3 font is view-only in Edit Content V1.',
    REJECTED_UNSUPPORTED_GLYPH: 'The existing PDF font cannot represent the replacement.',
    REJECTED_FONT_RESOURCE_COLLISION: 'This page has colliding font resources and cannot be regenerated safely.',
    REJECTED_LAYOUT: 'The replacement would require unsupported layout changes.',
    REJECTED_COLLATERAL_INTEGRITY: 'Verification found an unexpected change elsewhere in the PDF.',
    REJECTED_PERSISTENCE: 'The replacement did not persist correctly after the PDF was reopened.',
    REJECTED_PUBLICATION: 'The verified PDF could not be published safely.',
  };
  return reason ? messages[reason] ?? 'This text cannot be edited safely.' : 'This text cannot be edited safely.';
}
