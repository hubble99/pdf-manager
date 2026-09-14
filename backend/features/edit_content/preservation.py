"""Read-only, xref-independent resource identities for persisted verification.

These are dependency fingerprints, not an alternate PDF editing model. Native
object correspondence and geometry are still required by the worker verifier.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

from pypdf.generic import (
    ArrayObject, BooleanObject, DictionaryObject, IndirectObject, NullObject,
    StreamObject,
)


class UnprovenPreservation(ValueError):
    pass


def semantic_value(value: Any, *, _active: frozenset = frozenset(), _depth: int = 0) -> Any:
    """Resolve references; hash decoded bytes, retaining masks and dependencies.

    Cycles and excessive depth fail closed. Stream transport spelling is not
    semantic identity; decoded data and the remaining dictionary are.
    """
    if _depth > 32:
        raise UnprovenPreservation("resource nesting exceeds the proof boundary")
    if isinstance(value, IndirectObject):
        key = (id(value.pdf), value.idnum, value.generation)
        if key in _active:
            raise UnprovenPreservation("cyclic resource dependency")
        return semantic_value(value.get_object(), _active=_active | {key}, _depth=_depth + 1)
    descend = lambda child: semantic_value(child, _active=_active, _depth=_depth + 1)
    if value is None or isinstance(value, NullObject):
        return None
    if isinstance(value, BooleanObject):
        return bool(value.value)
    if isinstance(value, StreamObject):
        data = value.get_data()
        if not isinstance(data, bytes) or len(data) > 64 * 1024 * 1024:
            raise UnprovenPreservation("unbounded decoded stream")
        return {
            "dictionary": {str(key): descend(item) for key, item in sorted(value.items())
                           if key not in {"/Length", "/Filter", "/DecodeParms"}},
            "decodedBytes": len(data), "decodedSha256": hashlib.sha256(data).hexdigest(),
        }
    if isinstance(value, DictionaryObject):
        return {str(key): descend(item) for key, item in sorted(value.items())}
    if isinstance(value, (ArrayObject, list, tuple)):
        return [descend(item) for item in value]
    if isinstance(value, bytes):
        return {"bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
    if isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float) and math.isfinite(value):
        # PDF integer/real spelling is not a semantic difference.
        return int(value) if value.is_integer() else value
    raise UnprovenPreservation("unsupported resource value")


def semantic_hash(value: Any) -> str:
    canonical = json.dumps(semantic_value(value), sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def optional_proof(producer, value: Any) -> Any:
    """Missing phase-5 proof blocks verification, not read-only discovery."""
    try:
        return producer(value)
    except Exception:
        return None


def resource_fingerprints(resources: Any) -> dict[str, list[str]]:
    """Preserve each dependency's multiplicity independently of resource aliases.

    Fonts are matched per native text object separately. Form resource/content
    alias rewriting has no proof here and must reject through native coverage.
    """
    if resources is None:
        return {}
    resolved = resources.get_object()
    if not isinstance(resolved, DictionaryObject):
        raise UnprovenPreservation("invalid resource dictionary")
    result = {}
    for kind, items in resolved.items():
        if kind in {"/Font", "/ProcSet"}:
            continue
        mapping = items.get_object()
        if not isinstance(mapping, DictionaryObject):
            raise UnprovenPreservation("unknown resource category")
        if kind == "/ExtGState":
            # PDFium emits explicit defaults during regeneration. Native APIs
            # cannot read blend mode: support only this proven default subset,
            # not arbitrary state dictionaries with coincidentally equal hashes.
            for state in mapping.values():
                state = semantic_value(state)
                defaults = {"/Type": "/ExtGState", "/BM": "/Normal", "/CA": 1, "/ca": 1}
                if not isinstance(state, dict) or any(key not in defaults or defaults[key] != value
                                                      for key, value in state.items()):
                    raise UnprovenPreservation("unproven nondefault graphics state")
            continue
        result[str(kind)] = sorted(semantic_hash(item) for item in mapping.values())
    return result


def image_resource_bindings(page: Any, resources: Any) -> list[dict[str, str]]:
    """Bind only distinct named image streams, retaining every mask dependency.

    Encoded bytes identify the resource *within this file*, not across saves.
    Full semantic hashes (including masks/filters' decoded meaning) are what
    the native verifier compares across files. Inline images, forms, and
    duplicate raw streams cannot establish that binding and fail closed.
    """
    resolved = resources.get_object() if resources is not None else DictionaryObject()
    if not isinstance(resolved, DictionaryObject):
        raise UnprovenPreservation('invalid image resource scope')
    contents = page.get_contents()
    if contents is not None and any(op == b'INLINE IMAGE' for _, op in contents.operations):
        raise UnprovenPreservation('inline image binding is unavailable')
    mapping = resolved.get('/XObject', DictionaryObject()).get_object()
    if not isinstance(mapping, DictionaryObject):
        raise UnprovenPreservation('invalid image resource dictionary')
    result, seen = [], set()
    for value in mapping.values():
        image = value.get_object()
        if not isinstance(image, StreamObject) or image.get('/Subtype') != '/Image':
            raise UnprovenPreservation('opaque or nested image resource')
        # pypdf's decoded get_data() drops the transport identity exposed by
        # FPDFImageObj_GetImageDataRaw; use the pinned parser's stored bytes.
        raw = image._data
        if not isinstance(raw, bytes) or not raw or len(raw) > 64 * 1024 * 1024:
            raise UnprovenPreservation('unbounded or empty image stream')
        fingerprint = hashlib.sha256(raw).hexdigest()
        if fingerprint in seen:
            raise UnprovenPreservation('ambiguous image stream identity')
        seen.add(fingerprint)
        result.append({'rawSha256': fingerprint, 'semanticSha256': semantic_hash(value)})
    return sorted(result, key=lambda entry: entry['rawSha256'])
