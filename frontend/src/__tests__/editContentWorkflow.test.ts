import { describe, expect, it } from 'vitest';

import type { ContentReply, NativePageDescriptor } from '../features/edit-content/types';
import {
  buildEditCommand,
  isCurrentReply,
  projectNativePoint,
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
    expect(buildEditCommand('AB', 'AXB')).toBeNull();
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
