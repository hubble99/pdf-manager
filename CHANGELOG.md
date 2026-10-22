# Changelog

## Unreleased

**Fixed**

- **Compress PDF:** a PDF that is only permission-restricted (it opens without a password, but editing or copying is not allowed) is now compressed instead of refused as "password required". Its restrictions are kept in the result.

## 1.9.0 — 2026-10-21 · Phase 1: native Rust core and new tools

> The first tools that run on the new Rust core (`dokuwu-core`) instead of the
> Python backend. They work on files directly on disk, report progress, can be
> cancelled, and keep memory use flat for large files.

**New tools**

- **PDF to Word:** turn a PDF into an editable `.docx` in the Convert group. Paragraphs, headings, bullet and numbered lists, underline and strike-through, ruled tables with merged cells, columns and pictures are rebuilt, and the result opens in Microsoft Word without a repair prompt. A scanned page is kept as a picture and reported as having no text to edit. A password-protected PDF is reported instead of failing. Shows page progress and can be cancelled; the file goes to Downloads without overwriting an existing one.
- **WEBP to PNG/JPG:** convert many WEBP images at once to PNG, JPG or JPEG (JPEG quality adjustable). Transparent areas become white for JPEG, animated WEBP keeps its first frame, a broken file is reported without stopping the others, and existing files are never overwritten.
- **Compress Photos:** make JPEG and PNG photos smaller, many at once. A photo that cannot get smaller is copied unchanged, the camera orientation and colour profile are kept, and the originals are never touched.

**Improved**

- **Compress PDF:** rebuilt on the Rust core. Memory stays roughly flat even for very large PDFs, progress is shown per picture, it can be cancelled, and it says so when nothing could be made smaller.

**Edit Content**

- Fixed the action buttons being pushed out of the side panel in Indonesian, so Deselect and Cancel are no longer clipped.
- A rejected edit now keeps the selection and the typed text, with the reason shown above Apply, so the text can be revised instead of retyped.
- Rejection messages are translated, Ctrl+S and Ctrl+Z are ignored while an edit is running, text fields keep their own undo, a failed page render offers Try again, and PDFs over 16 MiB are refused before upload with a clear message.
- PDFs made by macOS Quartz (repeated identical objects and stacked clip paths) are verified more often instead of being rejected. Verification rules were not loosened.

**Canvas PDF**

- **Images:** add PNG, JPG or WEBP images to a page with the new Insert image button, or drop image files on the page where they should go. An image can be moved, resized (corners keep the proportions, side handles or Shift stretch it), rotated to any angle, layered, copied, faded with an opacity slider, and deleted, with undo and redo. Saving embeds the original image in the PDF at the same place and angle; JPG and PNG files are embedded unchanged, and a photo's camera orientation is respected.

## 1.8.0 — 2026-10-15 · Cumulative release (1.3.0 → 1.8.0)

> 1.8.0 is the first published release since 1.2.4, so it carries everything in
> the 1.7.0 section below plus the changes here.

**Renamed to Dokuwu and final cleanup before publishing**

- **Name:** the application is now called **Dokuwu** (previously PDF Manager). The window title, splash screen, Home, About, installer name and Start Menu entry use the new name. The repository, its URL, the app's data folders and saved settings keep their existing names, so nothing stored on a device is lost.
- **Cleanup:** removed code that nothing used, with no change in behaviour. This covers four unused preview components, leftover template images, unused CSS rules, and backend endpoints no screen called (the one-shot Compress and Organize requests, Insert, and the Donation settings endpoints). Compress with progress and the Organize workspace are unchanged.

**UAT feedback (October 18)**

- **Language:** Settings now has a Language option, English or Bahasa Indonesia. The choice is remembered on the device and applied by reloading the app once. Every screen, message, tooltip and accessibility label is translated; any text without a translation falls back to English. A test fails if a new string is added without an Indonesian entry.
- **Settings:** removed the Output folder card. It never changed anything, because finished files always go to the Downloads folder.
- **Wording:** actions no longer say "download", since this is a desktop app. Merge & Download is now **Merge PDF**, and the other tools use their plain action names (Save PDF, Save PNG, and so on). Messages say a file was saved to your Downloads folder.
- **Canvas PDF:** the left panel is tidier. Tool icons and controls are larger and laid out symmetrically, using the free space below and beside them.
- **Canvas PDF colours:** pages are now rendered with colour management and at a higher resolution (up to 500 DPI, capped by a pixel budget so large pages stay safe), so the canvas matches the original PDF's colours closely, including CMYK content.
- **QR & Barcode:** the preview has far less empty padding around the code.

