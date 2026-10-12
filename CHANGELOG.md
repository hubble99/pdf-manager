# Changelog

## 1.5.0 — 2026-10-12

- Added **Folder mode** to Merge PDF. Point it at a folder and browse its PDFs in a collapsible tree, then build an explicit ordered merge queue from what you choose. Folder mode never uploads anything: the desktop app passes the folder path and the backend reads the files directly.
- Choosing a folder never fills the queue, and a queue never mixes uploaded files with folder files. Quick mode is unchanged and keeps failing the whole merge on a bad file.
- Ordered the tree naturally (case-insensitive, digit runs compared as numbers, folders before files) and used that same order for the files added from a folder.
- Added a check before merging that reports files which are missing, unreadable, damaged, or encrypted, so you can skip exactly those and merge the rest instead of losing the whole merge to one unusable document. The result reports how many files were merged and how many were skipped.
- Read paths only inside the folder you chose, resolving them fully so parent references and links cannot escape it, and refused anything that is not a PDF.
- Made Folder mode desktop-only, with the toggle disabled and explained when the desktop shell is not present.

## 1.4.0 — 2026-10-12


- Turned **Organize PDF** into a visual page-management workspace. The grid is now the working document itself: reorder by dragging, and rotate, mirror, duplicate, or delete any page or selection, so typed page numbers are no longer needed to keep positions correct.
- Added **Insert PDF** and **Insert Image**. Pages from other PDFs are picked by range or in full, images keep their original size, and insertion position is resolved against the selected pages (or the document ends when nothing is selected). Pick order is preserved and duplicates are allowed.
- Added bulk **Delete pages** by current grid position with a live count and highlighted cells, plus a **Sources** panel that lists every added file and can remove one together with its pages.
- Added **Undo**, **Redo**, and **Reset**. One action is one undo step, and reset returns to the starting document.
- Added eager, low-resolution page thumbnails rendered in the backend in bounded batches, cached per file, so large documents stay responsive and no page is left unloaded when scrolling. Rotation and mirroring reuse the cached thumbnail instead of re-rendering.
- Editing now happens entirely in memory and reaches the backend only on **Save**, which assembles the final page list into one PDF. Page mirroring preserves selectable text rather than rasterizing pages.
- Made the insertion position explicit: the insert panel now has a **Reference page** that always refers to a page in the current grid, with a live summary and a marker showing where the pages will land. The reference starts at the selected page (or the last page when nothing is selected), can be typed, and can be set by clicking a page while the panel is open. Insertion is no longer defined relative to the start or end of the original document, and Before no longer jumps to the beginning when nothing is selected.
- Kept the page grid to a fixed three, four, or five columns depending on window width, so a wide window no longer produces a wall of narrow cells. Cell controls now sit inside the cell: the selection checkbox has its own zone instead of covering the page image, and the action buttons are centred in the cell without overflowing or being clipped.
- Filtered the insert file dialogs by type and re-checked the chosen file by extension and content, so a file picked through "All files" that does not match the action is refused with a clear message instead of being uploaded.
- Tidied the insert panel: pages and position sit side by side to keep the grid visible, the page expression field appears only when picking, and a single-page source no longer offers a page choice at all.
- Folded the separate **Insert Content** feature into the workspace. Its HTTP endpoint and tests remain available; its sidebar entry and page are removed.
- The existing `POST /api/v1/organize/` and `POST /api/v1/insert/` endpoints keep their routes and request fields.

## 1.3.0 — 2026-10-12


- Consolidated **PDF to Image** and **Image to PDF** into one **PDF & Image** feature. The conversion direction is detected from one uploaded PDF or an image batch, so the direction no longer has to be chosen manually. The previous `/pdf-to-image` and `/image-to-pdf` routes still open the consolidated workspace.
- Added explicit PDF page selection with **All pages** and **Selected pages** modes. Selected pages accept a single page, ranges, and comma-separated combinations, stay synchronized with thumbnail checkboxes and the selected-page count, and disable conversion instead of silently falling back to all pages when the selection is empty or invalid.
- Rejected mixed PDF/image batches, multiple PDFs, and unsupported files atomically, preserving the existing batch, its order, its adjustments, and its settings.
- Added **A5** and **F4 (210 × 330 mm)** output page sizes for image-to-PDF, with the existing A4, A3, Letter, Legal, and original-image-size options retained. One page-size choice still applies to the whole batch, and per-image rotation and horizontal mirroring continue to apply per image.
- Kept retained image source files usable when returning to the converter, discarded late responses from replaced or cleared input, and prevented duplicate or stale conversions from publishing results.

## 1.2.4 — 2026-09-30

- Fixed the QR & Barcode preview regenerating in an endless loop while typing content, which flickered the preview, revoked the image being displayed, and intermittently disabled the Download button.
- Let the preview state own blob URL lifetime, ignored superseded generation requests, and released the temporary SVG download URL only after the browser started saving.
- Added a frontend regression test for the single-request preview and blob URL replacement.

## 1.2.3 — 2026-09-24

- Wrapped long selected native text inside the Edit Content object picker instead of clipping it on one line.

## 1.2.2 — 2026-09-24

- Kept Edit Content selection unavailable during accepted-checkpoint refresh and cleared queued selections, preventing expired targets and drafts from being restored after a guarded rejection.
- Added a frontend regression for rejection, refresh, explicit fresh selection, and successful Apply.
- Preserved native trailing spaces when editing a word, so typing a replacement without invisible spacing does not remove the separator and trigger a guarded rejection.
- Made the Edit Content object picker expand consistently below its control with a searchable list, and showed V1 editing limits before and during editing.

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
