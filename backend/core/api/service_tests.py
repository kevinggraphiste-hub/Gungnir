"""
Service connectivity tests — un handler par service avec le bon endpoint,
le bon schéma d'auth et la bonne méthode. Appelés depuis /config/services/
{name}/test.

Retour standardisé : {"ok": bool, "status": int | None, "message": str,
"error": str | None}. L'UI Settings affiche soit `message` (succès) soit
`error` (échec).

Chaque test fonction reçoit :
    base_url: URL effective (pref user_svc.base_url > meta.base_url)
    api_key:  clé en clair (déjà déchiffrée)
    token:    token OAuth/Bot en clair
    extra:    tout user_svc (project_id, database, region, etc.)

IMPORTANT : aucun test ne lit de variable d'env globale — tous les secrets
viennent strictement de `user_svc`, per-user.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Callable, Awaitable

logger = logging.getLogger("gungnir.service_tests")


TestResult = dict  # {"ok": bool, "status": int | None, "message": str, "error"?: str}


def _ok(msg: str, status: int | None = 200) -> TestResult:
    return {"ok": True, "status": status, "message": msg}


def _err(msg: str, status: int | None = None) -> TestResult:
    return {"ok": False, "status": status, "error": msg}


# ══════════════════════════════════════════════════════════════════════════
# TCP-only services (pas d'HTTP, on teste juste la réachabilité du port)
# ══════════════════════════════════════════════════════════════════════════

async def _test_tcp(host: str, port: int, label: str) -> TestResult:
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=5
        )
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return _ok(f"Port {label} joignable ({host}:{port})")
    except asyncio.TimeoutError:
        return _err(f"Timeout — {label} injoignable sur {host}:{port}")
    except Exception as e:
        return _err(f"{label} : {e}")


def _split_host_port(url: str, default_scheme: str, default_port: int) -> tuple[str, int]:
    u = (url or "").strip()
    for pfx in (f"{default_scheme}://", "http://", "https://"):
        if u.startswith(pfx):
            u = u[len(pfx):]
            break
    u = u.split("/")[0].split("@")[-1]
    host = u.split(":")[0]
    port_str = u.split(":")[-1] if ":" in u else ""
    try:
        port = int(port_str) if port_str.isdigit() else default_port
    except Exception:
        port = default_port
    return host, port


async def _test_postgresql(base_url, api_key, token, extra):
    host, port = _split_host_port(base_url or "postgresql://localhost:5432", "postgresql", 5432)
    return await _test_tcp(host, port, "PostgreSQL")


async def _test_mysql(base_url, api_key, token, extra):
    host, port = _split_host_port(base_url or "mysql://localhost:3306", "mysql", 3306)
    return await _test_tcp(host, port, "MySQL")


async def _test_mongodb(base_url, api_key, token, extra):
    host, port = _split_host_port(base_url or "mongodb://localhost:27017", "mongodb", 27017)
    return await _test_tcp(host, port, "MongoDB")


async def _test_redis(base_url, api_key, token, extra):
    host, port = _split_host_port(base_url or "redis://localhost:6379", "redis", 6379)
    return await _test_tcp(host, port, "Redis")


async def _test_elasticsearch(base_url, api_key, token, extra):
    # ES : GET /_cluster/health avec optionnellement Basic auth
    if not base_url:
        return _err("URL Elasticsearch manquante")
    import aiohttp
    import base64
    url = base_url.rstrip("/") + "/_cluster/health"
    headers = {}
    if api_key:
        headers["Authorization"] = f"ApiKey {api_key}"
    elif token:
        # format user:pass encodé en base64
        if ":" in token:
            headers["Authorization"] = "Basic " + base64.b64encode(token.encode()).decode()
        else:
            headers["Authorization"] = f"Bearer {token}"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status < 400:
                    return _ok("Cluster Elasticsearch OK", r.status)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


# ══════════════════════════════════════════════════════════════════════════
# Vector stores
# ══════════════════════════════════════════════════════════════════════════

async def _test_qdrant(base_url, api_key, token, extra):
    if not base_url:
        return _err("URL Qdrant manquante")
    import aiohttp
    url = base_url.rstrip("/") + "/healthz"
    headers = {}
    if api_key:
        headers["api-key"] = api_key
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status < 400:
                    return _ok("Qdrant connecté", r.status)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_pinecone(base_url, api_key, token, extra):
    if not api_key:
        return _err("Clé API Pinecone manquante")
    import aiohttp
    # L'endpoint control-plane /indexes liste les indexes. Auth: Api-Key header.
    url = "https://api.pinecone.io/indexes"
    headers = {"Api-Key": api_key, "X-Pinecone-API-Version": "2024-07"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status < 400:
                    return _ok("Pinecone connecté", r.status)
                if r.status in (401, 403):
                    return _err("Clé Pinecone refusée", r.status)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_weaviate(base_url, api_key, token, extra):
    if not base_url:
        return _err("URL Weaviate manquante")
    import aiohttp
    url = base_url.rstrip("/") + "/v1/.well-known/ready"
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status < 400:
                    return _ok("Weaviate prêt", r.status)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_chromadb(base_url, api_key, token, extra):
    if not base_url:
        return _err("URL ChromaDB manquante")
    import aiohttp
    url = base_url.rstrip("/") + "/api/v1/heartbeat"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(url, timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status < 400:
                    return _ok("ChromaDB vivant", r.status)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_milvus(base_url, api_key, token, extra):
    # Milvus : HTTP proxy /v1/vector/collections (si le proxy HTTP est activé)
    if not base_url:
        return _err("URL Milvus manquante")
    host, port = _split_host_port(base_url, "http", 19530)
    return await _test_tcp(host, port, "Milvus")


# ══════════════════════════════════════════════════════════════════════════
# Dev tools
# ══════════════════════════════════════════════════════════════════════════

async def _test_github(base_url, api_key, token, extra):
    key = api_key or token
    if not key:
        return _err("Token GitHub manquant")
    import aiohttp
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/vnd.github+json"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get("https://api.github.com/user", headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    return _ok(f"Connecté en tant que @{d.get('login', '?')}", 200)
                if r.status == 401:
                    return _err("Token GitHub refusé", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_gitlab(base_url, api_key, token, extra):
    key = api_key or token
    if not key:
        return _err("Token GitLab manquant")
    import aiohttp
    base = (base_url or "https://gitlab.com").rstrip("/")
    headers = {"Authorization": f"Bearer {key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{base}/api/v4/user", headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    return _ok(f"Connecté en tant que @{d.get('username', '?')}", 200)
                if r.status == 401:
                    return _err("Token GitLab refusé", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_notion(base_url, api_key, token, extra):
    key = api_key or token
    if not key:
        return _err("Token Notion manquant")
    import aiohttp
    headers = {
        "Authorization": f"Bearer {key}",
        "Notion-Version": "2022-06-28",
    }
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get("https://api.notion.com/v1/users/me", headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    return _ok(f"Connecté : {d.get('name', d.get('id', '?'))}", 200)
                if r.status == 401:
                    return _err("Token Notion refusé", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_linear(base_url, api_key, token, extra):
    key = api_key or token
    if not key:
        return _err("Clé API Linear manquante")
    import aiohttp
    # Linear : GraphQL, auth via header `Authorization: <key>` (sans Bearer)
    query = {"query": "{ viewer { id name email } }"}
    headers = {"Authorization": key, "Content-Type": "application/json"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post("https://api.linear.app/graphql", json=query,
                               headers=headers,
                               timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    v = (d.get("data") or {}).get("viewer") or {}
                    return _ok(f"Connecté : {v.get('name', '?')}", 200)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_jira_like(base_url, api_key, token, extra, product: str):
    """Jira/Confluence : Basic auth (email:token base64) sur /rest/api/3/myself."""
    if not base_url:
        return _err(f"URL {product} manquante")
    if not api_key and not token:
        return _err(f"Token {product} manquant (format attendu : email:token)")
    import aiohttp
    import base64
    cred = api_key or token
    if ":" not in cred:
        return _err(f"Format attendu : email:api_token (séparé par :)")
    headers = {"Authorization": "Basic " + base64.b64encode(cred.encode()).decode(),
               "Accept": "application/json"}
    path = "/rest/api/3/myself" if product == "Jira" else "/wiki/rest/api/user/current"
    url = base_url.rstrip("/") + path
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(url, headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    return _ok(f"{product} connecté", 200)
                if r.status == 401:
                    return _err("Identifiants refusés", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_jira(base_url, api_key, token, extra):
    return await _test_jira_like(base_url, api_key, token, extra, "Jira")


async def _test_confluence(base_url, api_key, token, extra):
    return await _test_jira_like(base_url, api_key, token, extra, "Confluence")


# ══════════════════════════════════════════════════════════════════════════
# Communication
# ══════════════════════════════════════════════════════════════════════════

async def _test_slack(base_url, api_key, token, extra):
    key = token or api_key
    if not key:
        return _err("Token Slack manquant (xoxb-...)")
    import aiohttp
    headers = {"Authorization": f"Bearer {key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get("https://slack.com/api/auth.test", headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                d = await r.json()
                if d.get("ok"):
                    return _ok(f"Connecté au workspace {d.get('team', '?')}", 200)
                return _err(f"Slack : {d.get('error', 'auth_failed')}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_discord(base_url, api_key, token, extra):
    key = token or api_key
    if not key:
        return _err("Token Discord Bot manquant")
    import aiohttp
    headers = {"Authorization": f"Bot {key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get("https://discord.com/api/v10/users/@me", headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    return _ok(f"Bot connecté : {d.get('username', '?')}", 200)
                if r.status == 401:
                    return _err("Token Discord refusé", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_telegram(base_url, api_key, token, extra):
    key = token or api_key
    if not key:
        return _err("Token Telegram Bot manquant")
    import aiohttp
    url = f"https://api.telegram.org/bot{key}/getMe"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(url, timeout=aiohttp.ClientTimeout(total=6)) as r:
                d = await r.json()
                if d.get("ok"):
                    u = d.get("result") or {}
                    return _ok(f"Bot @{u.get('username', '?')} prêt", 200)
                return _err(f"Telegram : {d.get('description', 'auth_failed')}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_email_smtp(base_url, api_key, token, extra):
    # SMTP : on ne peut pas facilement tester sans faire du TLS handshake
    # complet. On se contente de vérifier le port TCP.
    host, port = _split_host_port(base_url or "smtp://smtp.gmail.com:587", "smtp", 587)
    return await _test_tcp(host, port, "SMTP")


# ══════════════════════════════════════════════════════════════════════════
# Automation — webhooks-only, pas de test canonique
# ══════════════════════════════════════════════════════════════════════════

async def _test_webhook_url(base_url, api_key, token, extra):
    if not base_url:
        return _err("URL manquante")
    import aiohttp
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(base_url, timeout=aiohttp.ClientTimeout(total=6)) as r:
                # Les webhooks répondent souvent 405/200/302 à un GET.
                # On considère OK si la socket répond.
                return _ok(f"Endpoint joignable (HTTP {r.status})", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_n8n(base_url, api_key, token, extra):
    if not base_url:
        return _err("URL n8n manquante")
    import aiohttp
    # /healthz est dispo sur les installations n8n récentes. Sinon fallback root.
    headers = {}
    if api_key:
        headers["X-N8N-API-KEY"] = api_key
    for path in ("/healthz", "/rest/active-workflows", ""):
        url = base_url.rstrip("/") + path
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(url, headers=headers,
                                  timeout=aiohttp.ClientTimeout(total=6)) as r:
                    if r.status < 400:
                        return _ok(f"n8n joignable ({path or '/'})", r.status)
                    if r.status in (401, 403) and api_key:
                        return _err("Clé API n8n refusée", r.status)
        except Exception:
            continue
    return _err("n8n injoignable")


# ══════════════════════════════════════════════════════════════════════════
# Monitoring
# ══════════════════════════════════════════════════════════════════════════

async def _test_sentry(base_url, api_key, token, extra):
    key = token or api_key
    if not key:
        return _err("Token Sentry manquant")
    import aiohttp
    base = (base_url or "https://sentry.io/api/0").rstrip("/")
    headers = {"Authorization": f"Bearer {key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{base}/organizations/", headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    return _ok("Sentry connecté", 200)
                if r.status == 401:
                    return _err("Token Sentry refusé", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_grafana(base_url, api_key, token, extra):
    if not base_url:
        return _err("URL Grafana manquante")
    key = api_key or token
    if not key:
        return _err("Clé API Grafana manquante")
    import aiohttp
    headers = {"Authorization": f"Bearer {key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(base_url.rstrip("/") + "/api/org", headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    return _ok("Grafana connecté", 200)
                if r.status == 401:
                    return _err("Clé Grafana refusée", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_posthog(base_url, api_key, token, extra):
    if not api_key:
        return _err("Clé personal API PostHog manquante")
    import aiohttp
    base = (base_url or "https://app.posthog.com").rstrip("/")
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{base}/api/users/@me/", headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    return _ok("PostHog connecté", 200)
                if r.status == 401:
                    return _err("Clé PostHog refusée", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


# ══════════════════════════════════════════════════════════════════════════
# Databases-as-service (Supabase)
# ══════════════════════════════════════════════════════════════════════════

async def _test_supabase(base_url, api_key, token, extra):
    if not base_url:
        return _err("URL Supabase manquante")
    if not api_key:
        return _err("Clé Supabase manquante (anon ou service_role)")
    import aiohttp
    # /rest/v1/ répond 200 avec un header apikey valide (même sans table)
    url = base_url.rstrip("/") + "/rest/v1/"
    headers = {"apikey": api_key, "Authorization": f"Bearer {api_key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(url, headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status < 400:
                    return _ok("Supabase connecté", r.status)
                if r.status == 401:
                    return _err("Clé Supabase refusée", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


# ══════════════════════════════════════════════════════════════════════════
# AI APIs
# ══════════════════════════════════════════════════════════════════════════

async def _test_huggingface(base_url, api_key, token, extra):
    key = api_key or token
    if not key:
        return _err("Token Hugging Face manquant")
    import aiohttp
    headers = {"Authorization": f"Bearer {key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get("https://huggingface.co/api/whoami-v2", headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    d = await r.json()
                    return _ok(f"Hugging Face : @{d.get('name', '?')}", 200)
                if r.status == 401:
                    return _err("Token Hugging Face refusé", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_replicate(base_url, api_key, token, extra):
    if not api_key:
        return _err("Token Replicate manquant")
    import aiohttp
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get("https://api.replicate.com/v1/account", headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    return _ok("Replicate connecté", 200)
                if r.status == 401:
                    return _err("Token Replicate refusé", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_stability(base_url, api_key, token, extra):
    if not api_key:
        return _err("Clé Stability AI manquante")
    import aiohttp
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get("https://api.stability.ai/v1/user/account", headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    return _ok("Stability AI connecté", 200)
                if r.status == 401:
                    return _err("Clé Stability refusée", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


# ══════════════════════════════════════════════════════════════════════════
# Search providers (HuntR) — on teste une vraie requête minimale
# ══════════════════════════════════════════════════════════════════════════

async def _test_tavily(base_url, api_key, token, extra):
    if not api_key:
        return _err("Clé Tavily manquante")
    import aiohttp
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(
                "https://api.tavily.com/search",
                json={"api_key": api_key, "query": "ping", "max_results": 1},
                timeout=aiohttp.ClientTimeout(total=8),
            ) as r:
                if r.status == 200:
                    return _ok("Tavily OK", 200)
                if r.status == 401:
                    return _err("Clé Tavily refusée", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_brave(base_url, api_key, token, extra):
    if not api_key:
        return _err("Clé Brave Search manquante")
    import aiohttp
    headers = {"X-Subscription-Token": api_key, "Accept": "application/json"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                "https://api.search.brave.com/res/v1/web/search",
                params={"q": "ping", "count": 1},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=8),
            ) as r:
                if r.status == 200:
                    return _ok("Brave Search OK", 200)
                if r.status in (401, 403):
                    return _err("Clé Brave refusée", r.status)
                if r.status == 429:
                    return _err("Quota Brave dépassé (mais clé valide)", 429)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_exa(base_url, api_key, token, extra):
    if not api_key:
        return _err("Clé Exa manquante")
    import aiohttp
    headers = {"x-api-key": api_key, "Content-Type": "application/json"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(
                "https://api.exa.ai/search",
                json={"query": "ping", "num_results": 1},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=8),
            ) as r:
                if r.status == 200:
                    return _ok("Exa OK", 200)
                if r.status == 401:
                    return _err("Clé Exa refusée", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_serper(base_url, api_key, token, extra):
    if not api_key:
        return _err("Clé Serper.dev manquante")
    import aiohttp
    headers = {"X-API-KEY": api_key, "Content-Type": "application/json"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(
                "https://google.serper.dev/search",
                json={"q": "ping", "num": 1},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=8),
            ) as r:
                if r.status == 200:
                    return _ok("Serper.dev OK", 200)
                if r.status in (401, 403):
                    return _err("Clé Serper refusée", r.status)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_serpapi(base_url, api_key, token, extra):
    if not api_key:
        return _err("Clé SerpAPI manquante")
    import aiohttp
    # /account : endpoint cheap qui valide la clé sans consommer de recherche
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                "https://serpapi.com/account",
                params={"api_key": api_key},
                timeout=aiohttp.ClientTimeout(total=8),
            ) as r:
                if r.status == 200:
                    return _ok("SerpAPI OK", 200)
                if r.status == 401:
                    return _err("Clé SerpAPI refusée", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_kagi(base_url, api_key, token, extra):
    if not api_key:
        return _err("Clé Kagi manquante")
    import aiohttp
    headers = {"Authorization": f"Bot {api_key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                "https://kagi.com/api/v0/search",
                params={"q": "ping", "limit": 1},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=8),
            ) as r:
                if r.status == 200:
                    return _ok("Kagi OK", 200)
                if r.status in (401, 403):
                    return _err("Clé Kagi refusée", r.status)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_bing(base_url, api_key, token, extra):
    if not api_key:
        return _err("Clé Bing Web Search manquante")
    import aiohttp
    headers = {"Ocp-Apim-Subscription-Key": api_key}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                "https://api.bing.microsoft.com/v7.0/search",
                params={"q": "ping", "count": 1},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=8),
            ) as r:
                if r.status == 200:
                    return _ok("Bing Web Search OK", 200)
                if r.status in (401, 403):
                    return _err("Clé Bing refusée", r.status)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_searxng(base_url, api_key, token, extra):
    if not base_url:
        return _err("URL SearXNG manquante")
    import aiohttp
    url = base_url.rstrip("/") + "/search"
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(url, params={"q": "ping", "format": "json"},
                              headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status < 400:
                    return _ok("SearXNG joignable", r.status)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


# ══════════════════════════════════════════════════════════════════════════
# Services qui nécessitent un driver/SDK qu'on n'a pas embarqué (trop lourd
# ou OAuth multi-étape). On le dit honnêtement plutôt que de faire semblant.
# ══════════════════════════════════════════════════════════════════════════

async def _test_not_implemented(service_name: str, reason: str) -> TestResult:
    return {
        "ok": False,
        "status": None,
        "error": f"Test automatique non disponible : {reason}",
        "message": "Configuration stockée — vérifie manuellement via l'outil qui l'utilise",
    }


async def _test_s3(base_url, api_key, token, extra):
    return await _test_not_implemented("s3", "SigV4 requis (boto3 non embarqué)")


async def _test_azure_blob(base_url, api_key, token, extra):
    return await _test_not_implemented("azure_blob", "SAS signature / Azure SDK requis")


async def _test_google_drive(base_url, api_key, token, extra):
    return await _test_not_implemented("google_drive", "OAuth 2.0 requis (pas juste une clé API)")


async def _test_dropbox(base_url, api_key, token, extra):
    key = token or api_key
    if not key:
        return _err("Token OAuth Dropbox manquant")
    import aiohttp
    headers = {"Authorization": f"Bearer {key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post("https://api.dropboxapi.com/2/users/get_current_account",
                               headers=headers,
                               timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    return _ok("Dropbox connecté", 200)
                if r.status == 401:
                    return _err("Token Dropbox refusé", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_ftp(base_url, api_key, token, extra):
    if not base_url:
        return _err("URL FTP/SFTP manquante")
    host, port = _split_host_port(base_url, "sftp", 22)
    return await _test_tcp(host, port, "FTP/SFTP")


async def _test_sqlite(base_url, api_key, token, extra):
    return await _test_not_implemented("sqlite", "fichier local — pas de test réseau pertinent")


async def _test_teams(base_url, api_key, token, extra):
    key = token or api_key
    if not key:
        return _err("Token Microsoft Graph manquant")
    import aiohttp
    headers = {"Authorization": f"Bearer {key}"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get("https://graph.microsoft.com/v1.0/me", headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    return _ok("Microsoft Graph connecté", 200)
                if r.status == 401:
                    return _err("Token Graph refusé", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


async def _test_whatsapp(base_url, api_key, token, extra):
    key = token or api_key
    if not key:
        return _err("Token WhatsApp Business manquant")
    return await _test_not_implemented(
        "whatsapp",
        "nécessite un phone_number_id + WABA ID pour valider. "
        "Stockage OK — test actif non implémenté"
    )


async def _test_activepieces(base_url, api_key, token, extra):
    if not base_url:
        return _err("URL Activepieces manquante")
    import aiohttp
    key = api_key or token
    headers = {}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    url = base_url.rstrip("/") + "/api/v1/users/me"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(url, headers=headers,
                              timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    return _ok("Activepieces connecté", 200)
                if r.status == 401:
                    return _err("Clé Activepieces refusée", 401)
                return _err(f"HTTP {r.status}", r.status)
    except Exception as e:
        return _err(f"Erreur réseau : {e}")


# ══════════════════════════════════════════════════════════════════════════
# Registry
# ══════════════════════════════════════════════════════════════════════════

SERVICE_TEST_HANDLERS: dict[str, Callable[..., Awaitable[TestResult]]] = {
    # Database
    "supabase": _test_supabase,
    "postgresql": _test_postgresql,
    "mysql": _test_mysql,
    "mongodb": _test_mongodb,
    "redis": _test_redis,
    "sqlite": _test_sqlite,
    # Storage
    "s3": _test_s3,
    "google_drive": _test_google_drive,
    "dropbox": _test_dropbox,
    "azure_blob": _test_azure_blob,
    "ftp": _test_ftp,
    # RAG / Vectoriel
    "pinecone": _test_pinecone,
    "qdrant": _test_qdrant,
    "weaviate": _test_weaviate,
    "chromadb": _test_chromadb,
    "milvus": _test_milvus,
    "elasticsearch": _test_elasticsearch,
    # Dev
    "github": _test_github,
    "gitlab": _test_gitlab,
    "notion": _test_notion,
    "jira": _test_jira,
    "linear": _test_linear,
    "confluence": _test_confluence,
    # Communication
    "slack": _test_slack,
    "discord": _test_discord,
    "telegram": _test_telegram,
    "email_smtp": _test_email_smtp,
    "teams": _test_teams,
    "whatsapp": _test_whatsapp,
    # Automation
    "n8n": _test_n8n,
    "make": _test_webhook_url,
    "zapier": _test_webhook_url,
    "activepieces": _test_activepieces,
    # Monitoring
    "sentry": _test_sentry,
    "grafana": _test_grafana,
    "posthog": _test_posthog,
    # AI
    "huggingface": _test_huggingface,
    "replicate": _test_replicate,
    "stability": _test_stability,
    # Search (HuntR)
    "tavily": _test_tavily,
    "brave": _test_brave,
    "exa": _test_exa,
    "serper": _test_serper,
    "serpapi": _test_serpapi,
    "kagi": _test_kagi,
    "bing": _test_bing,
    "searxng": _test_searxng,
}


async def run_service_test(
    service_name: str,
    base_url: str,
    api_key: str | None,
    token: str | None,
    extra: dict,
) -> TestResult:
    """Dispatcher. Retourne toujours un dict {ok, status?, message|error}."""
    handler = SERVICE_TEST_HANDLERS.get(service_name)
    if not handler:
        return {
            "ok": False,
            "status": None,
            "error": f"Pas de test implémenté pour '{service_name}'",
        }
    try:
        return await handler(base_url, api_key, token, extra or {})
    except Exception as e:
        logger.warning(f"[service_tests] {service_name} crashed: {e}")
        return {"ok": False, "status": None, "error": f"Erreur interne : {e}"}
