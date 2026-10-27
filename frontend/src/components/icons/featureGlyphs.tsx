import type { ReactNode } from 'react';

/** Which base a feature's glyph sits on: a document sheet, a picture frame, or a square tile. */
export type GlyphBase = 'sheet' | 'frame' | 'tile';

export interface GlyphDef {
  base: GlyphBase;
  /**
   * The emblem drawn on the base, in a 24 x 24 box. Elements marked `data-accent`
   * take the secondary colour; everything else takes the emblem colour.
   */
  emblem: ReactNode;
}

export type GlyphId =
  | 'merge' | 'extract' | 'organize' | 'converter' | 'pdf-to-word' | 'image-format'
  | 'edit-canvas' | 'edit-content' | 'compress' | 'photo-compress' | 'protect' | 'qr-barcode';

export const GLYPHS: Record<GlyphId, GlyphDef> = {
  merge: {
    base: 'sheet',
    emblem: (
      <>
        <path d="M8 11.2h2.6a2.2 2.2 0 0 1 2.2 2.2v.6M8 18h2.6a2.2 2.2 0 0 0 2.2-2.2v-.6M12.8 14.7h3.6" />
        <path data-accent d="M14.8 12.9l1.8 1.8-1.8 1.8" />
      </>
    ),
  },
  extract: {
    base: 'sheet',
    emblem: (
      <>
        <circle cx="9" cy="11.7" r="1.35" />
        <circle cx="9" cy="17.5" r="1.35" />
        <path data-accent d="M10.2 12.5L16.6 17.2M10.2 16.7L16.6 12" />
      </>
    ),
  },
  organize: {
    base: 'sheet',
    emblem: (
      <>
        <rect x="8" y="10.4" width="3.5" height="3.5" rx=".8" />
        <rect data-accent x="12.6" y="10.4" width="3.5" height="3.5" rx=".8" />
        <rect x="8" y="15.2" width="3.5" height="3.5" rx=".8" />
        <rect x="12.6" y="15.2" width="3.5" height="3.5" rx=".8" />
      </>
    ),
  },
  converter: {
    base: 'sheet',
    emblem: (
      <>
        <path d="M8 12.2h7.6M13.4 10l2.2 2.2-2.2 2.2" />
        <path data-accent d="M16 17.4H8.4M10.6 15.2l-2.2 2.2 2.2 2.2" />
      </>
    ),
  },
  'pdf-to-word': {
    base: 'sheet',
    emblem: <path d="M7.4 11l2 7.2 2.6-5.8 2.6 5.8 2-7.2" />,
  },
  'image-format': {
    base: 'frame',
    emblem: (
      <>
        <circle data-accent cx="8.6" cy="9.4" r="1.4" />
        <path d="M4.2 17.6l4.4-4.6 3.2 3.2 2.4-2.4 5.6 5" />
        <path d="M14 8.6h4.2M16.4 6.8l1.8 1.8-1.8 1.8" />
      </>
    ),
  },
  'edit-canvas': {
    base: 'sheet',
    emblem: (
      <>
        <path d="M8.6 18.6l.4-2.8 6.4-6.4a1.6 1.6 0 0 1 2.3 2.3l-6.4 6.4z" />
        <path data-accent d="M14.2 10.6l2.3 2.3" />
      </>
    ),
  },
  'edit-content': {
    base: 'sheet',
    emblem: (
      <>
        <path d="M8 11.2h7.8M8 14.5h4" />
        <path data-accent d="M15.3 15.8v3.8M14.1 15.8h2.4M14.1 19.6h2.4" />
      </>
    ),
  },
  compress: {
    base: 'sheet',
    emblem: (
      <>
        <path d="M12 10v3.4M10.2 11.8l1.8 1.8 1.8-1.8" />
        <path data-accent d="M12 19.2v-3.4M10.2 17l1.8-1.8 1.8 1.8" />
      </>
    ),
  },
  'photo-compress': {
    base: 'frame',
    emblem: (
      <>
        <path d="M4.2 8.4V6.5a1.8 1.8 0 0 1 1.8-1.8h1.9M16.1 4.7h1.9a1.8 1.8 0 0 1 1.8 1.8v1.9" />
        <rect x="6.4" y="9.6" width="11.2" height="9" rx="2" />
        <circle data-accent cx="10" cy="12.8" r="1.1" />
        <path d="M7.4 17l3.2-2.6 2.2 1.8 2-1.8 1.6 1.6" />
      </>
    ),
  },
  protect: {
    base: 'sheet',
    emblem: (
      <>
        <path d="M12 10.2l3.8 1.4v2.8c0 2.2-1.6 3.7-3.8 4.6-2.2-.9-3.8-2.4-3.8-4.6v-2.8z" />
        <path data-accent d="M10.4 14.3l1.2 1.2 2.1-2.4" />
      </>
    ),
  },
  'qr-barcode': {
    base: 'tile',
    emblem: (
      <>
        <rect x="6" y="6" width="4.4" height="4.4" rx=".9" />
        <rect x="13.6" y="6" width="4.4" height="4.4" rx=".9" />
        <rect x="6" y="13.6" width="4.4" height="4.4" rx=".9" />
        <path data-accent d="M13.8 13.8h1.8M17.8 13.8v1.8M13.8 16.2v1.8h1.8M17.8 18h.01" />
      </>
    ),
  },
};
