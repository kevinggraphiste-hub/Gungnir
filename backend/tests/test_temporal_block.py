"""
Vérifie que `_build_temporal_block` produit un bloc lisible avec les
bonnes infos (date FR, ISO, heure, UTC), et tolère une TZ invalide.

C'est le correctif du bug "l'agent hallucine la date" — sans ce bloc
injecté au system prompt, les LLM retournent la date de leur cutoff
d'entraînement.
"""
from __future__ import annotations

from backend.core.api.chat import _build_temporal_block


def test_block_contains_expected_keys():
    block = _build_temporal_block("Europe/Paris")
    assert "CONTEXTE TEMPOREL" in block
    assert "Nous sommes le" in block
    assert "Date ISO" in block
    assert "Heure locale" in block
    assert "Heure UTC" in block
    assert "Europe/Paris" in block


def test_block_contains_french_weekday():
    block = _build_temporal_block("Europe/Paris")
    # Un des 7 jours français DOIT apparaître
    jours = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
    assert any(j in block for j in jours), f"Jour FR manquant dans:\n{block}"


def test_block_contains_french_month():
    block = _build_temporal_block("Europe/Paris")
    mois = ["janvier", "février", "mars", "avril", "mai", "juin",
            "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
    assert any(m in block for m in mois), f"Mois FR manquant dans:\n{block}"


def test_block_iso_date_format():
    import re
    block = _build_temporal_block("Europe/Paris")
    # Cherche un pattern YYYY-MM-DD
    m = re.search(r"\b20\d\d-\d{2}-\d{2}\b", block)
    assert m, f"Date ISO manquante dans:\n{block}"


def test_block_with_invalid_tz_falls_back_to_utc():
    """Une TZ invalide ne doit pas faire crasher — fallback UTC silencieux."""
    block = _build_temporal_block("Invalid/Nowhere")
    assert "UTC" in block
    # Pas de crash, et on a quand même les infos de base
    assert "CONTEXTE TEMPOREL" in block


def test_block_with_utc_tz_is_consistent():
    block = _build_temporal_block("UTC")
    assert "UTC" in block
