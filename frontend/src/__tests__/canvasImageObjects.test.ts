import { describe, expect, it } from 'vitest';
import {
  collectImageAssets,
  createImageObject,
  fitImageToPage,
  IMAGE_CASCADE_OFFSET,
  isSupportedCanvasImage,
  placeImageOnPage,
} from '../features/edit-canvas/imageObjects';
import type { CanvasImageAsset } from '../types/canvas';

describe('Canvas PDF image objects', () => {
  it('accepts PNG, JPG and WEBP by MIME type or by extension when the type is empty', () => {
    expect(isSupportedCanvasImage({ name: 'a.png', type: 'image/png' })).toBe(true);
    expect(isSupportedCanvasImage({ name: 'a.jpg', type: 'image/jpeg' })).toBe(true);
    expect(isSupportedCanvasImage({ name: 'a.webp', type: 'image/webp' })).toBe(true);
    expect(isSupportedCanvasImage({ name: 'PHOTO.JPEG', type: '' })).toBe(true);
    expect(isSupportedCanvasImage({ name: 'doc.pdf', type: 'application/pdf' })).toBe(false);
    expect(isSupportedCanvasImage({ name: 'a.gif', type: 'image/gif' })).toBe(false);
    expect(isSupportedCanvasImage({ name: 'notes.txt', type: '' })).toBe(false);
  });

  it('shrinks large images to half the page and keeps their aspect ratio', () => {
    const size = fitImageToPage(4000, 2000, 600, 800);
    expect(size.width).toBeCloseTo(300);
    expect(size.height).toBeCloseTo(150);

    const tall = fitImageToPage(1000, 3000, 600, 800);
    expect(tall.height).toBeCloseTo(400);
    expect(tall.width / tall.height).toBeCloseTo(1 / 3);
  });

  it('never enlarges small images', () => {
    expect(fitImageToPage(40, 20, 600, 800)).toEqual({ width: 40, height: 20 });
  });

  it('centres on the page or on a drop point and stays on the page', () => {
    expect(placeImageOnPage({ width: 100, height: 50 }, 600, 800)).toEqual({ x: 250, y: 375 });
    expect(placeImageOnPage({ width: 100, height: 50 }, 600, 800, { x: 200, y: 100 })).toEqual({ x: 150, y: 75 });
    // A drop near the corner is pulled back inside the page.
    expect(placeImageOnPage({ width: 100, height: 50 }, 600, 800, { x: 590, y: 5 })).toEqual({ x: 500, y: 0 });
    // Several images inserted together are cascaded.
    expect(placeImageOnPage({ width: 100, height: 50 }, 600, 800, undefined, 2)).toEqual({
      x: 250 + 2 * IMAGE_CASCADE_OFFSET,
      y: 375 + 2 * IMAGE_CASCADE_OFFSET,
    });
  });

  it('creates an upright, opaque image object linked to its asset', () => {
    const object = createImageObject('asset-1', { naturalWidth: 200, naturalHeight: 100 }, 600, 800);
    expect(object).toMatchObject({
      type: 'image',
      assetId: 'asset-1',
      x: 200,
      y: 350,
      width: 200,
      height: 100,
      angle: 0,
      opacity: 1,
    });
    expect(object.id).toBeTruthy();
  });

  it('sends each used asset once per page', () => {
    const store = new Map<string, CanvasImageAsset>([
      ['a', { src: 'data:image/png;base64,AAA', element: {} as HTMLImageElement, naturalWidth: 1, naturalHeight: 1 }],
      ['b', { src: 'data:image/png;base64,BBB', element: {} as HTMLImageElement, naturalWidth: 1, naturalHeight: 1 }],
    ]);
    const assets = collectImageAssets(
      [
        { type: 'image', assetId: 'a' },
        { type: 'image', assetId: 'a' },
        { type: 'rect' },
      ],
      store,
    );
    expect(assets).toEqual({ a: 'data:image/png;base64,AAA' });
  });
});
