import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LETTER_SPACING,
  formatLetterSpacing,
  MAX_LETTER_SPACING,
  MIN_LETTER_SPACING,
  normalizeLetterSpacing,
  stepLetterSpacing,
} from '../features/edit-canvas/letterSpacing';

describe('letter spacing', () => {
  it('defaults legacy text objects to neutral tracking', () => {
    expect(normalizeLetterSpacing()).toBe(DEFAULT_LETTER_SPACING);
    expect(DEFAULT_LETTER_SPACING).toBe(0);
  });

  it('supports tightening and expanding within the stable range', () => {
    expect(normalizeLetterSpacing(-50)).toBe(-50);
    expect(normalizeLetterSpacing(240)).toBe(240);
  });

  it('clamps unsafe and non-finite values', () => {
    expect(normalizeLetterSpacing(-500)).toBe(MIN_LETTER_SPACING);
    expect(normalizeLetterSpacing(900)).toBe(MAX_LETTER_SPACING);
    expect(normalizeLetterSpacing(Number.NaN)).toBe(DEFAULT_LETTER_SPACING);
  });

  it('formats tracking values without a percentage suffix', () => {
    expect(formatLetterSpacing(-50)).toBe('-50');
    expect(formatLetterSpacing(0)).toBe('0');
    expect(formatLetterSpacing(240)).toBe('+240');
  });

  it('increments and decrements by exactly one while respecting bounds', () => {
    expect(stepLetterSpacing(24, -1)).toBe(23);
    expect(stepLetterSpacing(24, 1)).toBe(25);
    expect(stepLetterSpacing(MIN_LETTER_SPACING, -1)).toBe(MIN_LETTER_SPACING);
    expect(stepLetterSpacing(MAX_LETTER_SPACING, 1)).toBe(MAX_LETTER_SPACING);
  });
});
