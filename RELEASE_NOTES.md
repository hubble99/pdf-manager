# Dokuwu 1.10.1 — Release Notes

**Release type:** patch. A fix found while testing 1.10.0 on Windows. The
detailed entry is in [`CHANGELOG.md`](CHANGELOG.md).

## 1.10.1 highlights
- **Split PDF / Merge PDF:** a very large job no longer leaves temporary `.spillN.pdf.part` files in the output folder on Windows.

---

# Dokuwu 1.10.0 — Release Notes

**Release type:** minor. Phase 2 of the move to the native Rust core: more tools
run without the Python backend. The detailed entry is in
[`CHANGELOG.md`](CHANGELOG.md).

## 1.10.0 highlights
- **PDF & Image, Merge PDF, Split PDF, Protect PDF and QR & Barcode** now run on the Rust core: files are read from disk, progress is shown, jobs can be cancelled, and big files no longer fill memory.
- **Split PDF:** hold Shift and click to select a range of pages.
- **Long lists** (Merge PDF, Images to PDF, Compress Photos) scroll in their own box, so the buttons stay in view; Compress Photos uses two columns.
- **Protect PDF:** the confusing Owner Password field is gone; permissions still apply.
- Results are saved to Downloads under a free name and never overwrite a file.

---

# Dokuwu 1.9.1 — Release Notes

**Release type:** patch. Fixes found while testing 1.9.0 on real documents. The
detailed entry is in [`CHANGELOG.md`](CHANGELOG.md).

## 1.9.1 highlights
- **Edit Content** accepts more macOS-made PDFs (equally named fonts, ICC colours) and PDFs that are only restricted from editing (no password needed); empty text strings in browser-printed PDFs no longer block an edit.
- **PDF to Word:** letterheads and logos with transparency no longer turn black.
- **Compress PDF:** PDFs that only restrict editing or copying are compressed instead of refused.

---

# Dokuwu 1.9.0 — Release Notes

**Release type:** minor. This release adds the first tools built on the new Rust
core and fixes Edit Content edge cases. The detailed entry is in
[`CHANGELOG.md`](CHANGELOG.md).

## 1.9.0 highlights
- **PDF to Word:** convert a PDF to an editable Word document.
- **WEBP to PNG/JPG:** batch image conversion.
- **Compress Photos:** make JPEG and PNG photos smaller in batches.
- **Compress PDF** now keeps memory flat on large files and can be cancelled.
- **Canvas PDF** accepts images (move, resize, rotate, opacity).
- **Edit Content:** buttons no longer clip in Indonesian, rejected edits keep your text, and more macOS-made PDFs are accepted.

---

# Dokuwu 1.8.0 — Release Notes

**Release type:** cumulative. This release publishes everything built since
1.2.4 together: **1.3.0 through 1.8.0**. Those versions were
built and verified but never published or tagged, so they ship as one version
with one changelog. The detailed entry is in [`CHANGELOG.md`](CHANGELOG.md).

**Platform:** Windows 10/11 (x64). **Offline:** everything runs on this device;
files are never uploaded.

## Highlights

### 1.8.0 changes
- **New name: Dokuwu.** The app was called PDF Manager before. Your settings and files stay where they were, and the Windows installer and Start Menu entry now use the new name.
- **Leaner build.** Unused code, styles, images and backend endpoints were removed with no change in behaviour.
- **Edit Content** now works on signature-stamped government PDFs, and hidden text layers (for example a letterhead image with a transparent text layer) are shown as view-only instead of being silently edited.
- **PDF & Image** has two tabs, PDF to Images and Images to PDF, each with its own uploader.
- **Merge PDF** folder mode shows page count and size per file, reports the merged count correctly, and offers Open Folder. Edit Content also offers Open Folder after saving.
- Upload areas are centered vertically on every tool.

### A visual system instead of per-screen styling
The whole interface was rebuilt around one layout language: a shared header bar,
one card style, one navigation model, and one set of colour roles that every
theme maps onto. Every screen — Home, Merge, Split, Organize, PDF & Image,
Canvas PDF, Edit Content, Compress, Protect, QR & Barcode,
Donation, and Settings — now looks and behaves like the same application.

### Four themes, Light by default
**Light** is now the default, alongside the existing **Dark**, **Dusty Rose**,
and **Steel Blue**. Your saved theme is kept; only the fallback changed. Document
pages and generated QR/barcode images stay white in every theme.

