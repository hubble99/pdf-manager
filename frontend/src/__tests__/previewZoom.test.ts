import { describe, expect, it } from 'vitest';
import { calculatePreviewFitZoom } from '../utils/previewZoom';

describe('calculatePreviewFitZoom', () => {
  it('fits a portrait PDF page inside the preview viewport including padding', () => {
    expect(calculatePreviewFitZoom({
      sourceWidth: 595,
      sourceHeight: 842,
      viewportWidth: 600,
      viewportHeight: 600,
    })).toBeCloseTo(536 / 842);
  });

  it('accounts for a quarter-turn image rotation', () => {
    expect(calculatePreviewFitZoom({
      sourceWidth: 1200,
      sourceHeight: 800,
      viewportWidth: 900,
      viewportHeight: 700,
      rotation: 90,
    })).toBeCloseTo(636 / 1200);
  });

  it('keeps a usable minimum zoom for very large images', () => {
    expect(calculatePreviewFitZoom({
      sourceWidth: 100000,
      sourceHeight: 100000,
      viewportWidth: 200,
      viewportHeight: 200,
    })).toBe(0.05);
  });
});
