"""Stable HTTP contract checks for the public API surface."""

import pytest
from httpx import ASGITransport, AsyncClient

from main import app


EXPECTED_API_ROUTES = {
    ("POST", "/api/v1/merge/"),
    ("POST", "/api/v1/extract/"),
    ("POST", "/api/v1/compress/"),
    ("POST", "/api/v1/compress/stream"),
    ("GET", "/api/v1/compress/download/{download_id}"),
    ("POST", "/api/v1/pdf-to-image/"),
    ("POST", "/api/v1/pdf-to-image/pages"),
    ("POST", "/api/v1/pdf-to-image/page"),
    ("POST", "/api/v1/image-to-pdf/"),
    ("POST", "/api/v1/qr-barcode/qr"),
    ("POST", "/api/v1/qr-barcode/barcode"),
    ("POST", "/api/v1/insert/"),
    ("POST", "/api/v1/pdf-info/"),
    ("POST", "/api/v1/settings/clear-temp"),
    ("POST", "/api/v1/settings/open-downloads"),
    ("POST", "/api/v1/organize/"),
    ("POST", "/api/v1/metadata/"),
    ("POST", "/api/v1/protect/"),
    ("POST", "/api/v1/protect/remove"),
    ("POST", "/api/v1/preview/"),
    ("POST", "/api/v1/edit-pdf/save"),
}


REQUEST_BODY_CONTRACTS = {
    ("POST", "/api/v1/merge/"): {
        "media_type": "multipart/form-data",
        "required": {"files"},
        "defaults": {"output_filename": "merged_output.pdf"},
    },
    ("POST", "/api/v1/extract/"): {
        "media_type": "multipart/form-data",
        "required": {"file"},
        "defaults": {
            "page_ranges": "1",
            "output_mode": "combine",
            "output_filename": "",
        },
    },
    ("POST", "/api/v1/compress/"): {
        "media_type": "multipart/form-data",
        "required": {"file"},
        "defaults": {"quality": 70, "output_filename": ""},
    },
    ("POST", "/api/v1/compress/stream"): {
        "media_type": "multipart/form-data",
        "required": {"file"},
        "defaults": {"quality": 70, "output_filename": ""},
    },
    ("POST", "/api/v1/pdf-to-image/"): {
        "media_type": "multipart/form-data",
        "required": {"file"},
        "defaults": {
            "page_ranges": "",
            "format": "png",
            "dpi": 150,
            "output_filename": "",
        },
    },
    ("POST", "/api/v1/pdf-to-image/pages"): {
        "media_type": "multipart/form-data",
        "required": {"file"},
        "defaults": {"dpi": 200},
    },
    ("POST", "/api/v1/pdf-to-image/page"): {
        "media_type": "multipart/form-data",
        "required": {"file", "page_index"},
        "defaults": {"dpi": 200},
    },
    ("POST", "/api/v1/image-to-pdf/"): {
        "media_type": "multipart/form-data",
        "required": {"files"},
        "defaults": {
            "page_size": "a4",
            "output_filename": "output.pdf",
            "rotations": "[]",
            "flips": "[]",
        },
    },
    ("POST", "/api/v1/qr-barcode/qr"): {
        "media_type": "application/json",
        "required": {"content"},
        "defaults": {
            "size": 10,
            "error_correction": "M",
            "format": "png",
            "border": 4,
        },
    },
    ("POST", "/api/v1/qr-barcode/barcode"): {
        "media_type": "application/json",
        "required": {"content"},
        "defaults": {"barcode_type": "code128", "format": "png"},
    },
    ("POST", "/api/v1/insert/"): {
        "media_type": "multipart/form-data",
        "required": {"main_pdf", "rules_json"},
        "defaults": {"source_files": [], "output_filename": ""},
    },
    ("POST", "/api/v1/pdf-info/"): {
        "media_type": "multipart/form-data",
        "required": {"file"},
        "defaults": {},
    },
    ("POST", "/api/v1/organize/"): {
        "media_type": "multipart/form-data",
        "required": {"file", "pages_config"},
        "defaults": {"output_filename": "organized.pdf"},
    },
    ("POST", "/api/v1/metadata/"): {
        "media_type": "multipart/form-data",
        "required": {"file"},
        "defaults": {"title": "", "author": "", "subject": "", "keywords": ""},
    },
    ("POST", "/api/v1/protect/"): {
        "media_type": "multipart/form-data",
        "required": {"file", "user_pw"},
        "defaults": {
            "owner_pw": "",
            "output_filename": "protected.pdf",
            "allow_print": True,
            "allow_copy": True,
            "allow_modify": True,
        },
    },
    ("POST", "/api/v1/protect/remove"): {
        "media_type": "multipart/form-data",
        "required": {"file", "user_pw"},
        "defaults": {"output_filename": ""},
    },
    ("POST", "/api/v1/preview/"): {
        "media_type": "multipart/form-data",
        "required": {"file"},
        "defaults": {"page": 1, "dpi": 72, "quality_hint": "auto"},
    },
    ("POST", "/api/v1/edit-pdf/save"): {
        "media_type": "multipart/form-data",
        "required": {"file", "annotations"},
        "defaults": {"output_filename": "edited_document"},
    },
}

