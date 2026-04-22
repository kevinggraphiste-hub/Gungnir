"""Git integration endpoints (+ PAT credential helper + AI commit message)."""
from __future__ import annotations

import asyncio
import os
import re
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel

from . import (
    _effective_user_id,
    _resolve_user_provider,
    _safe_path,
    _workspace,
    logger,
    router,
)


# ── Low-level git helpers ───────────────────────────────────────────────────

async def _git_exec(*args: str, cwd: str | None = None) -> tuple[bool, str]:
    """Run a git command and return (success, output)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd or str(_workspace()),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
        out = stdout.decode("utf-8", errors="replace") + stderr.decode("utf-8", errors="replace")
        return proc.returncode == 0, out.strip()
    except Exception as e:
        return False, str(e)


# ── PAT / credential helpers ────────────────────────────────────────────────

_GIT_HOST_TO_SERVICE = {
    "github.com": "git_github",
    "gitlab.com": "git_gitlab",
    "bitbucket.org": "git_bitbucket",
}

_GIT_HOST_USERNAME = {
    "github.com": "x-access-token",
    "gitlab.com": "oauth2",
    "bitbucket.org": "x-token-auth",
}


def _scrub_git_secrets(text: str, token: Optional[str]) -> str:
    """Remove a PAT (raw and URL-encoded forms) and any inline creds from text.

    Git can echo the authenticated URL in stderr on failures; the token may
    appear raw, percent-encoded, or inside a `https://user:pass@host/` form.
    This scrubber handles all three, so the result never leaks the secret.
    """
    if not text:
        return text
    if token:
        text = text.replace(token, "***")
        try:
            from urllib.parse import quote
            encoded = quote(token, safe="")
            if encoded and encoded != token:
                text = text.replace(encoded, "***")
        except Exception:
            pass
    # Belt-and-suspenders: strip any inline `user:secret@host` creds that
    # might have slipped through an encoding we didn't anticipate.
    text = re.sub(r"(https?://)[^/\s:@]+:[^/\s@]+@", r"\1***:***@", text)
    return text


async def _git_exec_env(*args: str, cwd: str | None = None, env: dict | None = None, scrub_token: Optional[str] = None) -> tuple[bool, str]:
    """Like _git_exec but accepts a custom environment (for credential injection).

    If ``scrub_token`` is provided, the returned output (including any Python
    exception message) is scrubbed so the PAT never leaks to callers.
    """
    merged_env = os.environ.copy()
    # Disable any interactive prompt — we never want git to block waiting for
    # a password in a Docker container. Either the URL carries a PAT or the
    # command fails fast with a clear error.
    merged_env["GIT_TERMINAL_PROMPT"] = "0"
    merged_env["GIT_ASKPASS"] = "/bin/echo"
    if env:
        merged_env.update(env)
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd or str(_workspace()),
            env=merged_env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
        out = stdout.decode("utf-8", errors="replace") + stderr.decode("utf-8", errors="replace")
        return proc.returncode == 0, _scrub_git_secrets(out.strip(), scrub_token)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return False, "Timeout (60s) — verifie ton PAT ou la connectivite."
    except Exception as e:
        return False, _scrub_git_secrets(str(e), scrub_token)


def _git_host_of(url: str) -> Optional[str]:
    """Extract host from a git URL (https, git@host:... or bare host)."""
    if not url:
        return None
    m = re.match(r"https?://([^/@]+?)(?::\d+)?/", url)
    if m:
        return m.group(1).lower()
    m = re.match(r"git@([^:]+):", url)
    if m:
        return m.group(1).lower()
    return None


def _authed_url(url: str, token: Optional[str]) -> str:
    """Inject a PAT into an https URL. Returns the url unchanged when no token
    or when the URL is not https (SSH urls use a different mechanism entirely).

    A URL already containing credentials is not modified.
    """
    if not token or not url.startswith(("http://", "https://")):
        return url
    if re.match(r"https?://[^/@]+@", url):
        return url  # already has creds
    host = _git_host_of(url) or ""
    username = _GIT_HOST_USERNAME.get(host, "x-access-token")
    scheme_end = url.find("://") + 3
    # URL-encode the token just enough to protect ':' and '@' inside it.
    from urllib.parse import quote
    safe_token = quote(token, safe="")
    return url[:scheme_end] + f"{username}:{safe_token}@" + url[scheme_end:]


async def _user_git_token_for_url(url: str) -> Optional[str]:
    """Look up the current user's stored PAT for the host of `url`."""
    host = _git_host_of(url)
    if not host:
        return None
    service = _GIT_HOST_TO_SERVICE.get(host)
    if not service:
        return None
    try:
        from backend.core.db.engine import async_session
        from backend.core.api.auth_helpers import get_user_settings, get_user_service_key
    except ImportError:
        return None
    uid = await _effective_user_id()
    if uid <= 0:
        return None
    async with async_session() as _s:
        user_settings = await get_user_settings(uid, _s)
        svc = get_user_service_key(user_settings, service)
        if not svc:
            return None
        return svc.get("token") or svc.get("api_key")