**Edit Content**

- Fixed edits on signature-stamped (BSrE) PDFs: text drawn with a bare `Td` position and text whose font is bound by an unnamed slot can now be verified, so replacements on such government documents are accepted instead of rejected.
- Text that is invisible (fully transparent, or a hidden text layer over a scanned/Word-exported image such as a letterhead) is now **view-only** with a clear explanation. Previously an edit could be "accepted" on the hidden layer while the visible page did not change.
- Selecting text on the page no longer fills the object list with empty or whitespace-only runs; a single match is selected directly.
- Added **Open Folder** after saving (toast and result card), like the other tools.
- Updated the in-app limits text to describe view-only text (scanned, outlined, Type 3, split, hidden), verification, and signed PDFs.

**Merge PDF**

- Fixed the folder-mode toast that reported "0 files merged": the result headers were not exposed to the desktop app's webview.
- Folder mode no longer merges twice in strict mode.
- The folder queue now shows each file's page count and size, like Quick mode.
- PDFs inside subfolders are indented deeper than PDFs at the chosen folder's root.
- Added **Open Folder** after a folder merge.

**PDF & Image**

- The workspace now has two tabs, **PDF to Images** and **Images to PDF**, each with its own uploader. A file added on the wrong tab is refused with a pointer to the other one. The old shared uploader and automatic direction detection are gone.

**Layout**

- Upload drop zones on Split, Organize, PDF & Image, Edit Metadata, Compress, and Protect are now centered vertically.

**Layout (second UAT pass)**

- Quick Merge with files is now two panels: previews on the left, and Add more PDFs, Output Filename, Clear All and Merge PDF on the right, so long lists need less scrolling. The empty state is just the centered drop zone.
- Content shorter than the page now sits in the vertical middle on every tool (upload screens and loaded forms alike); content that is taller still scrolls from the top. Mode tabs stay at the top. This also centers the PDF & Image uploader, which was stuck at the top.
- Merge Folder: the empty Folder and Files to Merge cards center their content before a folder is chosen.
- Images to PDF previews now fit their card at any rotation, so landscape or rotated images are no longer cropped.
- Edit Content: the Output filename field now sits in the header next to **Save PDF**, where it is visible without scrolling the control panel.

**UI consistency and accessibility**

- Protect PDF asks to confirm the password when adding protection; a mismatch blocks the action. Passwords have a show/hide toggle.
- Shared controls (mode tabs, segmented options, option cards, sliders, password field) are now used across Merge, Protect, Compress, Extract, PDF & Image, QR & Barcode, Donation and Settings, with arrow-key navigation on tabs.
- Quick Merge cards are smaller so more files fit without scrolling.
- Keyboard and screen-reader fixes: labelled main navigation, page grid and tool-options regions, status announcements for results.
- Text and button contrast now meets WCAG AA in all four themes.

**Canvas PDF**

- Tool options moved to a left panel; the top bar keeps the main tools.
- Font weights 450, 500 and 550 are available for fonts that ship fewer weights (for example Arial, Times, Calibri). They are approximated by slightly thickening the nearest real weight; the saved text stays selectable.

**Reordering**

- Fixed mouse drag-and-drop in Merge (Quick and Folder mode): the desktop webview swallowed in-page HTML5 drag events, so only the arrow buttons worked. Reordering now uses pointer-based dragging (the same engine as Organize), with Alt+Arrow and earlier/later buttons kept for the keyboard.
- Quick Merge is now a grid of cards: the first page of each PDF as preview, the file name wrapped below, size and page count, and a **Duplicate** badge on later copies of the same file (still allowed, just flagged).
- Images to PDF uses the same card grid, with a left image panel and right controls like PDF to Images.
- Long file names now wrap in the Merge folder tree and queue.