NO_BODY_ROUTES = {
    ("GET", "/api/v1/compress/download/{download_id}"),
    ("POST", "/api/v1/settings/clear-temp"),
    ("POST", "/api/v1/settings/open-downloads"),
}


def _resolve_schema(schema, components):
    while "$ref" in schema:
        schema_name = schema["$ref"].rsplit("/", 1)[-1]
        schema = components[schema_name]
    return schema


def test_api_route_surface_matches_contract():
    actual = {
        (method, route.path)
        for route in app.routes
        if getattr(route, "path", "").startswith("/api/")
        for method in (route.methods or set())
        if method not in {"HEAD", "OPTIONS"}
    }

    assert actual == EXPECTED_API_ROUTES


def test_every_api_route_has_an_explicit_request_contract():
    assert set(REQUEST_BODY_CONTRACTS) | NO_BODY_ROUTES == EXPECTED_API_ROUTES


def test_openapi_request_contracts_match_fields_required_flags_and_defaults():
    schema = app.openapi()
    paths = schema["paths"]
    components = schema["components"]["schemas"]

    for (method, path), contract in REQUEST_BODY_CONTRACTS.items():
        operation = paths[path][method.lower()]
        request_body = operation["requestBody"]
        assert request_body["required"] is True
        assert set(request_body["content"]) == {contract["media_type"]}

        body_schema = _resolve_schema(
            request_body["content"][contract["media_type"]]["schema"],
            components,
        )
        expected_fields = contract["required"] | set(contract["defaults"])
        assert set(body_schema["properties"]) == expected_fields, f"Field drift: {method} {path}"
        assert set(body_schema.get("required", [])) == contract["required"]

        for field, default in contract["defaults"].items():
            assert body_schema["properties"][field].get("default") == default


def test_openapi_no_body_routes_and_download_path_parameter_match_contract():
    paths = app.openapi()["paths"]

    for method, path in NO_BODY_ROUTES:
        operation = paths[path][method.lower()]
        assert "requestBody" not in operation

    download = paths["/api/v1/compress/download/{download_id}"]["get"]
    assert download["parameters"] == [
        {
            "name": "download_id",
            "in": "path",
            "required": True,
            "schema": {"type": "string", "title": "Download Id"},
        }
    ]


def test_openapi_documents_validation_responses_for_all_validated_operations():
    paths = app.openapi()["paths"]

    for method, path in set(REQUEST_BODY_CONTRACTS) | {
        ("GET", "/api/v1/compress/download/{download_id}"),
    }:
        operation = paths[path][method.lower()]
        assert "422" in operation["responses"], f"Missing validation response: {method} {path}"


@pytest.mark.parametrize(
    ("method", "path", "contract"),
    [
        (method, path, contract)
        for (method, path), contract in REQUEST_BODY_CONTRACTS.items()
    ],
    ids=[path for _, path in REQUEST_BODY_CONTRACTS],
)
@pytest.mark.asyncio
async def test_missing_required_request_fields_use_fastapi_validation_shape(method, path, contract):
    request_kwargs = {"json": {}} if contract["media_type"] == "application/json" else {}
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.request(method, path, **request_kwargs)

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert body["status"] == "error"
    assert body["message"] == "Request validation failed."
    details = body["detail"]
    assert isinstance(details, list)

    missing_fields = {
        error["loc"][-1]
        for error in details
        if error["type"] == "missing" and error["loc"][0] == "body"
    }
    assert missing_fields == contract["required"]


@pytest.mark.asyncio
async def test_validation_error_shape_is_stable():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/v1/pdf-info/")

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert body["status"] == "error"
    assert body["message"] == "Request validation failed."
    assert isinstance(body["detail"], list)
    assert body["detail"][0]["loc"] == ["body", "file"]
    assert body["detail"][0]["type"] == "missing"


@pytest.mark.asyncio
async def test_expired_compress_download_error_contract_is_stable():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/compress/download/not-in-cache")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {
        "status": "error",
        "message": "Download not found or expired.",
        "detail": "Download not found or expired.",
    }


@pytest.mark.asyncio
async def test_health_response_and_exposed_headers_are_stable():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert body["status"] == "success"
    assert body["message"] == "PDF Manager API is running"
    assert body["data"]["version"] == "1.1.2"
    assert isinstance(body["data"]["temp_dir"], str)
    assert isinstance(body["data"]["output_dir"], str)

    exposed = {
        item.strip().lower()
        for item in response.headers["access-control-expose-headers"].split(",")
    }
    assert {
        "content-disposition",
        "x-file-size",
        "x-output-file",
        "x-total-pages",
    } <= exposed
