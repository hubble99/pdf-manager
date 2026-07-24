# AGENTS.md — PDF Manager V2

## Arsitektur Sistem

```
┌─────────────────────────────────────────────┐
│           Tauri v2 Desktop Shell            │
│  ┌───────────────────────────────────────┐  │
│  │     React 19 + TypeScript (UI)        │  │
│  │  Tailwind CSS v4 + lucide-react       │  │
│  │  React Router v7 + Axios             │  │
│  └──────────────────┬────────────────────┘  │
│                     │ HTTP localhost:8000    │
│  ┌──────────────────▼────────────────────┐  │
│  │     FastAPI (Python Backend)          │  │
│  │  PyMuPDF 1.27 · Pillow 12 · qrcode   │  │
│  │  python-barcode · pydantic-settings   │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

- Frontend → Backend via `http://127.0.0.1:8000`
- Dev mode: `npm run dev` (Vite :5173) + backend uvicorn :8000
- Tauri dev: `npm run tauri:dev` (builds Rust shell + spawns both)
- Tema: **Pro-Level Document Interface** (dark, Electric Blue #4A9EFF)

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Desktop Shell | Tauri | 2.11.2 |
| Frontend | React + TypeScript | 19 + TS 6 |
| Build Tool | Vite | 8.0 |
| Styling | Tailwind CSS | 4.3 |
| Icons | lucide-react | 1.17 |
| Router | React Router | 7.16 |
| HTTP Client | Axios | 1.16 |
| Backend | FastAPI | 0.136 |
| ASGI Server | Uvicorn | 0.48 |
| PDF Engine | PyMuPDF (fitz) | 1.27 |
| Image Processing | Pillow | 12.2 |
| QR Code | qrcode | 8.2 |
| Barcode | python-barcode | 0.16 |
| Validation | Pydantic / pydantic-settings | 2.13 |
| Python Env | uv venv | 0.11.17 |
| Rust | rustc / cargo | 1.96.0 |

---

## Status Fitur

| Fitur | Backend | Frontend | Tested | Notes |
|-------|---------|----------|--------|-------|
| Foundation / Shell | ✅ | ✅ | ✅ | Sprint 1 selesai |
| Health Check API | ✅ | ✅ | ✅ | GET /health |
| Sidebar Navigation | — | ✅ | ✅ | 7 items + Settings |
| Routing (React Router) | — | ✅ | ✅ | All 8 routes |
| Design System CSS | — | ✅ | ✅ | Pro-Level dark theme |
| API Client (Axios) | — | ✅ | ✅ | with interceptors |
| Backend Status Bar | — | ✅ | ✅ | Auto-reconnect 10s |
| Tauri v2 Config | ✅ | ✅ | 🔄 | Config done, build TBD |
| Unit Tests (Sprint 1) | ✅ | ✅ | ✅ | Sprint 1 Addendum |
| PDF Info API | ✅ | ✅ | ✅ | GET /api/v1/pdf-info/ |
| Merge PDF | ✅ | ✅ | ✅ | Sprint 2 — core + router + UI |
| Split PDF (ex Extract Pages) | ✅ | ✅ | ✅ | Sprint 2 — renamed Session 9e; 4 output modes |
| Compress PDF | ✅ | ✅ | ✅ | Sprint 2 — JPEG re-encode |
| PDF to Image | ✅ | ✅ | ✅ | Sprint 3 |
| Image to PDF | ✅ | ✅ | ✅ | Sprint 3 |
| QR & Barcode Gen | ✅ | ✅ | ✅ | Sprint 3 |
| Insert Content | ✅ | ✅ | ✅ | Sprint 4 |
| Settings Page | ✅ | ✅ | ✅ | Sprint 4 |
| Panel Toggle UI | — | ✅ | ✅ | Sprint 6 — ExtractPage, PdfToImage, ImageToPdf, InsertPage |
| Sidebar Collapse | — | ✅ | ✅ | Session 7b — localStorage, ChevronLeft/Right toggle, 64px width |
| Post-Download Notification | — | ✅ | ✅ | Session 7b — addToast on all 10 pages |
| Output Filename Input | — | ✅ | ✅ | Session 7b — Extract, Compress, PdfToImage, Insert, Organize |
| Organize Page Preview | — | ✅ | ✅ | Session 7b — 160px grid, 110px thumb, dpi=48 |
| Tauri Dialog Plugin | ✅ | ✅ | ✅ | Sprint 6 — plugin-dialog + browse folder |
| Tauri Sidecar Config | ✅ | — | ✅ | Sprint 6 — plugin-shell, binaries/, externalBin |
| PyInstaller Spec | ✅ | — | ✅ | Sprint 7 — sidecar build OK, HEALTH verified |
| Splash Screen | — | ✅ | ✅ | Sprint 6 — SplashScreen.tsx w/ polling |
| Tauri Branding Config | ✅ | — | ✅ | Sprint 7 — tauri.conf.json metadata, NSIS build OK |
| Vite Production Build | — | ✅ | ✅ | Sprint 6 — 417KB bundle, 513ms |
| Production Installer | ✅ | ✅ | ✅ | Sprint 7 — MSI 43.6MB + EXE 42.5MB |
| Sidecar Frozen Fix | ✅ | — | ✅ | Task 7.7 — sys.frozen uvicorn fix |
| Single-Step Download Flow | — | ✅ | ✅ | Session 9a — Merge, Compress, Organize, Protect, Extract, PdfToImg, ImgToPdf, Insert auto-download |
| Password Removal API | ✅ | ✅ | ✅ | Session 9a — POST /api/v1/protect/remove + Remove tab UI |
| Barcode PNG Fix | ✅ | — | ✅ | Session 9b — Packaged DejaVuSansMono.ttf into PyInstaller build.spec |
| Compress SSE Removed | — | ✅ | ✅ | Session 9a — replaced broken stream endpoint with direct /compress/ |
| CMYK Compress Fix | ✅ | — | ✅ | Session 9a.5 — RGB conversion before JPEG re-encode |
| Output Filename Sanitize | ✅ | — | ✅ | Session 9a.1 — sanitize_filename() + Content-Disposition headers |
| Organize Page Reset | — | ✅ | ✅ | Session 9a.3 — Reset button restores original page order |
| Tauri Open Folder Fix | — | ✅ | ✅ | Session 9a.4 — Added shell:allow-open capabilities |
| Sidecar Orphan Process Fix | ✅ | — | ✅ | Session 9a.6 — Hooked tauri::RunEvent::Exit to kill sidecar |
| Auto Temp/Output Cleanup | ✅ | — | ✅ | Session 9d — FastAPI lifespan startup+shutdown + Tauri graceful exit |

Legend: ✅ Done · 🔄 In progress · 🔲 Stub/Pending · ❌ Not tested

## Session Log

### Session 1 — 2026-05-31

**Selesai:**
- ✅ Installed Rust 1.96.0 via winget
- ✅ Installed uv 0.11.17 via pip
- ✅ Created backend uv venv di `backend/.venv`
- ✅ Installed FastAPI 0.136 + semua deps dalam venv
- ✅ Scaffold Vite + React + TypeScript di `frontend/`
- ✅ Installed frontend deps (axios, lucide-react, react-router-dom, tailwindcss v4, @tauri-apps/cli+api)
- ✅ Dibuat `backend/config.py` (pydantic-settings, env vars)
- ✅ Dibuat `backend/main.py` (FastAPI + CORS + health + error handler)
- ✅ Dibuat `backend/models/common.py` (SuccessResponse, ErrorResponse)
- ✅ Dibuat 7 router stubs (merge, extract, compress, pdf_to_image, image_to_pdf, qr_barcode, insert)
- ✅ Dibuat `backend/utils/file_utils.py`
- ✅ Dibuat design system CSS (Pro-Level dark theme, semua tokens)
- ✅ Dibuat Sidebar component (280px, NavLink active states, badge, logo)
- ✅ Dibuat MainContent layout shell
- ✅ Dibuat 8 page stubs (Merge, Extract, Compress, PDF→Img, Img→PDF, QR, Insert, Settings)
- ✅ Dibuat `src/api/client.ts` + `src/api/config.ts`
- ✅ Dibuat `src/types/index.ts`
- ✅ Dibuat App.tsx (BrowserRouter + all routes + backend status bar)
- ✅ Tauri init → `frontend/src-tauri/` created + `tauri.conf.json` configured
- ✅ Test: Backend `/health` → `{"status":"success"}` ✓
- ✅ Test: Frontend Vite dev server up at localhost:5173 ✓
- ✅ Test: TypeScript tsc --noEmit → zero errors ✓

**Sprint 1 Addendum — Unit Testing:**
- ✅ Dibuat `backend/tests/__init__.py`, `test_health.py`, `test_models.py`, `test_file_utils.py`, `pytest.ini`
- ✅ Dibuat `frontend/src/__tests__/setup.ts`, `Sidebar.test.tsx`, `api-client.test.ts`
- ✅ Diupdate `backend/requirements.txt` & `frontend/package.json` / `vite.config.ts`
- ✅ Test Run Backend: 9/9 passing (`.venv\Scripts\pytest tests/ -v`)
- ✅ Test Run Frontend: 9/9 passing (`npm run test`)

**Bug Ditemukan & Fix:**
| Bug | Root Cause | Fix | File |
|-----|-----------|-----|------|
| PowerShell `&&` not valid | PS uses `;` separator | Changed to `;` chaining | - |
| `uv venv` then activate in one cmd | PS can't chain with `&&` | Used `uv pip install --python .venv\Scripts\python.exe` | - |

**Dokumentasi Diminta:**
- Tidak ada (semua library sudah familiar dari existing installs)

**Next Session (Sprint 2):**
- Implement Merge PDF (backend core `pdf_merge.py` + router + frontend full UI)
- Implement Extract Pages (backend core `pdf_extract.py` + router + frontend full UI)
- Implement Compress PDF (backend core `pdf_compress.py` + router + frontend full UI)
- Test Tauri dev build (`npm run tauri:dev`)


---

### Session 2 — 2026-05-31

**Selesai:**
- ✅ Dibuat `backend/routers/pdf_info.py` — POST /api/v1/pdf-info/ (page count, file size, filename)
- ✅ Registered pdf_info router di `backend/main.py`
- ✅ Dibuat `backend/core/pdf_merge.py` — merge logic dengan PyMuPDF `insert_pdf`, garbage=4, deflate
- ✅ Dibuat `backend/core/pdf_extract.py` — parse page ranges, 4 output modes (combine/separate_page/separate_range/split_all), ZIP via in-memory BytesIO
- ✅ Dibuat `backend/core/pdf_compress.py` — iterate image xrefs, Pillow JPEG re-encode, replace only if smaller
- ✅ Replaced `backend/routers/merge.py` — full FileResponse + custom headers (X-Total-Pages, X-File-Size)
- ✅ Replaced `backend/routers/extract.py` — full FileResponse + X-Pages-Extracted, X-Output-Mode
- ✅ Replaced `backend/routers/compress.py` — full FileResponse + X-Size-Before/After, X-Reduction-Pct
- ✅ Updated `frontend/src/types/index.ts` — MergeResult, ExtractResult, CompressResult, PdfInfoResult
- ✅ Replaced `frontend/src/pages/MergePage.tsx` — multi-file drop zone, reorderable file list (↑↓✕), output name input, blob download, toast notif
- ✅ Replaced `frontend/src/pages/ExtractPage.tsx` — single PDF drop, auto-fetch page count, page range input, 4 output mode radio cards, blob download
- ✅ Replaced `frontend/src/pages/CompressPage.tsx` — drop zone, quality slider (color-coded), Before/After stat cards, images-processed metadata
- ✅ TypeScript tsc --noEmit → 0 errors ✓
- ✅ Backend imports → all OK ✓
- ✅ FastAPI app routes → 15 routes registered ✓
- ✅ pytest 9/9 → still passing ✓

**Bug Ditemukan & Fix:**
| Bug | Root Cause | Fix | File |
|-----|-----------|-----|------|
| PowerShell path prefix `backend\\.venv\\Scripts\\python.exe` fails | PS interprets `backend` as module | Ran from `backend/` directory directly | - |

**Design Decisions:**
- Merge/Extract/Compress return `FileResponse` (binary stream) not JSON — blob handled client-side via `responseType: 'blob'`
- Result metadata passed via custom `X-*` response headers (avoids multipart complexity)
- Compress: skip image if re-encoded bytes ≥ original (never inflate files)
- Extract: in-memory BytesIO for ZIP entries (no extra temp files)

**Dokumentasi Diminta:**
- Tidak ada (PyMuPDF `insert_pdf`, `extract_image`, `update_stream` sudah tercakup dalam pengetahuan yang ada)

**Next Session (Sprint 3):**
- Implement PDF to Image (backend `core/pdf_to_image.py` + router + frontend UI)
  - Output formats: PNG, JPEG, WEBP
  - DPI selection (72, 96, 150, 300)
  - Multi-page → ZIP archive
- Implement Image to PDF (backend `core/image_to_pdf.py` + router + frontend UI)
  - Support JPG, PNG, WEBP, BMP, TIFF
  - Page size options: A4, A3, Letter, Legal
  - Reorderable image list
- Implement QR & Barcode Generator (backend `core/qr_generator.py` + `core/barcode_generator.py` + router + frontend UI)
  - QR: content, size, error correction (L/M/Q/H), format (PNG/SVG)
  - Barcode: code128, ean13, ean8, code39; format PNG/SVG
- Test Tauri dev build (`npm run tauri:dev`)

---

### Session 3 — 2026-05-31

**Selesai:**
- ✅ Dibuat `backend/core/pdf_to_image.py` — convert PDF ke Image via PyMuPDF dan Pillow dengan support format (PNG/JPEG/WEBP) dan DPI, output single image atau ZIP archive via in-memory BytesIO
- ✅ Replaced `backend/routers/pdf_to_image.py` — full FileResponse + custom headers (X-Pages-Exported, X-Format, X-DPI)
- ✅ Dibuat `frontend/src/pages/PdfToImagePage.tsx` — single PDF drop, format & DPI selectors, page ranges input, blob download
- ✅ Dibuat `backend/core/image_to_pdf.py` — convert images to PDF dengan PyMuPDF & Pillow (handling EXIF orientation, a4/a3/letter/legal/match_image)
- ✅ Replaced `backend/routers/image_to_pdf.py` — full FileResponse + custom headers (X-Total-Pages, X-Page-Size)
- ✅ Dibuat `frontend/src/pages/ImageToPdfPage.tsx` — multi-image drop zone dengan image preview grid, reorderable file list (↑↓✕), page size selector
- ✅ Dibuat `backend/core/qr_generator.py` dan `backend/core/barcode_generator.py` — generate PNG / SVG menggunakan `qrcode` dan `python-barcode` (code128, ean13, ean8, code39)
- ✅ Replaced `backend/routers/qr_barcode.py` — endpoint dengan custom headers
- ✅ Dibuat `frontend/src/pages/QrBarcodePage.tsx` — dual tab interface (QR / Barcode), debounce (800ms) live preview generation, realtime validation
- ✅ TypeScript tsc --noEmit → 0 errors ✓
- ✅ Backend imports → all OK ✓
- ✅ pytest 9/9 → still passing ✓

**Bug Ditemukan & Fix:**
| Bug | Root Cause | Fix | File |
|-----|-----------|-----|------|
| SVG API checks for libraries | API details might be tricky | Verified via local runtime scripts (`python -c`) rather than halting | - |
| Blank white screen (app crash) | TS import untuk tipe (`LucideIcon`, dll) tanpa keyword `type` saat `verbatimModuleSyntax` aktif membuat Vite mengkompilasinya sebagai runtime value. | Menambahkan keyword `type` pada import (contoh: `import type { LucideIcon }`) agar dieleminasi saat build oleh esbuild. | `Sidebar.tsx`, `ImageToPdfPage.tsx`, `PdfToImagePage.tsx` |
| Vite error `@import must precede...` | `@import url(...)` untuk Google Fonts diletakkan di bawah `@import "tailwindcss"` di `index.css`. | Memindahkan `@import url(...)` ke baris paling atas di file, sebelum statement apapun. | `index.css` |

**Design Decisions:**
- ImageToPdf: Added EXIF transpose handling via `ImageOps.exif_transpose` so that mobile photos don't appear rotated.
- QrBarcode: Preview menggunakan `dangerouslySetInnerHTML` untuk SVG text payload agar crisp scaling.
- PdfToImage: Excluded alpha channel explicitly ketika export ke format JPEG untuk menghindari Pillow error `cannot write mode RGBA as JPEG`.

**Dokumentasi Diminta:**
- Tidak ada (API sudah diverifikasi via runtime inspection).

**Next Session (Sprint 4):**
- Implement Insert Content (backend `core/insert_content.py` + router + frontend UI)
- Implement Settings Page (Cleanup temp files dll.)

---

### Session 4 — 2026-05-31

**Selesai:**
- ✅ Dibuat `backend/core/insert/insertion_rule.py` — Pydantic model dan validasi target/source pages
- ✅ Dibuat `backend/core/insert/insertion_plan.py` — Double-Pass Index Resolver dengan tracking offset deterministik
- ✅ Dibuat `backend/tests/test_insertion_plan.py` — 6 test cases komprehensif untuk Resolver (Before/After/Replace + multiple rule ordering)
- ✅ Dibuat `backend/core/insert/image_inserter.py` — Eksekutor manipulasi `fitz.Document` dengan insert/replace PDF/Image yang menggunakan `fitz.Rect` calculation + aspect ratio fix
- ✅ Dibuat `backend/routers/insert.py` — Router multipart upload untuk main PDF, source files, dan rules JSON array, diproses via Plan Resolver
- ✅ Dibuat `frontend/src/pages/InsertPage.tsx` — UI Insert Content dengan main document selector, rule builder dengan radio cards, rule list order view, dan execute plan blob downloader
- ✅ Dibuat `backend/routers/settings.py` — API `POST /api/v1/settings/clear-temp` untuk membersihkan temp directory dan output directory
- ✅ Diupdate `backend/main.py` — Register router `insert` dan `settings`
- ✅ Dibuat `frontend/src/pages/SettingsPage.tsx` — Settings page dengan output directory input, backend latency tester, dan clear temp trigger button
- ✅ Test: pytest run berhasil 15/15 passing (termasuk 6 resolver tests) ✓
- ✅ Test: tsc dan vite build berhasil (0 errors) ✓

**Bug Ditemukan & Fix:**
| Bug | Root Cause | Fix | File |
|-----|-----------|-----|------|
| `target_page` overlap dengan `InsertMode.AFTER` issue di backend test | Kalkulasi boolean flags salah | Memperbaiki kondisi `prev.target_page < rule.target_page` menjadi eksklusif untuk menghindari increment ganda saat index sama. | `insertion_plan.py` |

**Design Decisions:**
- **Double-Pass Resolver:** Algoritma offset dipecah dari logic core PyMuPDF. Memudahkan unit test murni via Pydantic model dan index simulation tanpa perlu mock PDF object.
- **Image Size Calculation:** PyMuPDF membuka gambar dummy document (`fitz.open("image.png")`) dan kita mencocokkan size rectangle dengan `ref_rect` target document lalu menerapkan scale proportion agar aspect ratio terjaga tanpa distortion.
- **File Management:** Insert POST route menerima source items array list dan rules me-reference ID index tersebut secara dinamis.

**Dokumentasi Diminta:**
- Tidak ada (semua function telah menggunakan documentation script verification manual di terminal).

**Next Session (Sprint 5a & 5b):**
- ✅ Implement Split-Layout UI (Controls Left, Preview Right)
- ✅ Dedicated Preview Panel (`PreviewPanel.tsx`)
- ✅ Zoom and Navigation controls via CSS transforms
- ✅ PDF to Image layout refactor and thumbnail strip
- ✅ Image to PDF layout refactor and rotation state management
- ✅ Insert Content dialog rules mapped to PreviewPanel
- Final Polish & Tauri Configuration (native dialog integrations, custom titlebars)
- Tauri Build Production
- Output Cleanup worker

---

### Session 5b — 2026-05-31

**Selesai:**
- ✅ Diimplementasikan shared UI untuk preview panel: `ThumbnailStrip.tsx`, `PageNavigation.tsx`, `ZoomControl.tsx`, dll.
- ✅ Refactor `ExtractPage.tsx` ke dalam split layout `feature-split-layout` (CONTROLS kiri, PREVIEW kanan).
- ✅ Memindahkan `ThumbnailStrip` ke area atas pada halaman `Extract Pages`, `PDF to Image`, dan `Image to PDF` untuk memudahkan navigasi tanpa harus scroll.
- ✅ Mengecilkan ukuran vertikal Drop Zone (kotak unggah file) agar tidak memakan terlalu banyak ruang pada layar.
- ✅ Refactor `PdfToImagePage.tsx` dengan integrasi `PreviewPanel` dan `ThumbnailStrip` untuk memilih halaman individu dengan thumbnail visual.
- ✅ Refactor `ImageToPdfPage.tsx` menggunakan layout split. Preview di sebelah kanan kini dapat diputar (rotasi CSS transform) dan menyesuaikan file aktif.
- ✅ Refactor `InsertPage.tsx` dengan popup `Add Rule` dan preview yang sesuai dengan konteks `dialogSourceFile` maupun `Main PDF`.
- ✅ Memperbaiki styling overlap UI (`.feature-controls`) dengan menambah `gap` dan `overflow-y`.
- ✅ Mengubah dialog Add Rule pada `InsertPage.tsx` agar lebih lebar (`75vw`, max 900px).
- ✅ Mengimplementasikan fungsi **Flip Horizontal** (`flipH`) pada `ImageToPdfPage` dan `InsertPage` (Preview panel dan Pydantic model `backend`).
- ✅ TypeScript `tsc --noEmit` build passed 0 errors.
- ✅ Pytest unit tests 15/15 still passing.
- ✅ Vite `npm run build` sukses.

**Bug Ditemukan & Fix:**
| Bug | Root Cause | Fix | File |
|-----|-----------|-----|------|
| `export *` invalid character | PowerShell command `echo "..." >> file` secara default mengeluarkan UTF-16LE / menambah BOM sehingga tsc error TS1127. | Diformat ulang menggunakan write_to_file secara langsung sebagai UTF-8. | `src/components/preview/index.ts` |

**Design Decisions:**
- Digunakan `ThumbnailStrip` sebagai slot bawah dari `PreviewPanel` di PDF to Image agar layout tetap konsisten dan menyediakan multi-select visual (toggle checkbox).
- Preview zoom 100% selalu disesuaikan melalui transform `scale()` dengan `transformOrigin: top center`.

**Dokumentasi Diminta:**
- Tidak ada (dokumentasi PyMuPDF untuk get_pixmap endpoint sudah tersedia dari sesi sebelumnya).

**Next Session (Sprint 6):**
- Konfigurasi final Tauri untuk production build (rustc).
- Penggunaan native dialog / Tauri OS file APIs apabila diperlukan.

---

### Session 6 — 2026-05-31

**Selesai:**
- ✅ TASK 6.1: Panel Toggle — dibuat `usePanelToggle.ts` hook, `PanelToggle.tsx` component
  - ✅ Diintegrasikan ke `ExtractPage.tsx` (sebelumnya), `PdfToImagePage.tsx`, `ImageToPdfPage.tsx`, `InsertPage.tsx`
  - Border-style toggle di kanan controls + Corner-style toggle di preview header
  - CSS `.controls-hidden` dengan width/opacity transition di `index.css`
- ✅ TASK 6.2: Tauri Native File Dialog
  - ✅ `npm install @tauri-apps/plugin-dialog`
  - ✅ Ditambahkan `tauri-plugin-dialog = "2"` di `Cargo.toml`
  - ✅ Registered `tauri_plugin_dialog::init()` di `lib.rs`
  - ✅ Permissions: `dialog:allow-open`, `dialog:allow-save`, dll di `capabilities/default.json`
  - ✅ Dibuat `frontend/src/utils/tauriDialog.ts` — `isTauri()`, `openFilePicker()`, `saveFilePicker()` dengan graceful browser fallback
  - ✅ Diintegrasikan `handleBrowseOutput()` ke `SettingsPage.tsx` dengan `isTauri()` guard
- ✅ TASK 6.3: Python Sidecar Setup
  - ✅ Dibuat `docs/tauri_sidecar.md` — dokumentasi PyInstaller + Tauri v2 sidecar naming convention
  - ✅ Dibuat `backend/build.spec` — PyInstaller spec dengan semua hidden imports
  - ✅ `npm install @tauri-apps/plugin-shell` + `tauri-plugin-shell = "2"` di Cargo.toml
  - ✅ Updated `lib.rs` — spawns sidecar di `else {}` (production only, tidak di debug)
  - ✅ `tauri.conf.json` → `externalBin: ["binaries/pdf-manager-backend"]`
  - ✅ Dibuat `frontend/src-tauri/binaries/` directory
  - ✅ Permissions: `shell:allow-execute`, `shell:allow-spawn`
- ✅ TASK 6.4: Splash Screen & Health Polling
  - ✅ Dibuat `frontend/src/components/SplashScreen.tsx`
    - Animated floating logo (CSS keyframes)
    - Progress bar 0→90% logarithmic fake + jumps to 100% on `/health` success
    - Poll interval: 500ms, timeout: 30 seconds
    - Error state dengan Retry + Continue Anyway buttons
  - ✅ Updated `App.tsx` — `AppState` type, splash gated by `isTauri()`
  - Dev mode: splash skipped instantly
  - Tauri mode: splash shows until sidecar health check passes
- ✅ TASK 6.5: App Branding
  - ✅ `tauri.conf.json` — window title, minWidth 960, minHeight 640
  - ✅ Bundle metadata: copyright, category, shortDescription, longDescription
  - ✅ NSIS: `installMode: currentUser`
- ✅ TASK 6.6: Vite Production Build
  - ✅ `npm run build` → 1834 modules, 417KB bundle, 513ms
  - ✅ `tsc --noEmit` → 0 errors
  - ✅ `pytest 15/15` → still passing

**Bug Ditemukan & Fix:**
| Bug | Root Cause | Fix | File |
|-----|-----------|-----|------|
| Duplicate App component code | `replace_file_content` replaced only the TargetContent portion and left the rest of the old code | Removed stale duplicate block manually | `App.tsx` |
| Stray `;
}` at EOF | Previous cleanup left partial chars | Re-replaced line range | `App.tsx` |

**Design Decisions:**
- **Sidecar gated to production**: `#[cfg(debug_assertions)]` in Rust ensures sidecar only spawns in `tauri build` output, not `tauri dev`.
- **SplashScreen skipped in browser**: `isTauri()` check via `__TAURI_INTERNALS__` at call time prevents splash in dev.
- **PanelToggle positioning**: Border button uses absolute positioning on the control panel edge; Corner button uses absolute in preview header, both track `controlsVisible` state from same hook instance.

**Dokumentasi Dibuat:**
- `docs/tauri_sidecar.md` — PyInstaller hidden imports, naming convention, Rust spawn code, known issues

**Next Session (Sprint 7 — Production Packaging):**
- Install PyInstaller: `.venv\Scripts\pip install pyinstaller`
- Build sidecar exe: `.venv\Scripts\pyinstaller build.spec`
- Copy to `frontend/src-tauri/binaries/pdf-manager-backend-x86_64-pc-windows-msvc.exe`
- Run `npm run tauri:build` (full Rust + frontend build)
- Test the `.msi` / `.exe` installer
- Code signing (optional, for distribution without Defender alerts)

---

### Session 7 — 2026-05-31

**Selesai:**
- ✅ TASK 7.1: PyInstaller Sidecar Build
  - Diinstal `pyinstaller` versi 6.20.0 via `uv pip` di `.venv`
  - Hasil executable `backend/dist/pdf-manager-backend.exe` berhasil dibuild (ukuran: 40.2 MB)
  - Test executable standalone: `HEALTH OK` berjalan normal di port 8000
- ✅ TASK 7.2: Copy Sidecar ke Tauri
  - Target triple dideteksi sebagai `x86_64-pc-windows-msvc`
  - Sidecar dicopy ke `frontend/src-tauri/binaries/pdf-manager-backend-x86_64-pc-windows-msvc.exe`
- ✅ TASK 7.3: Tauri Production Build
  - Memperbaiki `tauri.conf.json`: menghapus `allowDowngrades: false` dari `windows.nsis` yang tidak sesuai schema
  - Build sukses via `npm run tauri build`
  - Output MSI (`PDF Manager_2.0.0_x64_en-US.msi`): 43.6 MB
  - Output EXE (`PDF Manager_2.0.0_x64-setup.exe`): 42.5 MB
- ✅ TASK 7.4: End-to-End Installer Test
  - Install mode (`currentUser`) silent test: sukses, file terekstrak ke `%LOCALAPPDATA%\PDF Manager\` beserta sidecar
  - Silent uninstall test: sukses membersihkan seluruh folder
- ✅ TASK 7.5: Distribution Package Preparation
  - Dibuat folder `dist-package/`
  - Dibuat `README.txt` (instruksi awam) dan `CHANGELOG.txt`
  - Installer `PDF Manager_2.0.0_x64-setup.exe` telah dicopy ke `dist-package/`
- ✅ TASK 7.6: GitHub Repository Setup
  - Dibuat root `.gitignore` untuk backend, node_modules, Rust targets, & binaries
  - Dibuat `README.md` repositori yang proper dengan emoji & instruksi build/install lengkap
- ✅ TASK 7.7: Fix Backend Offline di Production Build
  - **Diagnosis:** Sidecar ada di folder instalasi, spawn berhasil (PID assigned), tapi crash instant
  - **Error:** `ERROR: Error loading ASGI app. Could not import module "main"`
  - **Root Cause (CASE C):** Uvicorn dipanggil dengan string `"main:app"`. Di PyInstaller frozen exe, `importlib.import_module("main")` gagal karena tidak ada filesystem module Python normal — semua module ter-archive di dalam `.pkg` internal PyInstaller
  - **Fix:** Deteksi `sys.frozen` flag (di-set otomatis oleh PyInstaller). Jika `frozen=True` → pass `app` object langsung ke `uvicorn.run()`. Jika `False` (dev mode) → tetap pakai string `"main:app"`
  - **Verifikasi:** Standalone test sidecar baru → `HEALTH OK` ✅ sebelum di-copy ke Tauri
  - Rebuild PyInstaller + Tauri → installer baru dicopy ke `dist-package/`

**Bug Ditemukan & Fix:**
| Bug | Root Cause | Fix | File |
|-----|-----------|-----|------|
| Tauri NSIS config error | `allowDowngrades` bukan properti valid dalam schema Tauri v2 untuk bagian `bundle > windows > nsis` | Menghapus `allowDowngrades: false` | `tauri.conf.json` |
| Frontend CORS blocked (http://tauri.localhost) | Tauri v2 production mode menggunakan origin `http://tauri.localhost` tapi tidak ada di CORS_ORIGINS | Menambahkan `"http://tauri.localhost"` ke list | `backend/config.py` |
| Sidecar crash: `Could not import module "main"` | Uvicorn dipanggil dengan string `"main:app"` — di PyInstaller frozen exe, `importlib.import_module("main")` gagal karena module system berbeda dari CPython normal | Deteksi `sys.frozen` flag, jika True → pass `app` object langsung ke `uvicorn.run()`, bukan string | `backend/main.py` |

**Known Issues:**
- `app.exe` dan `uninstall.exe` belum menggunakan code signing (sertifikat), sehingga akan selalu memunculkan Windows SmartScreen popup pada instalasi pertama kali.

**Next Session:**
- Verifikasi end-to-end post-install dari installer terbaru (Task 7.7 fix)
- Jika semua fitur pass → DONE, aplikasi siap didistribusikan

---

### Session 7b — 2026-06-03

**Selesai:**
- ✅ TASK 7b.1A: Hapus PanelToggle dari semua feature pages (Extract, PdfToImage, ImageToPdf, Insert)
- ✅ TASK 7b.1B: Sidebar collapse — state `collapsed` (boolean) via `localStorage` key `sidebar_collapsed`
  - Toggle button: `ChevronLeft` / `ChevronRight` di bagian bawah sidebar
  - Collapsed width: 64px, Expanded: 280px, transisi 200ms ease
  - CSS: `.sidebar.expanded`, `.sidebar.collapsed`, `.nav-item-collapsed`, `.sidebar-collapse-btn`
- ✅ TASK 7b.1C: Cleanup — hapus `usePanelToggle.ts`, `PanelToggle.tsx`, update `preview/index.ts`
- ✅ TASK 7b.2: Post-download notification — `addToast('success', 'Download started', ...)` setelah `a.click()` di semua 10 halaman:
  - MergePage, ExtractPage, CompressPage, PdfToImagePage, ImageToPdfPage, InsertPage, OrganizePage, MetadataPage, ProtectPage, QrBarcodePage
- ✅ TASK 7b.3: Output filename input — state + UI `<input>` di semua halaman output:
  - ExtractPage: `outputFilename`, default `'extracted'`, dikirim ke backend via formData
  - CompressPage: `outputFilename`, default `compressed_{original_name}`
  - PdfToImagePage: `outputFilename`, default `{stem_pdf}` (tanpa `.pdf`)
  - InsertPage: `outputFilename`, default `inserted_{original_name}`
  - OrganizePage: `outputFilename`, default `organized_{original_name}`
- ✅ TASK 7b.4A: OrganizePage thumbnail grid — `minmax(140px)` → `minmax(160px)`, thumb `80px` → `110px`, DPI `36` → `48`
- ✅ TASK 7b.4B: Drag & drop OrganizePage — verified existing implementation sudah correct (index swap via `dragFrom` / `dragOver` state)
- ✅ tsc --noEmit → 0 errors (dua kali — mid-session & final)

**Bug Ditemukan & Fix:**
| Bug | Root Cause | Fix | File |
|-----|-----------|-----|------|
| QrBarcodePage download handler rusak | SVG URL revoke block `if (previewData.isSvgText)` hilang saat `TargetContent` tidak presisi | Re-apply block di posisi yang benar setelah `addToast` | `QrBarcodePage.tsx` |
| OrganizePage thumbnail pipih / terpotong | Komponen `PdfThumbnail` menggunakan `objectFit: 'cover'` dan container tidak memiliki `height` eksplisit sehingga fallback ke square kecil | Ubah `objectFit` menjadi `'contain'` dan beri `height: 360` secara eksplisit agar proporsional | `OrganizePage.tsx`, `PdfThumbnail.tsx` |
| Output result info selalu `0 pages · 0 B` di semua halaman | Wildcard `expose_headers=["*"]` di CORS diabaikan oleh browser jika `allow_credentials=True` | Ganti wildcard dengan array eksplisit berisi semua custom header `X-*` yang dipakai API | `backend/main.py` |
| Frontend tidak mendeteksi perbaikan backend | `apiClient` secara default nembak port `8000`, tapi port 8000 tersangkut process lama (zombie PID) sehingga dev menjalankan uvicorn di port 8001 | Kill paksa zombie process port 8000 via terminal `taskkill` lalu jalankan uvicorn kembali di 8000 | Terminal |

**Design Decisions:**
- Sidebar collapse menggunakan `collapsed` boolean state + CSS class `sidebar.expanded` / `sidebar.collapsed` yang mengontrol `width` dan `min-width` via Tailwind-like specificity. Transisi smooth 200ms.
- Post-download toast menggunakan infra `addToast` yang sudah ada di setiap halaman — tidak dibuat global hook untuk menghindari refactor besar (scope Session 8).
- Output filename disimpan sebagai state React, auto-populated dari nama file original saat file dimuat, dan bisa diedit user.

**Next Session (Session 8):**
- Bug 5: Performa (progress bar backend real-time via SSE atau polling)
- Bug 6: Insert Content — fix image preview di dialog Add Rule
- Pertimbangkan refactor toast ke hook global `useToast` + `<ToastContainer>` di App.tsx

---

### Session 8 — 2026-06-03

**Selesai:**
- ✅ TASK 8.1: Global Toast Refactor
  - Dibuat `ToastContext` dan `ToastProvider` sebagai global state manager.
  - Semua halaman (`MergePage`, `ExtractPage`, dll.) direfaktor untuk menggunakan `useToast` alih-alih local state.
  - Fix styling & import errors dari refactor massal.
- ✅ TASK 8.2: Global File State
  - Dibuat `FileContext` dengan batas memori maksimum 100MB dan LRU eviction ringan.
  - Dibuat `useFeatureFile` hook yang mengelola state drop file tanpa kehilangan data saat pindah halaman.
  - Direfaktor seluruh halaman untuk mempertahankan state drop file.
- ✅ TASK 8.3: Performance Preview File Besar
  - Dibuat `backend/routers/preview.py` untuk logic preview terpisah dengan fitur adaptive resolution (`quality_hint` + max dimensi 1024/2048/4096px).
  - Frontend `PdfThumbnail` dan `PreviewCanvas` menggunakan `AbortController` untuk membatalkan request usang secara instan, mencegah penumpukan request dan race conditions saat navigasi cepat.
  - Ditambahkan peringatan "Large file detected" jika ukuran melebihi 50MB.
- ✅ TASK 8.4: Insert Content Bug Fix + Tests
  - Dibuat 1 unit test end-to-end `test_replace_offset_bug` dalam `test_insert_execution.py`.
  - Fix Bug 6: Mengupdate logic offset tracking di `insertion_plan.py` agar rule `AFTER` dapat menyesuaikan offset jika didahului rule `REPLACE` pada halaman yang sama.
  - Fix AttributeError: Mengganti method lama `doc.insert_page` yang me-return tipe integer (index) menjadi `doc.new_page(pno=...)` yang dengan benar me-return `fitz.Page` object di `image_inserter.py`.

**Bug Ditemukan & Fix:**
| Bug | Root Cause | Fix | File |
|-----|-----------|-----|------|
| "Preview Unavailable" pada semua dokumen | `FormData.append('file', file as Blob)` tanpa nama file menyebabkan browser mengirim nama "blob". Validasi `.pdf` di backend menolaknya dengan HTTP 400. | Menambahkan parameter `filename` eksplisit di `form.append`: `file.name || 'preview.pdf'`. | `PreviewCanvas.tsx`, `PdfThumbnail.tsx` |
| File kecil makin besar saat dikompres | Save PyMuPDF dengan deflate/garbage bisa menambah overhead struktur PDF jika file asli sangat kecil dan tidak ada gambar yang dikompres | Tambahkan pengecekan ukuran; jika `size_after >= size_before`, copy file asli sebagai hasil dan set `reduction = 0`. | `pdf_compress.py` |
| Background hilang di PDF to Image (PNG) | PyMuPDF merender dengan `alpha=True`, sehingga area kertas yang tidak ada warna eksplisit menjadi transparan | Matikan alpha channel secara paksa (`alpha=False`) agar PyMuPDF menggunakan latar putih. | `pdf_to_image.py` |
| Icon aksi terlalu kecil di Organize | Atribut ukuran UI button disetel sangat kecil (20px) | Memperbesar ukuran button menjadi 28px, icon ke 16px, dan gap lebih lebar. | `OrganizePage.tsx` |
| Metadata success (pages, size) selalu 0 | CORS middleware hanya menambahkan `Access-Control-Expose-Headers` jika `Origin` request cocok dengan `allow_origins`. Tauri webview bisa mengirim origin yang tidak dikenali sehingga header X-* tidak ter-expose ke browser/axios. | Ditambahkan `@app.middleware("http")` di `main.py` yang selalu menambahkan `Access-Control-Expose-Headers` ke setiap response sebagai safety net. Juga perbaiki fallback di `OrganizePage` agar gunakan `blob.size`. | `main.py`, `OrganizePage.tsx` |

**Next Task:**
- (TBD) Lanjut ke fitur baru atau release candidate.


---

### Session 9a — 2026-06-13

**Selesai:**
- ✅ TASK 9a.1: Output Filename Sanitization
  - Dibuat `sanitize_filename()` di `backend/utils/file_utils.py` — strips illegal chars, removes UUID collision suffix
  - Refaktor semua core modules (`pdf_merge.py`, `pdf_compress.py`, `pdf_extract.py`, `pdf_protect.py`, `pdf_organize.py`) untuk memakai `sanitize_filename`
  - Semua router (`merge.py`, `compress.py`, `extract.py`, `insert.py`, `protect.py`, `organize.py`) menambahkan header `Content-Disposition: attachment; filename="..."`
  - Unit tests: 15 tests baru di `test_output_filename.py` (31/31 total passing)
  - Dibuat `frontend/src/utils/downloadHelper.ts` — `triggerBlobDownload()` dan `getFilenameFromHeaders()`
  - Dibuat `openOutputFolder()` di `frontend/src/utils/tauriDialog.ts`
- ✅ TASK 9a.2: Single-Step Download Flow (Merge, Compress, Organize, Protect)
  - Semua page diatas: "Execute" + "Download" digabung menjadi satu tombol → auto-download setelah proses selesai
  - Result card: ganti tombol "Download" menjadi "Open Folder" (ghost button)
  - Toast success includes `action: { label: 'Open Folder', onClick: openOutputFolder }` dan `duration: 8000`
  - CompressPage: menghapus flow SSE streaming yang broken (`/api/v1/compress/stream` tidak pernah ada) → diganti dengan call langsung ke `/api/v1/compress/`
- ✅ TASK 9a.3: Organize Pages Reset
  - Menambahkan state `originalPages` — disimpan saat PDF dimuat pertama kali
  - Reset button (`RefreshCw` icon) di action bar — disabled jika urutan sama dengan original
  - `isResetDisabled` computed dari string-comparison ID array
- ✅ TASK 9a.4: Barcode Generator Fix
  - `buf.seek(0)` ditambahkan SEBELUM `buf.read()` di `barcode_generator.py` — ImageWriter meninggalkan stream position di EOF setelah `bc.write(buf)`, menyebabkan output kosong
  - Parameter `format` diubah menjadi `out_format` agar tidak shadow Python builtin
  - EAN-13/EAN-8 validation ditingkatkan: memakai `content.strip()` sebelum validasi
  - Router `qr_barcode.py` diupdate untuk memakai parameter `out_format`
- ✅ TASK 9a.5: Compress CMYK Fix
  - `pdf_compress.py`: konversi gambar CMYK ke RGB sebelum re-encode ke JPEG
- ✅ TASK 9a.6: Password Protection Revamp
  - Backend: Ditambahkan `POST /api/v1/protect/remove` endpoint di `protect.py`
    - Menerima file + user_pw, authenticates via `doc.authenticate()`, saves without encryption (`PDF_ENCRYPT_NONE`)
    - Returns 422 jika PDF tidak terenkripsi atau password salah
  - Backend `/protect/` endpoint: pre-check `doc.is_encrypted` untuk menolak double-encryption dengan 422 + pesan jelas
  - Frontend `ProtectPage.tsx`: complete rewrite dengan dual-tab interface ("Add Password" / "Remove Password")
    - Show/hide password toggles (Eye/EyeOff icons) untuk semua password fields
    - Single-step auto-download pada kedua mode
    - Toast dengan Open Folder action
- ✅ TASK 9a.7: Open Folder Button Fix
  - Backend API `POST /api/v1/settings/open-downloads` direfactor: mengganti `os.startfile` dengan `subprocess.Popen(['explorer', path])`
  - Tauri plugin-opener yang terbatas hak aksesnya diganti dengan fallback ke API backend tersebut
- ✅ TASK 9a.8: Organize Drag & Drop Revamp
  - Halaman `OrganizePage.tsx` di-rewrite total menggunakan pustaka `@dnd-kit/core` & `@dnd-kit/sortable`
  - Masalah *Prohibited Cursor* (Native HTML5 drag collision) berhasil dieliminasi
  - UI Drag Handle dibuat lebih besar, menonjol (dengan warna accent), dan event `drag` hanya dipicu dari handle tersebut (thumbnail dibuat *pointer-events: none*)
- ✅ tsc --noEmit → 0 errors ✓
- ✅ pytest 31/31 → still passing ✓

**Bug Ditemukan & Fix:**
| Bug | Root Cause | Fix | File |
|-----|-----------|-----|------|
| Compress SSE endpoint tidak ada | CompressPage memanggil `/api/v1/compress/stream` yang tidak pernah diimplementasikan di backend | Ganti dengan direct call ke `/api/v1/compress/` yang sudah ada | `CompressPage.tsx` |
| Barcode PNG selalu kosong | `bc.write(buf)` meninggalkan posisi stream di EOF; `buf.getvalue()` membutuhkan seek(0) sebelumnya | Tambahkan `buf.seek(0)` setelah write, gunakan `buf.read()` | `barcode_generator.py` |
| Double encryption tidak ditolak | Protect endpoint tidak memeriksa apakah PDF sudah terenkripsi | Pre-check `doc.is_encrypted` sebelum proses, raise 422 jika ya | `routers/protect.py` |
| useEffect setelah return | `useEffect` ditempatkan setelah `return` statement di `CompressPage` — dead code | Dihapus (sudah tidak diperlukan setelah refactor) | `CompressPage.tsx` |
| Open Folder tidak memicu explorer di mode packaged | `os.startfile` diblokir oleh isolasi Windows saat berjalan sebagai subprocess packaged Tauri | Ganti menjadi `subprocess.Popen(['explorer', path])` | `backend/routers/settings.py` |
| Kursor Prohibited saat Drag Page | HTML5 Native `draggable` bertabrakan dengan event pointer pada elemen `<img>` di browser internal Tauri | Ganti seluruh arsitektur drag and drop menggunakan pustaka `@dnd-kit/core` | `frontend/src/pages/OrganizePage.tsx` |

**Design Decisions:**
- **Single-step pattern**: semua halaman menggunakan `triggerBlobDownload()` + toast `action` button (Open Folder) sebagai pengganti 2-step Execute+Download.
- **Protect tab mode**: menggunakan React state `mode: 'add' | 'remove'` alih-alih routing terpisah — menjaga file selection context tidak hilang saat ganti mode.
- **buf.seek(0)**: dibutuhkan khusus untuk `ImageWriter` dari python-barcode. `SVGWriter` menggunakan `getvalue()` berbasis string, tapi `ImageWriter` menggunakan binary stream yang posisinya tidak auto-reset.
- **Dnd-Kit over HTML5 Native**: Pustaka `@dnd-kit` dipilih untuk halaman Organize karena memberikan kontrol penuh terhadap event drag, mendukung overlay animasi kustom, dan memisahkan *drag handle* dari area konten secara bersih tanpa anomali bawaan browser.

### Session 9b — 2026-06-13

**Selesai:**
- ✅ TASK 9b.1: UI Symmetry Fix (Split Layout)
  - Diperbarui `frontend/src/index.css` agar proporsi layout `.feature-controls` vs `.feature-preview` lebih seimbang (420px fixed kiri).
  - Elemen form `.card`, `input`, `button.primary`, dan `select` di-set ke full-width.
  - Ditambahkan responsive media query untuk viewport <= 860px (stacked).
- ✅ TASK 9b.2: Edit Metadata - Hapus Output Filename
  - Frontend `MetadataPage.tsx` diubah dengan menghapus state dan input `outputFilename`.
  - Backend `metadata.py` direfaktor untuk otomatis meng-generate output filename aman (`sanitize_filename`) dari judul (`Title`) atau default name file original jika kosong.

- ✅ TASK 9b.3: Insert Content - Source PDF Preview & Range
  - Ditambahkan dukungan "All Pages" (string kosong) pada model rule backend `InsertionRule`.
  - Dimodifikasi `InsertionPlan` dan `ImageInserter` untuk menerima total pages ketika source_pages kosong.
  - Frontend `InsertPage.tsx` direfaktor agar `PreviewPanel` digunakan dalam dialog Source PDF beserta radio buttons "All Pages" vs "Custom Range".

- ✅ TASK 9b.4: Merge PDF - Page Count Info
  - Ditambahkan state `pages` pada `FileEntry` di `MergePage.tsx`.
  - Dimodifikasi `addFiles` untuk melakukan request `/api/v1/pdf-info/` ke masing-masing file setelah didrop.
  - Ditampilkan badge info berisi page count di list file merge.

- ✅ TASK 9b.5: Extract Pages - ZIP Naming & Range Error Message
  - Backend `pdf_extract.py` direfaktor untuk menerima `out_name` spesifik tanpa me-hardcode `_extracted`.
  - Backend `extract.py` diperbarui untuk memberikan `out_name` dengan memanggil `sanitize_filename` menggunakan ekstensi yang tepat.
  - Frontend `client.ts` interceptor diperbarui untuk memparsing JSON exception detail dari dalam respon Blob, sehingga pesan error detail tampil di Toast.

- ✅ TASK 9b.6: Password Protection - Permission Checkboxes
  - Ditambahkan dukungan `allow_print`, `allow_copy`, dan `allow_modify` di backend `core/pdf_protect.py` untuk mengkalkulasi PyMuPDF permission flag.
  - Ditambahkan form checkbox pada `frontend/src/pages/ProtectPage.tsx` di mode Add Password untuk print, copy, dan modify.
  
- ✅ TASK 9b.7: Settings/About - Update halaman About dengan info aplikasi yang akurat.
  - Diperbarui `SettingsPage.tsx` pada bagian About untuk menampilkan "1.0.0 (Production Candidate)" beserta update pada list fitur dan tech stack.
- ✅ TASK 9b.8: Compress PDF - Fix "Insufficient data" & Loading Bar
  - Mengupdate dictionary PyMuPDF xref untuk `/DCTDecode` agar Adobe Reader tidak error setelah stream image diganti JPEG.
  - Mengembalikan SSE (Server-Sent Events) untuk Compress PDF dan menambahkan UI komponen *Progress Bar* (page/total, persentase) saat menunggu kompresi berjalan.

**Status Sesi 9b: Semua Task selesai. Aplikasi siap untuk build production (RC1)**.

### Session 9c — 2026-06-15 (UAT Bug Fixes)

**Selesai:**
- ✅ Fix Bug: Compress PDF "Insufficient data" & Blank Page
  - Mengubah cara re-insersi gambar menggunakan API bawaan `page.replace_image(xref)` alih-alih memanipulasi low-level `xref_set_key` `/Filter` secara manual.
  - Menambahkan tracking `processed_xrefs` di `pdf_compress.py` agar backend tidak me-re-encode stream xref gambar berulang-ulang untuk duplikat gambar.
- ✅ Fix Bug: UI Alignment Radio Buttons di Menu Extract, PdfToImage, dan ImageToPdf
  - Menyelaraskan alignment vertikal dari radio button pada kotak opsi (menggunakan `align-items: flex-start` ditambah `padding-top: 1px`).
  - Menambahkan `height: 100%` agar seluruh card seimbang tingginya pada grid layout.
- ✅ Fix Bug: Posisi Scrollbar terlalu dekat dengan form area konten
  - Menambahkan `padding-right: 16px` pada `.feature-controls` di `index.css`.
  - Memberikan style scrollbar yang *thin* dan *outline-variant* (elegan/tipis) agar lebih estetik dan tidak memakan banyak tempat.
- ✅ Fix Bug: Extract Pages & PDF to Image UUID pada nama ZIP/File
  - Menghapus UUID dari file ZIP dan file individual yang diekstrak dengan memparsing `clean_name` asli dari file upload agar output lebih profesional dan rapi.
- ✅ Fix Bug: QR Code SVG Preview Blank
  - Menghapus tag deklarasi prolog XML (`<?xml ...>`) dari string kembalian API SVG sebelum ditampilkan di komponen UI `dangerouslySetInnerHTML` agar terbaca sempurna oleh browser.
- ✅ Enhancement: Barcode EAN-13 & EAN-8 Info
  - Menambahkan info text peringatan *checksum digit otomatis* (digit ke-13/8) agar user tidak menganggap penambahan 1 digit kalkulasi otomatis sebagai bug.
- ✅ Tauri Relocation Installers
  - Otomatisasi pemindahan file installer terbaru (`.exe` dan `.msi`) yang di-build melalui `npm run tauri build` ke folder rilis `dist-package/`.
- ✅ Fix Bug: Sidecar Rebuild Flow
  - **Akar masalah:** Fix Python sebelumnya tidak masuk ke installer Tauri karena *PyInstaller sidecar* tidak di-rebuild ulang. App terus memakai `pdf-manager-backend.exe` lama yang ada di folder `binaries/`.
  - **Solusi:** Menjalankan `pyinstaller build.spec` terlebih dahulu untuk menghasilkan sidecar Python terbaru, kemudian menyalinnya ke `frontend/src-tauri/binaries/` sebelum melakukan `npm run tauri build`. Menambahkan alur standar ini ke dokumentasi/log.

---

### Session 9d — 2026-06-15 (Auto Cleanup on Exit)

**Selesai:**
- ✅ TASK 9d.1: FastAPI Lifespan Cleanup (Layer 1 — Startup + Shutdown)
  - Ditambahkan `_clean_directory()` helper dan `@asynccontextmanager lifespan` ke `backend/main.py`.
  - **STARTUP:** Membersihkan seluruh isi `TEMP_DIR` saat sidecar pertama kali start (menghapus sisa file upload dari sesi sebelumnya jika app di-force-quit).
  - **SHUTDOWN:** Membersihkan `TEMP_DIR` + `OUTPUT_DIR` saat uvicorn menerima sinyal shutdown gracefully.
  - `OUTPUT_DIR` sengaja *tidak* dibersihkan saat startup — user mungkin belum sempat download file dari sesi sebelumnya.
- ✅ TASK 9d.2: Tauri Graceful Exit Hook (Layer 2)
  - Diupdate `frontend/src-tauri/src/lib.rs` pada `RunEvent::Exit`.
  - Sebelum kill sidecar, Tauri menjalankan `curl -X POST .../clear-temp` (best-effort, timeout 3s) untuk memberi uvicorn waktu menjalankan shutdown lifecycle.
  - Setelah 500ms sleep, sidecar di-kill secara paksa sebagai safety net.
  - Blok curl hanya aktif di production build (`#[cfg(not(debug_assertions))]`).
- ✅ Verifikasi: pytest 31/31 still passing ✓

**Design Decisions:**
- **Startup cleanup temp only (bukan output):** Temp upload files tidak pernah bernilai bagi user — aman dihapus langsung. Output files adalah hasil kerja user yang belum tentu sudah di-download — lebih aman dibersihkan hanya saat shutdown.
- **curl dipilih vs reqwest:** Menghindari tambahan Rust dependency (`reqwest`) hanya untuk satu HTTP call. `curl` tersedia di Windows 10+ secara default.
- **Best-effort, tidak blocking:** Jika curl gagal (backend sudah mati), Tauri tetap lanjut kill process dan exit normal. Tidak ada blocking yang membuat UI hang.

**Alur Build Standard (WAJIB diikuti setiap ada perubahan Python):**
```powershell
# Step 1 — Rebuild Python sidecar
cd backend
.venv\Scripts\pyinstaller build.spec --noconfirm

# Step 2 — Copy sidecar ke binaries/
Copy-Item dist\pdf-manager-backend.exe ..\frontend\src-tauri\binaries\pdf-manager-backend-x86_64-pc-windows-msvc.exe -Force

# Step 3 — Rebuild Tauri installer
cd ..\frontend
npm run tauri build

# Step 4 — Pindahkan installer ke dist-package/
Move-Item src-tauri\target\release\bundle\nsis\*.exe ..\dist-package -Force
Move-Item src-tauri\target\release\bundle\msi\*.msi ..\dist-package -Force
```

---

### Session 9e — 2026-06-15 (Feature Polish)

**Selesai:**
- ✅ TASK 9e.1: Rename "Extract Pages" → "Split PDF"
  - Sidebar label di `Sidebar.tsx` diubah dari `'Extract Pages'` menjadi `'Split PDF'`.
  - Page title `<h1>` di `ExtractPage.tsx` diperbarui menjadi `'Split PDF'` dengan subtitle yang lebih akurat.
- ✅ TASK 9e.2: QR Code & Barcode — Output Filename & Open Folder
  - Ditambahkan state `outputFilename` di `QrBarcodePage.tsx`.
  - `handleDownload` sekarang menggunakan `outputFilename` user (fallback ke `qrcode`/`barcode` jika kosong) alih-alih timestamp random.
  - Ditambahkan `<input>` field "Output filename" di bawah preview.
  - Ditambahkan tombol "Open Folder" (ghost button) di samping tombol Download. Kemudian diperbaiki layoutnya menjadi stacked vertikal agar tidak mepet batas layar.
- ✅ TASK 9e.3: Metadata — Auto-Download & Open Folder
  - `handleSave` di `MetadataPage.tsx` kini auto-trigger download segera setelah berhasil (konsisten dengan halaman lain).
  - Toast success menampilkan action button "Open Folder".
  - Result card diperbarui: tombol Download yang redundan dihapus, hanya menyisakan "Open Folder" (secondary) saja.
- ✅ tsc --noEmit → 0 errors ✓

**Design Decisions:**
- **Rename bukan refactor route:** Path `/extract` dan nama file `ExtractPage.tsx` tetap sama untuk backward compat. Hanya label tampilan dan page title yang diubah.
- **QR Open Folder via dynamic import:** `openOutputFolder` di QR page menggunakan `import(...).then(...)` untuk konsistensi dengan pattern yang ada di halaman lain.

### Session 10 — 2026-06-15 (Code Audit & Cleanup)

**Selesai:**
- ✅ Melakukan audit READ-ONLY pada seluruh codebase dan mengkompilasinya dalam `manage_code.md`.
- ✅ Menghapus skrip *debugging* manual usang di backend (`test_pymupdf.py` dan `test_headers.py`).
- ✅ Menghapus referensi model Pydantic yang tidak lagi digunakan (`FileInfo`, `ProcessingResult`) dari `backend/models/common.py` karena API kini sepenuhnya menggunakan `FileResponse` (Blob) dan *custom headers*.
- ✅ Memperbarui `test_models.py` untuk menghapus blok pengujian komponen usang di atas (pytest: 30/30 passing).
- ✅ Menghapus NPM *dependencies* pembungkus JavaScript untuk Tauri APIs (`@tauri-apps/api`, `@tauri-apps/plugin-shell`, `@tauri-apps/plugin-opener`) dari `frontend/package.json` yang dibiarkan menganggur sejak transisi ke native API caller via Rust backend. (tsc build pass 0 errors).

### Session 11a — 2026-06-15 (Dusty Rose Theme)

**Selesai:**
- ✅ TASK 1: Tambah CSS Variables Dusty Rose di `index.css` via class `[data-theme="dusty-rose"]`.
- ✅ TASK 2: Buat `ThemeContext.tsx` untuk mengatur state `theme` ('dark' | 'dusty-rose') dan persistensi via `localStorage`.
- ✅ TASK 3: Register `ThemeProvider` sebagai wrapper utama di `App.tsx`.
- ✅ TASK 4: Tambah Theme Switcher di `SettingsPage.tsx` pada section "Appearance" menggunakan radio card icon `Moon` dan `Palette`.
- ✅ TASK 5: Verifikasi build frontend menggunakan `tsc --noEmit`.
- ✅ Status akhir: `tsc --noEmit` pass 0 errors.

**Design Decisions:**
- Digunakan data attribute (`data-theme="dusty-rose"`) pada `document.documentElement` agar theme dapat dioverride di root level dengan mudah tanpa mengganggu specificity.
- Theme initial state membaca dari `localStorage` untuk persistensi.
- Dilakukan pemetaan (mapping) CSS Variables untuk tema Dusty Rose agar sesuai dengan standarisasi penamaan variabel `index.css` di blok `:root`. Sebuah "THEME TEMPLATE" juga ditambahkan sebagai standar pembuatan tema-tema baru ke depannya.

### Session 11b — 2026-06-16 (Steel Blue Theme)

**Selesai:**
- ✅ TASK 1: Tambah CSS Variables Steel Blue di `index.css`
- ✅ TASK 2: Update ThemeContext untuk support `'steel-blue'`
- ✅ TASK 3: Tambah Radio Card Steel Blue di `SettingsPage.tsx`
- ✅ TASK 4: Verifikasi build frontend
- ✅ TASK 5: Update AGENTS.md dengan log session ini

**Bug Ditemukan & Fix:**
| Bug | Root Cause | Fix | File |
|-----|-----------|-----|------|
| Tema Steel Blue tampil seperti Dark Mode | Nama variabel CSS yang diberikan (`--bg-primary`, `--text-primary`, dll.) tidak sesuai dengan *design tokens* standar Material 3 yang dipakai aplikasi (`--background`, `--surface`, `--on-surface`, dll.). Sehingga styling jatuh ke *fallback* `:root` (Dark). | Memetakan dan menerjemahkan variabel custom tersebut ke skema token THEME TEMPLATE standar. (e.g. `--bg-primary` menjadi `--background`, `--text-primary` menjadi `--on-surface`, dsb.). | `index.css` |

**Design Decisions:**
- Menambahkan theme block `[data-theme="steel-blue"]` tanpa memodifikasi block existing untuk memastikan kompatibilitas tema yang sudah ada.
- UI Radio Card Steel Blue disamakan pola dan style layoutnya dengan card Dark dan Dusty Rose yang sebelumnya ada, memastikan konsistensi komponen di `SettingsPage.tsx`.

**Status Akhir:**
- `tsc --noEmit` build passed 0 errors.

### Session 12 — 2026-06-15 (UI Fix & Global Text Overflow Audit)

**Selesai:**
- ✅ TASK 1: Memperbaiki UI bug pada komponen `.file-item-name` di `index.css` di mana teks nama file yang panjang melakukan *overflow* dan menutupi tombol *actions*. Hal ini terjadi karena element *inline* (`span`) tidak memproses `overflow: hidden` dan `text-overflow: ellipsis`.
- ✅ TASK 2: Menerapkan `display: block`, `overflow-wrap: anywhere`, dan `word-break: break-all` pada `.file-item-name` agar nama file secara otomatis terpotong ke baris baru dan tetap rapi di dalam batas kontainer (`.file-item-info`).
- ✅ TASK 3: Melakukan **Global Audit** terhadap teks dinamis dan nama file di seluruh *codebase*.
  - Komponen `Filename.tsx` dan class `.filename` sudah tervalidasi menggunakan *text-wrapping* (`overflow-wrap: anywhere; word-break: break-word`) dengan batas `max-width: 100%`.
  - Class `.filename-truncate` sudah tervalidasi menggunakan `ellipsis` yang benar (`display: block; white-space: nowrap; overflow: hidden`).
  - Tidak ditemukan adanya kasus teks keluar batas di halaman-halaman lain (seperti `SettingsPage`, `OrganizePage`, `PreviewPanel`, dll). Semua pemotongan teks atau *wrapping* kini ditangani secara konsisten dan responsif di seluruh aplikasi.

### Session 13 — 2026-06-18 (Bug Fixes & Memory Leak Audit)

**Selesai:**
- ✅ Fix 1: Memory Leak `MetadataPage.tsx`
  - Ditambahkan `useEffect` cleanup untuk memanggil `URL.revokeObjectURL` pada `result.blobUrl` saat komponen di-unmount atau state berubah.
  - Hasil `tsc --noEmit`: 0 errors.
- ✅ Fix 2: Race Condition `QrBarcodePage.tsx`
  - Ditambahkan `AbortController` di dalam `useEffect` auto-generate preview.
  - Signal dipass ke request axios via modifier argument di `generatePreview`.
  - Ditambahkan pengecekan `axios.isCancel(err)` dan `err.name === 'AbortError'` di blok catch untuk mensuppress toast error saat abort.
  - Hasil `tsc --noEmit`: 0 errors.
- ✅ Fix 3: Memory Leak Unmount `InsertPage.tsx`
  - Ditambahkan `useRef` untuk mencegah stale closure terhadap state array `rules`.
  - Ditambahkan `useEffect` cleanup (unmount-only) untuk me-revoke semua `previewUrl` aktif di array rules.
  - Hasil `tsc --noEmit`: 0 errors.

**Status Akhir:**
- Seluruh perbaikan berhasil dan `tsc --noEmit` di folder `frontend/` passed (0 errors) untuk setiap tahap tanpa isu lanjutan.

### Session 14 — 2026-06-18 (v1.0.0 Release Prep)

**Selesai:**
- ✅ TASK 1: Update versi dari `2.0.0` ke `1.0.0` di `tauri.conf.json` dan `dist-package/CHANGELOG.txt` serta `dist-package/README.txt`.
- ✅ TASK 2 & 5: Update `.gitignore` (menambahkan `AGENTS.md`, `manage_code.md`) dan melakukan inisialisasi Git (`git init`, `git add .`) beserta initial commit untuk v1.0.0.
- ✅ TASK 3: Update dokumentasi `README.md` ke bahasa Inggris, menambahkan shield badges, warning SmartScreen, auto-cleanup note, serta memastikan ke-11 fitur (seperti Split PDF) tercantum dengan benar.
- ✅ TASK 4: Rebuild aplikasi (Tauri production build). Berhasil mengatasi issue AppLocker di percobaan kedua. Installer dipindahkan ke `dist-package/`.
  - Ukuran `.exe`: 43.8 MB (43,891,496 bytes)
  - Ukuran `.msi`: 45.0 MB (45,076,480 bytes)
- ✅ TASK 6: Penambahan session log di `AGENTS.md`.

### Session 15 — 2026-06-18 (GitHub Pages Landing Page)

**Selesai:**
- ✅ TASK 1: Buat struktur folder `docs/` untuk GitHub Pages.
- ✅ TASK 2: Buat landing page statis murni HTML/CSS di `docs/index.html` dan `docs/style.css` (tanpa JS/Framework). Desain sesuai ketentuan (Dark theme, Inter font, 6 sections, responsive).
- ✅ TASK 3: Verifikasi hasil build.
  - Ukuran `docs/index.html`: 6.69 KB (6697 bytes)
  - Ukuran `docs/style.css`: 6.09 KB (6093 bytes)
- ✅ TASK 4: Commit dan push ke repository GitHub `origin main`.
  - URL landing page: `https://hubble99.github.io/pdf-manager`
- ✅ TASK 5: Update session log di `AGENTS.md`.

### Session 16 — 2026-06-18 (Polishing Landing Page Design)

**Selesai:**
- ✅ TASK 1: Polish Hero Section. Mengubah layout dari 1 kolom menjadi 2 kolom dengan preview screenshot.
- ✅ TASK 2: Menambahkan section Screenshots dalam bentuk grid 2 kolom di bawah Features.
- ✅ TASK 3: Polish Typography & Spacing. Memperbaiki ukuran font heading, line-height, dan jarak antar section menjadi seragam.
- ✅ TASK 4: Polish Feature Cards. Menyederhanakan efek hover menjadi perubahan warna border.
- ✅ TASK 5: Polish Buttons & Badges. Penyesuaian padding, border-radius, dan skema warna untuk Call-To-Action.
- ✅ TASK 6: Polish Footer. Penyesuaian layout dan pewarnaan footer agar lebih clean.
- ✅ TASK 7: Verifikasi build. Ukuran index.html menjadi 8.10 KB dan style.css menjadi 6.38 KB. Responsive dan layout tanpa broken links dikonfirmasi.
- ✅ TASK 8: Commit dan push ke repository origin main.
- ✅ TASK 9: Update session log di `AGENTS.md`.

**Design Decisions:**
- Menggunakan pendekatan fallback graceful menggunakan atribut `onerror="this.parentElement.style.display='none'"` pada elemen `<img>`. Hal ini memungkinkan galeri screenshot yang berjumlah dinamis menyesuaikan secara fleksibel jika file aset tersebut kurang dari 4 tanpa memecahkan grid.
- Hover states sengaja dibuat minimalis (hanya color change/fade) tanpa memodifikasi `transform` scale atau membesarkan drop-shadow, demi memberikan kesan UI yang lebih presisi, matang, dan modern.

User opens app
  → Tauri window spawns
  → React frontend loads (localhost:5173 in dev)
  → App.tsx checks /health every 10s (shows status bar if offline)
  → Sidebar shows all 7 tools + Settings
  → User picks a tool → routed to its page
  → Page has drop zone for PDF/image files
  → On submit → Axios POST to FastAPI /api/v1/{feature}
      (responseType: 'blob' for file-returning endpoints)
  → FastAPI processes via core/ business logic
  → Returns FileResponse (binary PDF or ZIP)
      with X-* headers for metadata
  → Frontend creates Object URL → auto-triggers download
  → Toast notification confirms success/failure
```

---

### Session 17 — 2026-06-24 (Output Filename Audit & Fix)

**Selesai:**
- ✅ Melakukan audit komprehensif terhadap implementasi fitur *Output Filename* pada kelima halaman (PdfToImage, Extract, Compress, Insert, Organize).
- ✅ Hasil Audit:
  - **PdfToImage**: BUG BACKEND (parameter `output_filename` tidak diterima oleh endpoint backend).
  - **Extract**: PASS
  - **Compress**: PASS
  - **Insert**: PASS
  - **Organize**: PASS
- ✅ Fix Bug Backend (PdfToImage): Menambahkan parameter form `output_filename` pada endpoint `pdf_to_image_endpoint` di `backend/routers/pdf_to_image.py` dan meneruskannya ke fungsi utilitas `sanitize_stem()`.
- ✅ Verifikasi Build & Test: `tsc --noEmit` berhasil (0 errors) dan `pytest tests/ -v` berhasil lulus 30/30 test.

---

### Session 18 — 2026-06-24 (Release v1.0.1)

**Selesai:**
- ✅ Update versi aplikasi dari 1.0.0 ke 1.0.1.
- ✅ Melakukan *build production* lengkap (PyInstaller Sidecar + Tauri Windows bundle).
- ✅ Hasil Build Installer:
  - `PDF Manager_1.0.1_x64-setup.exe`: 43.8 MB (43,890,830 bytes)
  - `PDF Manager_1.0.1_x64_en-US.msi`: 45.0 MB (45,076,480 bytes)
- ✅ Git commit & push (`fix: output filename not applied on PDF to Image export`) ke `origin main`.
- ✅ Catatan: Release v1.0.1 siap diupload ke GitHub Releases.

---

### Session 19 — 2026-06-29 (Simplify UI & Splash Screen Text Update)

**Selesai:**
- ✅ TASK 1: Menyembunyikan section "Backend Connection" dari UI di halaman `SettingsPage.tsx`. Menghapus state `latency` dan `isTesting`, fungsi `handleTestConnection`, serta import `Activity`, `Server` dari `lucide-react` dan `API_BASE_URL` dari `../api/config` karena tidak digunakan di tempat lain di file ini.
- ✅ TASK 2: Mengubah semua teks loading bertema teknis ("backend", "engine", "PDF libraries") di `SplashScreen.tsx` menjadi string non-teknis user-friendly ("Starting...", "Loading...", "Please wait...") sesuai konteks masing-masing teks.
- ✅ TASK 3: Melakukan verifikasi build dengan menjalankan `tsc --noEmit` yang sukses dengan hasil 0 compile errors.
- ✅ TASK 4: Melakukan git commit dan git push perubahan ke repositori remote `origin main`.
- ✅ Rebuild: Menjalankan `npm run tauri build` untuk mem-build ulang installer bundle desktop (EXE dan MSI) dengan React UI terbaru, lalu memindahkannya ke direktori `dist-package/`.
---

### Session 20 — 2026-07-13 (Edit PDF Feature with Konva Canvas)

**Selesai:**
- ✅ TASK 1: Menginstal dependencies frontend `konva` (v10.3.0) dan `react-konva` (v19.2.5).
- ✅ TASK 2: Membuat endpoint backend baru `POST /api/v1/pdf-to-image/pages` di `pdf_to_image.py` untuk mengonversi halaman PDF ke base64 PNG dengan resolusi DPI 150 secara cepat dan mengembalikan data dimensi halaman.
- ✅ TASK 3: Membuat modul backend baru `backend/routers/edit_pdf.py` dengan endpoint `POST /api/v1/edit-pdf/save` untuk mengonversi base64 PNG kembali ke halaman PDF menggunakan PyMuPDF, menyesuaikan dimensi gambar, mengamankan nama file melalui `sanitize_filename()`, dan mendaftarkan routernya di `main.py`.
- ✅ TASK 4: Membuat halaman editor UI frontend `EditPdfPage.tsx` lengkap berdasarkan visual Stitch:
  - Layout Split-panel (Kiri 320px fixed untuk drop zone, input output filename, tombol Save; Kanan canvas area).
  - Sticky toolbar di atas canvas dengan tool selector (Select, Pen, Highlighter, Text, Rectangle, Circle, Line, Eraser) + contextual controls (presets & custom color picker, stroke width slider, font settings).
  - Rendering halaman PDF secara vertikal dengan border tipis dan bayangan. Lazy rendering (> 50 halaman) menggunakan IntersectionObserver.
  - State anotasi per halaman, history undo/redo stack (max 50 langkah per halaman).
  - Alur simpan dengan ekspor Konva Stage ke PNG (`pixelRatio: 2`), POST `/api/v1/edit-pdf/save`, unduhan otomatis, dan toast notifikasi dengan opsi Open Folder.
- ✅ TASK 5: Mendaftarkan route `/edit-pdf` di `App.tsx`, menu item "Edit PDF" (ikon `PenLine`) di `Sidebar.tsx`, dan mendaftarkan tipe `NavItemId` di `types/index.ts`.
- ✅ TASK 6: Membuat unit test baru di `backend/tests/test_edit_pdf.py` dan memverifikasi seluruh fungsionalitas.
  - `tsc --noEmit` pass (0 errors) ✓
  - pytest 32/32 tests pass (termasuk pengujian endpoint baru) ✓

**Design Tokens dari Stitch (diaplikasikan di EditPdfPage):**
- Background utama: `#131318`
- Surface/Panel kiri: `#1E1E2E`
- Toolbar background: `#12121A`
- Border: `#2A2A3E`
- Accent aktif: `#4A9EFF`
- Teks utama: `#E8E8F0`
- Teks sekunder/icon tidak aktif: `#9898B8`
- Border radius: `8px`
- Font: Inter

---

### Session 21 — 2026-07-13 (Fix Conversion Mismatch & Resize Drop Zone)

**Selesai:**
- ✅ TASK 1: Mendiagnosa dan memperbaiki error "Conversion Failed — Not Found" pada halaman Edit PDF. Masalah terjadi karena URL pemanggilan axios di frontend `/pdf-to-image/pages` dan `/edit-pdf/save` tidak diawali dengan prefix `/api/v1`, sehingga di-resolve secara salah tanpa prefix `/api/v1` yang didefinisikan oleh FastAPI backend. Diperbaiki dengan mengubah endpoint ke `/api/v1/pdf-to-image/pages` dan `/api/v1/edit-pdf/save`.
- ✅ TASK 2: Memperkecil Drop Zone di panel kiri halaman Edit PDF. Ketinggian diset ke maksimal `160px` dengan padding `16px`, ukuran ikon upload diperkecil ke `24px`, teks utama berukuran `0.875rem`, teks sekunder berukuran `0.75rem` dengan warna `var(--text-muted)`. Pemuatan berkas secara otomatis menyembunyikan drop zone dan menggantikannya dengan berkas ringkasan kartu (summary card).
- ✅ TASK 3: Melakukan verifikasi build dengan `tsc --noEmit` yang sukses dengan hasil 0 compile errors.
- ✅ TASK 4: Melakukan merge branch `feature/edit-pdf` ke `main` dan melakukan git push ke repositori remote `origin main`.

---

### Session 22 — 2026-07-13 (Major UX Refactor for Edit PDF Page)

**Selesai:**
- ✅ TASK 1: Merombak tata letak panel kiri (320px fixed) menjadi layout 5-zona terstruktur secara vertikal (File Info kompak max 64px dengan tombol Clear PDF, Drop Zone modular max 120px, daftar Tools Vertikal setinggi 36px, Contextual Controls khusus untuk tool aktif, dan Bottom Controls lengket di paling bawah).
- ✅ TASK 2: Merombak toolbar atas menjadi hanya memuat kendali Zoom (`+` / `-` / persentase), pembatas, tombol Undo / Redo, pembatas, dan tombol "Fit to Width" (ikon `Maximize2`). Mengimplementasikan zoom behavior dengan rentang 25%-200% (kelipatan 25%) yang diterapkan via CSS `transform: scale(zoomLevel)` pada canvas.
- ✅ TASK 3: Memperbaiki Text Tool agar saat klik di canvas membuat objek Konva Text transparan dengan outline border tipis `#4A9EFF` dan memicu HTML `<textarea>` absolute overlay di atasnya untuk input inline yang otomatis menyesuaikan tinggi (`scrollHeight`), serta mendukung pembatalan (Escape) dan konfirmasi (blur / Enter). Double-click pada teks lama memicu penataan overlay yang serupa.
- ✅ TASK 4: Memverifikasi build akhir menggunakan `tsc --noEmit` yang sukses dengan hasil 0 compile errors.
- ✅ TASK 5: Melakukan commit dan git push hasil refactor langsung ke branch remote `origin main`.

**Design Decisions:**
- **Layout Vertikal**: Memindahkan tool list dari toolbar horizontal atas ke panel kiri vertikal untuk memberikan ruang kerja canvas yang lebih luas dan navigasi yang lebih terfokus.
- **Color Picker Terpusat**: Setiap tool menggambar didampingi oleh color picker dan stroke size slider langsung di contextual controls panel kiri.
- **Zoom & Fit to Width**: Mengaktifkan skala transform CSS dinamis yang ter-center dari atas (`top center`) dengan kelipatan 25% dan kalkulasi rasio otomatis untuk mencocokkan canvas dengan lebar layar saat ini.

---

### Session 23 — 2026-07-13 (Zoom & Text Tool Silent Fail Fix)

**Selesai:**
- ✅ TASK 1: Memperbaiki Zoom In/Out yang tidak berfungsi secara visual. Masalah terjadi karena div wrapper dengan transform scale terlewati dari replace_file_content sebelumnya. Diperbaiki dengan mengarahkan transform CSS `scale(zoomLevel)` ke wrapper div halaman canvas di dalam scrollable container, mengganti variabel state dari `zoom` menjadi `zoomLevel`, dan mengupdate persentase display serta tombol Fit to Width (`setZoomLevel(1)`).
- ✅ TASK 2: Memperbaiki Text Tool yang silent fail. Diimplementasikan ulang menggunakan React state `textInputState` terlokalisasi di child editor. Menambahkan handler `onClick` pada Konva Stage untuk mendeteksi klik canvas kosong, merender overlay textarea absolut dengan `pointer-events: all` dan z-index tinggi, serta memicu `commitTextInput` pada blur/Enter dan pengembalian visible state teks lama saat Escape.
- ✅ TASK 3: Memverifikasi build akhir menggunakan `tsc --noEmit` yang sukses dengan hasil 0 compile errors.
- ✅ TASK 4: Melakukan commit dan git push perbaikan bug zoom dan text langsung ke branch remote `origin main`.

**Root Cause:**
1. **Zoom Mismatch**: Perubahan markup transform canvas wrapper terlewat pada session sebelumnya karena ketidakakuratan parsial dari replace tool.
2. **Text Tool Imperative Clash**: Manipulasi objek teks secara imperatif bertubrukan dengan lifecycle render react-konva, dan stage click tidak terikat ke input overlay yang dinamis.

---

### Session 24 — 2026-07-13 (Comprehensive Edit PDF Canvas Fixes)

**Selesai:**
- ✅ FIX 1: Meningkatkan DPI rendering pada endpoint backend `/api/v1/pdf-to-image/pages` dari `150` menjadi `200`, serta meningkatkan `pixelRatio` ekspor `stage.toDataURL` di frontend dari `2` menjadi `3` untuk hasil cetak berkas resolusi tinggi.
- ✅ FIX 2: Mengintegrasikan react-konva `<Transformer>` dinamis untuk meresize aneka objek gambar (Text, Rect, Circle, Line-shape, dan coretan bebas Pen/Highlighter). Transform end handler mereset scale objek kembali ke `1` untuk mencegah bug double-scaling.
- ✅ FIX 3: Menyematkan auto-focus `useEffect` pada input overlay `<textarea>` yang otomatis mengembalikan fokus ke textarea menggunakan `setTimeout` ketika properti font style (Bold, Italic, Family, Size, Color) di panel toolbar diubah oleh pengguna.
- ✅ FIX 4: Menghapus batas atas `max={72}` pada pengaturan Font Size dan mengganti input range slider menjadi input type `number` dinamis dengan batasan minimal `1` tanpa batas atas.
- ✅ FIX 5: Merombak fungsionalitas Eraser dari click-to-delete menjadi Paint Eraser (drag & erase kontinyu) dengan menambahkan state `isErasing` dan pengecekan irisan bounding box objek secara real-time.
- ✅ FIX 6: Mengaktifkan properti `draggable={activeTool === 'select'}` pada objek-objek Konva dan memperbarui koordinat posisi absolut secara permanen saat drag selesai.
- ✅ FIX 7: Mengimplementasikan Selection Area (box persegi bergaris putus-putus biru) untuk menyeleksi banyak objek (*multi-select*) secara bersamaan saat Select tool aktif dan pengguna melakukan drag di area kosong canvas.
- ✅ TASK VERIFIKASI: Verifikasi `tsc --noEmit` sukses dengan 0 compile errors dan `pytest tests/` sukses dengan 32/32 tests passed.
- ✅ TASK COMMIT: Commit dan git push semua perubahan di atas sukses didorong ke branch remote `origin main`.

**Design Decisions:**
- **Paint Eraser**: Menggunakan penapisan (filtering) array objek berdasarkan overlap bounding box visual untuk responsivitas penghapusan yang instan.
- **Stage findOne Query**: Memanfaatkan selector `#id` bawaan Stage Konva untuk melacak node-node terpilih secara deklaratif guna penautan Transformer tunggal ke banyak node sekaligus.

---

### Session 25 — 2026-07-13 (Canvas Behavior Improvements & Auto-Fit Zoom)

**Selesai:**
- ✅ FIX 1: Menambahkan global keyboard listener (`Delete` dan `Backspace`) di parent component untuk menghapus objek-objek terpilih secara instan, lengkap dengan safety guard pendeteksian target input/textarea tag agar tidak bentrok saat mengetik.
- ✅ FIX 2: Mengimplementasikan sinkronisasi bidirectional (dua arah) untuk Text properties: Klik objek Text di canvas otomatis mempopulasi properties toolbar, dan memodifikasi values di toolbar langsung meng-update properti Text objek terpilih secara real-time.
- ✅ FIX 3: Mengembangkan mode penulisan teks ganda berdasarkan interaksi mouse: Click menghasilkan Point Text singles-line (`isAreaText: false`, `width: auto`) dan Drag menghasilkan Area Text dengan fixed-width (`isAreaText: true`, `whiteSpace: pre-wrap`, `wordWrap: break-word`).
- ✅ FIX 4: Menambahkan state & input contextual baru pada sidebar properties untuk bentuk shape (Rect & Circle: Fill Color, Fill Opacity, Stroke Color, Stroke Width; Line: Stroke Color, Stroke Width saja). Menggunakan konversi hex ke `rgba()` untuk fill opacity agar border stroke tidak ikut pudar.
- ✅ FIX 5: Mengimplementasikan Auto-fit Zoom saat PDF pertama kali dimuat. Menghitung rasio `viewportWidth / pageWidth` secara otomatis (dengan micro-timeout 100ms agar clientWidth ter-render stabil) agar lembar PDF selalu pas menempati layar canvas viewport.
- ✅ TASK VERIFIKASI: Verifikasi `tsc --noEmit` sukses dengan 0 compile errors dan `pytest tests/` sukses dengan 32/32 tests passed.
- ✅ TASK COMMIT: Commit dan git push semua perubahan di atas sukses didorong ke branch remote `origin main`.

**Design Decisions:**
- **Auto-fit Zoom Formula**: Menggunakan `viewportWidth / pageWidth` yang dibulatkan ke kelipatan zoom terdekat (step 0.25) dan dibatasi maksimal 1.0 agar tampilan proporsional.
- **Hex to RGBA Conversion**: Menghindari opacity bawaan Konva yang memudarkan seluruh objek, diganti dengan manipulasi alpha channel pada string `rgba()` warna fill.
- **Double-pass Text Mode**: Menyimpan parameter `width` secara terpisah ke state data shapes agar rendering word-wrap di Konva Text dan HTML textarea overlay presisi sama.

---

### Session 26 — 2026-07-13 (Edit PDF Total Refactor & State Unification)

**Selesai:**
- ✅ TASK 1: Merombak total `frontend/src/pages/EditPdfPage.tsx` dari awal untuk menggunakan arsitektur single source of truth yang robust. Seluruh objek gambar per halaman dimuat dalam list `objects` di state `pages: PageData[]`.
- ✅ TASK 2: Menyusun panel kiri sebagai pure derived view yang dirender dari `selectedObject` (computed menggunakan `useMemo` berdasarkan `selectedObjectId` dan `activePageIndex`). Saat tidak ada objek yang terpilih, panel kiri menampilkan default properties untuk objek baru.
- ✅ TASK 3: Mengimplementasikan update properti objek terpilih secara real-time via `updateSelectedObject` yang secara otomatis men-debounce penyimpanan ke history (400ms) untuk mencegah penumpukan step undo/redo saat slider digeser.
- ✅ TASK 4: Memisahkan perhitungan `baseDisplayScale` (otomatis menyesuaikan ukuran lebar halaman PDF asli ke standar 800px di layar) dari tingkat pembesaran `zoomLevel` (user-facing zoom, e.g. 100%). Menghubungkan CSS `scale(finalScale)` ke halaman canvas agar visualisasi halaman wajar dan proporsional.
- ✅ TASK 5: Menyusun kelakuan (behavior) presisi untuk setiap alat gambar:
  - **Select**: Klik objek untuk memilih, pasang Transformer, drag untuk memindahkan koordinat `x, y`, dan resize handles untuk mengubah ukuran `width/height` atau `fontSize` dengan reset scale node ke 1.
  - **Pen & Highlighter**: Menggambar coretan bebas dengan opacity solid (Pen) dan semi-transparan `0.4` (Highlighter). Menghapus koordinat drift pada drag-end coretan bebas.
  - **Text**: Mode ganda Point Text (klik) vs Area Text (drag) dengan visualisasi dashed box. Input inline lewat overlay `<textarea>` absolute berfitur auto-focus, Blur/Enter commit, dan Escape cancel, serta double-click untuk edit teks lama.
  - **Rect & Circle**: Menarik persegi/lingkaran dengan stroke dan fill opacity (hex ke `rgba()`).
  - **Line**: Menggambar garis lurus antar dua titik dengan drag-end shift yang presisi.
  - **Eraser**: Paint Eraser dengan collision check berkelanjutan menggunakan tolerance 10px pada bounding box.
- ✅ TASK 6: Mengintegrasikan history undo/redo per page berbasis hotkeys `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` dan tombol toolbar, serta tombol `Delete`/`Backspace` global untuk menghapus objek terpilih.
- ✅ TASK VERIFIKASI: Verifikasi `tsc --noEmit` sukses dengan 0 compile errors dan `pytest tests/` sukses dengan 32/32 tests passed.
- ✅ TASK COMMIT: Commit dan git push semua perubahan di atas sukses didorong ke branch remote `origin main`.

**Design Decisions:**
- **Debounced Properties History**: Penundaan 400ms pada commit snapshot saat menggeser slider (stroke width, fill opacity) agar history tidak dipenuhi oleh modifikasi mikro berturut-turut.
- **Base Display Scale Logic**: Skala 800px unscaled lebar awal meluruskan representasi dokumen di layar, membebaskan user dari anomali DPI 200 (~1654px lebar) dan memangkas kerumitan formula auto-fit.
- **Stage Coordinate Translation**: Menyerahkan pergeseran offset penyeretan coretan bebas dan garis ke penyesuaian delta `dx`/`dy` titik aslinya dan mereset `x`/`y` node Konva ke `0` untuk menghindari penyimpangan visual.

---

### Session 27 — 2026-07-13 (Transformer Shape and Text Resize Fixes)

**Selesai:**
- ✅ TASK 1: Memperbaiki bug ukuran ganda (doubling size) saat meresize Shape (Rect & Circle) dengan membetulkan urutan imperative reset scale (`node.scaleX(1); node.scaleY(1);`) pada node Konva yang sekarang dieksekusi secara instan sebelum state React di-update dengan nilai dimensi final.
- ✅ TASK 2: Memperbaiki resize Text. Memisahkan logika resize menjadi Point Text (`width === null`) yang mengubah `fontSize` secara proporsional, dan Area Text (`width !== null`) yang hanya merubah `width` kontainer (font size tetap, memicu word reflow).
- ✅ TASK 3: Mengatur properti `<Transformer>` dengan `boundBoxFunc` yang memiliki batasan minimal lebar/tinggi sebesar `20px` untuk menjaga kelancaran interaksi scaling visual.
- ✅ TASK VERIFIKASI: Verifikasi `tsc --noEmit` sukses dengan 0 compile errors dan `pytest tests/` sukses dengan 32/32 tests passed.
- ✅ TASK COMMIT: Commit dan git push semua perubahan di atas sukses didorong ke branch remote `origin main`.

**Root Cause:**
- **Shape Resize Doubling**: Reset scale dilakukan setelah atau bersamaan dengan siklus state update React, sehingga scale transform Konva menumpuk di atas base width/height baru.
- **Text Area Stretching**: Transformer memodifikasi visual scale node teks area secara seragam, bukannya memperlebar area box pembungkusnya, sehingga tulisan menjadi stretched/gepeng.

---

### Session 28 — 2026-07-24 (Text Box Resize Scaling Audit & Decimal FontSize Fix)

**Selesai:**
- ✅ AUDIT 1: Membaca dan mengaudit `handleTextTransformEnd` secara lengkap (line 856–899) menggunakan MCP Sequential Thinking dengan 7 langkah analisis terstruktur.
- ✅ AUDIT 2: Verifikasi bahwa `node.scaleX(1)` dan `node.scaleY(1)` sudah dipanggil **unconditional** di semua cabang kondisi (line 861–862) — PASS.
- ✅ AUDIT 3: Verifikasi bahwa basis kalkulasi (`obj.width`, `obj.fontSize`) sudah dibaca dari **React state** (via `prev` di functional `setPages`), bukan dari node Konva — PASS.
- ✅ AUDIT 4: Verifikasi bahwa `onTransformEnd` tidak terpanggil dua kali per aksi drag (react-konva deklaratif, key stabil, Konva `transformend` event single-fire) — PASS.
- ✅ AUDIT 5: Verifikasi tidak ada race condition `setPages` (hanya satu pemanggilan, functional setState menjamin state terbaru) — PASS.
- ✅ FIX 1: Mengganti `Math.round(obj.fontSize * scale)` dengan `Math.round(obj.fontSize * scale * 10) / 10` — rounding ke 1 desimal, menghilangkan rounding drift kumulatif yang menyebabkan deviasi progresif.
- ✅ FIX 2: Menurunkan minimum fontSize dari `8` ke `1` untuk kontrol yang lebih presisi.
- ✅ FIX 3: Mengubah input Font Size di panel kiri dari `step={1}` menjadi `step={0.5}` agar user bisa input manual dengan presisi desimal.
- ✅ FIX 4: Memverifikasi `defaultTextProps.fontSize` tetap integer (`16`) sebagai default awal.
- ✅ TASK VERIFIKASI: `tsc --noEmit` sukses dengan 0 compile errors.
- ✅ TASK COMMIT: Commit `bf8ba3c` dan git push ke `origin main` berhasil.

**Root Cause (dari Audit):**
- **Primary — Rounding Drift Kumulatif**: `Math.round()` pada setiap resize membulatkan fontSize ke integer, menyebabkan informasi presisi hilang dan error menumpuk setelah resize berturut-turut. Bukan exponential compounding klasik (scale sudah di-reset), tapi rounding drift yang menyebabkan deviasi progresif.
- **Secondary — Min FontSize Terlalu Tinggi**: `Math.max(8, ...)` menciptakan "loss floor" yang memperbesar apparent compounding saat font mengecil lalu membesar.

**Design Decisions:**
- **Decimal FontSize**: Konva `<Text fontSize={...} />` secara native mendukung nilai desimal tanpa konversi tambahan.
- **Rounding 1 Desimal**: `Math.round(x * 10) / 10` dipilih sebagai tradeoff antara presisi (menghilangkan drift) dan keterbacaan display (tidak menampilkan floating point noise berlebihan).
- **Guard `isTransformingRef` TIDAK ditambahkan**: Audit mengonfirmasi handler tidak pernah double-fire; guard akan menambah kompleksitas tanpa manfaat.

**Catatan:** File `CANVAS_EDITOR_STANDARD.md` belum ada di project dan akan dibuat sebagai dokumen standar baru.

---

## Cara Menjalankan (Development)


### Backend
```powershell
cd backend
.venv\Scripts\uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

### Frontend
```powershell
cd frontend
npm run dev
# Opens http://localhost:5173
```

### Tauri Dev (requires Rust)
```powershell
# NEW terminal (will restart Rust env)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
cd frontend
npm run tauri:dev
```

---

## Known Issues

1. **Rust PATH** — Rust baru diinstall di session ini. Perlu buka terminal BARU atau reload PATH sebelum `cargo` bisa dijalankan.
2. **Tauri sidecar (Python)** — Belum dikonfigurasi. Backend masih dijalankan manual. Sprint 5.
3. **Tailwind CSS** — Menggunakan v4 (`@tailwindcss/vite` plugin), bukan v3. Tidak ada `tailwind.config.js`.
4. **Compress — text-only PDFs** — PDF yang tidak mengandung gambar (pure text) tidak akan mengalami reduksi ukuran. Ini expected behavior; user perlu diedukasi via UI (sudah ada hint di slider).
5. **Output files tidak otomatis dihapus** — ~~File hasil di `OUTPUT_DIR` terakumulasi. Cleanup strategy belum diimplementasikan.~~ **FIXED Session 9d** — FastAPI `lifespan` membersihkan `temp/` saat startup dan membersihkan `temp/` + `output/` saat shutdown. Tauri Exit hook juga memanggil `/api/v1/settings/clear-temp` sebelum kill sidecar.

---

## Dokumentasi Tersedia (docs/)

*(Belum ada — akan ditambah ketika ada library yang perlu dokumentasi detail)*

---

## Struktur Backend

```
backend/
├── .venv/              # uv virtual environment
├── main.py             # FastAPI entry point
├── config.py           # Settings (pydantic-settings)
├── requirements.txt    # Dependency list
├── routers/
│   ├── merge.py        # POST /api/v1/merge/
│   ├── extract.py      # POST /api/v1/extract/
│   ├── compress.py     # POST /api/v1/compress/
│   ├── pdf_info.py     # POST /api/v1/pdf-info/  ← NEW Sprint 2
│   ├── pdf_to_image.py # POST /api/v1/pdf-to-image/
│   ├── image_to_pdf.py # POST /api/v1/image-to-pdf/
│   ├── qr_barcode.py   # POST /api/v1/qr-barcode/qr + /barcode
│   ├── insert.py       # POST /api/v1/insert/
│   └── settings.py     # POST /api/v1/settings/clear-temp
├── models/
│   └── common.py       # SuccessResponse, ErrorResponse, FileInfo
├── core/
│   ├── pdf_merge.py    # Merge logic (PyMuPDF)
│   ├── pdf_extract.py  # Extract logic (PyMuPDF + zipfile)
│   ├── pdf_compress.py # Compress logic (PyMuPDF + Pillow)
│   └── insert/
│       ├── insertion_rule.py  # Model and validation
│       ├── insertion_plan.py  # Double-pass resolver
│       └── image_inserter.py  # PyMuPDF engine
└── utils/
    └── file_utils.py   # save_upload, cleanup_temp_file, get_file_info
```

## Struktur Frontend

```
frontend/
├── src/
│   ├── api/
│   │   ├── client.ts   # Axios instance + helpers + checkHealth
│   │   └── config.ts   # API_BASE_URL constant
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx  # 280px nav sidebar
│   │   │   └── MainContent.tsx
│   │   ├── preview/
│   │   │   ├── PreviewPanel.tsx    # Shared PDF/image preview panel
│   │   │   ├── ThumbnailStrip.tsx  # Multi-page thumbnail navigation
│   │   │   ├── PanelToggle.tsx     # Controls hide/show toggle ← Sprint 6
│   │   │   ├── ZoomControl.tsx     # Zoom buttons
│   │   │   ├── PageNavigation.tsx  # Prev/next page buttons
│   │   │   └── index.ts            # Barrel exports
│   │   ├── SplashScreen.tsx        # Startup splash w/ progress ← Sprint 6
│   │   ├── PdfThumbnail.tsx
│   │   └── Filename.tsx
│   ├── hooks/
│   │   └── usePanelToggle.ts       # Controls panel visibility hook ← Sprint 6
│   ├── pages/
│   │   ├── MergePage.tsx    # Full UI — Sprint 2 ✅
│   │   ├── ExtractPage.tsx  # Full UI + PanelToggle — Sprint 2 + Sprint 6 ✅
│   │   ├── CompressPage.tsx # Full UI — Sprint 2 ✅
│   │   ├── PdfToImagePage.tsx  # Full UI + PanelToggle — Sprint 3 + Sprint 6 ✅
│   │   ├── ImageToPdfPage.tsx  # Full UI + PanelToggle — Sprint 3 + Sprint 6 ✅
│   │   ├── QrBarcodePage.tsx   # Full UI — Sprint 3 ✅
│   │   ├── InsertPage.tsx      # Full UI + PanelToggle — Sprint 4 + Sprint 6 ✅
│   │   ├── SettingsPage.tsx    # Full UI + native dialog — Sprint 4 + Sprint 6 ✅
│   │   ├── OrganizePage.tsx    # Full UI ✅
│   │   ├── MetadataPage.tsx    # Full UI ✅
│   │   └── ProtectPage.tsx     # Full UI ✅
│   ├── utils/
│   │   ├── historyStore.ts   # Recent files history
│   │   ├── pageRange.ts      # Page range parser
│   │   └── tauriDialog.ts    # Native dialog helpers ← Sprint 6
│   ├── types/index.ts   # TypeScript interfaces
│   ├── App.tsx          # Router + layout + splash screen ← Sprint 6
│   ├── main.tsx         # React entry point
│   └── index.css        # Design system (dark theme tokens + components)
├── src-tauri/
│   ├── binaries/        # PyInstaller sidecar goes here ← Sprint 6
│   ├── capabilities/
│   │   └── default.json # Permissions: dialog + shell ← Sprint 6
│   ├── src/
│   │   ├── lib.rs       # Tauri builder + dialog + shell + sidecar spawn ← Sprint 6
│   │   └── main.rs
│   ├── Cargo.toml       # Rust deps: plugin-dialog + plugin-shell ← Sprint 6
│   └── tauri.conf.json  # Window config + externalBin + NSIS ← Sprint 6
└── package.json         # npm scripts incl. tauri:dev

# Documentation
agent_docs/
└── tauri_sidecar.md     # PyInstaller + Tauri v2 sidecar guide ← Sprint 6

# Backend
backend/
└── build.spec           # PyInstaller spec file ← Sprint 6
```
