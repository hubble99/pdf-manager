import os

import pytest
from fastapi import HTTPException

from routers import settings


@pytest.mark.asyncio
async def test_open_downloads_reports_when_explorer_starts(monkeypatch):
    calls = []
    monkeypatch.setattr(settings.platform, "system", lambda: "Windows")
    monkeypatch.setattr(settings.os.path, "expanduser", lambda _: "C:/Users/tester")
    monkeypatch.setattr(settings.subprocess, "Popen", lambda args: calls.append(args))

    response = await settings.open_downloads()

    assert calls == [["explorer", os.path.join("C:/Users/tester", "Downloads")]]
    assert response.data == {"opened": True}


@pytest.mark.asyncio
async def test_open_downloads_returns_an_error_when_explorer_cannot_start(monkeypatch):
    monkeypatch.setattr(settings.platform, "system", lambda: "Windows")
    monkeypatch.setattr(settings.subprocess, "Popen", lambda _: (_ for _ in ()).throw(OSError("not available")))

    with pytest.raises(HTTPException, match="Could not open the downloads folder"):
        await settings.open_downloads()
