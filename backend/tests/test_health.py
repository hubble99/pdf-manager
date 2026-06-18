import time
import pytest
from httpx import AsyncClient, ASGITransport
from main import app

@pytest.mark.asyncio
async def test_health_status_200():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    assert data["message"] == "PDF Manager API is running"
    assert "version" in data["data"]

@pytest.mark.asyncio
async def test_health_response_time():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        t0 = time.perf_counter()
        resp = await client.get("/health")
        t1 = time.perf_counter()
        elapsed_ms = (t1 - t0) * 1000
    
    assert resp.status_code == 200
    # Response time should be < 500ms
    assert elapsed_ms < 500.0
