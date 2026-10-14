import type {
  ContentReply,
  EditCommand,
  NativePageDescriptor,
  NativeTextObjectDescriptor,
  Point,
  PreflightResult,
} from './types';

export function buildEditCommand(original: string, draft: string): EditCommand | null {
  if (original === draft) return null;
  const sourceSpaces = original.match(/ +$/)?.[0] ?? '';
  const draftSpaces = draft.match(/ +$/)?.[0] ?? '';
  // A native object's trailing spaces separate it from its next object. Keep
  // those spaces when the user edits the visible word without retyping them.
  if (sourceSpaces && draft.trimEnd() !== original.trimEnd()
      && draft && (!/\s$/.test(draft) || draftSpaces.length > 0)
      && draftSpaces.length < sourceSpaces.length) {
    draft += sourceSpaces.slice(draftSpaces.length);
  }
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
  let start = prefix;
  let removed = before.slice(prefix, before.length - suffix).join('');
  let replacement = after.slice(prefix, after.length - suffix).join('');
  if (!removed) {
    // A pure insertion removes no character, but the engine replaces a
    // non-empty range of the object's own text. Widen the range by one
    // neighbouring character and re-emit it: "ayam" -> "bayam" is sent as
    // "a" -> "ba". The resulting object text is identical and the same
    // glyph, collision, and verification guards apply to the full string.
    if (!replacement || before.length === 0) return null;
    if (prefix > 0) {
      start = prefix - 1;
      removed = before[start];
      replacement = removed + replacement;
    } else {
      removed = before[0];
      replacement = replacement + removed;
    }
  }
  const prefixUtf16 = before.slice(0, start).join('').length;
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

const DETAIL_MESSAGES: Record<string, string> = {
  SPLIT_WORD: 'This word is split across several text pieces in the PDF, so it cannot be edited safely.',
  TYPE3_FONT: 'This text uses a Type 3 font, which Edit Content cannot edit.',
  GLYPH_COVERAGE_UNKNOWN: 'Edit Content cannot confirm that the PDF font contains these characters. Try characters already used in this text.',
  FONT_RESOURCE_COLLISION: 'This page has font resources that cannot be regenerated without risking other text.',
  RESOURCE_SCOPE_UNKNOWN: 'The font resources of this page cannot be analysed safely.',
  UNSUPPORTED_FONT_TYPE: 'This text uses a font type that Edit Content does not support.',
  NESTED_CONTENT_SCOPE: 'This text sits inside a nested drawing group and is view-only.',
  CLIPPED_TEXT: 'This text is clipped by a shape and is view-only.',
  UNSUPPORTED_RENDER_MODE: 'This text uses an outline or invisible rendering mode and is view-only.',
  NEW_LINE: 'New lines cannot be added in Edit Content.',
  COMPLEX_SCRIPT: 'Text in this script needs shaping that Edit Content does not support.',
  OBJECT_NOT_EDITABLE: 'This text object is view-only.',
  SELECTION_EXPIRED: 'This selection is out of date. Select the text again.',
  INVALID_REQUEST: 'This change could not be checked.',
};

/** Characters named in a missing-glyph message, capped so the line stays short. */
export function formatMissingCharacters(codePoints: number[]): string {
  const shown = codePoints.slice(0, 6).map((point) => `"${String.fromCodePoint(point)}"`);
  return shown.join(', ') + (codePoints.length > 6 ? ', …' : '');
}

/** Turns a dry-run verdict into one sentence the user can act on. */
export function explainPreflight(result: PreflightResult): string {
  if (result.detailCodes.includes('MISSING_GLYPH')) {
    const characters = formatMissingCharacters(result.unsupportedCodePoints);
    return `This PDF font has no glyph for ${characters || 'one of the new characters'}. Use characters that already appear in this font.`;
  }
  const detail = result.detailCodes.find((code) => DETAIL_MESSAGES[code]);
  if (detail) return DETAIL_MESSAGES[detail];
  return explainGuard(result.primaryGuardReason ?? undefined);
}
