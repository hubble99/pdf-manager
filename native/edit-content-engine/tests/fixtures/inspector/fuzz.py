"""Mutation check: the Rust inspector may be stricter than the Python one, never laxer.

    python fuzz.py <rust-binary> <count-per-file> <seed> <pdf> [<pdf> ...]

Each source PDF is mutated (flipped digits and bytes, cut tails, inserted junk,
swapped keywords, repeated dictionary keys). For every mutant:
  - Rust supported but Python not          -> LAX      (a failure)
  - both supported but outputs differ      -> DIFFER   (a failure)
  - Python supported but Rust not          -> STRICT   (allowed, counted)
"""
import json
import os
import random
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from parity import BACKEND, PYTHON, collect, first_diffs, normalize  # noqa: E402

BULK = r'''
import json, sys
from pathlib import Path
from features.edit_content.resource_inspector import ReadOnlyResourceInspector
insp = ReadOnlyResourceInspector()
for line in sys.stdin:
    path = line.strip()
    print(json.dumps(insp.inspect(Path(path)).to_payload(), sort_keys=True), flush=True)
'''

KEYWORDS = [b"obj", b"endobj", b"stream", b"endstream", b"xref", b"trailer", b"startxref", b"/Type", b"/Length", b"/Kids", b"/Parent", b"/Font", b"/Resources", b"/Contents"]


def mutate(data: bytes, rng: random.Random) -> bytes:
    data = bytearray(data)
    kind = rng.choice(["digit", "byte", "truncate", "insert", "keyword", "dupkey", "delete", "ws", "digit", "keyword"])
    n = len(data)
    if kind == "digit":
        positions = [m.start() for m in re.finditer(rb"\d", bytes(data))]
        # Prefer structure: digits near the end (xref) or near keywords.
        for _ in range(rng.choice([1, 1, 2, 3])):
            i = rng.choice(positions)
            data[i] = ord(str(rng.randrange(10)))
    elif kind == "byte":
        for _ in range(rng.choice([1, 2, 5])):
            data[rng.randrange(n)] = rng.randrange(256)
    elif kind == "truncate":
        del data[n - rng.randrange(1, 400):]
    elif kind == "insert":
        i = rng.randrange(n)
        data[i:i] = bytes(rng.choice(b" \n\r\t\x00\x0c%(<>/[") for _ in range(rng.randrange(1, 4)))
    elif kind == "keyword":
        word = rng.choice(KEYWORDS)
        hits = [m.start() for m in re.finditer(re.escape(word), bytes(data))]
        if hits:
            i = rng.choice(hits)
            op = rng.choice(["drop", "case", "dup", "space"])
            if op == "drop":
                del data[i:i + len(word)]
            elif op == "case":
                data[i:i + len(word)] = bytes(word).swapcase()
            elif op == "dup":
                data[i:i] = word + b" "
            else:
                data[i + len(word):i + len(word)] = b" "
    elif kind == "dupkey":
        hits = [m for m in re.finditer(rb"/(Type|Subtype|BaseFont|Encoding|FontDescriptor|Flags|Widths|ToUnicode) ", bytes(data))]
        if hits:
            m = rng.choice(hits)
            data[m.start():m.start()] = m.group(0) + b"/Null "
    elif kind == "delete":
        i = rng.randrange(n)
        del data[i:i + rng.randrange(1, 30)]
    elif kind == "ws":
        hits = [m.start() for m in re.finditer(rb"[ \n]", bytes(data[:max(1, n // 20)] + data[-n // 20:]))]
        if hits:
            i = rng.choice(hits)
            data[i:i + 1] = rng.choice([b"\r", b"\n\n", b"  ", b"\t", b"\x00"])
    return bytes(data)


def main():
    binary, count, seed, *pdfs = sys.argv[1:]
    count, seed = int(count), int(seed)
    rng = random.Random(seed)
    work = Path(tempfile.mkdtemp(prefix="inspector-fuzz-"))
    cases = []
    for pdf in pdfs:
        source = Path(pdf).read_bytes()
        for i in range(count):
            mutant = mutate(source, rng)
            path = work / f"{len(cases):05d}.pdf"
            path.write_bytes(mutant)
            cases.append((Path(pdf).name, path))
    python = subprocess.run([PYTHON, "-c", BULK], cwd=BACKEND, input="\n".join(str(p) for _, p in cases) + "\n",
                            capture_output=True, text=True, check=True)
    py_results = [json.loads(line) for line in python.stdout.splitlines()]
    assert len(py_results) == len(cases), (len(py_results), len(cases))
    tally = {"both-unsupported": 0, "equal": 0, "STRICT": 0, "LAX": 0, "DIFFER": 0}
    for (name, path), py in zip(cases, py_results):
        out = subprocess.run([binary, str(path)], capture_output=True, text=True, timeout=120).stdout
        rs = json.loads(out)
        py_ok, rs_ok = bool(py.get("supported")), bool(rs.get("supported"))
        if not py_ok and not rs_ok:
            tally["both-unsupported"] += 1
        elif py_ok and not rs_ok:
            tally["STRICT"] += 1
        elif rs_ok and not py_ok:
            tally["LAX"] += 1
            print("LAX   ", name, path)
        else:
            # `zeroMaskImages` only ever relaxes the backdrop proof, so a shorter list is a
            # stricter proof, not a difference.
            shorter = False
            for py_page, rs_page in zip(py.get("pages", []), rs.get("pages", [])):
                py_masks = (py_page.get("backdropContext") or {}).get("zeroMaskImages")
                rs_masks = (rs_page.get("backdropContext") or {}).get("zeroMaskImages")
                if isinstance(py_masks, list) and isinstance(rs_masks, list) and set(rs_masks) < set(py_masks):
                    py_page["backdropContext"]["zeroMaskImages"] = rs_masks
                    shorter = True
            a, b = {}, {}
            collect(py, a)
            collect(rs, b)
            diffs = [d for d in first_diffs(normalize(py, a), normalize(rs, b), limit=40) if not d.endswith(" != null")]
            stricter = len(first_diffs(normalize(py, a), normalize(rs, b), limit=40)) - len(diffs)
            tally["stricter-proof"] = tally.get("stricter-proof", 0) + bool((stricter or shorter) and not diffs)
            if diffs:
                tally["DIFFER"] += 1
                print("DIFFER", name, path)
                for d in diffs:
                    print("    ", d[:200])
            else:
                tally["equal"] += 1
    print(json.dumps(tally))
    if tally["LAX"] or tally["DIFFER"]:
        print("kept", work)
        sys.exit(1)
    for p in work.iterdir():
        p.unlink()
    work.rmdir()


if __name__ == "__main__":
    main()
