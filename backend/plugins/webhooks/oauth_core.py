"""
oauth_core.py — Flow OAuth 2.0 générique pour les connectors.

Méthodologie :
1. `build_authorize_url(provider, user_id, base_url)` — génère un state
   token signé contenant {user_id, provider, timestamp} et retourne l'URL
   de consentement.
2. L'user clique → autorise → provider redirige sur `/oauth/callback?code=&state=`.
3. `handle_callback(provider, code, state)` — vérifie le state, échange
   le code contre tokens, persiste chiffré dans `user_settings.service_keys.<provider>`.
4. `get_user_oauth_token(user_id, provider, session)` — retourne un
   access_token valide (auto-refresh si expiré et supporté par le provider).

Stockage : `user_settings.service_keys.<provider>` =
    {access_token, refresh_token?, expires_at, scope, account_label}
Les champs sensibles (access_token, refresh_token) sont chiffrés via
`encrypt_value`/`decrypt_value` du config global.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from typing import Any
from urllib.parse import urlencode

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.api.auth_helpers import get_user_settings
from backend.core.config.settings import encrypt_value, decrypt_value
from backend.plugins.webhooks.oauth_registry import (
    provider_config,
    get_credentials,
)

logger = logging.getLogger("gungnir.oauth")


def _state_secret() -> bytes:
    """Secret pour signer le state token CSRF. Dérivé d'une env var ou
    d'une valeur par défaut (les states ont une durée de vie courte)."""
    raw = os.getenv("GUNGNIR_OAUTH_STATE_SECRET", "gungnir-default-state-secret-change-me")
    return raw.encode()


def _sign(data: bytes) -> str:
    return base64.urlsafe_b64encode(hmac.new(_state_secret(), data, hashlib.sha256).digest()).decode().rstrip("=")


def encode_state(user_id: int, provider: str) -> str:
    payload = {"u": int(user_id), "p": provider, "t": int(time.time()), "n": secrets.token_urlsafe(8)}
    raw = json.dumps(payload, separators=(",", ":")).encode()
    body = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    sig = _sign(raw)
    return f"{body}.{sig}"


def decode_state(state: str, max_age: int = 600) -> dict | None:
    """Vérifie + décode le state. Retourne {u, p, t} ou None si invalide/expiré."""
    try:
        body, sig = state.split(".", 1)
        # Padding pour base64 url-safe
        pad = "=" * (-len(body) % 4)
        raw = base64.urlsafe_b64decode(body + pad)
        expected = _sign(raw)
        if not hmac.compare_digest(sig, expected):
            return None
        data = json.loads(raw)
        if int(time.time()) - int(data.get("t", 0)) > max_age:
            return None
        return {"u": int(data["u"]), "p": str(data["p"]), "t": int(data["t"])}
    except Exception:
        return None


def callback_url(base_url: str) -> str:
    """URL absolue où les providers OAuth redirigent. Doit être enregistrée
    dans la console developer de chaque provider à l'identique."""
    return f"{base_url.rstrip('/')}/api/plugins/webhooks/oauth/callback"


def build_authorize_url(provider: str, user_id: int, base_url: str, scopes: list[str] | None = None) -> str | None:
    cfg = provider_config(provider)
    creds = get_credentials(provider)
    if not cfg or not creds:
        return None
    client_id, _ = creds
    state = encode_state(user_id, provider)
    scope_list = scopes or cfg.get("default_scopes", [])
    params = {
        "client_id": client_id,
        "redirect_uri": callback_url(base_url),
        "response_type": "code",
        "state": state,
    }
    if scope_list:
        params["scope"] = " ".join(scope_list)
    extra = cfg.get("extra_auth_params") or {}
    params.update(extra)
    return f"{cfg['auth_url']}?{urlencode(params)}"


