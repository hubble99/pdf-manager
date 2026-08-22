# Changelog

## 1.1.3 — 2026-08-22

- Stabilized shared previews while switching PDF pages by retaining the current page during loading and discarding late preview responses safely.
- Fit mode now recalculates from the active page dimensions and viewport, including resize and rotated landscape pages.
- Added regression coverage for preview cancellation, mixed-size documents, responsive fit, and committed zoom slider interactions.

## 1.1.2 — 2026-08-22

- Fixed shared PDF and image previews to fit the available viewport across Split, PDF to Image, Image to PDF, and Insert Content.
- Added responsive Open Folder toast feedback with opening, success, and retry states; backend failures now propagate correctly.

## 1.1.1 — 2026-08-22

- Fixed Edit PDF theme propagation for Dusty Rose and Steel Blue, including Fabric selection controls.
- Standardized output filename sanitization and download filename handling.

## 1.1.0 — 2026-08-19

- Standardized backend error responses and exposed the canonical application version.
- Extracted PDF metadata, preview, PDF info, and Edit PDF processing into testable backend core modules.
- Completed frontend lint cleanup, lazy Edit PDF loading, and editor token/constant cleanup.
- Added release verification and UAT preparation artifacts.