async def _user_git_identity() -> tuple[Optional[str], Optional[str]]:
    """Return (user.name, user.email) stored for the current user, or (None, None)."""
    try:
        from backend.core.db.engine import async_session
        from backend.core.api.auth_helpers import get_user_settings
    except ImportError:
        return None, None
    uid = await _effective_user_id()
    if uid <= 0:
        return None, None
    async with async_session() as _s:
        user_settings = await get_user_settings(uid, _s)
        cfg = (user_settings.service_keys or {}).get("git_config") or {}
        return cfg.get("user_name") or None, cfg.get("user_email") or None


def _apply_identity_args(name: Optional[str], email: Optional[str]) -> list[str]:
    """Build `-c user.name=... -c user.email=...` args for inline git config."""
    extra: list[str] = []
    if name:
        extra += ["-c", f"user.name={name}"]
    if email:
        extra += ["-c", f"user.email={email}"]
    return extra


# ── Status / diff / commit / init / branches / checkout ─────────────────────

@router.get("/git/status")
async def git_status():
    """Git status of the workspace."""
    ws = str(_workspace())
    ok, _ = await _git_exec("rev-parse", "--git-dir", cwd=ws)
    if not ok:
        return {"is_repo": False}

    _, branch = await _git_exec("branch", "--show-current", cwd=ws)
    _, status = await _git_exec("status", "--porcelain", cwd=ws)
    _, log = await _git_exec("log", "--oneline", "-10", cwd=ws)

    files = []
    for line in status.strip().split("\n"):
        if len(line) >= 4:
            st = line[:2].strip()
            path = line[3:].strip()
            files.append({"status": st, "path": path})

    return {
        "is_repo": True,
        "branch": branch or "main",
        "files": files,
        "log": [l.strip() for l in log.strip().split("\n") if l.strip()][:10],
    }


@router.get("/git/diff")
async def git_diff(path: str = ""):
    """Get git diff for workspace or specific file."""
    ws = str(_workspace())
    args = ["diff"]
    if path:
        args.append("--")
        args.append(path)
    _, diff = await _git_exec(*args, cwd=ws)
    # Also staged diff
    args_staged = ["diff", "--cached"]
    if path:
        args_staged += ["--", path]
    _, staged = await _git_exec(*args_staged, cwd=ws)
    return {"diff": diff, "staged": staged}


class GitCommitRequest(BaseModel):
    message: str
    files: list[str] = []  # empty = all changed


@router.post("/git/commit")
async def git_commit(req: GitCommitRequest):
    """Stage files and commit. Identity is taken from the user's saved
    git_config entry (falls back to git defaults otherwise)."""
    ws = str(_workspace())
    if req.files:
        for f in req.files:
            await _git_exec("add", f, cwd=ws)
    else:
        await _git_exec("add", "-A", cwd=ws)
    name, email = await _user_git_identity()
    args = _apply_identity_args(name, email) + ["commit", "-m", req.message]
    ok, out = await _git_exec(*args, cwd=ws)
    return {"ok": ok, "output": out, "identity": {"name": name, "email": email} if name or email else None}


@router.post("/git/init")
async def git_init():
    """Initialize a git repo in the workspace."""
    ws = str(_workspace())
    ok, out = await _git_exec("init", cwd=ws)
    return {"ok": ok, "output": out}