### Home and navigation
Opening the app shows **Home**, which introduces the product and lists every
feature grouped by the task you are doing — Organize, Convert, Edit, Optimize,
Protect, and Create. The sidebar carries the same groups, driven by one registry,
so the layout survives new tools that are not about PDFs.

### New workspaces
- **PDF & Image** replaces the separate PDF-to-Image and Image-to-PDF pages. One
  upload decides the direction; page selection, image adjustment, and A4/A3/A5/
  F4/Letter/Legal/original-size output are all in one place.
- **Organize PDF** is a visual page workspace: drag to reorder, and rotate,
  mirror, duplicate, delete, insert PDF or image pages, with Sources, undo, redo,
  and reset. Edits stay in memory until Save.
- **Merge PDF Folder mode** adds a folder tree and an explicit ordered queue for
  desktop use, with natural ordering and a pre-merge check that reports files
  that cannot be read.

### Merge drag-to-reorder
In both Merge modes the whole file row is draggable: grab cursor, hover
background, an elevated lifted row, and a live insertion line while the number
badges renumber. The up/down buttons remain, and a focused row supports
Alt+Up / Alt+Down.

### Canvas PDF
The former **Edit Canvas** is now **Canvas PDF** in the sidebar, Home card, page
title, and toolbar. The route and file names are unchanged, so nothing breaks.
Its toolbar now wraps instead of clipping on a narrow window.

### Edit Content stays Beta
Edit Content keeps its **BETA** badge in the sidebar and on its Home card, with
the tooltip "Beta: this feature is still unstable.", and now shows a beta notice
before a file is opened. Its verified-edit workflow is unchanged.

### Donation
The Donation page now ships the **real QRIS and PayPal codes**. It shows
`Recipient: Ramadhoni Nasri` for each method and the reminder to check that your
payment app shows that name, plus the note that Dokuwu never asks for
payment details or for donations by email or chat. The PayPal link opens in your
system browser only, and the app collects no card, account, or credential data.

## Upgrade notes

- **Light is now the default theme.** If you had never picked a theme, the app
  opens in Light. If you had, your choice is kept.
- **Recent output files is session-only.** The list in Settings now clears when
  the app closes, by design.
- **Edit Canvas is renamed Canvas PDF** in the interface only. The
  `/edit-canvas` route, feature id, and modules are unchanged.
- **Donation data moved into the app.** The bundled codes and the single fixed
  PayPal URL now live in `frontend/src/config/donation.ts`; the old backend
  donation settings are no longer read by the interface. Both legacy donation
  endpoints still exist for compatibility.

## Known limitations

- **Edit Content** edits existing native/selectable text only. Scanned or
  outlined text, new lines, font changes, and text split across objects remain
  unsupported, and uncertain documents are still rejected safely during
  verification. It is marked Beta for that reason.
- **Canvas PDF** adds overlays; it does not correct existing PDF text.
- **Organize PDF** builds the new document in memory and only writes on Save.
- Features that came from the design reference as simulations are **not**
  implemented: compress size estimates and progress are real backend work, but
  no fake estimates, update checks, or download simulations were added.
- **Publication status:** this release is prepared but **not tagged and not
  pushed**. Publishing is a separate, explicit decision.

## Verification

- Frontend: `tsc -b` clean, ESLint clean, production build succeeds, and the full
  Vitest suite passes (31 files / 296 tests).
- Backend: API contract tests pass, and the bundled sidecar reports version
  `1.7.0` from `/health`, matching the app version.
- **Installer build:** `tauri build` succeeded and produced both bundles on
  2026-10-14:
  - `PDF Manager_1.7.0_x64-setup.exe` — 51,941,690 bytes,
    SHA-256 `81C5C26DF0FA1CCDA8EE86580F20741F7EAE46C09BF547D2E4DCBD6DB9AB490F`
  - `PDF Manager_1.7.0_x64_en-US.msi` — 54,362,112 bytes,
    SHA-256 `5F945748F46DEC6AEC91D75B3D7E0BFEC1B3E46B75D83AAFC02AA6E340DC29BF`
- Manual test checklist: [`UAT/UAT_1.7.0.md`](UAT/UAT_1.7.0.md) (private, not
  committed) covers Donation, all four themes, Canvas PDF and Edit Content at a
  narrow window, and Merge drag-to-reorder. Its Pass/Fail fields are for the
  tester.
