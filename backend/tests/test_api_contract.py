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


def test_api_route_surface_matches_contract():
    actual = {
        (method, route.path)
        for route in app.routes
        if getattr(route, "path", "").startswith("/api/")
        for method in (route.methods or set())
        if method not in {"HEAD", "OPTIONS"}
    }

    assert actual == EXPECTED_API_ROUTES


def test_openapi_documents_request_bodies_and_validation_responses():
    schema = app.openapi()
    paths = schema["paths"]

    for method, path in EXPECTED_API_ROUTES:
        operation = paths[path][method.lower()]
        if path not in {
            "/api/v1/compress/download/{download_id}",
            "/api/v1/settings/clear-temp",
            "/api/v1/settings/open-downloads",
        }:
            assert "requestBody" in operation, f"Missing request body schema: {method} {path}"
            assert "422" in operation["responses"], f"Missing validation response: {method} {path}"


@pytest.mark.asyncio
async def test_validation_error_shape_is_stable():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/v1/pdf-info/")

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert isinstance(body["detail"], list)
    assert body["detail"][0]["loc"] == ["body", "file"]
    assert body["detail"][0]["type"] == "missing"


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
    assert body["data"]["version"] == "1.0.0"
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