@router.get("/git/branches")
async def git_branches():
    """List git branches."""
    ws = str(_workspace())
    ok, out = await _git_exec("branch", "--no-color", cwd=ws)
    if not ok:
        return {"branches": [], "current": ""}
    branches = []
    current = ""
    for line in out.strip().split("\n"):
        line = line.strip()
        if line.startswith("* "):
            current = line[2:]
            branches.append(current)
        elif line:
            branches.append(line)
    return {"branches": branches, "current": current}


@router.post("/git/checkout")
async def git_checkout(data: dict):
    """Switch branch."""
    ws = str(_workspace())
    branch = data.get("branch", "")
    if not branch:
        raise HTTPException(400, "Branche requise")
    ok, out = await _git_exec("checkout", branch, cwd=ws)
    return {"ok": ok, "output": out}


# ── Git remote (push / pull / clone / remotes, with PAT credential helper) ──

@router.get("/git/remote")
async def git_remote_list():
    """List configured remotes (name → url) for the workspace repo."""
    ws = str(_workspace())
    ok, out = await _git_exec("remote", "-v", cwd=ws)
    if not ok:
        return {"is_repo": False, "remotes": []}
    seen: dict[str, str] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] not in seen:
            seen[parts[0]] = parts[1]
    return {"is_repo": True, "remotes": [{"name": n, "url": u, "host": _git_host_of(u)} for n, u in seen.items()]}


class GitRemoteAddRequest(BaseModel):
    name: str = "origin"
    url: str


@router.post("/git/remote")
async def git_remote_add(req: GitRemoteAddRequest):
    """Add or replace a remote (defaults to 'origin')."""
    ws = str(_workspace())
    name = (req.name or "origin").strip() or "origin"
    url = req.url.strip()
    if not url:
        raise HTTPException(400, "URL requise")
    # Try add first; if it exists, set-url instead.
    ok, out = await _git_exec("remote", "add", name, url, cwd=ws)
    if not ok and "already exists" in out.lower():
        ok, out = await _git_exec("remote", "set-url", name, url, cwd=ws)
    return {"ok": ok, "output": out, "name": name, "url": url}


@router.delete("/git/remote/{name}")
async def git_remote_remove(name: str):
    ws = str(_workspace())
    ok, out = await _git_exec("remote", "remove", name, cwd=ws)
    return {"ok": ok, "output": out}


class GitPushPullRequest(BaseModel):
    remote: str = "origin"
    branch: Optional[str] = None  # None = current branch
    set_upstream: bool = False     # push only


@router.post("/git/push")
async def git_push(req: GitPushPullRequest):
    """Push to remote using the user's stored PAT for credential injection.

    The PAT is never written to disk — it is injected into the remote URL for
    the duration of one command via `-c remote.<name>.url=<authed>`.
    """
    ws = str(_workspace())
    _, branch = await _git_exec("branch", "--show-current", cwd=ws)
    target_branch = (req.branch or branch or "main").strip()
    # Read remote URL
    ok, remote_url = await _git_exec("remote", "get-url", req.remote, cwd=ws)
    if not ok or not remote_url:
        raise HTTPException(400, f"Remote '{req.remote}' introuvable. Ajoute-le d'abord via /git/remote.")
    token = await _user_git_token_for_url(remote_url)
    authed = _authed_url(remote_url, token)
    args: list[str] = []
    if authed != remote_url:
        args += ["-c", f"remote.{req.remote}.url={authed}"]
    args += ["push"]
    if req.set_upstream:
        args += ["--set-upstream"]
    args += [req.remote, target_branch]
    ok, out = await _git_exec_env(*args, cwd=ws, scrub_token=token)
    return {"ok": ok, "output": out, "branch": target_branch, "remote": req.remote, "authenticated": bool(token)}


@router.post("/git/pull")
async def git_pull(req: GitPushPullRequest):
    ws = str(_workspace())
    _, branch = await _git_exec("branch", "--show-current", cwd=ws)
    target_branch = (req.branch or branch or "main").strip()
    ok, remote_url = await _git_exec("remote", "get-url", req.remote, cwd=ws)
    if not ok or not remote_url:
        raise HTTPException(400, f"Remote '{req.remote}' introuvable.")
    token = await _user_git_token_for_url(remote_url)
    authed = _authed_url(remote_url, token)
    args: list[str] = []
    if authed != remote_url:
        args += ["-c", f"remote.{req.remote}.url={authed}"]
    # Identity is needed for the merge commit when pull creates one.
    name, email = await _user_git_identity()
    args += _apply_identity_args(name, email)
    args += ["pull", req.remote, target_branch]
    ok, out = await _git_exec_env(*args, cwd=ws, scrub_token=token)
    return {"ok": ok, "output": out, "branch": target_branch, "remote": req.remote, "authenticated": bool(token)}


