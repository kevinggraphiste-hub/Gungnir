"""
Vérifie que chaque plugin qui expose `MIGRATIONS` ait bien la bonne shape
(list[tuple[str, str]]) — attrape les régressions à la compilation des
fichiers migrations.py (rename par accident, oubli de label, etc.).
"""
from __future__ import annotations

import importlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PLUGINS_DIR = REPO / "backend" / "plugins"


def test_plugin_migrations_are_well_shaped():
    for plugin_dir in sorted(PLUGINS_DIR.iterdir()):
        if not plugin_dir.is_dir():
            continue
        mig = plugin_dir / "migrations.py"
        if not mig.exists():
            continue
        mod = importlib.import_module(f"backend.plugins.{plugin_dir.name}.migrations")
        items = getattr(mod, "MIGRATIONS", None)
        assert items is not None, f"{plugin_dir.name}: MIGRATIONS missing"
        assert isinstance(items, list), f"{plugin_dir.name}: MIGRATIONS must be a list"
        for i, entry in enumerate(items):
            assert isinstance(entry, (tuple, list)) and len(entry) == 2, (
                f"{plugin_dir.name}: entry {i} must be (sql, label)"
            )
            sql, label = entry
            assert isinstance(sql, str) and sql.strip(), (
                f"{plugin_dir.name}: entry {i} has empty SQL"
            )
            assert isinstance(label, str) and label.strip(), (
                f"{plugin_dir.name}: entry {i} has empty label"
            )
