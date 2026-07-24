import sys
import re

file_path = 'AGENTS.md'
try:
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
except UnicodeDecodeError:
    with open(file_path, 'r', encoding='utf-16') as f:
        content = f.read()

original_lines = len(content.splitlines())
original_chars = len(content)

summary_text = """### Session 20-31 — Edit PDF Feature (Konva.js — Deprecated)

Fitur Edit PDF sempat diimplementasikan menggunakan Konva.js + react-konva dengan canvas editor lengkap (pen, highlighter, text, shapes, eraser, undo/redo, zoom). Setelah berbagai iterasi perbaikan, ditemukan masalah presisi resize yang persisten pada object Text dan Line (hasil resize tidak proporsional 1:1 terhadap drag mouse) serta masalah zoom (scroll tidak menjangkau seluruh area dokumen, tampilan bergeser saat zoom in/out). Root cause bervariasi antar object type dan tidak terselesaikan tuntas meski sudah beberapa kali audit dan fix bertahap.

**Keputusan:** Migrasi implementasi Edit PDF dari Konva.js ke Fabric.js, karena Fabric.js punya object model (Textbox, dll) yang secara native sudah menangani resize/reflow dengan benar untuk kasus serupa. Kode Konva.js lama akan digantikan total, bukan ditambal.

Detail lengkap riwayat percobaan Konva.js (jika dibutuhkan untuk referensi) diarsipkan di `AGENTS_ARCHIVE_EditPDF_Konva.md`."""

# Find start of Session 20
match_start = re.search(r'^### Session 20\b.*$', content, flags=re.MULTILINE)
if not match_start:
    print("Could not find Session 20")
    sys.exit(1)

start_idx = match_start.start()

# Find the end of Session 31. It ends where the next ## Section starts, or another ### Session
# But there is no Session 32. Let's find ### Session 31, and then find the next ## or ### after it, or EOF
match_31 = re.search(r'^### Session 31\b.*$', content, flags=re.MULTILINE)
if not match_31:
    print("Could not find Session 31")
    sys.exit(1)

# Find the end of the text for Session 31
# We look for the next markdown header (## or ###) after match_31.start() + 1
next_header = re.search(r'^\#\#[\#]? ', content[match_31.end():], flags=re.MULTILINE)

if next_header:
    end_idx = match_31.end() + next_header.start()
else:
    # If no header, just end of string
    end_idx = len(content)

# Replace content
new_content = content[:start_idx] + summary_text + "\n\n" + content[end_idx:]

# Update the feature status table
# Find the row for Edit PDF and change its status
# Format is usually like: | Edit PDF | ... | ... | ... |
def replace_status(match):
    # match.group(0) is the entire line
    # We replace the status (usually a checkbox or emoji) with the new one
    line = match.group(0)
    cols = line.split('|')
    if len(cols) >= 4: # basic markdown table format
        cols[3] = ' 🔄 Migrating to Fabric.js '
        # Also maybe note in the Notes column
        if len(cols) >= 5:
            cols[4] = ' Lihat ringkasan Session 20-31 '
    return '|'.join(cols)

# We find the Edit PDF row (might be named Edit PDF, Canvas Editor, etc)
# Let's just do a string replace or regex
# Let's search for "Edit PDF" in the table
if "Edit PDF" in new_content:
    new_content = re.sub(r'^\|\s*Edit PDF.*$', replace_status, new_content, flags=re.MULTILINE)
    
new_lines = len(new_content.splitlines())
new_chars = len(new_content)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(new_content)

print(f"Stats:")
print(f"Before: {original_lines} baris, {original_chars} karakter")
print(f"After: {new_lines} baris, {new_chars} karakter")
print("\n--- Preview Ringkasan ---")
print(summary_text)
