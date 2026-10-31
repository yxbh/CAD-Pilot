import pytest


@pytest.fixture(autouse=True)
def _own_cache(tmp_path, monkeypatch):
    # Meshed STEP parts are cached per user; each test, and each command it runs, gets a cache of its own.
    monkeypatch.setenv("CAD_PILOT_CACHE", str(tmp_path / "cad-cache"))
