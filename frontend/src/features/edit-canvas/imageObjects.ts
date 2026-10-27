import type { CanvasImageAsset, ImageObject } from '../../types/canvas';
import { generateCanvasObjectId } from './ids';

/** Image formats Canvas PDF accepts. The browser decodes them and the core embeds them. */
export const CANVAS_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const CANVAS_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;
export const CANVAS_IMAGE_ACCEPT = [...CANVAS_IMAGE_MIME_TYPES, ...CANVAS_IMAGE_EXTENSIONS].join(',');

/** A new image takes at most this share of the page width or height. */
export const IMAGE_MAX_PAGE_FRACTION = 0.5;
/** Each further image inserted at once is shifted by this many canvas units. */
export const IMAGE_CASCADE_OFFSET = 20;

export type CanvasImageAssetStore = Map<string, CanvasImageAsset>;

export function isSupportedCanvasImage(file: Pick<File, 'name' | 'type'>): boolean {
  const type = (file.type || '').toLowerCase();
  if ((CANVAS_IMAGE_MIME_TYPES as readonly string[]).includes(type)) return true;
  // Some systems report an empty MIME type; fall back to the extension then.
  if (type) return false;
  const name = file.name.toLowerCase();
  return CANVAS_IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * Size for a newly inserted image: the image's own size, shrunk with its aspect ratio kept
 * until it fits inside the given share of the page. Small images are never enlarged.
 */
export function fitImageToPage(
  naturalWidth: number,
  naturalHeight: number,
  pageWidth: number,
  pageHeight: number,
  maxFraction = IMAGE_MAX_PAGE_FRACTION,
): { width: number; height: number } {
  const width = Math.max(1, naturalWidth);
  const height = Math.max(1, naturalHeight);
  const scale = Math.min(1, (pageWidth * maxFraction) / width, (pageHeight * maxFraction) / height);
  return { width: width * scale, height: height * scale };
}

/**
 * Top-left position for an image of the given size. Centred on `point` when given,
 * otherwise on the page, and always kept fully on the page.
 */
export function placeImageOnPage(
  size: { width: number; height: number },
  pageWidth: number,
  pageHeight: number,
  point?: { x: number; y: number },
  cascadeIndex = 0,
): { x: number; y: number } {
  const centerX = point ? point.x : pageWidth / 2;
  const centerY = point ? point.y : pageHeight / 2;
  const offset = cascadeIndex * IMAGE_CASCADE_OFFSET;
  const clamp = (value: number, max: number) => Math.min(Math.max(0, value), Math.max(0, max));
  return {
    x: clamp(centerX - size.width / 2 + offset, pageWidth - size.width),
    y: clamp(centerY - size.height / 2 + offset, pageHeight - size.height),
  };
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('The image could not be decoded.'));
    element.src = src;
  });
}

/** Reads an image file into the asset store and returns its asset id. */
export async function addImageAsset(store: CanvasImageAssetStore, file: Blob): Promise<string> {
  const src = await readFileAsDataUrl(file);
  const element = await loadImageElement(src);
  if (!element.naturalWidth || !element.naturalHeight) {
    throw new Error('The image has no size.');
  }
  const assetId = generateCanvasObjectId();
  store.set(assetId, {
    src,
    element,
    naturalWidth: element.naturalWidth,
    naturalHeight: element.naturalHeight,
  });
  return assetId;
}

export function createImageObject(
  assetId: string,
  asset: Pick<CanvasImageAsset, 'naturalWidth' | 'naturalHeight'>,
  pageWidth: number,
  pageHeight: number,
  point?: { x: number; y: number },
  cascadeIndex = 0,
): ImageObject {
  const size = fitImageToPage(asset.naturalWidth, asset.naturalHeight, pageWidth, pageHeight);
  const position = placeImageOnPage(size, pageWidth, pageHeight, point, cascadeIndex);
  return {
    id: generateCanvasObjectId(),
    type: 'image',
    assetId,
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    angle: 0,
    opacity: 1,
  };
}

/** The image data a page's save request needs, keyed by asset id. */
export function collectImageAssets(
  objects: ReadonlyArray<{ type: string; assetId?: string }>,
  store: CanvasImageAssetStore,
): Record<string, string> {
  const assets: Record<string, string> = {};
  for (const object of objects) {
    if (object.type !== 'image' || !object.assetId || object.assetId in assets) continue;
    const asset = store.get(object.assetId);
    if (asset) assets[object.assetId] = asset.src;
  }
  return assets;
}
