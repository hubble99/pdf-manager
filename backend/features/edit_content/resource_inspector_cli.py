"""Protocol-only CLI for the read-only resource inspector."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from features.edit_content.resource_inspector import ReadOnlyResourceInspector


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    args = parser.parse_args()
    payload = ReadOnlyResourceInspector().inspect(args.input).to_payload()
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
