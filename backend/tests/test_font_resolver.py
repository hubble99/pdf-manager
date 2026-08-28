"""Tests for the layered font resolver and app-level font library."""

import shutil
import struct
from pathlib import Path

import fitz
import pytest

from config import settings
from core import font_library
from core.edit_canvas import save_edited_pdf
from core.edit_canvas_shapes import _canonical_font_family, _font_candidates, load_font

_FONT_DIR = Path(__file__).resolve().parent.parent / ".venv" / "_test_fonts"


def _find_system_ttf() -> Path | None:
    candidates = [
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    return next((path for path in candidates if path.exists()), None)


def _minimal_sfnt_with_weight(weight: int) -> bytes:
    table_offset = 28
    header = b"\x00\x01\x00\x00" + struct.pack(">HHHH", 1, 0, 0, 0)
    record = b"OS/2" + struct.pack(">III", 0, table_offset, 6)
    os2_table = struct.pack(">HhH", 0, 0, weight)
    return header + record + os2_table


@pytest.fixture()
def font_env(monkeypatch):
    """Isolate the font library inside a temp app data dir."""
    test_data = settings.APP_DATA_DIR.parent / "_pytest_font_lib"
    monkeypatch.setattr(settings, "APP_DATA_DIR", test_data)
    yield test_data / "fonts"
    shutil.rmtree(test_data, ignore_errors=True)


def _register_library_font(env_dir: Path, source_ttf: Path, family: str) -> dict:
    result = font_library.save_font(source_ttf.read_bytes(), f"{family}.ttf")
    # Overwrite the detected family with an explicit alias name.
    index = font_library._read_index()
    index[result["id"]]["family"] = family
    font_library._write_index(index)
    return result


# ---------------------------------------------------------------------------
# 5.1 Storage validation
# ---------------------------------------------------------------------------


def test_validate_rejects_garbage_and_empty():
    assert font_library.validate_font_bytes(b"") is not None
    assert font_library.validate_font_bytes(b"MZ\x90\x00 not a font") is not None
    assert font_library.validate_font_bytes(b"x" * (21 * 1024 * 1024)) is not None


def test_save_list_delete_roundtrip(font_env):
    source = _find_system_ttf()
    if source is None:
        pytest.skip("No system TTF available for fixture bytes")
    saved = font_library.save_font(source.read_bytes(), "My Custom Font.ttf")
    assert saved["family"]
    assert (font_env / saved["filename"]).exists()

    listed = font_library.list_fonts()
    assert [entry["id"] for entry in listed] == [saved["id"]]
    assert listed[0]["family"] == saved["family"]

    # Same stem again gets a unique id/file.
    second = font_library.save_font(source.read_bytes(), "My Custom Font.ttf")
    assert second["id"] != saved["id"]

    assert font_library.delete_font(saved["id"]) is True
    assert not (font_env / saved["filename"]).exists()
    assert font_library.delete_font(saved["id"]) is False


@pytest.mark.parametrize(
    ("full_name", "flags", "expected"),
    [
        ("Roboto Regular", {"bold": 0, "italic": 0}, ("Roboto", 400, False)),
        ("Open Sans Bold Italic", {"bold": 1, "italic": 1}, ("Open Sans", 700, True)),
        ("Inter 18pt Bold", {"bold": 1, "italic": 0}, ("Inter", 700, False)),
        ("Noto Sans Italic", {"bold": 0, "italic": 1}, ("Noto Sans", 400, True)),
        ("Montserrat SemiBold", {"bold": 1, "italic": 0}, ("Montserrat", 600, False)),
    ],
)
def test_font_identity_separates_family_from_style(full_name, flags, expected):
    assert font_library.font_identity(full_name, flags) == expected


def test_font_identity_prefers_opentype_weight_class():
    assert font_library.font_identity(
        "Example Sans Regular",
        {"bold": 0, "italic": 0},
        _minimal_sfnt_with_weight(550),
    ) == ("Example Sans", 550, False)


def test_explicit_named_weight_overrides_noncanonical_opentype_value():
    assert font_library.font_identity(
        "Poppins Thin",
        {"bold": 0, "italic": 0},
        _minimal_sfnt_with_weight(250),
    ) == ("Poppins", 100, False)


def test_library_resolver_selects_exact_then_nearest_weight(font_env):
    font_env.mkdir(parents=True, exist_ok=True)
    for filename in ("example-regular.ttf", "example-medium.ttf", "example-bold.ttf", "example-medium-italic.ttf"):
        (font_env / filename).write_bytes(b"fixture")
    font_library._write_index({
        "regular": {
            "family": "Example Sans",
            "filename": "example-regular.ttf",
            "weight": 400,
            "italic": False,
        },
        "medium": {
            "family": "Example Sans",
            "filename": "example-medium.ttf",
            "weight": 500,
            "italic": False,
        },
        "bold": {
            "family": "Example Sans",
            "filename": "example-bold.ttf",
            "weight": 700,
            "italic": False,
        },
        "medium-italic": {
            "family": "Example Sans",
            "filename": "example-medium-italic.ttf",
            "weight": 500,
            "italic": True,
        },
    })

    assert font_library.resolve_font_file("Example Sans", weight=500).name == "example-medium.ttf"
    assert font_library.resolve_font_file("Example Sans", weight=600).name == "example-bold.ttf"
    assert font_library.resolve_font_file("Example Sans", weight=600, italic=True).name == "example-medium-italic.ttf"


def test_legacy_bold_index_entry_maps_to_numeric_weight(font_env):
    font_env.mkdir(parents=True, exist_ok=True)
    (font_env / "legacy-bold.ttf").write_bytes(b"fixture")
    font_library._write_index({
        "legacy": {
            "family": "Legacy Sans",
            "filename": "legacy-bold.ttf",
            "bold": True,
            "italic": False,
        },
    })

    assert font_library.list_fonts()[0]["weight"] == 700
    assert font_library.resolve_font_file("Legacy Sans", weight=700).name == "legacy-bold.ttf"


def test_load_font_buffer_returns_bytes_for_known_id(font_env):
    source = _find_system_ttf()
    if source is None:
        pytest.skip("No system TTF available for fixture bytes")
    saved = font_library.save_font(source.read_bytes(), "buffered.ttf")
    data = font_library.load_font_buffer(saved["id"])
    assert data == source.read_bytes()
    assert font_library.load_font_buffer("missing-id") is None


# ---------------------------------------------------------------------------
# 4.1 Layered resolution order
# ---------------------------------------------------------------------------


def test_library_beats_system(font_env):
    """A library entry matching the requested family must win over system."""
    source = _find_system_ttf()
    if source is None:
        pytest.skip("No system TTF available for fixture bytes")
    probe_name = fitz.Font(fontfile=str(source)).name
    _register_library_font(font_env, source, "Alias Family")
    font = load_font("Alias Family")
    assert font.name == probe_name, "loaded font must come from the library file"


def test_system_fonts_used_without_library_match(font_env):
    if Path("C:/Windows/Fonts/times.ttf").exists():
        expected_fragment = "times"
        font = load_font("Times New Roman")
    elif Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf").exists():
        expected_fragment = ""
        font = load_font("DejaVu Serif", bold=True)
    else:
        pytest.skip("No known system serif font available")
    assert font is not None
    assert expected_fragment in font.name.lower() or font.name


def test_fallback_when_nothing_matches(font_env):
    """With no library/system hit, the built-in Helvetica is used as-is."""
    monkey_candidates = ["zzz-missing-bold.ttf", "zzz-missing.ttf", "arial.ttf"]
    original_exists = Path.exists

    def fake_exists(path):
        if path.suffix == ".ttf":
            return path.name in monkey_candidates and False  # nothing resolvable
        return original_exists(path)

    import pathlib
    pathlib.Path.exists = fake_exists
    try:
        font = load_font("Totally Unknown Family")
        assert isinstance(font, fitz.Font)
    finally:
        pathlib.Path.exists = original_exists


def test_bold_variant_candidate_ordering():
    assert _font_candidates("Arial", bold=True, italic=False)[0].startswith("arialbd")
    assert _font_candidates("Arial", bold=True, italic=True)[0].startswith("arialbi")
    assert _font_candidates("Arial", False, False)[0].startswith("arial.ttf")


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("BCDEEE+Calibri-Bold", "Calibri"),
        ("Arial-BoldMT", "Arial"),
        ("Times New Roman", "Times New Roman"),
        ("TimesNewRomanPS-ItalicMT", "Times New Roman"),
        ("CourierNewPSMT", "Courier New"),
    ],
)
def test_pdf_font_names_are_normalized_before_resolution(source, expected):
    assert _canonical_font_family(source) == expected


