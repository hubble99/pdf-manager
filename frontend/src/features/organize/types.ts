export type QuarterTurn = 0 | 90 | 180 | 270;

/** One entry in the working document. The list itself is the page order. */
export interface PageRef {
  /** Unique per list entry, so the same source page can appear more than once. */
  key: string;
  /** A source id from the source registry. */
  source: string;
  /** One-based page number within that source. */
  page: number;
  rotation: QuarterTurn;
  flip: boolean;
}

export type SourceKind = 'pdf' | 'image';

export interface SourceHandle {
  id: string;
  name: string;
  kind: SourceKind;
  pageCount: number;
  /** Handle from the core's document registry, one per added file. */
  documentId: string;
  /** The file's path in comparable form; used to refuse the same file twice. */
  fingerprint?: string;
}

export interface OrganizeSnapshot {
  pages: PageRef[];
  sources: SourceHandle[];
}

export type InsertMode = 'all' | 'pick';
export type InsertPosition = 'after' | 'before';
/** Extensions the core accepts, without the dot. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'];
export const PDF_EXTENSIONS = ['pdf'];
