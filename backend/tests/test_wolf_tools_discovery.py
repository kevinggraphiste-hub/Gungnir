"""
Vérifie que l'auto-discovery des outils WOLF (dans chaque plugin) charge
bien les schémas et les exécuteurs. La régression la plus probable si le
refactor casse : wolf_tools ne trouve plus les tools valkyrie.
"""
from __future__ import annotations


def test_valkyrie_tools_are_loaded():
    from backend.core.agents.wolf_tools import WOLF_TOOL_SCHEMAS, WOLF_EXECUTORS
    # Attendu : les 22 tools valkyrie_* sont présents via auto-discovery.
    names = {
        s.get("function", {}).get("name") for s in WOLF_TOOL_SCHEMAS
        if isinstance(s, dict)
    }
    assert "valkyrie_list_projects" in names
    assert "valkyrie_create_card" in names
    assert "valkyrie_get_reminders" in names
    # Exécuteurs correspondants enregistrés
    assert "valkyrie_list_projects" in WOLF_EXECUTORS
    assert "valkyrie_create_card" in WOLF_EXECUTORS
    # Check cohérence schema ↔ executor pour la surface valkyrie
    for name in names:
        if name and name.startswith("valkyrie_"):
            assert name in WOLF_EXECUTORS, f"Tool {name} has schema but no executor"


def test_core_tools_still_present():
    from backend.core.agents.wolf_tools import WOLF_EXECUTORS
    # Quelques outils centraux qui ne doivent jamais disparaître
    for core_tool in ("web_fetch", "kb_write", "kb_read", "soul_read", "soul_write"):
        assert core_tool in WOLF_EXECUTORS, f"{core_tool} missing from WOLF_EXECUTORS"