**Naming**

- Protect (encrypt and unlock) and Edit Content now use the output name you type exactly; the default (`<name>_protected`, `<name>_unlocked`, `<name>-edited`) only applies when the field is empty. Edit Content gained an Output filename field and a **Save and download** button.
- PDF to Images ZIP no longer appends `_images` to a name you typed.

**Compress**

- Fixed black areas after compression on PDFs with transparent images: the soft mask was lost when an image was re-encoded. Stencil masks, indexed, CMYK, separation and other unsafe image types are now left untouched.
- Added a **Low quality** preset; the four presets are equal-width and centered.

**Images to PDF**

- Landscape images now get a landscape page on fixed paper sizes (A4 landscape and so on) instead of being shrunk onto a portrait page.

**Organize**

- The opened PDF is shown in a header bar with a red X; closing it also discards the inserted sources. The Sources panel has its own close button.
- Adding the same PDF or image to Sources twice is refused with a pointer to the existing source.

**QR & Barcode**

- A bare domain such as `example.com` is saved as `https://example.com`, so phones open it as a link instead of a web search.

**Other**

- Settings → Change folder now opens the folder picker.
- Split, Compress and Protect: **Change file** opens the file picker directly, and a red bin button clears the file.
- Mode tabs no longer stay fixed while a long page scrolls.

**Removed**

- **Edit Metadata** is removed: the page, its route, the Home card and sidebar item, and the `/api/v1/metadata/` endpoint with its PDF metadata writer. The tool changed only title, author, subject, and keywords, which did not justify its place in the final v1 scope. The Edit group now holds Canvas PDF and Edit Content.

**Canvas PDF**

- Removed the stray BETA chip from the Canvas PDF header. Only Edit Content carries the Beta marker.

## 1.7.0 — 2026-10-14 · Cumulative release (1.3.0 → 1.7.0)

> Versions 1.3.0 through 1.7.0 were built and verified but never published or
> tagged. They ship together as one release, so this section covers the whole
> unpublished range instead of only the last increment. User-facing highlights
> are in [`RELEASE_NOTES.md`](RELEASE_NOTES.md).

**New workspaces**

