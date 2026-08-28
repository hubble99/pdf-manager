// ── Navigation ────────────────────────────────────────────────────────────────

export type NavItemId =
  | 'merge'
  | 'extract'
  | 'compress'
  | 'pdf-to-image'
  | 'image-to-pdf'
  | 'qr-barcode'
  | 'insert'
  | 'edit-canvas'
  | 'organize'
  | 'metadata'
  | 'protect';

// ── Feature-specific result types (Sprint 2) ─────────────────────────────────

export interface PdfInfoResult {
  filename: string;
  total_pages: number;
  file_size_bytes: number;
}

export interface PdfToImageResult {
  pagesExported: number;
  format: string;
  dpi: number;
  filename: string;
  isZip: boolean;
}

export interface ImageToPdfResult {
  totalPages: number;
  pageSize: string;
  filename: string;
  fileSizeBytes: number;
}