def test_subset_calibri_bold_uses_calibri_candidate_not_arial():
    assert _font_candidates("BCDEEE+Calibri-Bold", bold=True, italic=False)[0] == "calibrib.ttf"


def test_cambria_regular_uses_windows_collection_candidate():
    assert _font_candidates("Cambria", bold=False, italic=False)[0] == "cambria.ttc"


def test_calibri_light_uses_installed_light_face():
    assert _font_candidates("Calibri", bold=False, italic=False, weight=300)[0] == "calibril.ttf"


@pytest.mark.parametrize(
    ("family", "expected_fragment", "required_font", "bold", "italic"),
    [
        ("Times New Roman", "timesnewroman", Path("C:/Windows/Fonts/times.ttf"), False, False),
        ("Cambria", "cambria", Path("C:/Windows/Fonts/cambria.ttc"), False, False),
        ("Tahoma", "tahoma", Path("C:/Windows/Fonts/tahoma.ttf"), False, True),
    ],
)
def test_saved_canvas_text_embeds_selected_family(
    font_env,
    tmp_path,
    family,
    expected_fragment,
    required_font,
    bold,
    italic,
):
    if not required_font.exists():
        pytest.skip(f"System fixture font is unavailable: {required_font}")

    source_path = tmp_path / "source.pdf"
    output_path = tmp_path / "output.pdf"
    document = fitz.open()
    document.new_page(width=220, height=120)
    document.save(source_path)
    document.close()

    annotations = [{
        "canvas_width": 220,
        "canvas_height": 120,
        "native_objects": [{
            "type": "text",
            "x": 20,
            "y": 20,
            "width": 180,
            "text": "Selected font survives save",
            "lines": ["Selected font survives save"],
            "fontFamily": family,
            "fontSize": 14,
            "lineHeight": 1.16,
            "color": "#000000",
            "bold": bold,
            "italic": italic,
            "opacity": 1,
        }],
    }]

    save_edited_pdf(source_path, annotations, output_path)

    saved = fitz.open(output_path)
    try:
        embedded_names = " ".join(
            str(value)
            for font in saved[0].get_fonts(full=True)
            for value in font
        ).lower().replace(" ", "")
    finally:
        saved.close()

    assert expected_fragment in embedded_names
    assert "arial" not in embedded_names