- Consolidated **PDF to Image** and **Image to PDF** into one **PDF & Image** feature. The conversion direction is detected from one uploaded PDF or an image batch, so the direction no longer has to be chosen manually. The previous `/pdf-to-image` and `/image-to-pdf` routes still open the consolidated workspace.
- Added explicit PDF page selection with **All pages** and **Selected pages** modes. Selected pages accept a single page, ranges, and comma-separated combinations, stay synchronized with thumbnail checkboxes and the selected-page count, and disable conversion instead of silently falling back to all pages when the selection is empty or invalid.
- Rejected mixed PDF/image batches, multiple PDFs, and unsupported files atomically, preserving the existing batch, its order, its adjustments, and its settings.
- Added **A5** and **F4 (210 × 330 mm)** output page sizes for image-to-PDF, with the existing A4, A3, Letter, Legal, and original-image-size options retained. One page-size choice still applies to the whole batch, and per-image rotation and horizontal mirroring continue to apply per image.
- Kept retained image source files usable when returning to the converter, discarded late responses from replaced or cleared input, and prevented duplicate or stale conversions from publishing results.
- Turned **Organize PDF** into a visual page-management workspace. The grid is the working document itself: reorder by dragging, and rotate, mirror, duplicate, or delete any page or selection, so typed page numbers are no longer needed to keep positions correct.
- Added **Insert PDF** and **Insert Image**. Pages from other PDFs are picked by range or in full, images keep their original size, and insertion position is resolved against the selected pages (or the document ends when nothing is selected). Pick order is preserved and duplicates are allowed.
- Added bulk **Delete pages** by current grid position with a live count and highlighted cells, plus a **Sources** panel that lists every added file and can remove one together with its pages.
- Added **Undo**, **Redo**, and **Reset**. One action is one undo step, and reset returns to the starting document.
- Added eager, low-resolution page thumbnails rendered in the backend in bounded batches, cached per file, so large documents stay responsive and no page is left unloaded when scrolling. Rotation and mirroring reuse the cached thumbnail instead of re-rendering.
- Editing now happens entirely in memory and reaches the backend only on **Save**, which assembles the final page list into one PDF. Page mirroring preserves selectable text rather than rasterizing pages.
- Made the insertion position explicit: the insert panel now has a **Reference page** that always refers to a page in the current grid, with a live summary and a marker showing where the pages will land. The reference starts at the selected page (or the last page when nothing is selected), can be typed, and can be set by clicking a page while the panel is open. Insertion is no longer defined relative to the start or end of the original document, and Before no longer jumps to the beginning when nothing is selected.
- Kept the page grid to a fixed three, four, or five columns depending on window width, so a wide window no longer produces a wall of narrow cells. Cell controls now sit inside the cell: the selection checkbox has its own zone instead of covering the page image, and the action buttons are centred in the cell without overflowing or being clipped.
- Filtered the insert file dialogs by type and re-checked the chosen file by extension and content, so a file picked through "All files" that does not match the action is refused with a clear message instead of being uploaded.
- Tidied the insert panel: pages and position sit side by side to keep the grid visible, the page expression field appears only when picking, and a single-page source no longer offers a page choice at all.
- Folded the separate **Insert Content** feature into the workspace. Its HTTP endpoint and tests remain available; its sidebar entry and page are removed. The existing `POST /api/v1/organize/` and `POST /api/v1/insert/` endpoints keep their routes and request fields.
- Added **Folder mode** to Merge PDF. Point it at a folder and browse its PDFs in a collapsible tree, then build an explicit ordered merge queue from what you choose. Folder mode never uploads anything: the desktop app passes the folder path and the backend reads the files directly.
- Choosing a folder never fills the queue, and a queue never mixes uploaded files with folder files. Quick mode is unchanged and keeps failing the whole merge on a bad file.
- Ordered the tree naturally (case-insensitive, digit runs compared as numbers, folders before files) and used that same order for the files added from a folder.
- Added a check before merging that reports files which are missing, unreadable, damaged, or encrypted, so you can skip exactly those and merge the rest instead of losing the whole merge to one unusable document. The result reports how many files were merged and how many were skipped.
- Read paths only inside the folder you chose, resolving them fully so parent references and links cannot escape it, and refused anything that is not a PDF. Folder mode is desktop-only, with the toggle disabled and explained when the desktop shell is not present.

**Home, navigation, and identity**

- Added **Home** as the entry point. Opening the app now shows what it is and what it can do, instead of dropping you into one tool.
- Grouped the features by the task you are performing — **Organize** (Merge PDF, Split PDF, Organize PDF), **Convert** (PDF & Image), **Edit** (Canvas PDF, Edit Content, Edit Metadata), **Optimize** (Compress PDF), **Protect** (Protect PDF), and **Create** (QR & Barcode). The same groups appear on Home and in the sidebar, so the layout survives new tools that are not about PDFs.
- Drove both the sidebar and the Home cards from **one feature registry**, so a feature is described once and adding one later means adding a single entry.
- Renamed "Organize Pages" to **Organize PDF** so a feature no longer repeats its group's name.
- Moved the application name, tagline, and version into one place. The interface reads the running version from `frontend/package.json` instead of hardcoding it, so it cannot drift from the release version, and shows **PDF Manager** everywhere.

**Interface redesign (1.7.0)**

