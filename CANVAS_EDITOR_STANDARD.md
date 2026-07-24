# CANVAS_EDITOR_STANDARD.md — PDF Manager V2 Canvas Editor Rules

Dokumen standar untuk pengembangan dan pemeliharaan Canvas Editor (Edit PDF) berbasis Konva + react-konva.

---

## Section 1 — Arsitektur State

Semua objek gambar per halaman disimpan dalam `pages: PageData[]` → `objects: CanvasObject[]`.
React state (`setPages`) adalah **single source of truth**. Node Konva hanya render dari props React — tidak menyimpan state sendiri secara permanen.

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

## Section 3 — Konva Node Scale Reset Rule

> **Rule 3: Konva Node Scale Selalu Reset ke 1 SEBELUM update React state.**

Setiap handler `onTransformEnd` WAJIB menjalankan urutan ini:

```typescript
const scaleX = node.scaleX();  // 1. Capture scale
const scaleY = node.scaleY();

node.scaleX(1);                // 2. Reset SEGERA (unconditional)
node.scaleY(1);

// 3. Baru hitung dan update state
setPages(prev => { ... });
```

Pelanggaran rule ini menyebabkan **exponential/compounding scaling** — resize 2x drag menghasilkan 4x hasil.

---

## Section 4 — Basis Kalkulasi

Semua perhitungan resize **WAJIB** menggunakan nilai dari React state atau node Konva yang sudah di-reset scale-nya ke 1 (`node.width() * scaleX`), **BUKAN** dari node Konva yang berpotensi membawa scale residual tanpa reset.

```typescript
// ✅ BENAR — basis dari React state atau node Konva ter-reset
patch.width = Math.max(20, node.width() * scaleX);

// ❌ SALAH — basis dari node Konva tanpa reset scale
const newWidth = Math.max(5, node.width() * scaleX); // jika scaleX belum direset ke 1
```

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
```typescript
const horizontalChanged = Math.abs(scaleX - 1) > 0.01;
const verticalChanged = Math.abs(scaleY - 1) > 0.01;
```

### 5.4 Min Values
- `fontSize`: minimum `1` (bukan 8)
- `width`: minimum `20`

### 5.5 Transformer Config
```typescript
<Transformer
  rotateEnabled={false}
  keepRatio={false}
  anchorSize={16}
  anchorStrokeWidth={2}
  anchorCornerRadius={4}
  boundBoxFunc={(oldBox, newBox) => {
    if (newBox.width < 20 || newBox.height < 20) return oldBox;
    return newBox;
  }}
/>
```

### 5.6 Freehand/Pen/Highlighter & Line Transform
- Reset `node.x(0)`, `node.y(0)` selain scale
- Translate semua titik points secara relatif: `val * scaleX + nodeX` / `val * scaleY + nodeY`
- Untuk Line, formula translasi relatif yang sama WAJIB digunakan (jangan mengunci titik awal `points[0]` sebagai anchor).
- **WAJIB**: Tambahkan `strokeScaleEnabled={false}` pada `<KonvaLine>` untuk semua objek coretan (Pen, Highlighter, Line) agar konsisten dengan shape geometris dan mencegah offset mismatch akibat scaling ketebalan stroke.

### 5.7 Font Size Desimal & Real-time Reflow

- `fontSize` mendukung nilai desimal (bukan wajib integer)
- Rounding ke 1 desimal: `Math.round(val * 10) / 10`
- Konva `<Text fontSize={...} />` secara native mendukung desimal
- Input panel: `step={0.5}` untuk presisi manual
- Default awal (`defaultTextProps.fontSize`) adalah `20` (integer)
- Overlay textarea: border `2px dashed #000000`
- **Transform Lifecycle**: Penanganan resize Text dilakukan sepenuhnya pada event `onTransformEnd`. DILARANG memasang handler `onTransform` per-frame yang meng-reset scale (`node.scaleX(1)`), karena hal tersebut merusak matriks internal Konva Transformer di pertengahan drag dan membuat `scaleX` bernilai `1.0` saat `onTransformEnd` dipanggil, yang mengakibatkan penyesuaian ukuran (resize) gagal total. `onTransformEnd` membaca scale akhir, mereset scale ke 1, lalu memperbarui state `width` (`obj.width * scaleX`) dan `fontSize` (`obj.fontSize * scaleY`).

---

## Section 6 — Shape Resize Logic & Styling

### Rect & Circle
```typescript
newWidth = Math.max(5, obj.width * scaleX);   // Basis: React state / node width
newHeight = Math.max(5, obj.height * scaleY);
```
- `strokeScaleEnabled={false}` WAJIB di-set pada `<KonvaRect>` dan `<KonvaEllipse>` agar ketebalan garis (stroke width) tidak ter-distorsi atau menebal secara visual selama proses resize drag.
- Default fill shape baru: opacity `100%` dengan warna `#E8E8E8` (abu-abu terang netral agar tidak menutupi teks dokumen).

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
- CSS: `transform: scale(finalScale)` pada wrapper halaman canvas dengan `transformOrigin: 'top center'`
- **Scroll Compensation**: Zoom In/Out WAJIB mempertahankan center viewport visual pengguna menggunakan scroll compensation (`applyZoomWithScrollCompensation`) agar posisi pandang user tidak melompat.

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

> **Transformer Config Note**: `<Transformer>` WAJIB di-set `keepRatio={false}` — default Konva `keepRatio: true` memaksa `scaleX`/`scaleY` proporsional saat drag dari anchor sudut, bertentangan dengan model resize independen (width dari `scaleX`, fontSize/height dari `scaleY`) yang dipakai di seluruh spec ini.

---

## Section 12 — Checklist Audit

Gunakan checklist ini setiap kali mengubah handler `onTransformEnd` atau logika resize:

- [ ] Apakah `<Transformer>` di-set `keepRatio={false}` untuk mendukung kalkulasi resize X/Y independen?
- [ ] Apakah `node.scaleX(1)` dan `node.scaleY(1)` dipanggil **tanpa syarat** (unconditional) di awal handler?
- [ ] Apakah reset scale terjadi **SEBELUM** `setPages` / state update apapun?
- [ ] Apakah basis kalkulasi scale diambil dari **state React** atau `node.width()` yang sudah ter-reset, bukan dari node Konva yang berpotensi membawa scale residual?
- [ ] Apakah formula Line/Freehand menggunakan translasi relatif terhadap node offset (`val * scaleX + nodeX`), bukan anchor tetap di titik pertama array points?
- [ ] Apakah semua object dengan stroke (freehand, line, shape) punya `strokeScaleEnabled={false}`?
- [ ] Apakah handler hanya dipanggil **sekali** per aksi transform (tidak ada duplikasi event listener)?
- [ ] Apakah `setPages` menggunakan **functional form** (`prev => ...`) untuk menghindari stale closure?
- [ ] Apakah nilai fontSize di-round ke 1 desimal (`Math.round(val * 10) / 10`), bukan ke integer?
- [ ] Apakah minimum fontSize adalah `1` (bukan `8`)?
