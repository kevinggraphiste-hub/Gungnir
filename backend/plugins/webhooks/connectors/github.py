"""
Connector GitHub — agent_tools après authentification OAuth.

Tools exposés :
- github_list_repos           : liste des repos accessibles
- github_search_issues        : recherche d'issues/PRs (via search API)
- github_create_issue         : ouvre une issue sur un repo
- github_search_code          : recherche de code (via search API)
- github_get_repo_info        : métadonnées d'un repo

Tous les calls utilisent le token OAuth de l'user via `get_user_oauth_token`.
"""
from __future__ import annotations

from typing import Any
import httpx

from backend.core.agents.wolf_tools import get_user_context


_GITHUB_API = "https://api.github.com"


async def _gh_token(user_id: int) -> str | None:
    from backend.core.db.engine import async_session
    from backend.plugins.webhooks.oauth_core import get_user_oauth_token
    async with async_session() as session:
        return await get_user_oauth_token(user_id, "github", session)


async def _gh_request(method: str, path: str, *, params: dict | None = None, json_body: dict | None = None) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Authentification requise"}
    token = await _gh_token(uid)
    if not token:
        return {"ok": False, "error": "GitHub non connecté. Va dans Intégrations → Connecter GitHub."}
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    url = path if path.startswith("http") else f"{_GITHUB_API}{path}"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.request(method, url, params=params, json=json_body, headers=headers)
            if r.status_code >= 400:
                return {"ok": False, "status": r.status_code, "error": r.text[:300]}
            return {"ok": True, "data": r.json() if r.text else None}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


# ── Schémas ──────────────────────────────────────────────────────────────

TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "github_list_repos",
            "description": "Liste les repos GitHub accessibles à l'user (visible avec le scope 'repo'). Top 30 par défaut, triés par activité récente.",
            "parameters": {
                "type": "object",
                "properties": {
                    "per_page": {"type": "integer", "description": "Nombre max de repos (default 30, max 100).", "default": 30},
                    "type": {"type": "string", "description": "all | owner | member (default all)", "default": "all"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "github_search_issues",
            "description": "Recherche d'issues / PRs via l'API GitHub Search. Supporte la syntaxe complète (ex: 'repo:user/repo is:open label:bug').",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Query GitHub search (ex: 'is:issue is:open author:@me')."},
                    "per_page": {"type": "integer", "description": "Nb max résultats (default 20, max 100).", "default": 20},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "github_create_issue",
            "description": "Crée une issue sur un repo GitHub. Requiert scope 'repo'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "owner": {"type": "string", "description": "Owner (user ou org)."},
                    "repo": {"type": "string", "description": "Nom du repo."},
                    "title": {"type": "string", "description": "Titre de l'issue."},
                    "body": {"type": "string", "description": "Description (markdown supporté)."},
                    "labels": {"type": "array", "items": {"type": "string"}, "description": "Labels à appliquer."},
                },
                "required": ["owner", "repo", "title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "github_search_code",
            "description": "Recherche de code via l'API GitHub Search. Pratique pour trouver un snippet ou un fichier dans tous les repos accessibles.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Query (ex: 'addEventListener language:typescript repo:user/repo')."},
                    "per_page": {"type": "integer", "description": "Nb max résultats (default 20, max 100).", "default": 20},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "github_get_repo_info",
            "description": "Métadonnées d'un repo (description, stars, langages, default branch, dernier push).",
            "parameters": {
                "type": "object",
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                },
                "required": ["owner", "repo"],
            },
        },
    },
]


# ── Executors ────────────────────────────────────────────────────────────

async def _github_list_repos(per_page: int = 30, type: str = "all") -> dict:
    res = await _gh_request("GET", "/user/repos", params={
        "per_page": min(int(per_page), 100), "sort": "pushed", "type": type,
    })
    if not res.get("ok"):
        return res
    repos = res.get("data") or []
    out = [
        {
            "full_name": r.get("full_name"),
            "private": r.get("private"),
            "description": r.get("description"),
            "stars": r.get("stargazers_count"),
            "language": r.get("language"),
            "default_branch": r.get("default_branch"),
            "updated_at": r.get("pushed_at"),
            "url": r.get("html_url"),
        }
        for r in repos
    ]
    return {"ok": True, "count": len(out), "repos": out}


async def _github_search_issues(query: str, per_page: int = 20) -> dict:
    res = await _gh_request("GET", "/search/issues", params={
        "q": query, "per_page": min(int(per_page), 100),
    })
    if not res.get("ok"):
        return res
    data = res.get("data") or {}
    items = data.get("items", [])
    out = [
        {
            "title": i.get("title"),
            "number": i.get("number"),
            "state": i.get("state"),
            "is_pr": "pull_request" in i,
            "repo": i.get("repository_url", "").rsplit("/", 2)[-2:],
            "url": i.get("html_url"),
            "updated_at": i.get("updated_at"),
            "labels": [l.get("name") for l in i.get("labels", [])],
        }
        for i in items
    ]
    return {"ok": True, "total": data.get("total_count", 0), "items": out}


async def _github_create_issue(owner: str, repo: str, title: str, body: str = "", labels: list | None = None) -> dict:
    payload: dict = {"title": title, "body": body or ""}
    if labels:
        payload["labels"] = list(labels)
    res = await _gh_request("POST", f"/repos/{owner}/{repo}/issues", json_body=payload)
    if not res.get("ok"):
        return res
    issue = res.get("data") or {}
    return {
        "ok": True,
        "number": issue.get("number"),
        "url": issue.get("html_url"),
        "title": issue.get("title"),
    }


async def _github_search_code(query: str, per_page: int = 20) -> dict:
    res = await _gh_request("GET", "/search/code", params={
        "q": query, "per_page": min(int(per_page), 100),
    })
    if not res.get("ok"):
        return res
    data = res.get("data") or {}
    items = data.get("items", [])
    out = [
        {
            "name": i.get("name"),
            "path": i.get("path"),
            "repo": (i.get("repository") or {}).get("full_name"),
            "url": i.get("html_url"),
            "score": i.get("score"),
        }
        for i in items
    ]
    return {"ok": True, "total": data.get("total_count", 0), "items": out}


async def _github_get_repo_info(owner: str, repo: str) -> dict:
    res = await _gh_request("GET", f"/repos/{owner}/{repo}")
    if not res.get("ok"):
        return res
    r = res.get("data") or {}
    return {
        "ok": True,
        "full_name": r.get("full_name"),
        "description": r.get("description"),
        "stars": r.get("stargazers_count"),
        "forks": r.get("forks_count"),
        "open_issues": r.get("open_issues_count"),
        "language": r.get("language"),
        "default_branch": r.get("default_branch"),
        "updated_at": r.get("pushed_at"),
        "url": r.get("html_url"),
        "topics": r.get("topics", []),
    }


EXECUTORS: dict[str, Any] = {
    "github_list_repos": _github_list_repos,
    "github_search_issues": _github_search_issues,
    "github_create_issue": _github_create_issue,
    "github_search_code": _github_search_code,
    "github_get_repo_info": _github_get_repo_info,
}