- Rebuilt the interface around the design reference in `ui_improvement/pdf-manager-ui.html` using the existing React components and tokens. Every screen now shares one header bar, one card language, and one set of navigation roles (`--bg`, `--surface`, `--sc`, `--sch`, `--line`, `--text`, `--muted`, `--act`, `--pb`, `--hov`, `--sel`), and no backend behaviour changed.
- **Correction:** the first pass of this redesign applied the reference's colors, tokens, and header bar but left most screen layouts as they were, so the statement above that every screen follows the reference was not yet true. The screens below were restructured to the reference's layout in a second pass:
  - **Compress PDF**, **Split PDF**, **PDF & Image**, and **QR & Barcode** now use the reference's flush cards with a header row, a centered form column, and (for Split and PDF & Image) a page-thumbnail grid beside the options. Their empty states are a centered drop zone.
  - **Split PDF** and **PDF & Image** select pages by clicking thumbnails. The grid and the page-range field stay in sync, and the grid is disabled while an option makes it irrelevant (Split all pages, All pages). The large preview panel on those screens was removed.
  - **Organize PDF** page cells follow the reference card style (hover actions, position label below the page) with a centered empty state.
  - **Merge PDF > Folder** follows the reference layout: a folder card on the left with a path bar, an **Expand all / Collapse all** control, a tree whose folders show a PDF count and an **Add all** link and whose files show a PDF marker with a **+ Add** / **✓ Added** tag, and a footer with the PDFs found and files added; the right side holds the ordered **Files to Merge** list, the output name, and **Clear** / **Merge & Download**. Choosing a folder still never fills the queue, and the queue still supports dragging, Alt+Up / Alt+Down, and the arrow buttons.
  - **Donation** follows the reference's tabbed layout: **Indonesia** (QRIS) and **International** (PayPal) show one method at a time instead of two side by side. Recipient name, copy and open actions, the PayPal link, the safety note, and the allowed opener scope are unchanged.
- Fixed layout problems on **Edit Content** and **Canvas PDF**: the Edit Content preview no longer overflows its container at narrow widths and opens fitted to the panel width instead of cropped; the Canvas PDF output-name and Save controls stay together on the right when the toolbar wraps; and the Canvas PDF contextual properties bar wraps instead of scrolling sideways, so no control is hidden.
- Removed the unused `PreviewPanel` and `ThumbnailStrip` components and their tests, which the new layouts replaced.
- Added **Light** as the default theme and kept **Dark**, **Dusty Rose**, and **Steel Blue**. A saved theme is preserved, and only the fallback changed. Settings > Appearance now offers all four, and document pages and QR/barcode images stay white in every theme.
- Renamed **Edit Canvas** to **Canvas PDF** in the sidebar, Home card, page title, toolbar, and documentation. The `/edit-canvas` route and `edit-canvas` feature id are unchanged for compatibility.
- Kept the **BETA** badge on Edit Content in the sidebar and on its Home card, with the tooltip "Beta: this feature is still unstable.", and added a matching beta notice above the limits card before a file is opened.
- Made the **whole file row draggable** in Merge PDF Quick and Folder modes, with a grab cursor, a hover background, an elevated lifted row, and a live insertion line. The number badges renumber while the row is in the air. The up/down buttons remain, and a focused row supports Alt+Up / Alt+Down.
- Made **Canvas PDF** and **Edit Content** responsive and overflow-safe: the canvas toolbar wraps instead of clipping, the workspace shares the available height, and long text wraps instead of overflowing.
- Made **Recent output files** session-only: the list lives in `sessionStorage` and clears when the app closes.
- Did not implement the reference's prototype simulations. Compress estimates, update checks, and download simulations were left out.

**Donation**

- Added a **Donation** page, reachable from the sidebar and from a small teaser on Home. It shows a QRIS code and an international PayPal option, works entirely offline, and stores nothing. Both entry points are unobtrusive: no popups, banners, or reminders.
- Replaced the donation placeholders with the **real bundled assets**: the QRIS and PayPal codes ship in `frontend/src/assets`, and `frontend/src/config/donation.ts` is the single source for the PayPal URL, the recipient name, and both asset paths. The page shows `Recipient: Ramadhoni Nasri` for each method, the pre-payment check, and the guidance that PDF Manager never asks for payment details or for donations by email or chat.
- Hardened the payment surface: the PayPal link opens in the system browser only, the Tauri `opener:allow-open-url` scope allows exactly that one URL, no URL is built from input, and the page collects no card, account, or credential data. `donationAssets.test.ts` pins the URL, the recipient name, both image SHA-256 hashes, and the capability scope. The earlier backend-held donation value is no longer read by the interface; the legacy `/api/v1/settings/donation` and `/api/v1/settings/open-donation` endpoints remain available.

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
