"""Read-only PDF resource/font inspection used by the native Content worker."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import io
import json
from pathlib import Path
from typing import Any

from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, StreamObject
from features.edit_content.preservation import image_resource_bindings, optional_proof, resource_fingerprints, semantic_hash
from features.edit_content.marked_content import marked_content_proof
from features.edit_content.empty_paint import text_paint_slots
from features.edit_content.backdrop import backdrop_context


SCHEMA_VERSION = "edit-content-resource-inspection/v1"
UNSUPPORTED_REASON = "REJECTED_UNSUPPORTED_STRUCTURE"


class _UnsupportedInspection(Exception):
    pass


@dataclass(frozen=True)
class ResourceInspection:
    supported: bool
    pages: tuple[dict[str, Any], ...] = ()
    shared_resources: tuple[dict[str, Any], ...] = ()

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "supported": self.supported,
        }
        if self.supported:
            payload["pages"] = list(self.pages)
            payload["sharedResources"] = list(self.shared_resources)
        else:
            payload["guardReason"] = UNSUPPORTED_REASON
            payload["error"] = "resource inspection is unavailable for this document"
        return payload


class ReadOnlyResourceInspector:
    """Inspects resource dictionaries without exposing a PDF writer."""

    def inspect(self, source: Path) -> ResourceInspection:
        try:
            path = Path(source)
            if path.is_symlink() or not path.is_file():
                raise _UnsupportedInspection
            source_bytes = path.read_bytes()
            reader = PdfReader(io.BytesIO(source_bytes), strict=True)
            if reader.is_encrypted:
                raise _UnsupportedInspection
            page_scopes = _page_resource_scopes(reader)
            pages: list[dict[str, Any]] = []
            resource_pages: dict[str, set[int]] = {}
            for page_index, (resources, inherited_from) in enumerate(page_scopes):
                fonts: list[dict[str, Any]] = []
                _walk_resources(
                    resources,
                    page_index=page_index,
                    inherited_from=inherited_from,
                    scope="page",
                    fonts=fonts,
                    resource_pages=resource_pages,
                    seen=set(),
                )
                pages.append(
                    {
                        "pageIndex": page_index,
                        "inheritedResourcesFrom": inherited_from,
                        "fonts": fonts,
                        "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
                        "textPaintSlots": optional_proof(
                            lambda value: text_paint_slots(reader.pages[page_index], value), resources),
                        "backdropContext": optional_proof(
                            lambda value: backdrop_context(reader.pages[page_index], value), resources),
                        "markedContentProof": optional_proof(
                            lambda value: marked_content_proof(reader.pages[page_index], value), resources),
                        "preservationResources": optional_proof(resource_fingerprints, resources),
                        "imageResourceBindings": optional_proof(
                            lambda value: image_resource_bindings(reader.pages[page_index], value), resources),
                        "pagePreservation": optional_proof(semantic_hash, DictionaryObject({
                            key: value for key, value in reader.pages[page_index].items()
                            if key not in {"/Type", "/Parent", "/Contents", "/Resources", "/MediaBox", "/CropBox", "/Rotate"}
                        })),
                    }
                )
            shared = tuple(
                {"resourceObject": object_id, "pageIndexes": sorted(indexes)}
                for object_id, indexes in sorted(resource_pages.items())
                if len(indexes) > 1
            )
            return ResourceInspection(True, tuple(pages), shared)
        except Exception:
            # The protocol intentionally exposes no parser exception or filesystem path.
            return ResourceInspection(False)


def _page_resource_scopes(reader: PdfReader) -> list[tuple[Any | None, str | None]]:
    root = _resolve(_raw_get(reader.trailer, "/Root"))
    if not isinstance(root, DictionaryObject):
        raise _UnsupportedInspection
    pages_root = _raw_get(root, "/Pages")
    scopes: list[tuple[Any | None, str | None]] = []
    active: set[str] = set()

    def walk(node_value: Any, inherited: Any | None, owner: str | None) -> None:
        node_id = _object_id(node_value)
        if node_id in active:
            raise _UnsupportedInspection
        active.add(node_id)
        node = _resolve(node_value)
        if not isinstance(node, DictionaryObject):
            raise _UnsupportedInspection
        local_resources = _raw_get(node, "/Resources", missing_ok=True)
        current = inherited if local_resources is None else local_resources
        current_owner = owner if local_resources is None else node_id
        node_type = str(node.get("/Type", ""))
        if node_type == "/Pages":
            kids = _resolve(_raw_get(node, "/Kids"))
            if not isinstance(kids, ArrayObject):
                raise _UnsupportedInspection
            for kid in kids:
                walk(kid, current, current_owner)
        elif node_type == "/Page":
            scopes.append((current, current_owner))
        else:
            raise _UnsupportedInspection
        active.remove(node_id)

    walk(pages_root, None, None)
    return scopes


def _walk_resources(
    resources_value: Any | None,
    *,
    page_index: int,
    inherited_from: str | None,
    scope: str,
    fonts: list[dict[str, Any]],
    resource_pages: dict[str, set[int]],
    seen: set[str],
) -> None:
    if resources_value is None:
        return
    resource_id = _object_id(resources_value)
    resource_pages.setdefault(resource_id, set()).add(page_index)
    if resource_id in seen:
        return
    seen.add(resource_id)
    resources = _resolve(resources_value)
    if not isinstance(resources, DictionaryObject):
        raise _UnsupportedInspection

    font_map_value = _raw_get(resources, "/Font", missing_ok=True)
    if font_map_value is not None:
        font_map = _resolve(font_map_value)
        if not isinstance(font_map, DictionaryObject):
            raise _UnsupportedInspection
        for resource_name, font_value in sorted(font_map.items(), key=lambda item: str(item[0])):
            fonts.append(
                {
                    "resourceName": str(resource_name),
                    "resourceObject": resource_id,
                    "resourceInheritedFrom": inherited_from,
                    "scope": scope,
                    **_inspect_font(font_value, active=set()),
                }
            )

    xobjects_value = _raw_get(resources, "/XObject", missing_ok=True)
    if xobjects_value is None:
        return
    xobjects = _resolve(xobjects_value)
    if not isinstance(xobjects, DictionaryObject):
        raise _UnsupportedInspection
    for name, xobject_value in sorted(xobjects.items(), key=lambda item: str(item[0])):
        xobject = _resolve(xobject_value)
        if not isinstance(xobject, DictionaryObject):
            raise _UnsupportedInspection
        if str(xobject.get("/Subtype", "")) != "/Form":
            continue
        nested = _raw_get(xobject, "/Resources", missing_ok=True)
        if nested is not None:
            _walk_resources(
                nested,
                page_index=page_index,
                inherited_from=_object_id(xobject_value),
                scope=f"{scope}/XObject:{name}",
                fonts=fonts,
                resource_pages=resource_pages,
                seen=seen,
            )


def _inspect_font(font_value: Any, active: set[str]) -> dict[str, Any]:
    font_id = _object_id(font_value)
    if font_id in active:
        raise _UnsupportedInspection
    active.add(font_id)
    font = _resolve(font_value)
    if not isinstance(font, DictionaryObject):
        raise _UnsupportedInspection
    subtype = str(font.get("/Subtype", ""))
    base_font = str(font.get("/BaseFont", ""))
    if not subtype:
        raise _UnsupportedInspection

    encoding = _inspect_encoding(_raw_get(font, "/Encoding", missing_ok=True))
    to_unicode = _inspect_stream(_raw_get(font, "/ToUnicode", missing_ok=True))
    descendants_value = _raw_get(font, "/DescendantFonts", missing_ok=True)
    descendants: list[dict[str, Any]] = []
    if descendants_value is not None:
        descendants_array = _resolve(descendants_value)
        if not isinstance(descendants_array, ArrayObject) or not descendants_array:
            raise _UnsupportedInspection
        descendants = [_inspect_font(item, active.copy()) for item in descendants_array]
    elif subtype == "/Type0":
        raise _UnsupportedInspection

    descriptor_value = _raw_get(font, "/FontDescriptor", missing_ok=True)
    descriptor = _inspect_descriptor(descriptor_value)
    widths = _inspect_widths(font)
    cid_to_gid = _inspect_cid_to_gid(_raw_get(font, "/CIDToGIDMap", missing_ok=True))
    glyph_coverage = _inspect_glyph_coverage(
        font,
        descriptor_value=descriptor_value,
        subtype=subtype,
        base_font=base_font,
        encoding=encoding,
    )
    if subtype == "/Type0":
        if len(descendants) == 1:
            glyph_coverage = descendants[0]["glyphCoverage"]
        else:
            glyph_coverage = {
                "status": "unknown",
                "source": "ambiguous-descendant-fonts",
                "ranges": [],
            }
    result = {
        "fontObject": font_id,
        "semanticSha256": optional_proof(semantic_hash, font_value),
        "baseFont": base_font,
        "effectiveBaseFont": _effective_base_font(base_font),
        "collisionEffectiveBaseFont": _collision_effective_base_font(base_font, subtype),
        "subtype": subtype,
        "encoding": encoding,
        "toUnicode": to_unicode,
        "fontPrograms": descriptor,
        "glyphCoverage": glyph_coverage,
        "widths": widths,
        "cidToGidMap": cid_to_gid,
        "cidSystemInfo": _canonical(_raw_get(font, "/CIDSystemInfo", missing_ok=True)),
        "descendants": descendants,
    }
    active.remove(font_id)
    return result


def _inspect_encoding(value: Any | None) -> dict[str, Any] | None:
    if value is None:
        return None
    resolved = _resolve(value)
    if isinstance(resolved, str):
        detail: Any = {"name": str(resolved)}
    elif isinstance(resolved, DictionaryObject):
        detail = {
            "baseEncoding": str(resolved.get("/BaseEncoding", "")) or None,
            "differences": _canonical(_raw_get(resolved, "/Differences", missing_ok=True)),
        }
    else:
        raise _UnsupportedInspection
    return {"detail": detail, "sha256": _json_hash(detail)}


def _inspect_stream(value: Any | None) -> dict[str, Any] | None:
    if value is None:
        return None
    stream = _resolve(value)
    if not isinstance(stream, StreamObject):
        raise _UnsupportedInspection
    data = stream.get_data()
    if not isinstance(data, bytes):
        raise _UnsupportedInspection
    return {
        "object": _object_id(value),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def _inspect_descriptor(value: Any | None) -> list[dict[str, Any]]:
    if value is None:
        return []
    descriptor = _resolve(value)
    if not isinstance(descriptor, DictionaryObject):
        raise _UnsupportedInspection
    programs = []
    for key in ("/FontFile", "/FontFile2", "/FontFile3"):
        program = _raw_get(descriptor, key, missing_ok=True)
        if program is not None:
            detail = _inspect_stream(program)
            if detail is None:
                raise _UnsupportedInspection
            programs.append({"kind": key, **detail})
    return programs


def _inspect_glyph_coverage(
    font: DictionaryObject,
    *,
    descriptor_value: Any | None,
    subtype: str,
    base_font: str,
    encoding: dict[str, Any] | None,
) -> dict[str, Any]:
    """Return a bounded Unicode coverage proof without exposing font bytes."""
    if subtype == "/Type3":
        return {"status": "type3", "source": "type3", "ranges": []}

    program_data: bytes | None = None
    program_hash: str | None = None
    if descriptor_value is not None:
        descriptor = _resolve(descriptor_value)
        if not isinstance(descriptor, DictionaryObject):
            raise _UnsupportedInspection
        for key in ("/FontFile2", "/FontFile3", "/FontFile"):
            value = _raw_get(descriptor, key, missing_ok=True)
            if value is None:
                continue
            stream = _resolve(value)
            if not isinstance(stream, StreamObject):
                raise _UnsupportedInspection
            program_data = stream.get_data()
            if not isinstance(program_data, bytes):
                raise _UnsupportedInspection
            program_hash = hashlib.sha256(program_data).hexdigest()
            break

    encoding_points = _encoding_codepoints(font)
    if program_data is not None:
        coverage = _font_cmap_codepoints(program_data)
        if coverage is None:
            return {
                "status": "unknown",
                "source": "embedded-program-unparseable",
                "ranges": [],
                "fontProgramSha256": program_hash,
                "encodingSha256": encoding.get("sha256") if encoding else None,
            }
        if encoding_points is not None and subtype not in {
            "/Type0", "/CIDFontType0", "/CIDFontType2"
        }:
            coverage &= encoding_points
        return {
            "status": "proven",
            "source": "embedded-cmap-and-encoding",
            "ranges": _codepoint_ranges(coverage),
            "fontProgramSha256": program_hash,
            "encodingSha256": encoding.get("sha256") if encoding else None,
        }

    standard_name = _effective_base_font(base_font)
    base14 = {
        "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
        "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
        "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
    }
    if standard_name in base14 and encoding_points is not None:
        return {
            "status": "proven",
            "source": "standard-font-encoding",
            "ranges": _codepoint_ranges(encoding_points),
            "fontProgramSha256": None,
            "encodingSha256": encoding.get("sha256") if encoding else None,
        }
    return {
        "status": "unknown",
        "source": "font-program-or-encoding-unavailable",
        "ranges": [],
        "fontProgramSha256": program_hash,
        "encodingSha256": encoding.get("sha256") if encoding else None,
    }


def _font_cmap_codepoints(data: bytes) -> set[int] | None:
    try:
        from fontTools.ttLib import TTFont

        font = TTFont(io.BytesIO(data), fontNumber=0, lazy=True)
        try:
            cmap = font.getBestCmap()
            if cmap:
                return set(cmap)
            if "cmap" not in font:
                return None
            points: set[int] = set()
            for table in font["cmap"].tables:
                points.update(table.cmap)
            return points or None
        finally:
            font.close()
    except Exception:
        return None


def _encoding_codepoints(font: DictionaryObject) -> set[int] | None:
    value = _raw_get(font, "/Encoding", missing_ok=True)
    if value is None:
        return set(range(0x20, 0x7F))
    resolved = _resolve(value)
    if isinstance(resolved, str):
        return _named_encoding_codepoints(str(resolved))
    if not isinstance(resolved, DictionaryObject):
        return None
    base = _named_encoding_codepoints(str(resolved.get("/BaseEncoding", "/StandardEncoding")))
    if base is None:
        base = set()
    differences = _raw_get(resolved, "/Differences", missing_ok=True)
    if differences is not None:
        array = _resolve(differences)
        if not isinstance(array, ArrayObject):
            return None
        try:
            from fontTools.agl import toUnicode

            for item in array:
                if isinstance(item, str) and str(item).startswith("/"):
                    mapped = toUnicode(str(item)[1:])
                    base.update(ord(character) for character in mapped)
        except Exception:
            return None
    return base


def _named_encoding_codepoints(name: str) -> set[int] | None:
    normalized = name.removeprefix("/")
    codec = {"WinAnsiEncoding": "cp1252", "MacRomanEncoding": "mac_roman"}.get(normalized)
    if codec:
        points: set[int] = set()
        for value in range(0x20, 0x100):
            try:
                points.add(ord(bytes([value]).decode(codec)))
            except UnicodeDecodeError:
                continue
        return points
    if normalized == "StandardEncoding":
        return set(range(0x20, 0x7F))
    if normalized in {"Identity-H", "Identity-V"}:
        return None
    return None


def _codepoint_ranges(points: set[int]) -> list[list[int]]:
    ranges: list[list[int]] = []
    for point in sorted(points):
        if not ranges or point > ranges[-1][1] + 1:
            ranges.append([point, point])
        else:
            ranges[-1][1] = point
    return ranges


def _inspect_widths(font: DictionaryObject) -> dict[str, Any] | None:
    fields = {}
    for key in ("/FirstChar", "/LastChar", "/Widths", "/DW", "/W", "/DW2", "/W2"):
        value = _raw_get(font, key, missing_ok=True)
        if value is not None:
            fields[key[1:]] = _canonical(value)
    if not fields:
        return None
    return {"detail": fields, "sha256": _json_hash(fields)}


def _inspect_cid_to_gid(value: Any | None) -> dict[str, Any] | None:
    if value is None:
        return None
    resolved = _resolve(value)
    if isinstance(resolved, str):
        detail = {"name": str(resolved)}
        return {"detail": detail, "sha256": _json_hash(detail)}
    return _inspect_stream(value)


def _canonical(value: Any | None, depth: int = 0) -> Any:
    if value is None:
        return None
    if depth > 16:
        raise _UnsupportedInspection
    if isinstance(value, IndirectObject):
        return {
            "ref": _object_id(value),
            "value": _canonical(_resolve(value), depth + 1),
        }
    resolved = _resolve(value)
    if isinstance(resolved, ArrayObject):
        return [_canonical(item, depth + 1) for item in resolved]
    if isinstance(resolved, DictionaryObject):
        return {
            str(key): _canonical(item, depth + 1)
            for key, item in sorted(resolved.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(resolved, bytes):
        return {"bytes": len(resolved), "sha256": hashlib.sha256(resolved).hexdigest()}
    if isinstance(resolved, (str, int, float, bool)):
        return resolved
    raise _UnsupportedInspection


def _raw_get(dictionary: Any, key: str, *, missing_ok: bool = False) -> Any | None:
    if not isinstance(dictionary, DictionaryObject):
        raise _UnsupportedInspection
    try:
        return dictionary.raw_get(key)
    except KeyError:
        if missing_ok:
            return None
        raise _UnsupportedInspection from None


def _resolve(value: Any) -> Any:
    try:
        return value.get_object()
    except Exception as exc:
        raise _UnsupportedInspection from exc


def _object_id(value: Any) -> str:
    reference = value if isinstance(value, IndirectObject) else getattr(value, "indirect_reference", None)
    if isinstance(reference, IndirectObject):
        return f"{reference.idnum}:{reference.generation}"
    try:
        fingerprint = value.hash_value_data()
        if not isinstance(fingerprint, bytes):
            fingerprint = repr(value).encode("utf-8", "replace")
    except Exception:
        fingerprint = repr(value).encode("utf-8", "replace")
    return f"direct:{hashlib.sha256(fingerprint).hexdigest()}"


def _effective_base_font(value: str) -> str:
    name = value.removeprefix("/")
    if len(name) > 7 and name[6] == "+" and name[:6].isalpha() and name[:6].isupper():
        return name[7:]
    return name


def _collision_effective_base_font(value: str, subtype: str) -> str:
    name = value.removeprefix("/")
    if subtype in {"/Type0", "/CIDFontType0", "/CIDFontType2"}:
        return name
    return _effective_base_font(value)


def _json_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    return hashlib.sha256(encoded).hexdigest()
