# CANVAS_EDITOR_STANDARD.md — PDF Manager V2 Canvas Editor Rules

> **Catatan Migrasi (2026-07-xx):** Proyek migrasi dari Konva.js ke Fabric.js. Bagian requirement behavior (Section 1-8, 10, 12) tetap berlaku sebagai spesifikasi produk. Bagian implementasi teknis Konva.js (formula Transformer, zoom native Stage scale) sudah diarsipkan terpisah dan TIDAK berlaku lagi — perlu didefinisikan ulang dengan Fabric.js API. Arsip versi Konva.js lengkap: `CANVAS_EDITOR_STANDARD_ARCHIVE_Konva.md`.

Dokumen standar untuk pengembangan dan pemeliharaan Canvas Editor (Edit PDF).

---

## Section 1 — Arsitektur State

Semua objek gambar per halaman disimpan dalam `pages: PageData[]` → `objects: CanvasObject[]`.
React state (`setPages`) adalah **single source of truth**. Object library canvas hanya render dari props React — tidak menyimpan state sendiri secara permanen.

---

## Section 2 — Object Types

| Type | Interface | Resize via |
|------|-----------|------------|
| Pen / Highlighter | `FreehandObject` | Scale + translate points |
| Text (Point) | `TextObject` (width = null) | fontSize proporsional |
| Text (Area) | `TextObject` (width = number) | width + fontSize berdasarkan arah |
| Rect | `ShapeObject` | width × scaleX, height × scaleY |
| Circle | `ShapeObject` | radiusX/Y via width/height |
| Line | `LineObject` | Scale endpoint coordinates |

---

## Section 3 — Node Scale Reset Rule (Konva-Specific)

**[BELUM DIDEFINISIKAN UNTUK FABRIC.JS]**

Versi Konva.js (deprecated, referensi historis saja) diarsipkan di `CANVAS_EDITOR_STANDARD_ARCHIVE_Konva.md` Section 3.

Requirement behavior yang tetap berlaku (independen dari library):
- Resize harus 1:1 proporsional terhadap drag mouse, tidak boleh exponential/compounding
- Reset scale/transform state harus terjadi sebelum kalkulasi dimensi baru
- Basis kalkulasi harus konsisten (tidak mencampur node-level dan state-level tanpa sinkronisasi)

---

## Section 4 — Basis Kalkulasi (Konva-Specific)

**[BELUM DIDEFINISIKAN UNTUK FABRIC.JS]**

Versi Konva.js diarsipkan di `CANVAS_EDITOR_STANDARD_ARCHIVE_Konva.md` Section 4.

---

## Section 5 — Text Resize Logic

### 5.1 Point Text (`width === null`)
- Resize proporsional: `fontSize = obj.fontSize × max(scaleX, scaleY)`
- Width tetap `null` (auto-expand)

### 5.2 Area Text (`width !== null`)
Dibedakan berdasarkan arah drag:
- **Horizontal only**: ubah `width`, fontSize tetap (word reflow)
- **Vertical only**: ubah `fontSize`, width tetap
- **Diagonal**: HANYA `fontSize` yang berubah, `width` tidak ikut berubah (Opsi B, keputusan produk untuk konsistensi dengan drag vertikal)

### 5.3 Threshold Deteksi
Deteksi perubahan arah drag harus disesuaikan dengan event Fabric.js.
(Konsep: perubahan dianggap terjadi jika rasio skala melebihi toleransi `0.01`).

### 5.4 Min Values
- `fontSize`: minimum `1` (bukan 8)
- `width`: minimum `20`

### 5.5 Transformer Config (Konva-Specific)

**[BELUM DIDEFINISIKAN UNTUK FABRIC.JS]**

Versi Konva.js diarsipkan di `CANVAS_EDITOR_STANDARD_ARCHIVE_Konva.md` Section 5.5.

### 5.6 Freehand/Pen/Highlighter & Line Transform (Konva-Specific API)

**[BELUM DIDEFINISIKAN UNTUK FABRIC.JS]**

Versi Konva.js diarsipkan di `CANVAS_EDITOR_STANDARD_ARCHIVE_Konva.md` Section 5.6.

Requirement behavior yang tetap berlaku:
- Transformasi objek coretan bebas dan garis harus dihitung secara presisi tanpa offset mismatch.
- Skala visual ketebalan coretan (stroke width) tidak boleh merusak dimensi bounding box akhir saat resize.

### 5.7 Font Size Desimal & Real-time Reflow

- `fontSize` mendukung nilai desimal (bukan wajib integer)
- Rounding ke 1 desimal: `Math.round(val * 10) / 10`
- Input panel: `step={0.5}` untuk presisi manual
- Default awal (`defaultTextProps.fontSize`) adalah `20` (integer)
- Overlay textarea: border `2px dashed #000000`

