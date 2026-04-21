"""
Smoke tests du plugin_registry — le hub d'hooks cross-plugin qui découple
le core des plugins (conscience, providers, snapshots).

Volontairement unit-only : aucune DB, aucun I/O — on teste la plomberie
qui était la plus risquée du refactor d'autonomie.
"""
from __future__ import annotations

import asyncio
import importlib


def _fresh_registry():
    """Recharge le module pour isoler les tests (l'état vit au niveau module)."""
    import backend.core.plugin_registry as pr
    importlib.reload(pr)
    return pr


def test_consciousness_accessors_default_to_none():
    pr = _fresh_registry()
    assert pr.is_consciousness_available() is False
    assert pr.get_consciousness_engine(42) is None
    assert pr.get_existing_consciousness_engine(42) is None
    # Evict doit être no-op safe même sans provider enregistré
    pr.evict_consciousness(42)


def test_consciousness_provider_roundtrip():
    pr = _fresh_registry()

    class _FakeEngine:
        def __init__(self, uid): self.uid = uid

    pr.register_consciousness_provider(lambda uid: _FakeEngine(uid))
    assert pr.is_consciousness_available() is True
    eng = pr.get_consciousness_engine(7)
    assert eng is not None
    assert eng.uid == 7


def test_existing_accessor_is_independent():
    pr = _fresh_registry()
    existing = {}

    def _get_existing(uid):
        return existing.get(uid)

    pr.register_existing_consciousness_provider(_get_existing)
    assert pr.get_existing_consciousness_engine(1) is None
    existing[1] = "sentinel"
    assert pr.get_existing_consciousness_engine(1) == "sentinel"


def test_evict_is_called_when_provider_registered():
    pr = _fresh_registry()
    evicted = []
    pr.register_consciousness_evict_provider(lambda uid: evicted.append(uid))
    pr.evict_consciousness(3)
    pr.evict_consciousness(11)
    assert evicted == [3, 11]


def test_provider_errors_are_swallowed():
    pr = _fresh_registry()

    def _boom(_uid):
        raise RuntimeError("provider crashed")

    pr.register_consciousness_provider(_boom)
    # Must not raise
    assert pr.get_consciousness_engine(0) is None


def test_user_snapshot_sync_read_after_write():
    pr = _fresh_registry()
    pr.set_user_snapshot(1, "demo", {"count": 3})
    assert pr.get_user_snapshot(1, "demo") == {"count": 3}
    # Unknown key falls back to default
    assert pr.get_user_snapshot(1, "missing", default="def") == "def"
    # Unknown user falls back to default
    assert pr.get_user_snapshot(999, "demo") is None


def test_capabilities_lookup():
    pr = _fresh_registry()
    pr.declare_plugin_capabilities("demo", {"exports": ["json", "csv"]})
    assert pr.get_plugin_capabilities("demo") == {"exports": ["json", "csv"]}
    assert "demo" in pr.all_plugin_capabilities()


def test_conscience_block_providers_gather():
    pr = _fresh_registry()
    calls: list[int] = []

    async def _p1(uid):
        calls.append(uid)
        return "block-1"

    def _p2(uid):  # sync provider also works
        return None  # skip

    async def _p3(uid):
        raise RuntimeError("bad provider")

    pr.register_conscience_block_provider(_p1)
    pr.register_conscience_block_provider(_p2)
    pr.register_conscience_block_provider(_p3)

    blocks = asyncio.run(pr.gather_conscience_blocks(42))
    assert "block-1" in blocks
    assert calls == [42]
    # _p3 must not kill the batch
    assert all(b != "bad provider" for b in blocks)
