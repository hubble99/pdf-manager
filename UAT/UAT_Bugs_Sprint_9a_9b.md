# UAT Bug Reports - Sprint 9a & 9b

## Sprint 9a
1. **BUG-9A-01: Compress SSE endpoint tidak ditemukan (Error 404)**
   - **Masalah:** Halaman Compress gagal melakukan kompresi karena API `/api/v1/compress/stream` tidak sinkron dengan *frontend*.
   - **Fix:** Sempat diganti dengan POST langsung (Blob) sebelum dikembalikan menggunakan *EventSource/fetch SSE* dengan progress bar di Sprint 9b.
2. **BUG-9A-02: CMYK Compress Fix**
   - **Masalah:** Pillow error tidak bisa memproses format gambar PDF yang menggunakan spektrum CMYK ke JPEG secara langsung.
   - **Fix:** Dilakukan konversi mode gambar (CMYK/P/RGBA) menjadi RGB sebelum proses re-encoding ke JPEG.
3. **BUG-9A-03: Organize Page Reset**
   - **Masalah:** Tidak ada opsi untuk mengembalikan urutan halaman (reset) ke kondisi awal apabila pengguna sudah terlalu banyak mengubah posisi thumbnail.
   - **Fix:** Penambahan tombol Reset untuk memulihkan urutan orisinal dokumen.
4. **BUG-9A-04: Output Filename Sanitize**
   - **Masalah:** Nama file hasil ekspor berantakan dan string ekstensi PDF/ZIP bisa tumpang tindih dengan UUID internal jika tidak divalidasi.
   - **Fix:** Implementasi modul `sanitize_filename` untuk membersihkan spasi dan *illegal characters*, lalu meneruskannya via `Content-Disposition`.
5. **BUG-9A-05: Tauri Open Folder Fix**
   - **Masalah:** Tombol "Open Folder" tidak merespons setelah proses di-Tauri Desktop.
   - **Fix:** Mengonfigurasi `shell:allow-open` pada kapabilitas keamanan *plugin shell* Tauri.
6. **BUG-9A-06: Sidecar Orphan Process Fix**
   - **Masalah:** Backend FastAPI python *sidecar* terus berjalan di background meskipun *window* aplikasi utama sudah ditutup.
   - **Fix:** *Hook* Rust di `tauri::RunEvent::Exit` diaktifkan untuk me-kill process PID dari sidecar ketika desktop shell tertutup.

## Sprint 9b
1. **BUG-9B-01: UI Symmetry & Typography Layout (Page Header & Main)**
   - **Masalah:** Tata letak dan jarak padding/margin tidak seimbang antara Sidebar dan Main Content, menyebabkan antarmuka aplikasi terkesan tidak simetris secara visual.
   - **Fix:** Refactor dan standarisasi margin di CSS class global untuk menyeragamkan grid komponen antar-halaman.
2. **BUG-9B-02: Missing Password Protection Form Options**
   - **Masalah:** Fungsi Enkripsi (Protect PDF) hanya mengunci dokumen tetapi tidak memberikan izin granular (print, copy, modify).
   - **Fix:** Ditambahkan opsi form checkbox di UI untuk mengatur `allow_print`, `allow_copy`, dan `allow_modify` di backend `pdf_protect.py`.
3. **BUG-9B-03: Compress PDF "Insufficient data for an image" Error**
   - **Masalah:** PDF dengan rasio kompresi tinggi yang memuat banyak gambar tidak dapat dibuka di Adobe Acrobat dan menampilkan *error popup* "Insufficient data for an image."
   - **Fix:** Metadata dict `Filter` dikonfigurasi ulang menjadi `/DCTDecode` agar Adobe Reader mengetahui stream dikompres menggunakan standar JPEG dan menghapus sisa `DecodeParms` dari kompresi Flate sebelumnya.
4. **BUG-9B-04: Missing Progress Bar Indicator pada Compress**
   - **Masalah:** Tidak ada bar loading interaktif ketika proses kompresi memakan waktu lama, hanya ada spinner kosong yang tidak informatif.
   - **Fix:** Reimplementasi mekanisme *Server-Sent Events* (SSE) di endpoint `/api/v1/compress/stream` untuk mengirim parameter `page`, `total`, dan persentase kompresi, ditambah komponen Progress Bar di `CompressPage.tsx` untuk pengalaman pengguna yang lebih baik.
