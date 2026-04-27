"""
oauth_registry.py — Catalogue des providers OAuth supportés.

Chaque entrée définit le flow OAuth 2.0 standard (auth URL, token URL,
scopes par défaut). Les credentials applicatifs (client_id, client_secret)
sont lus depuis les variables d'environnement au runtime — l'admin Gungnir
crée son app OAuth chez chaque provider une fois et configure les env vars.

Pour ajouter un provider : ajouter une entrée ici + créer un adapter dans
`connectors/<provider>.py` qui expose les agent_tools spécifiques à l'API.
"""
from __future__ import annotations

import os
from typing import Any


OAUTH_PROVIDERS: dict[str, dict[str, Any]] = {
    "github": {
        "display_name": "GitHub",
        "description": "Issues, PRs, recherche de code, releases.",
        "auth_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "default_scopes": ["repo", "read:user"],
        "user_info_url": "https://api.github.com/user",
        "user_info_field": "login",
        "supports_refresh": False,  # tokens classiques GitHub OAuth = longue durée
        "client_id_env": "GUNGNIR_OAUTH_GITHUB_CLIENT_ID",
        "client_secret_env": "GUNGNIR_OAUTH_GITHUB_CLIENT_SECRET",
        "icon": "Github",
        "category": "dev",
        # Mode BYOT (Personal Access Token) — option self-hosting friendly
        "manual_token_supported": True,
        "manual_token_label": "Personal Access Token (PAT)",
        "manual_token_url": "https://github.com/settings/tokens/new?scopes=repo,read:user&description=Gungnir",
        "manual_token_help": "Crée un PAT classic avec les scopes 'repo' et 'read:user'. Format: ghp_... ou github_pat_...",
        # OAuth Device Flow (« Login simple ») — UX la plus fluide pour les
        # users self-hosted : pas de callback URL à configurer, juste un code
        # à 8 chars à taper sur github.com/login/device.
        "device_flow_supported": True,
    },
    "google": {
        "display_name": "Google (Drive + Gmail)",
        "description": "Google Drive, Gmail, Sheets — un seul connecteur pour tous les services Google.",
        "auth_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "default_scopes": [
            "openid", "email", "profile",
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/gmail.modify",
        ],
        "user_info_url": "https://www.googleapis.com/oauth2/v2/userinfo",
        "user_info_field": "email",
        "supports_refresh": True,
        # Force le consent screen pour récupérer un refresh_token (Google ne le
        # renvoie qu'au premier consentement par défaut).
        "extra_auth_params": {"access_type": "offline", "prompt": "consent"},
        "client_id_env": "GUNGNIR_OAUTH_GOOGLE_CLIENT_ID",
        "client_secret_env": "GUNGNIR_OAUTH_GOOGLE_CLIENT_SECRET",
        "icon": "Mail",
        "category": "productivity",
        # Google ne fournit pas de PAT pour Drive/Gmail — OAuth obligatoire
        "manual_token_supported": False,
    },
    "notion": {
        "display_name": "Notion",
        "description": "Recherche, lecture, écriture de pages et databases.",
        "auth_url": "https://api.notion.com/v1/oauth/authorize",
        "token_url": "https://api.notion.com/v1/oauth/token",
        "default_scopes": [],  # Notion n'utilise pas de scopes OAuth standards
        "user_info_url": None,  # Renvoyé directement dans la réponse token
        "supports_refresh": False,
        "client_id_env": "GUNGNIR_OAUTH_NOTION_CLIENT_ID",
        "client_secret_env": "GUNGNIR_OAUTH_NOTION_CLIENT_SECRET",
        "extra_auth_params": {"owner": "user"},
        "use_basic_auth_for_token": True,  # Notion exige Basic auth sur token endpoint
        "icon": "FileText",
        "category": "productivity",
        # Mode BYOT (Internal Integration Token)
        "manual_token_supported": True,
        "manual_token_label": "Internal Integration Token",
        "manual_token_url": "https://www.notion.so/my-integrations",
        "manual_token_help": "Crée une 'Internal Integration', copie le 'Internal Integration Token' (format: ntn_...). N'oublie pas de partager les pages/databases avec cette intégration via le menu '...' → Connections.",
    },
}


def provider_config(provider: str) -> dict[str, Any] | None:
    return OAUTH_PROVIDERS.get(provider)


def list_providers() -> list[dict[str, Any]]:
    """Retourne la liste publique des providers (sans les secrets, juste
    les infos d'affichage UI + readiness)."""
    out = []
    for key, cfg in OAUTH_PROVIDERS.items():
        client_id = os.getenv(cfg.get("client_id_env", ""), "")
        client_secret = os.getenv(cfg.get("client_secret_env", ""), "")
        out.append({
            "provider": key,
            "display_name": cfg["display_name"],
            "description": cfg["description"],
            "icon": cfg.get("icon", "Plug"),
            "category": cfg.get("category", "other"),
            "configured": bool(client_id and client_secret),
            "supports_refresh": cfg.get("supports_refresh", False),
            # Mode BYOT — l'user peut coller un PAT/token directement sans
            # passer par le flow OAuth. Particulièrement utile pour le
            # self-hosting où l'admin n'a pas créé d'OAuth app.
            "manual_token_supported": cfg.get("manual_token_supported", False),
            "manual_token_label": cfg.get("manual_token_label", ""),
            "manual_token_url": cfg.get("manual_token_url", ""),
            "manual_token_help": cfg.get("manual_token_help", ""),
            "device_flow_supported": bool(cfg.get("device_flow_supported") and client_id),
        })
    return out


def get_credentials(provider: str) -> tuple[str, str] | None:
    """Retourne (client_id, client_secret) depuis l'env, ou None si non configuré."""
    cfg = provider_config(provider)
    if not cfg:
        return None
    client_id = os.getenv(cfg.get("client_id_env", ""), "").strip()
    client_secret = os.getenv(cfg.get("client_secret_env", ""), "").strip()
    if not client_id or not client_secret:
        return None
    return (client_id, client_secret)
