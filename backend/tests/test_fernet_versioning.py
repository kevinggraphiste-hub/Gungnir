"""
Round-trip et compat descendante du chiffrement versionné Fernet (fix sécu H4).

Couvre :
- Encrypt produit bien le préfixe `FERNET:v2:`
- Decrypt supporte v2 (courant)
- Decrypt supporte les anciennes valeurs `FERNET:<token>` sans version
- Rotation via GUNGNIR_SECRET_KEY_PREV : ancien contenu décryptable après
  changement de la clé courante
"""
from __future__ import annotations

import os

from backend.core.config.settings import (
    encrypt_value, decrypt_value, _fernet_for_secret,
)


def _set_env(key: str, value: str | None):
    if value is None:
        os.environ.pop(key, None)
    else:
        os.environ[key] = value


def test_encrypt_emits_versioned_format():
    _set_env("GUNGNIR_SECRET_KEY", "test-secret-v1")
    _set_env("GUNGNIR_SECRET_KEY_PREV", None)
    v = encrypt_value("hello")
    assert v.startswith("FERNET:v2:"), f"Expected versioned prefix, got {v[:20]!r}"
    # Reencrypt noop
    assert encrypt_value(v) == v


def test_roundtrip_current_key():
    _set_env("GUNGNIR_SECRET_KEY", "round-trip-key")
    _set_env("GUNGNIR_SECRET_KEY_PREV", None)
    enc = encrypt_value("sk-secret-12345")
    assert decrypt_value(enc) == "sk-secret-12345"


def test_backward_compat_unversioned_fernet():
    """Valeurs écrites avant H4 n'ont pas de version dans le préfixe —
    elles doivent rester lisibles tant que la clé courante est identique."""
    _set_env("GUNGNIR_SECRET_KEY", "stable-key")
    _set_env("GUNGNIR_SECRET_KEY_PREV", None)

    # Simule une ancienne valeur FERNET:<token> (sans version) en utilisant
    # directement Fernet avec la clé courante.
    f = _fernet_for_secret("stable-key")
    token = f.encrypt(b"legacy-value").decode()
    legacy_blob = "FERNET:" + token

    assert decrypt_value(legacy_blob) == "legacy-value"


def test_rotation_with_prev_key_decrypts_old_content():
    """Scénario rotation : ancienne clé dans PREV, nouvelle dans SECRET_KEY.
    Une valeur chiffrée avec l'ancienne doit encore être lisible."""
    # Étape 1 : on chiffre avec la clé "old"
    _set_env("GUNGNIR_SECRET_KEY", "old-key")
    _set_env("GUNGNIR_SECRET_KEY_PREV", None)
    enc = encrypt_value("api-key-before-rotation")
    assert enc.startswith("FERNET:v2:")

    # Étape 2 : rotation — on bascule SECRET_KEY sur "new" et PREV sur "old"
    _set_env("GUNGNIR_SECRET_KEY", "new-key")
    _set_env("GUNGNIR_SECRET_KEY_PREV", "old-key")

    # La valeur chiffrée avec l'ancienne clé doit encore se décrypter grâce
    # à la clé PREV.
    assert decrypt_value(enc) == "api-key-before-rotation"


def test_rotation_without_prev_key_returns_empty():
    """Cas sans garde-fou : si l'user perd l'ancienne clé, on retourne
    string vide (documenté — pas de crash)."""
    _set_env("GUNGNIR_SECRET_KEY", "old-key-2")
    _set_env("GUNGNIR_SECRET_KEY_PREV", None)
    enc = encrypt_value("lost-forever")

    _set_env("GUNGNIR_SECRET_KEY", "brand-new-key")
    _set_env("GUNGNIR_SECRET_KEY_PREV", None)
    assert decrypt_value(enc) == ""


def test_empty_and_plain_values_pass_through():
    assert decrypt_value("") == ""
    assert decrypt_value(None) is None or decrypt_value(None) == ""
    # Valeur non-préfixée : retournée telle quelle (compat)
    assert decrypt_value("plain-text-not-encrypted") == "plain-text-not-encrypted"
