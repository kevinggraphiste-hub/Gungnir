"""
Vérifie que le filtre de redaction ne laisse pas passer les secrets dans
les logs (fix sécu M9). Pas de DB, pas d'I/O — juste la logique regex.
"""
from __future__ import annotations

from backend.core.logging_filters import _redact


def test_api_key_pattern_is_redacted():
    assert "***REDACTED***" in _redact("api_key=sk-abcdef1234567890")
    assert "sk-abcdef" not in _redact("api-key=sk-abcdef1234567890")
    assert "***REDACTED***" in _redact("apikey: \"XXYYZZ12345\"")


def test_bearer_token_is_redacted():
    out = _redact("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload")
    assert "Authorization: Bearer ***REDACTED***" in out
    assert "eyJhbGci" not in out


def test_fernet_value_is_redacted():
    out = _redact("Saved config: FERNET:gAAAAABmABCDefghIJKLmnopQRSTuvwx1234567890abcdef")
    assert "FERNET:***REDACTED***" in out
    assert "gAAAAABm" not in out


def test_long_hex_token_is_redacted():
    tok = "a" * 64
    out = _redact(f"user login with token {tok}")
    assert "***REDACTED_HEX***" in out
    assert tok not in out


def test_short_strings_are_not_touched():
    # Un mot de 20 chars (sub-seuil) ne doit pas être redacté à tort.
    msg = "user=alice display=salut"
    assert _redact(msg) == msg


def test_password_keyword():
    assert "***REDACTED***" in _redact("password=hunter2Secret!")


def test_refresh_token_keyword():
    out = _redact("refresh_token=rt_ABCDEFGH12345678")
    assert "***REDACTED***" in out
    assert "rt_ABCDEFGH" not in out


def test_empty_and_none_are_safe():
    assert _redact("") == ""
    # On accepte None/0/etc. côté filter, ici c'est la fn _redact interne qui
    # prend des strings — un appel None retournerait None.
    assert _redact("plain text nothing to redact") == "plain text nothing to redact"
