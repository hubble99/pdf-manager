import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useContinuousRotation } from '../hooks/useContinuousRotation';

describe('useContinuousRotation', () => {
  it('keeps turning clockwise past a full turn instead of spinning back', () => {
    const { result, rerender } = renderHook(({ rotation }) => useContinuousRotation(rotation), {
      initialProps: { rotation: 0 },
    });
    const seen = [result.current];
    for (const rotation of [90, 180, 270, 0, 90]) {
      act(() => rerender({ rotation }));
      seen.push(result.current);
    }
    expect(seen).toEqual([0, 90, 180, 270, 360, 450]);
  });

  it('turns back the short way for a counter-clockwise step', () => {
    const { result, rerender } = renderHook(({ rotation }) => useContinuousRotation(rotation), {
      initialProps: { rotation: 0 },
    });
    act(() => rerender({ rotation: 270 }));
    expect(result.current).toBe(-90);
  });
});
