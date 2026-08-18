import {
  EMPTY_TEXT_SENTINEL,
  getTextCanvasPresentation,
  isEmptyTextState,
  normalizeTextState,
  TEXT_PLACEHOLDER_COLOR,
  TEXT_PLACEHOLDER_LABEL,
} from '../utils/textPlaceholder';

describe('text placeholder state', () => {
  it.each([undefined, null, '', ' ', '   ', '\n\t'])('treats %j as empty text', (value) => {
    expect(isEmptyTextState(value)).toBe(true);
    expect(normalizeTextState(value)).toBe(EMPTY_TEXT_SENTINEL);
  });

  it('preserves meaningful text exactly as entered', () => {
    expect(normalizeTextState('  Signed by Alice  ')).toBe('  Signed by Alice  ');
  });

  it('maps empty state to the editor-only placeholder presentation', () => {
    expect(getTextCanvasPresentation('', '#123456')).toEqual({
      isPlaceholder: true,
      text: TEXT_PLACEHOLDER_LABEL,
      fill: TEXT_PLACEHOLDER_COLOR,
    });
  });

  it('uses the document text and color for non-empty state', () => {
    expect(getTextCanvasPresentation('Approved', '#123456')).toEqual({
      isPlaceholder: false,
      text: 'Approved',
      fill: '#123456',
    });
  });

  it('does not confuse literal placeholder wording with empty state', () => {
    expect(getTextCanvasPresentation(TEXT_PLACEHOLDER_LABEL, '#123456')).toEqual({
      isPlaceholder: false,
      text: TEXT_PLACEHOLDER_LABEL,
      fill: '#123456',
    });
  });
});