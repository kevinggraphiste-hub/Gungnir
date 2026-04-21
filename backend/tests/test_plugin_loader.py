"""
Smoke tests du plugin loader — vérifie que `discover_plugins()` trouve bien
les 10 plugins du repo et que le scan tiers `data/plugins_external/` ne
casse pas quand le dossier est vide.
"""
from __future__ import annotations

from pathlib import Path

from backend.core.services.plugin_loader import discover_plugins


REPO = Path(__file__).resolve().parents[2]
PLUGINS_DIR = REPO / "backend" / "plugins"


def test_discover_core_plugins_finds_all_manifests():
    manifests = discover_plugins(PLUGINS_DIR)
    names = {m.name for m in manifests}
    # Au moins ces 5 plugins doivent être détectés (les autres peuvent
    # varier selon la branche ; on liste les piliers stables).
    expected_subset = {"consciousness", "valkyrie", "channels", "scheduler", "voice"}
    assert expected_subset.issubset(names), f"Missing: {expected_subset - names}"


def test_discover_tags_source_on_manifest():
    manifests = discover_plugins(PLUGINS_DIR)
    assert all(getattr(m, "source", "core") == "core" for m in manifests)


def test_discover_external_dir_empty_is_safe(tmp_path):
    """Dossier externe vide → ne doit pas raise."""
    ext = tmp_path / "plugins_external"
    ext.mkdir()
    manifests = discover_plugins(PLUGINS_DIR, external_dir=ext)
    # Le scan trouve toujours les plugins core
    assert len(manifests) > 0
    # Aucun plugin externe trouvé (dossier vide)
    assert not any(getattr(m, "source", "core") == "external" for m in manifests)


def test_discover_external_plugin_is_tagged_external(tmp_path):
    """Pose un manifest minimal dans le dossier externe → doit être trouvé
    et tagué source='external'."""
    import json
    ext = tmp_path / "plugins_external"
    (ext / "demo_third").mkdir(parents=True)
    (ext / "demo_third" / "manifest.json").write_text(json.dumps({
        "name": "demo_third",
        "display_name": "Demo (third-party)",
        "version": "0.1.0",
        "backend_routes": False,
    }), encoding="utf-8")

    manifests = discover_plugins(PLUGINS_DIR, external_dir=ext)
    third = next((m for m in manifests if m.name == "demo_third"), None)
    assert third is not None
    assert getattr(third, "source", None) == "external"
    assert third.version == "0.1.0"


def test_sidebar_position_ordering():
    manifests = discover_plugins(PLUGINS_DIR)
    positions = [m.sidebar_position for m in manifests]
    assert positions == sorted(positions), "Manifests should be sorted by sidebar_position"
