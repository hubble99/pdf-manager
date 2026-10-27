# Dokuwu

> Dokuwu was previously named PDF Manager. The repository and its URL keep the original name.

![Version](https://img.shields.io/badge/version-1.11.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)
![Release](https://img.shields.io/github/downloads/hubble99/pdf-manager/total)
<p align="center">
  <img src="frontend/src-tauri/icons/128x128.png" alt="Dokuwu Logo" width="96"/>
</p>

<p align="center">
  <strong>An offline desktop application for professional PDF document processing.</strong><br/>
  Built with Tauri + React + Rust.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%2010%2F11-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/Version-1.11.0-green?style=flat-square" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" />
  <img src="https://img.shields.io/badge/Offline-100%25-purple?style=flat-square" />
</p>

---

## ✨ Features

| Feature | Description |
|-------|-----------|
| 📎 **Merge PDF** | Combine multiple PDF files into one using drag & drop |
| ✂️ **Split PDF** | Split a PDF or extract specific pages into separate files |
| 🗜️ **Compress PDF** | Reduce PDF file size with adaptive image compression |
| 🖼️ **PDF & Image** | Two tabs: export PDF pages to PNG, JPEG, or WEBP, or combine images (JPG/PNG/WEBP/BMP) into a single PDF |
| 🔲 **QR & Barcode** | Generate QR codes and barcodes (Code128, EAN13, EAN8, Code39) |
| 🗂️ **Organize Pages** | Rearrange, rotate, mirror, delete, and insert pages visually |
| ✏️ **Canvas PDF** | Add native text overlays, images, shapes, lines, freehand drawing, and highlights on an interactive PDF canvas |
| 🖊️ **Edit Content** (beta) | Correct existing native PDF text (typo fixes, word and shorter replacements, deletions, and genuine longer replacements) with verification before saving |
| 🔒 **Protect PDF** | Protect PDFs with a password or remove existing passwords |

Dokuwu is available in **English** and **Bahasa Indonesia** (Settings → Language) and has four themes.

> **All processing runs 100% offline on your machine. Your files are never sent to the internet. Temporary files are automatically cleaned up.**

Read the [Privacy Policy](https://hubble99.github.io/pdf-manager/privacy.html) (English and Bahasa Indonesia).

### Edit Content V1 — what it can and cannot safely do

Edit Content edits the **existing native text** of a supported PDF. A change is
published only after it has been regenerated privately, reopened, and verified;
the original file is never overwritten. Edit Content is intentionally
conservative — a rejection means the edit could not be proven safe, not that the
application failed.

**Supported**

- Editing existing native/selectable PDF text.
- Replacing an existing text range inside one supported text object: typo
  corrections, word replacement, and shorter replacements.
- Deleting a supported existing range inside a text object.
- Genuine longer replacements that replace an existing range and need no reflow;
  the object's own bounds may expand while surrounding content keeps its
  position.
- Saving only after integrity and safety verification succeeds.
- Undo/redo across accepted checkpoints.
- Safe fail-closed rejection when preservation cannot be proven.

**Current V1 limitations**

- It is not a general-purpose PDF word processor.
- It edits native/selectable text only. Scanned or image-only text and outlined
  text stay view-only; there is no OCR.
- The supported model is replacement of a **non-empty existing range** inside one
  text object. Pure insertion-style edits are not supported by the current draft
  model — for example `Gedung → Gedungs` is interpreted as an insertion and is
  rejected, with a message asking you to replace or remove existing text instead.
- Automatic text reflow, paragraph layout, wrapping, new lines, and object
  movement are outside V1.
- Replacement characters must be safely representable by the exact embedded
  font and resources the document already uses. A missing glyph rejects the edit,
  and V1 never substitutes another font to make unsupported characters available.
- Some PDFs with unsupported or ambiguous font/resource structures are
  intentionally rejected (for example Type 3 text, words split across text
  objects, or colliding font resources).
- Some formatting or layout changes are rejected when preservation cannot be
  proven.
- Rejections leave the document, the accepted revision, and the publication state
  unchanged and produce no download. After certain guarded rejections the
  selection is cleared and you must select the text again before retrying.

---

## 🛠️ Tech Stack

| Layer | Technology | Version |
|-------|-----------|-------|
| Desktop Shell | Tauri | 2.11.2 |
| Frontend | React + TypeScript | 19 + TS 6 |
| Build Tool | Vite | 8.0 |
| Styling | Tailwind CSS | 4.3 |
| Icons | lucide-react | 1.17 |
| Router | React Router | 7.16 |
| PDF Engine | MuPDF (`mupdf` crate) | 0.8 |
| Edit Content Engine | PDFium (pinned build) | see `native/edit-content-engine/pdfium-artifacts.json` |
| Image Processing | `image`, `webp`, `jpeg-encoder` | 0.25 |
| QR Code | `qrcode`, `rxing` (decoder, tests) | 0.14 |
| Barcode | Rust encoders in `dokuwu-core` | - |
| Rust | rustc / cargo | 1.88+ |

---

## 📸 Screenshots

<p align="center">
  <img src="docs/assets/screenshot-1.png" width="48%" alt="Dokuwu home screen with every tool grouped by task">
  <img src="docs/assets/screenshot-2.png" width="48%" alt="Organize PDF: page thumbnails with insert, delete and save actions">
  <br>
  <img src="docs/assets/screenshot-3.png" width="48%" alt="PDF &amp; Image: choose pages and export them as images">
  <img src="docs/assets/screenshot-4.png" width="48%" alt="Canvas PDF: annotate a page with text, shapes and drawings">
  <br>
  <img src="docs/assets/screenshot-5.png" width="48%" alt="Edit Content: select native text and correct it with verification">
  <img src="docs/assets/screenshot-6.png" width="48%" alt="Home screen in Bahasa Indonesia">
</p>

---

## 🔨 Build from Source

### Prerequisites

- **Node.js 20.19+** — [nodejs.org](https://nodejs.org)
- **Rust 1.77+** — [rustup.rs](https://rustup.rs)

### 1. Clone the repository

```bash
git clone https://github.com/hubble99/pdf-manager.git
cd pdf-manager
```

### 2. Setup the frontend

```powershell
cd frontend
npm install
```

### 3. Run in development mode

Every feature runs in the Rust core, so it only works inside the Dokuwu
window. A browser tab shows the interface but has no file access.

```powershell
# Ensure Rust is in your PATH:
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Edit Content needs its worker and the pinned PDFium library once
cd frontend
npm run prepare:edit-content:desktop

npm run tauri:dev
```

### 4. Build the Tauri production installer

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
cd frontend
npm run prepare:edit-content:desktop
npm run tauri build
```

The output installers will be located at: `frontend/src-tauri/target/release/bundle/`

---

## 📦 Installation Guide (End User)

1. Download the latest published installer from the [Releases](../../releases) page.
2. Follow the installation wizard.
3. Launch the app from **Start Menu → Dokuwu**.

### System Requirements
- Windows 10 / 11 (64-bit)
- Minimum 4 GB RAM
- Minimum 500 MB Storage

---

## ⚠️ Windows SmartScreen Warning

When installing Dokuwu for the first time, Windows SmartScreen may show a warning saying *"Windows protected your PC"*. This is expected behavior for open-source apps without an expensive code signing certificate.

**To proceed with installation:**
1. Click **"More info"** on the SmartScreen dialog
2. Click **"Run anyway"**
3. Installation will proceed normally

Dokuwu is fully open-source. You can review the entire source code in this repository.

---

## 🧪 Testing

```powershell
# Rust core and Edit Content host
cargo test --locked --manifest-path native/dokuwu-core/Cargo.toml

# Frontend tests
cd frontend
npm run test

# TypeScript type check
cd frontend
npx tsc --noEmit
```

---

## 🎨 UI Design System

Dokuwu follows a compact desktop-productivity design system: document
preview remains primary, controls stay space-efficient, and shared patterns are
preferred over feature-specific styling through shared tokens and components.

The application provides Light (default), Dark, Dusty Rose, and Steel Blue
themes. Document pages and generated QR/barcode images stay white in every
theme.

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

## 🙏 Acknowledgements

- [MuPDF](https://mupdf.com/) — PDF rendering and editing engine
- [PDFium](https://pdfium.googlesource.com/pdfium/) — Edit Content text engine
- [Tauri](https://tauri.app/) — Desktop shell framework
- [React](https://react.dev/) — UI framework