@router.post("/git/fetch")
async def git_fetch(req: GitPushPullRequest):
    ws = str(_workspace())
    ok, remote_url = await _git_exec("remote", "get-url", req.remote, cwd=ws)
    if not ok or not remote_url:
        raise HTTPException(400, f"Remote '{req.remote}' introuvable.")
    token = await _user_git_token_for_url(remote_url)
    authed = _authed_url(remote_url, token)
    args: list[str] = []
    if authed != remote_url:
        args += ["-c", f"remote.{req.remote}.url={authed}"]
    args += ["fetch", "--prune", req.remote]
    ok, out = await _git_exec_env(*args, cwd=ws, scrub_token=token)
    return {"ok": ok, "output": out, "remote": req.remote}


class GitCloneRequest(BaseModel):
    url: str
    target: Optional[str] = None  # subdir name inside workspace; defaults to repo basename


@router.post("/git/clone")
async def git_clone(req: GitCloneRequest):
    """Clone a remote repo into the workspace (or a named sub-folder).

    Writing into the workspace root is allowed only when it is empty; otherwise
    a subfolder is required so we never clobber user files.
    """
    ws = _workspace()
    url = (req.url or "").strip()
    if not url:
        raise HTTPException(400, "URL requise")
    # Determine target directory
    sub = (req.target or "").strip().strip("/") or None
    if sub is None:
        m = re.search(r"/([^/]+?)(?:\.git)?/?$", url)
        sub = m.group(1) if m else "cloned_repo"
    dest = _safe_path(sub) if sub else ws
    if dest.exists() and any(dest.iterdir()):
        raise HTTPException(409, f"'{sub}' existe deja et n'est pas vide.")
    dest.parent.mkdir(parents=True, exist_ok=True)
    token = await _user_git_token_for_url(url)
    authed = _authed_url(url, token)
    ok, out = await _git_exec_env("clone", authed, str(dest), cwd=str(ws), scrub_token=token)
    return {"ok": ok, "output": out, "target": sub, "authenticated": bool(token)}


# ── Credentials ──────────────────────────────────────────────────────────

class GitCredentialSaveRequest(BaseModel):
    host: str  # github.com | gitlab.com | bitbucket.org
    token: str


@router.post("/git/credentials")
async def git_credentials_save(req: GitCredentialSaveRequest):
    """Store an encrypted PAT for a given host under the current user."""
    try:
        from backend.core.db.engine import async_session
        from backend.core.api.auth_helpers import get_user_settings
        from backend.core.config.settings import encrypt_value
        from sqlalchemy.orm.attributes import flag_modified
    except ImportError:
        raise HTTPException(500, "Backend auth indisponible")
    host = (req.host or "").strip().lower()
    service = _GIT_HOST_TO_SERVICE.get(host)
    if not service:
        raise HTTPException(400, f"Host non supporte: {host}. Supportes: {list(_GIT_HOST_TO_SERVICE.keys())}")
    token = (req.token or "").strip()
    if not token:
        raise HTTPException(400, "Token requis")
    uid = await _effective_user_id()
    if uid <= 0:
        raise HTTPException(401, "Authentification requise")
    async with async_session() as _s:
        user_settings = await get_user_settings(uid, _s)
        service_keys = dict(user_settings.service_keys or {})
        service_keys[service] = {
            "token": encrypt_value(token),
            "enabled": True,
            "host": host,
        }
        user_settings.service_keys = service_keys
        flag_modified(user_settings, "service_keys")
        await _s.commit()
    return {"ok": True, "host": host}