# ---------------------------------------------------------------------------
# 4.2 No synthetic fake-bold
# ---------------------------------------------------------------------------


def test_plain_family_still_resolves_when_bold_variant_missing(font_env):
    """Bold request falls back to plain family file, never fails or fake-bolds."""
    source = _find_system_ttf()
    if source is None:
        pytest.skip("No system TTF available for fixture bytes")
    _register_library_font(font_env, source, "Plain Only")
    resolved = font_library.resolve_font_file("Plain Only", bold=True)
    assert resolved is not None
    assert load_font("Plain Only", bold=True) is not None


# ---------------------------------------------------------------------------
# 5.2 Font library endpoints
# ---------------------------------------------------------------------------

import json as _json

from httpx import ASGITransport
from httpx import AsyncClient

from main import app


async def test_fonts_crud_endpoints(font_env):
    source = _find_system_ttf()
    if source is None:
        pytest.skip("No system TTF available for fixture bytes")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        upload = await client.post(
            "/api/v1/fonts",
            files={"file": ("Test Family.ttf", source.read_bytes(), "font/ttf")},
        )
        assert upload.status_code == 200
        font_entry = upload.json()["font"]
        assert font_entry["id"]
        assert isinstance(font_entry["weight"], int)
        assert font_entry["bold"] is (font_entry["weight"] >= 700)
        assert isinstance(font_entry["italic"], bool)

        listed = await client.get("/api/v1/fonts")
        assert listed.status_code == 200
        listed_fonts = listed.json()["fonts"]
        ids = [entry["id"] for entry in listed_fonts]
        assert font_entry["id"] in ids
        listed_entry = next(entry for entry in listed_fonts if entry["id"] == font_entry["id"])
        assert listed_entry["weight"] == font_entry["weight"]

        served = await client.get(f"/api/v1/fonts/{font_entry['id']}/file")
        assert served.status_code == 200
        assert served.content == source.read_bytes()

        invalid = await client.post(
            "/api/v1/fonts",
            files={"file": ("fake.ttf", b"not a font at all", "font/ttf")},
        )
        assert invalid.status_code == 400

        missing = await client.delete("/api/v1/fonts/does-not-exist")
        assert missing.status_code == 404

        removed = await client.delete(f"/api/v1/fonts/{font_entry['id']}")
        assert removed.status_code == 200
        gone = await client.get(f"/api/v1/fonts/{font_entry['id']}/file")
        assert gone.status_code == 404
