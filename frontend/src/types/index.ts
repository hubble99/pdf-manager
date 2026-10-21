// ── Navigation ────────────────────────────────────────────────────────────────

export type NavItemId =
  | 'home'
  | 'donation'
  | 'merge'
  | 'extract'
  | 'compress'
  | 'photo-compress'
  | 'converter'
  | 'image-format'
  | 'qr-barcode'
  | 'edit-canvas'
  | 'edit-content'
  | 'organize'
  | 'protect'
  | 'settings';

// ── Feature-specific result types (Sprint 2) ─────────────────────────────────

export interface PdfInfoResult {
  filename: string;
  total_pages: number;
  file_size_bytes: number;
}
