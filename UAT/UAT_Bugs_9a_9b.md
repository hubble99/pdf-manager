# UAT Bug Reports & Resolutions (Session 9a & 9b)

Dokumen ini merangkum seluruh bug, *UX issues*, dan temuan User Acceptance Testing (UAT) yang ditemukan dan diselesaikan selama tahap integrasi (Sprint 9a) dan tahap *polish* (Sprint 9b) untuk aplikasi **PDF Manager V2**.

## Session 9a (Core Fixes, Error Handling & Refactoring)

| ID | Issue / Bug | Root Cause | Fix / Resolution | Modul / File |
|---|---|---|---|---|
| BUG-9A-01 | Compress SSE endpoint tidak ditemukan (Error 404) | `CompressPage` mencoba mengakses API `/api/v1/compress/stream` yang tidak diimplementasikan di sisi backend. | Menghapus arsitektur SSE dan menggantinya dengan panggilan langsung ke endpoint REST `/api/v1/compress/`. | `CompressPage.tsx` |
| BUG-9A-02 | Ekspor Barcode (PNG) menghasilkan file gambar yang kosong/putih | `ImageWriter` (python-barcode) meninggalkan *stream pointer* di posisi akhir (EOF) setelah pemrosesan. `buf.getvalue()` membaca mulai dari sana. | Menambahkan `buf.seek(0)` sebelum membaca *binary buffer* dengan `buf.read()`. | `barcode_generator.py` |
| BUG-9A-03 | File PDF dapat dienkripsi ulang (*Double encryption*) | Endpoint `/protect/` tidak memvalidasi status *encryption* file sumber. | Menambahkan validasi `doc.is_encrypted` di backend untuk menolak enkripsi ganda dan me-*raise* respons HTTP `422`. | `routers/protect.py` |
| BUG-9A-04 | *Dead code* pada komponen `CompressPage` | Hook `useEffect` tidak sengaja ditempatkan setelah *return statement* akibat modifikasi berulang. | Menghapus sisa *dead code* setelah proses refactoring. | `CompressPage.tsx` |
| BUG-9A-05 | Tombol "Open Folder" tidak merespons di mode production desktop | Penggunaan `os.startfile` diblokir oleh kebijakan keamanan OS Windows ketika berjalan dari dalam Tauri. | Memodifikasi panggilan fungsi menjadi `subprocess.Popen(['explorer', path])`. | `backend/routers/settings.py` |
| BUG-9A-06 | Kursor *Prohibited* (dilarang) muncul saat operasi Drag & Drop | Event HTML5 native `draggable` tumpang tindih dengan *native pointer events* dari tag `<img>` di Chromium Webview. | Menulis ulang seluruh fungsionalitas drag-and-drop menggunakan library modern `@dnd-kit/core`. | `OrganizePage.tsx` |
| BUG-9A-07 | Isu resolusi warna menjadi rusak/negatif saat PDF dikompres | Mengompresi *image stream* berprofil CMYK ke format JPEG via Pillow tanpa konversi warna. | Menerapkan konversi warna gambar CMYK menjadi RGB secara *on-the-fly* sebelum mengompres. | `pdf_compress.py` |

## Session 9b (UI Symmetry, Feature Completion & UX Issues)

| ID | Issue / UX Flaw | Root Cause | Fix / Resolution | Modul / File |
|---|---|---|---|---|
| BUG-9B-01 | Proporsi *Split Layout* tidak seimbang (UI Asymmetry) | Flex-basis tidak memiliki batas statis pada kontainer sisi kiri (kendali). | Menetapkan *fixed width* 420px untuk container kontrol (`.feature-controls`) serta me-lebar-kan elemen form via `index.css`. | `index.css` |
| BUG-9B-02 | Nomenklatur output ekstrak file menjadi *double extension* (ex: `file.pdf.zip`) | Backend Router mem-passing string suffix *hardcoded* (`_extracted.zip`) berlebihan ke string hasil yang sudah memiliki `.pdf`. | Menggunakan helper `sanitize_filename()` dan merefaktor alur penetapan target variabel `out_name`. | `pdf_extract.py`, `extract.py` |
| BUG-9B-03 | Pesan Error validasi (seperti Range Halaman) tidak muncul, hanya tampil "Unknown Error" | `Axios` tidak mengurai (parse) kembalian *Blob Response* menjadi JSON jika API merespons dengan HTTP status `422 Unprocessable Entity`. | Mengubah *HTTP Interceptor* di frontend untuk membaca data Blob secara *asynchronous* menjadi teks JSON pesan Error. | `client.ts` |
| BUG-9B-04 | Parameter Rentang Halaman (Page Range) berantakan/sulit digunakan pada mode "Insert Content" | Komponen Insert sebelumnya menggunakan string input bebas yang rentan *error* jika pengguna ingin menyelipkan keseluruhan dokumen PDF utuh. | Menerapkan radio button di UI untuk memisahkan mode "All Pages" dan "Custom Range" untuk masing-masing *InsertionRule*. | `InsertPage.tsx`, `insertion_rule.py` |
| BUG-9B-05 | Fitur Password Protection mengunci *permissions* pengguna meskipun tidak diminta | PyMuPDF menggunakan *default properties* yang ketat saat di-*save*, melarang copy, edit, dan print dokumen secara otomatis. | Menambahkan checkbox boolean (`allow_print`, `allow_copy`, `allow_modify`) di UI serta memproses kalkulasi bitwise di backend. | `ProtectPage.tsx`, `pdf_protect.py` |
| BUG-9B-06 | Kosongnya informasi jumlah halaman total saat menggunakan "Merge PDF" | UI list file awalnya tidak mengekstraksi dan menampilkan jumlah page untuk tiap PDF yang ditambahkan. | Melakukan pemanggilan asinkron ke `/api/v1/pdf-info/` setelah file dimuat ke *Drop Zone* untuk menampilkan label info jumlah halaman. | `MergePage.tsx` |
| BUG-9B-07 | Input *Output Filename* (Edit Metadata) malah memicu potensi *error* konflik sistem berkas | Membebaskan string metadata berisiko tanpa sanitasi jika digunakan ke nama output. | Menghapus properti text input, lalu membiarkan backend menghasilkan nama dari ekstrak judul PDF menggunakan `sanitize_filename`. | `MetadataPage.tsx`, `metadata.py` |
