// ── Navigation ────────────────────────────────────────────────────────────────

export type NavItemId =
  | 'home'
  | 'donation'
  | 'merge'
  | 'extract'
  | 'compress'
  | 'converter'
  | 'qr-barcode'
  | 'edit-canvas'
  | 'edit-content'
  | 'organize'
  | 'metadata'
  | 'protect'
  | 'settings';

// ── Feature-specific result types (Sprint 2) ─────────────────────────────────

export interface PdfInfoResult {
  filename: string;
  total_pages: number;
  file_size_bytes: number;
}
