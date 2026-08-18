export const EMPTY_TEXT_SENTINEL = ' ';
export const TEXT_PLACEHOLDER_LABEL = 'Enter text here';
export const TEXT_PLACEHOLDER_COLOR = '#9898B8';

export function isEmptyTextState(text: string | null | undefined): boolean {
  return !text || text.trim().length === 0;
}

export function normalizeTextState(text: string | null | undefined): string {
  return isEmptyTextState(text) ? EMPTY_TEXT_SENTINEL : text!;
}

export function getTextCanvasPresentation(text: string, textColor: string) {
  const isPlaceholder = isEmptyTextState(text);

  return {
    isPlaceholder,
    text: isPlaceholder ? TEXT_PLACEHOLDER_LABEL : text,
    fill: isPlaceholder ? TEXT_PLACEHOLDER_COLOR : textColor,
  };
}