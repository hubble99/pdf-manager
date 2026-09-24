# Changelog

## 1.2.1 — 2026-09-22

- Finalized Edit Content V1 for release: it edits existing native PDF text (typo fixes, word and shorter replacements, deletions, and genuine longer replacements that need no reflow), verifies every accepted change before publishing, and rejects unsupported or uncertain content safely.
- Documented the supported scope and the intentional V1 limitations (native/selectable text only, no OCR, no automatic reflow or font substitution, replacement of a non-empty existing range only, fail-closed rejections) in the README.
- Cleared expired Edit Content target bindings after guarded Apply rejection, refreshed native discovery, and required explicit reselection before retrying.
- Added frontend and packaged regression coverage for rejection, target rotation, unchanged committed state, and successful retry with a fresh target.

## 1.2.0 — 2026-08-28

- Froze the UAT-approved canvas-only Edit Canvas baseline and removed the unstable selectable-text editing prototype from the runtime contract.
- Added Smart Eyedropper foreground sampling and non-destructive letter-spacing controls for text overlays.
- Added an application font library with numeric font weights, lazy browser face loading, nearest-weight resolution, and native PDF font embedding.
- Preserved text, shapes, lines, freehand paths, and highlights as native PDF output without full-page rasterization.
- Consolidated shared feature headers, empty/loading/error states, preview layout behavior, and accessibility styling.
- Renamed Edit PDF canvas routes and modules to Edit Canvas in preparation for the isolated native editor rewrite.

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