*(Catatan spesifik tentang Transform Lifecycle dan larangan onTransform per-frame dari Konva.js diarsipkan di `CANVAS_EDITOR_STANDARD_ARCHIVE_Konva.md`)*

---

## Section 6 — Shape Resize Logic & Styling

### Rect & Circle
- Limitasi ukuran minimum:
  - `newWidth = Math.max(5, calculated_width);`
  - `newHeight = Math.max(5, calculated_height);`
- Default fill shape baru: opacity `100%` dengan warna `#E8E8E8` (abu-abu terang netral agar tidak menutupi teks dokumen).

*(Catatan spesifik tentang strokeScaleEnabled={false} dari Konva.js diarsipkan di `CANVAS_EDITOR_STANDARD_ARCHIVE_Konva.md`)*

---

## Section 7 — History (Undo/Redo)

- Snapshot per halaman: `history: CanvasObject[][]`, `historyIndex: number`
- Max 50 snapshot per halaman
- Debounce 400ms untuk property slider changes (mencegah penumpukan step)
- Hotkeys: `Ctrl+Z` (Undo), `Ctrl+Y` / `Ctrl+Shift+Z` (Redo)

---

## Section 8 — Text Editing

- Click canvas → Point Text (single-line, width auto)
- Drag canvas → Area Text (fixed-width, word wrap)
- Double-click existing text → Edit via overlay `<textarea>`
- Commit: Blur atau Enter
- Cancel: Escape

---

## Section 9 — Eraser

Paint Eraser mode: collision check kontinyu dengan tolerance 10px pada bounding box objek. Menghapus objek yang ter-irisan saat drag.

---

## Section 10 — Zoom & Display Scale

- `baseDisplayScale` = `800 / pageWidth` (normalisasi ke 800px unscaled)
- `zoomLevel` = user-facing zoom (25%–200%, step 25%)
- `finalScale` = `baseDisplayScale × zoomLevel`

**Catatan Migrasi Fabric.js:**
- Evaluasi ulang apakah akan menggunakan CSS wrapper `transform: scale(finalScale)` atau native zoom API dari Fabric.js.
- **Scroll Compensation WAJIB dipertahankan**: Zoom In/Out harus mempertahankan center viewport visual pengguna agar posisi pandang user tidak melompat. Area dokumen harus fully scrollable.

---

## Section 11 — Data Types & Precision

| Field | Type | Precision | Notes |
|-------|------|-----------|-------|
| `x`, `y` | `number` | float | Posisi piksel |
| `width` | `number \| null` | float | null = auto text |
| `height` | `number` | float | Shape only |
| `fontSize` | `number` | 1 desimal | Mendukung desimal (e.g. `20.5`). Rounding `Math.round(val * 10) / 10`. Default awal `20`. |
| `strokeWidth` | `number` | integer | Min 1 |
| `fillOpacity` | `number` | integer 0-100 | Dikonversi ke rgba alpha. Default `100%`. |
| `points` | `number[]` | float | Koordinat freehand/line |

---

## Section 12 — Checklist Audit

Gunakan checklist ini setiap kali mengubah handler resize/transform:

### Checklist Umum (Berlaku Semua Library)
- [ ] Apakah basis kalkulasi scale diambil dari **state React** atau object properties yang konsisten dan akurat?
- [ ] Apakah handler memastikan tidak ada *exponential/compounding scaling* (misal dengan me-reset scale state ke default sebelum menghitung)?
- [ ] Apakah handler hanya dipanggil **sekali** per aksi transform (tidak ada duplikasi event listener)?
- [ ] Apakah `setPages` menggunakan **functional form** (`prev => ...`) untuk menghindari stale closure?
- [ ] Apakah nilai fontSize di-round ke 1 desimal (`Math.round(val * 10) / 10`), bukan ke integer?
- [ ] Apakah minimum fontSize adalah `1` (bukan `8`)?

### Checklist Spesifik Konva (Deprecated, Referensi Arsip)
**[DIARSIPKAN DI `CANVAS_EDITOR_STANDARD_ARCHIVE_Konva.md`]**
- [ ] Apakah `<Transformer>` di-set `keepRatio={false}`?
- [ ] Apakah `node.scaleX(1)` dipanggil tanpa syarat sebelum update state?
- [ ] Apakah formula Line/Freehand menggunakan translasi relatif terhadap offset (`val * scaleX + nodeX`)?
- [ ] Apakah object dengan stroke punya `strokeScaleEnabled={false}`?