async def _exchange_code(provider: str, code: str, base_url: str) -> dict[str, Any] | None:
    cfg = provider_config(provider)
    creds = get_credentials(provider)
    if not cfg or not creds:
        return None
    client_id, client_secret = creds
    headers = {"Accept": "application/json"}
    body = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": callback_url(base_url),
    }
    auth = None
    if cfg.get("use_basic_auth_for_token"):
        auth = (client_id, client_secret)
    else:
        body["client_id"] = client_id
        body["client_secret"] = client_secret
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(cfg["token_url"], data=body, headers=headers, auth=auth)
        if r.status_code != 200:
            logger.warning(f"OAuth token exchange failed {provider}: {r.status_code} {r.text[:200]}")
            return None
        try:
            return r.json()
        except Exception:
            return None


async def _fetch_user_label(provider: str, access_token: str) -> str | None:
    cfg = provider_config(provider)
    if not cfg or not cfg.get("user_info_url"):
        return None
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            cfg["user_info_url"],
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        )
        if r.status_code != 200:
            return None
        try:
            data = r.json()
            field = cfg.get("user_info_field", "email")
            return str(data.get(field) or "")[:120] or None
        except Exception:
            return None


async def handle_callback(
    provider: str, code: str, state: str, base_url: str, session: AsyncSession,
) -> dict[str, Any]:
    """Échange le code contre tokens et persiste dans user_settings."""
    decoded = decode_state(state)
    if not decoded or decoded["p"] != provider:
        return {"ok": False, "error": "État OAuth invalide ou expiré."}
    user_id = decoded["u"]

    token_data = await _exchange_code(provider, code, base_url)
    if not token_data or not token_data.get("access_token"):
        return {"ok": False, "error": "Échec de l'échange de code OAuth."}

    access_token = token_data["access_token"]
    refresh_token = token_data.get("refresh_token", "")
    expires_in = int(token_data.get("expires_in") or 0)
    expires_at = int(time.time()) + expires_in if expires_in else 0

    label = await _fetch_user_label(provider, access_token)

    # Persister chiffré dans service_keys.<provider>
    us = await get_user_settings(user_id, session)
    sk = dict(us.service_keys or {})
    sk[provider] = {
        "access_token": encrypt_value(access_token),
        "refresh_token": encrypt_value(refresh_token) if refresh_token else "",
        "expires_at": expires_at,
        "scope": token_data.get("scope", ""),
        "account_label": label or provider,
        "connected_at": int(time.time()),
    }
    us.service_keys = sk
    await session.commit()
    logger.info(f"OAuth connected user={user_id} provider={provider} label={label}")
    return {"ok": True, "provider": provider, "account_label": label or provider}


async def disconnect(provider: str, user_id: int, session: AsyncSession) -> dict[str, Any]:
    us = await get_user_settings(user_id, session)
    sk = dict(us.service_keys or {})
    if provider in sk:
        sk.pop(provider, None)
        us.service_keys = sk
        await session.commit()
    return {"ok": True}


async def _refresh_access_token(provider: str, refresh_token: str) -> dict[str, Any] | None:
    cfg = provider_config(provider)
    creds = get_credentials(provider)
    if not cfg or not creds or not refresh_token:
        return None
    if not cfg.get("supports_refresh"):
        return None
    client_id, client_secret = creds
    body = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
        "client_secret": client_secret,
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(cfg["token_url"], data=body, headers={"Accept": "application/json"})
        if r.status_code != 200:
            logger.warning(f"OAuth refresh failed {provider}: {r.status_code}")
            return None
        try:
            return r.json()
        except Exception:
            return None


