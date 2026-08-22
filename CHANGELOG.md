# Changelog

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
