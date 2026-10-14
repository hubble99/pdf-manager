import platform
from types import SimpleNamespace

import fast_platform


def _version(build):
    return SimpleNamespace(major=10, minor=0, build=build)


def test_windows_uname_is_built_without_any_platform_call(monkeypatch):
    def forbidden(*_a, **_k):
        raise AssertionError("platform.* must not run")

    for name in ("uname", "system", "machine", "win32_ver"):
        monkeypatch.setattr(platform, name, forbidden)
    result = fast_platform.windows_uname(
        platform,
        windows_version=lambda: _version(26100),
        environ={"COMPUTERNAME": "DESK"},
        banner="3.13.1 [MSC v.1942 64 bit (AMD64)]",
    )
    assert (result.system, result.node, result.release, result.version, result.machine) == (
        "Windows", "DESK", "11", "10.0.26100", "AMD64")
    older = fast_platform.windows_uname(
        platform, windows_version=lambda: _version(19045), environ={},
        banner="3.13.1 [MSC v.1942 64 bit (ARM64)]")
    assert (older.release, older.machine) == ("10", "ARM64")


def test_install_only_acts_on_frozen_windows(monkeypatch):
    monkeypatch.setattr(fast_platform.sys, "platform", "linux")
    assert fast_platform.install() is False
    monkeypatch.setattr(fast_platform.sys, "platform", "win32")
    monkeypatch.delattr(fast_platform.sys, "frozen", raising=False)
    assert fast_platform.install() is False


def test_install_seeds_the_cache_so_platform_system_never_shells_out(monkeypatch):
    monkeypatch.setattr(fast_platform.sys, "platform", "win32")
    monkeypatch.setattr(fast_platform.sys, "frozen", True, raising=False)
    monkeypatch.setattr(fast_platform.sys, "getwindowsversion", lambda: _version(22631), raising=False)
    monkeypatch.setattr(fast_platform.sys, "version", "3.13 [MSC v.1942 64 bit (AMD64)]")
    monkeypatch.setattr(platform, "_uname_cache", None)
    assert fast_platform.install() is True
    assert platform.system() == "Windows"
    assert platform.machine() == "AMD64"
    monkeypatch.setattr(platform, "_uname_cache", None)
