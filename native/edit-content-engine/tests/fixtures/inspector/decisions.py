"""Edit decisions of the real worker with the Python and the native inspector.

    EDIT_CONTENT_TEST_PDFIUM_PATH=<libpdfium> python decisions.py <worker> <pdf> [<pdf> ...]

For every text object the worker discovers, a read-only preflight of a one
character replacement is run, and the decision (editable or view-only reason,
preflight verdict) is recorded. The two inspectors must give the same decisions
for every object of every document; the edit rate is the share of objects whose
preflight is eligible. Prints one line per document and exits 1 on any
difference.
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[5] / "backend"
PYTHON = os.environ.get("BACKEND_PYTHON", "/home/user/venv/bin/python")
SCRIPT = BACKEND / "features/edit_content/resource_inspector_cli.py"


class Worker:
    def __init__(self, binary, pdf, native, root):
        library = os.environ["EDIT_CONTENT_TEST_PDFIUM_PATH"]
        command = [binary, "--pdfium-library", library, "--session-id", "s",
                   "--workspace-root", str(root), "--source-file", pdf]
        env = dict(os.environ)
        if native:
            command.append("--native-inspector")
        else:
            command += ["--inspector-program", PYTHON, "--inspector-arg", str(SCRIPT)]
            env["PYTHONPATH"] = str(BACKEND)
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, env=env)
        self.sequence = 0

    def call(self, command, revision=None, payload=None, target=None):
        self.sequence += 1
        request = {"schemaVersion": "edit-content-request/v1", "requestId": f"{command}-{self.sequence}",
                   "sessionId": "s", "command": command, "payload": payload or {}}
        if revision is not None:
            request["expectedAcceptedRevision"] = revision
        if target is not None:
            request["targetId"] = target
        data = json.dumps(request).encode()
        self.process.stdin.write(struct.pack(">I", len(data)) + data)
        self.process.stdin.flush()
        header = self.process.stdout.read(4)
        return json.loads(self.process.stdout.read(struct.unpack(">I", header)[0]))

    def close(self):
        try:
            self.call("close", 0)
        finally:
            self.process.stdin.close()
            self.process.wait(timeout=30)


def decisions(binary, pdf, native):
    with tempfile.TemporaryDirectory() as root:
        worker = Worker(binary, pdf, native, root)
        try:
            opened = worker.call("open")
            if opened["status"] != "accepted":
                return {"open": [opened["status"], opened.get("guardReason")]}
            reply = worker.call("inspect", 0)
            if reply["status"] != "accepted":
                return {"inspect": [reply["status"], reply.get("guardReason")]}
            objects = reply["result"]["discovery"]["textObjects"]
            result = {}
            for index, obj in enumerate(objects):
                key = f"{obj.get('pageIndex')}:{index}"
                text = obj.get("text") or ""
                record = {k: v for k, v in obj.items()
                          if k not in ("targetId", "text", "bounds", "id", "nativeObjectIdentity") and not isinstance(v, (dict, list))}
                if text and obj.get("targetId"):
                    old = text[0]
                    new = "e" if old != "e" else "a"
                    edit = {"expectedText": text, "expectedOldText": old, "replacementText": new,
                            "utf16Start": 0, "utf16End": len(old.encode("utf-16-le")) // 2,
                            "operation": "preflight"}
                    verdict = worker.call("inspect", 0, edit, obj["targetId"])
                    record["preflight"] = [verdict["status"], verdict.get("guardReason"),
                                           (verdict.get("result", {}).get("preflight") or {}).get("detailCodes")]
                result[key] = record
            return result
        finally:
            worker.close()


def eligible(side):
    return sum(1 for r in side.values() if isinstance(r, dict) and (r.get("preflight") or [None])[0] == "accepted")


def main():
    binary, pdfs = sys.argv[1], sys.argv[2:]
    failed = False
    for pdf in pdfs:
        python_side = decisions(binary, pdf, False)
        native_side = decisions(binary, pdf, True)
        same = python_side == native_side
        failed |= not same
        print(f"{'OK  ' if same else 'DIFF'} {Path(pdf).name}: {eligible(native_side)}/{len(native_side)} eligible"
              + ("" if same else f" (python {eligible(python_side)})"), flush=True)
        if not same:
            for key in sorted(set(python_side) | set(native_side)):
                if python_side.get(key) != native_side.get(key):
                    print("   ", key, python_side.get(key), native_side.get(key))
                    break
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
