import { describe, expect, it } from 'vitest';

import type { ContentReply, NativePageDescriptor } from '../features/edit-content/types';
import {
  buildEditCommand,
  explainGuard,
  explainPreflight,
  formatMissingCharacters,
  isCurrentReply,
  keepsDraftAfterRejection,
  projectNativePoint,
  replyError,
} from '../features/edit-content/workflow';


describe('Edit Content workflow contracts', () => {
  it('derives one UTF-16 range while preserving unchanged prefix and suffix', () => {
    expect(buildEditCommand('Press A to continue', 'Press B to continue')).toEqual({
      expectedText: 'Press A to continue',
      expectedOldText: 'A',
      replacementText: 'B',
      utf16Start: 6,
      utf16End: 7,
    });
    expect(buildEditCommand('A😀B', 'A🎯B')).toEqual({
      expectedText: 'A😀B',
      expectedOldText: '😀',
      replacementText: '🎯',
      utf16Start: 1,
      utf16End: 3,
    });
    expect(buildEditCommand('same', 'same')).toBeNull();
  });

  it('sends a pure insertion as a replacement of one neighbouring character', () => {
    // prepend: ayam -> bayam
    expect(buildEditCommand('ayam', 'bayam')).toEqual({
      expectedText: 'ayam', expectedOldText: 'a', replacementText: 'ba', utf16Start: 0, utf16End: 1,
    });
    // middle: AB -> AXB widens to the character before the caret
    expect(buildEditCommand('AB', 'AXB')).toEqual({
      expectedText: 'AB', expectedOldText: 'A', replacementText: 'AX', utf16Start: 0, utf16End: 1,
    });
    // append: Gedung -> Gedungs
    expect(buildEditCommand('Gedung', 'Gedungs')).toEqual({
      expectedText: 'Gedung', expectedOldText: 'g', replacementText: 'gs', utf16Start: 5, utf16End: 6,
    });
    // repeated characters: aa -> aaa
    expect(buildEditCommand('aa', 'aaa')).toEqual({
      expectedText: 'aa', expectedOldText: 'a', replacementText: 'aa', utf16Start: 1, utf16End: 2,
    });
    // surrogate pairs stay whole when they are the widened neighbour
    expect(buildEditCommand('😀B', '😀XB')).toEqual({
      expectedText: '😀B', expectedOldText: '😀', replacementText: '😀X', utf16Start: 0, utf16End: 2,
    });
    // the result always rebuilds the draft exactly
    for (const [from, to] of [['ayam', 'bayam'], ['AB', 'AXB'], ['Gedung', 'Gedungs'], ['aa', 'aaa'], ['abc', 'Xabc']]) {
      const edit = buildEditCommand(from, to)!;
      expect(from.slice(0, edit.utf16Start) + edit.replacementText + from.slice(edit.utf16End)).toBe(to);
      expect(from.slice(edit.utf16Start, edit.utf16End)).toBe(edit.expectedOldText);
    }
  });

  it('keeps substitution and deletion commands unchanged', () => {
    expect(buildEditCommand('ayam', 'ayim')).toEqual({
      expectedText: 'ayam', expectedOldText: 'a', replacementText: 'i', utf16Start: 2, utf16End: 3,
    });
    expect(buildEditCommand('ayam', 'aym')).toEqual({
      expectedText: 'ayam', expectedOldText: 'a', replacementText: '', utf16Start: 2, utf16End: 3,
    });
  });

  it('turns dry-run verdicts into specific, actionable messages', () => {
    const base = { eligible: false, guardReasons: [], primaryGuardReason: null, detailCodes: [], unsupportedCodePoints: [] };
    expect(explainPreflight({ ...base, detailCodes: ['MISSING_GLYPH'], unsupportedCodePoints: [0x51, 0x151] }))
      .toContain('"Q", "ő"');
    expect(explainPreflight({ ...base, detailCodes: ['SPLIT_WORD'] })).toContain('split across several text pieces');
    expect(explainPreflight({ ...base, detailCodes: ['UNSUPPORTED_FONT_TYPE', 'RESOURCE_SCOPE_UNKNOWN'] }))
      .toContain('font type');
    // unknown detail codes fall back to the guard reason
    expect(explainPreflight({ ...base, primaryGuardReason: 'REJECTED_FONT_RESOURCE_COLLISION', detailCodes: ['NEW_CODE'] }))
      .toBe('This page has colliding font resources and cannot be regenerated safely.');
    expect(formatMissingCharacters([1, 2, 3, 4, 5, 6, 7]).endsWith('…')).toBe(true);
  });

  it('accepts async data only for the exact session, request, and revision', () => {
    const reply = {
      schemaVersion: 'edit-content-reply/v1',
      requestId: 'render-1',
      sessionId: 'session-1',
      status: 'accepted',
      acceptedRevision: 3,
      result: {},
    } satisfies ContentReply;
    expect(isCurrentReply(reply, 'session-1', 3, 'render-1')).toBe(true);
    expect(isCurrentReply(reply, 'session-1', 4, 'render-1')).toBe(false);
    expect(isCurrentReply(reply, 'session-2', 3, 'render-1')).toBe(false);
    expect(isCurrentReply(reply, 'session-1', 3, 'render-2')).toBe(false);
  });

  it('projects native PDF points through crop and page rotation', () => {
    const page: NativePageDescriptor = {
      pageIndex: 0,
      widthPt: 220,
      heightPt: 170,
      cropBox: { left: 10, bottom: 20, right: 230, top: 190 },
      rotation: 0,
    };
    expect(projectNativePoint({ x: 10, y: 190 }, page, 440, 340)).toEqual({ x: 0, y: 0 });
    expect(projectNativePoint({ x: 230, y: 20 }, page, 440, 340)).toEqual({ x: 440, y: 340 });
    expect(projectNativePoint({ x: 10, y: 20 }, { ...page, rotation: 90 }, 340, 440)).toEqual({ x: 0, y: 0 });
  });
});


describe('invisible text', () => {
  it('explains that hidden text layers are view-only', () => {
    expect(explainGuard('INVISIBLE_TEXT')).toMatch(/invisible/i);
  });
});

describe('refused replies', () => {
  it('prefers the page text for a known guard over the backend English text', () => {
    expect(replyError({ guardReason: 'REJECTED_LAYOUT', error: 'backend text' }))
      .toBe('The replacement would require unsupported layout changes.');
    expect(replyError({ guardReason: 'SOMETHING_NEW', error: 'backend text' })).toBe('backend text');
    expect(replyError({ error: 'Cancelled safely.' })).toBe('Cancelled safely.');
    expect(replyError({})).toBe('This text cannot be edited safely.');
  });

  it('keeps the draft only for guard verdicts on a candidate', () => {
    expect(keepsDraftAfterRejection({ status: 'rejected', guardReason: 'REJECTED_UNSUPPORTED_GLYPH' })).toBe(true);
    expect(keepsDraftAfterRejection({ status: 'rejected', guardReason: 'REJECTED_COLLATERAL_INTEGRITY' })).toBe(true);
    for (const reply of [
      { status: 'rejected' as const, guardReason: 'REJECTED_STALE_TARGET' },
      { status: 'rejected' as const, guardReason: 'REJECTED_STALE_REVISION' },
      { status: 'stale' as const, guardReason: 'REJECTED_STALE_TARGET' },
      { status: 'unknown' as const },
      { status: 'rejected' as const },
      { status: 'rejected' as const, guardReason: 'worker exited unexpectedly' },
    ]) {
      expect(keepsDraftAfterRejection(reply)).toBe(false);
    }
  });
});