@router.get("/git/credentials")
async def git_credentials_list():
    """Return which hosts have a stored PAT (without exposing the value)."""
    try:
        from backend.core.db.engine import async_session
        from backend.core.api.auth_helpers import get_user_settings
    except ImportError:
        return {"hosts": []}
    uid = await _effective_user_id()
    if uid <= 0:
        return {"hosts": []}
    async with async_session() as _s:
        user_settings = await get_user_settings(uid, _s)
        service_keys = user_settings.service_keys or {}
        hosts = []
        for host, service in _GIT_HOST_TO_SERVICE.items():
            entry = service_keys.get(service) or {}
            hosts.append({"host": host, "configured": bool(entry.get("token")), "enabled": bool(entry.get("enabled", True))})
        cfg = service_keys.get("git_config") or {}
        return {"hosts": hosts, "user_name": cfg.get("user_name"), "user_email": cfg.get("user_email")}


@router.delete("/git/credentials/{host}")
async def git_credentials_remove(host: str):
    try:
        from backend.core.db.engine import async_session
        from backend.core.api.auth_helpers import get_user_settings
        from sqlalchemy.orm.attributes import flag_modified
    except ImportError:
        return {"ok": False}
    service = _GIT_HOST_TO_SERVICE.get(host.lower())
    if not service:
        raise HTTPException(400, f"Host non supporte: {host}")
    uid = await _effective_user_id()
    if uid <= 0:
        raise HTTPException(401, "Authentification requise")
    async with async_session() as _s:
        user_settings = await get_user_settings(uid, _s)
        service_keys = dict(user_settings.service_keys or {})
        if service in service_keys:
            del service_keys[service]
            user_settings.service_keys = service_keys
            flag_modified(user_settings, "service_keys")
            await _s.commit()
    return {"ok": True}


class GitIdentityRequest(BaseModel):
    user_name: str
    user_email: str


@router.post("/git/config/identity")
async def git_set_identity(req: GitIdentityRequest):
    """Store the user.name / user.email applied to all commits for this user.

    Values are injected per-command via `-c user.name=...` so nothing is
    written to the container's global gitconfig.
    """
    try:
        from backend.core.db.engine import async_session
        from backend.core.api.auth_helpers import get_user_settings
        from sqlalchemy.orm.attributes import flag_modified
    except ImportError:
        raise HTTPException(500, "Backend auth indisponible")
    uid = await _effective_user_id()
    if uid <= 0:
        raise HTTPException(401, "Authentification requise")
    name = (req.user_name or "").strip()
    email = (req.user_email or "").strip()
    if not name or not email:
        raise HTTPException(400, "user_name et user_email requis")
    async with async_session() as _s:
        user_settings = await get_user_settings(uid, _s)
        service_keys = dict(user_settings.service_keys or {})
        service_keys["git_config"] = {"user_name": name, "user_email": email}
        user_settings.service_keys = service_keys
        flag_modified(user_settings, "service_keys")
        await _s.commit()
    return {"ok": True, "user_name": name, "user_email": email}


# ── AI Commit Message Generator ────────────────────────────────────────────

class AICommitRequest(BaseModel):
    diff: str
    provider_name: Optional[str] = None
    model_name: Optional[str] = None


@router.post("/git/ai-commit-message")
async def generate_commit_message(req: AICommitRequest):
    """Generate a commit message from git diff using AI."""
    try:
        from backend.core.providers import ChatMessage
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    provider, chosen_model, _err = await _resolve_user_provider(req.provider_name, req.model_name)
    if _err or not provider or not chosen_model:
        return {"ok": False, "error": _err or "Aucun provider LLM configuré"}

    messages = [
        ChatMessage(role="system", content=(
            "Tu generes des messages de commit Git concis et precis en anglais.\n"
            "Format: type(scope): description\n"
            "Types: feat, fix, refactor, docs, style, test, chore, perf\n"
            "- Premiere ligne: max 72 caracteres\n"
            "- Optionnel: ligne vide + description detaillee\n"
            "Reponds UNIQUEMENT avec le message de commit, rien d'autre."
        )),
        ChatMessage(role="user", content=f"Genere un message de commit pour ce diff:\n\n{req.diff[:6000]}"),
    ]

    try:
        response = await provider.chat(messages, chosen_model)
        msg = (response.content or "").strip()
        # Clean up: remove markdown code blocks if present
        if msg.startswith("```"):
            msg = msg.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        return {"ok": True, "message": msg}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}