async def get_user_oauth_token(
    user_id: int, provider: str, session: AsyncSession,
) -> str | None:
    """Retourne un token valide pour le provider :
    - PRIORITÉ 1 : token manuel (PAT/Integration Token saisi directement)
    - PRIORITÉ 2 : access_token OAuth (avec refresh auto si expiré)

    Le mode manuel est ce qui permet à un user self-hosted d'utiliser le
    connector sans avoir d'OAuth app configurée côté serveur.
    """
    us = await get_user_settings(user_id, session)
    sk = dict(us.service_keys or {})
    entry = sk.get(provider)
    if not entry:
        return None

    # Mode manuel : l'user a collé un PAT directement
    manual = entry.get("manual_token", "")
    if manual:
        try:
            return decrypt_value(manual)
        except Exception:
            return None

    # Mode OAuth standard
    access = decrypt_value(entry.get("access_token", "")) if entry.get("access_token") else ""
    expires_at = int(entry.get("expires_at") or 0)
    needs_refresh = expires_at and (int(time.time()) > expires_at - 60)
    if access and not needs_refresh:
        return access
    refresh = decrypt_value(entry.get("refresh_token", "")) if entry.get("refresh_token") else ""
    if not refresh:
        return access or None  # Pas de refresh dispo, on renvoie l'ancien (peut marcher si grace period)
    new = await _refresh_access_token(provider, refresh)
    if not new or not new.get("access_token"):
        return access or None
    new_access = new["access_token"]
    new_refresh = new.get("refresh_token", refresh)
    expires_in = int(new.get("expires_in") or 0)
    entry["access_token"] = encrypt_value(new_access)
    if new_refresh:
        entry["refresh_token"] = encrypt_value(new_refresh)
    entry["expires_at"] = int(time.time()) + expires_in if expires_in else 0
    sk[provider] = entry
    us.service_keys = sk
    await session.commit()
    return new_access


async def set_manual_token(
    provider: str, user_id: int, token: str, session: AsyncSession,
) -> dict[str, Any]:
    """Stocke un PAT / Integration Token saisi manuellement. Vérifie le
    token via l'endpoint user-info du provider quand dispo, pour valider
    qu'il fonctionne avant de le persister."""
    cfg = provider_config(provider)
    if not cfg:
        return {"ok": False, "error": "Provider inconnu"}
    if not cfg.get("manual_token_supported"):
        return {"ok": False, "error": "Ce provider n'accepte pas de token manuel — utilise OAuth."}
    token = (token or "").strip()
    if not token:
        return {"ok": False, "error": "Token vide"}

    # Validation : ping un endpoint provider avec le token pour vérifier qu'il
    # fonctionne avant de le persister.
    label: str | None = None
    if provider == "notion":
        label = await _validate_notion_token(token)
        if not label:
            return {"ok": False, "error": "Token Notion invalide (échec sur /v1/search). Vérifie le token et que tu as bien partagé au moins une page avec l'intégration."}
    elif cfg.get("user_info_url"):
        label = await _fetch_user_label(provider, token)
        if not label:
            return {"ok": False, "error": "Token invalide ou scopes insuffisants (échec sur l'endpoint user_info)."}

    us = await get_user_settings(user_id, session)
    sk = dict(us.service_keys or {})
    sk[provider] = {
        "manual_token": encrypt_value(token),
        "account_label": label or f"{provider} (token manuel)",
        "connected_at": int(time.time()),
        "manual": True,
    }
    us.service_keys = sk
    await session.commit()
    logger.info(f"Manual token set user={user_id} provider={provider} label={label}")
    return {"ok": True, "provider": provider, "account_label": label or provider}


async def _validate_notion_token(token: str) -> str | None:
    """Notion n'a pas d'endpoint /user — on ping /search pour valider."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                "https://api.notion.com/v1/search",
                json={"page_size": 1},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Notion-Version": "2022-06-28",
                    "Content-Type": "application/json",
                },
            )
            if r.status_code == 200:
                return "Notion (token manuel)"
            return None
    except Exception:
        return None


def list_user_connections(user_settings) -> list[dict[str, Any]]:
    """Retourne le statut connecté/non par provider pour cet user (sans secrets)."""
    sk = dict(user_settings.service_keys or {}) if user_settings else {}
    from backend.plugins.webhooks.oauth_registry import OAUTH_PROVIDERS
    out = []
    for provider in OAUTH_PROVIDERS:
        entry = sk.get(provider)
        if entry and (entry.get("manual_token") or entry.get("access_token")):
            out.append({
                "provider": provider,
                "connected": True,
                "mode": "manual" if entry.get("manual_token") else "oauth",
                "account_label": entry.get("account_label", ""),
                "connected_at": entry.get("connected_at", 0),
                "scope": entry.get("scope", ""),
                "expires_at": entry.get("expires_at", 0),
            })
        else:
            out.append({"provider": provider, "connected": False})
    return out
