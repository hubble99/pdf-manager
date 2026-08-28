export const DEFAULT_LETTER_SPACING = 0;
export const MIN_LETTER_SPACING = -100;
export const MAX_LETTER_SPACING = 500;

export function normalizeLetterSpacing(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LETTER_SPACING;
  return Math.max(MIN_LETTER_SPACING, Math.min(MAX_LETTER_SPACING, Number(value)));
}

export function formatLetterSpacing(value?: number): string {
  const normalized = normalizeLetterSpacing(value);
  return normalized > 0 ? `+${normalized}` : String(normalized);
}

export function stepLetterSpacing(value: number | undefined, direction: -1 | 1): number {
  return normalizeLetterSpacing(normalizeLetterSpacing(value) + direction);
}
