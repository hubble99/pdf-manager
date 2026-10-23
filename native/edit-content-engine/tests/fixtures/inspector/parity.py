"""Compares the Rust inspector's JSON with the old Python inspector's.

    python parity.py <rust-binary> <pdf> [<pdf> ...]

Both outputs must be identical except for `direct:<hash>` identities, which
only have to name the same equivalence classes on both sides. The Python side is
run from the backend directory with its own interpreter (BACKEND_PYTHON).
"""
import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[5] / "backend"
PYTHON = os.environ.get("BACKEND_PYTHON", str(Path("/home/user/venv/bin/python")))


def run_python(pdf):
    out = subprocess.run([PYTHON, "-m", "features.edit_content.resource_inspector_cli", "--input", pdf],
                         cwd=BACKEND, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def run_rust(binary, pdf):
    out = subprocess.run([binary, pdf], capture_output=True, text=True).stdout
    return json.loads(out)


def collect(value, ids):
    if isinstance(value, dict):
        for v in value.values():
            collect(v, ids)
    elif isinstance(value, list):
        for v in value:
            collect(v, ids)
    elif isinstance(value, str) and value.startswith("direct:"):
        ids.setdefault(value, len(ids))


def normalize(value, ids):
    if isinstance(value, dict):
        return {k: normalize(v, ids) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(v, ids) for v in value]
    if isinstance(value, str) and value.startswith("direct:"):
        return f"direct#{ids[value]}"
    return value


def first_diffs(a, b, path="", out=None, limit=12):
    out = [] if out is None else out
    if len(out) >= limit:
        return out
    if type(a) != type(b):
        out.append(f"{path}: {json.dumps(a)[:120]} != {json.dumps(b)[:120]}")
    elif isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                out.append(f"{path}/{k}: only on one side")
            else:
                first_diffs(a[k], b[k], f"{path}/{k}", out, limit)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append(f"{path}: length {len(a)} != {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            first_diffs(x, y, f"{path}[{i}]", out, limit)
    elif a != b:
        out.append(f"{path}: {json.dumps(a)[:120]} != {json.dumps(b)[:120]}")
    return out


def main():
    binary, *pdfs = sys.argv[1:]
    bad = 0
    for pdf in pdfs:
        py, rs = run_python(pdf), run_rust(binary, pdf)
        if not py.get("supported") or not rs.get("supported"):
            same = bool(py.get("supported")) == bool(rs.get("supported"))
            print(("OK  " if same else "DIFF"), Path(pdf).name, "supported:", py.get("supported"), rs.get("supported"))
            bad += not same
            continue
        py_ids, rs_ids = {}, {}
        # Number identities by first appearance in a stable walk.
        collect(py, py_ids)
        collect(rs, rs_ids)
        diffs = first_diffs(normalize(py, py_ids), normalize(rs, rs_ids))
        print(("OK  " if not diffs else "DIFF"), Path(pdf).name)
        for d in diffs:
            print("   ", d)
        bad += bool(diffs)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
