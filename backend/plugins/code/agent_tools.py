"""
SpearCode — agent_tools.py : outils WOLF pour piloter le workspace code
depuis le chat principal de Gungnir (l'agent global).

Convention auto-découverte : `TOOL_SCHEMAS` + `EXECUTORS` sont agrégés
par `backend/core/agents/wolf_tools.py` au boot.

Chaque outil est strictement per-user via `get_user_context()`. On
injecte aussi le ContextVar `_current_user_id` du plugin code pour que
ses helpers internes (`_workspace`, `_safe_path`) scopent bien sur le
bon user.

Fonctionnalités exposées (subset curated du plugin — pas les 53 routes) :
- Fichiers : list, read, write, delete, search (nom ou contenu)
- Exécution : run (11 langages), terminal shell (blocklist)
- Git : status, diff, commit
"""
from __future__ import annotations

from typing import Any, Optional

from backend.core.agents.wolf_tools import get_user_context


# ── Schémas OpenAI-compatible exposés au LLM ──────────────────────────────

TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "spearcode_list_files",
            "description": "Liste les fichiers et dossiers du workspace SpearCode de l'user (ou d'un sous-dossier). Utile pour explorer le projet avant d'agir.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin relatif dans le workspace. Vide = racine."},
                    "recursive": {"type": "boolean", "description": "Inclure les sous-dossiers. Default: false."},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spearcode_read_file",
            "description": "Lit le contenu d'un fichier texte dans le workspace SpearCode. Refuse les binaires. Limite 200 Ko.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin relatif depuis la racine du workspace."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spearcode_write_file",
            "description": "Écrit (crée ou remplace) un fichier dans le workspace SpearCode. Crée automatiquement les dossiers parents si besoin.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spearcode_delete_file",
            "description": "Supprime un fichier ou un dossier (récursif) du workspace SpearCode.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spearcode_search",
            "description": "Recherche dans le workspace : par nom de fichier ou par contenu (full-text).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "mode": {"type": "string", "enum": ["name", "content"], "description": "Default: 'content'."},
                    "limit": {"type": "integer", "description": "Nombre max de résultats (default 30)."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spearcode_run",
            "description": "Exécute un fichier dans le workspace (Python, Node, TS, Bash, Ruby, Go, PHP, Lua, R). Retourne stdout/stderr/exit_code.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin relatif du fichier à exécuter."},
                    "args": {"type": "array", "items": {"type": "string"}, "description": "Arguments passés au script."},
                    "timeout": {"type": "integer", "description": "Timeout en secondes (default 30)."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spearcode_terminal",
            "description": "Exécute une commande shell dans le workspace. Blocklist stricte pour les commandes système dangereuses (cf. wolf_tools.bash_exec).",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "timeout": {"type": "integer", "description": "Timeout en secondes (default 30)."},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spearcode_git_status",
            "description": "Retourne le statut git du workspace (branche courante, fichiers modified/untracked/staged).",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spearcode_git_diff",
            "description": "Retourne le diff git du workspace (tous fichiers ou un chemin spécifique).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin optionnel. Vide = tout le workspace."},
                    "staged": {"type": "boolean", "description": "Diff des fichiers staged (default false)."},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spearcode_git_commit",
            "description": "Crée un commit git avec le message fourni. Stage tous les changements par défaut (add -A).",
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {"type": "string"},
                    "add_all": {"type": "boolean", "description": "Stage tous les changements avant commit (default true)."},
                },
                "required": ["message"],
            },
        },
    },
]


# ── Helpers : injection du ContextVar du plugin code ─────────────────────

def _set_plugin_user_context(uid: int) -> None:
    """Le plugin code utilise son propre ContextVar pour scoper les paths
    per-user (_workspace, _safe_path). On le set avant d'appeler ses helpers."""
    try:
        from backend.plugins.code.routes import _current_user_id as _sc_uid
        _sc_uid.set(int(uid or 0))
    except Exception:
        pass


# ── Executors ────────────────────────────────────────────────────────────

async def _spearcode_list_files(path: str = "", recursive: bool = False) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    _set_plugin_user_context(uid)
    try:
        from backend.plugins.code.routes import _workspace, _safe_path
        ws = _workspace()
        target = _safe_path(path) if path else ws
        if not target.exists():
            return {"ok": False, "error": f"Chemin introuvable: {path}"}
        out: list[dict] = []
        if recursive:
            for p in sorted(target.rglob("*")):
                if p.is_file() or p.is_dir():
                    rel = str(p.relative_to(ws)).replace("\\", "/")
                    out.append({"path": rel, "is_dir": p.is_dir(),
                                "size": p.stat().st_size if p.is_file() else None})
                    if len(out) >= 500:
                        break
        else:
            for p in sorted(target.iterdir() if target.is_dir() else []):
                rel = str(p.relative_to(ws)).replace("\\", "/")
                out.append({"path": rel, "is_dir": p.is_dir(),
                            "size": p.stat().st_size if p.is_file() else None})
        return {"ok": True, "workspace": str(ws), "entries": out, "count": len(out)}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _spearcode_read_file(path: str) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    _set_plugin_user_context(uid)
    try:
        from backend.plugins.code.routes import _safe_path
        p = _safe_path(path)
        if not p.is_file():
            return {"ok": False, "error": "Fichier introuvable."}
        if p.stat().st_size > 200 * 1024:
            return {"ok": False, "error": f"Fichier trop gros ({p.stat().st_size // 1024} Ko > 200 Ko). Utilise spearcode_terminal avec grep/head pour cibler."}
        try:
            content = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return {"ok": False, "error": "Fichier binaire — lecture texte refusée."}
        return {"ok": True, "path": path, "content": content, "size": len(content)}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _spearcode_write_file(path: str, content: str) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    _set_plugin_user_context(uid)
    try:
        from backend.plugins.code.routes import _safe_path
        p = _safe_path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return {"ok": True, "path": path, "size": len(content)}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _spearcode_delete_file(path: str) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    _set_plugin_user_context(uid)
    try:
        from backend.plugins.code.routes import _safe_path
        import shutil
        p = _safe_path(path)
        if not p.exists():
            return {"ok": False, "error": "Introuvable."}
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
        return {"ok": True, "deleted": path}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _spearcode_search(query: str, mode: str = "content", limit: int = 30) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    _set_plugin_user_context(uid)
    try:
        from backend.plugins.code.routes import _workspace
        ws = _workspace()
        q = (query or "").lower().strip()
        if not q:
            return {"ok": True, "matches": []}
        matches: list[dict] = []
        MAX_FILE = 2 * 1024 * 1024  # 2 Mo
        for p in ws.rglob("*"):
            if len(matches) >= int(limit):
                break
            if not p.is_file():
                continue
            rel = str(p.relative_to(ws)).replace("\\", "/")
            if mode == "name":
                if q in rel.lower():
                    matches.append({"path": rel})
                continue
            # content mode (default)
            try:
                if p.stat().st_size > MAX_FILE:
                    continue
                text = p.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            lines_hit = [
                (i + 1, ln.strip()[:200])
                for i, ln in enumerate(text.splitlines())
                if q in ln.lower()
            ]
            if lines_hit:
                matches.append({
                    "path": rel,
                    "hits": lines_hit[:5],
                    "total_hits": len(lines_hit),
                })
        return {"ok": True, "mode": mode, "query": query, "matches": matches, "count": len(matches)}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _spearcode_run(path: str, args: Optional[list] = None, timeout: int = 30) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    _set_plugin_user_context(uid)
    try:
        from backend.plugins.code.routes import _safe_path, _workspace
        import asyncio as _asyncio
        p = _safe_path(path)
        if not p.is_file():
            return {"ok": False, "error": "Fichier introuvable."}
        ext = p.suffix.lower()
        RUNNERS = {
            ".py": ["python"], ".js": ["node"], ".mjs": ["node"],
            ".ts": ["tsx"], ".sh": ["bash"], ".bash": ["bash"],
            ".rb": ["ruby"], ".go": ["go", "run"], ".php": ["php"],
            ".lua": ["lua"], ".r": ["Rscript"], ".R": ["Rscript"],
        }
        cmd_prefix = RUNNERS.get(ext)
        if not cmd_prefix:
            return {"ok": False, "error": f"Extension {ext} non supportée."}
        argv = [*cmd_prefix, str(p), *[str(a) for a in (args or [])]]
        ws = _workspace()
        proc = await _asyncio.create_subprocess_exec(
            *argv,
            stdout=_asyncio.subprocess.PIPE,
            stderr=_asyncio.subprocess.PIPE,
            cwd=str(ws),
        )
        try:
            stdout, stderr = await _asyncio.wait_for(proc.communicate(), timeout=max(1, min(int(timeout), 180)))
        except _asyncio.TimeoutError:
            proc.kill()
            return {"ok": False, "error": f"Timeout après {timeout}s", "path": path}
        return {
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "stdout": stdout.decode("utf-8", errors="replace")[:8000],
            "stderr": stderr.decode("utf-8", errors="replace")[:4000],
            "command": " ".join(argv),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _spearcode_terminal(command: str, timeout: int = 30) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    _set_plugin_user_context(uid)
    try:
        # Réutilise la blocklist centrale de wolf_tools._bash_exec
        from backend.core.agents.wolf_tools import _bash_exec
        from backend.plugins.code.routes import _workspace
        ws = _workspace()
        # On convertit le chemin absolu du workspace en relatif au project_root
        # pour que _bash_exec accepte la cwd (qui attend un rel relatif à project_root).
        try:
            from pathlib import Path as _Path
            project_root = _Path(__file__).parent.parent.parent.parent
            rel = ws.relative_to(project_root)
            rel_str = str(rel)
        except Exception:
            rel_str = "."
        return await _bash_exec(command, timeout=timeout, cwd=rel_str)
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _spearcode_git_status() -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    _set_plugin_user_context(uid)
    try:
        from backend.plugins.code.routes import _workspace
        import asyncio as _asyncio
        ws = _workspace()
        proc = await _asyncio.create_subprocess_exec(
            "git", "status", "--porcelain=v1", "-b",
            stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.PIPE, cwd=str(ws),
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            return {"ok": False, "error": err.decode("utf-8", errors="replace")[:500]}
        lines = out.decode("utf-8", errors="replace").splitlines()
        branch = ""
        modified: list[str] = []
        untracked: list[str] = []
        staged: list[str] = []
        for ln in lines:
            if ln.startswith("## "):
                branch = ln[3:].split("...")[0]
                continue
            if len(ln) < 3:
                continue
            status = ln[:2]
            path = ln[3:]
            if status == "??":
                untracked.append(path)
            elif status[0] != " ":
                staged.append(path)
            else:
                modified.append(path)
        return {
            "ok": True, "branch": branch,
            "modified": modified, "untracked": untracked, "staged": staged,
            "clean": not (modified or untracked or staged),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _spearcode_git_diff(path: str = "", staged: bool = False) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    _set_plugin_user_context(uid)
    try:
        from backend.plugins.code.routes import _workspace
        import asyncio as _asyncio
        ws = _workspace()
        argv = ["git", "diff"]
        if staged:
            argv.append("--cached")
        if path:
            argv.extend(["--", path])
        proc = await _asyncio.create_subprocess_exec(
            *argv,
            stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.PIPE, cwd=str(ws),
        )
        out, err = await proc.communicate()
        if proc.returncode != 0 and err:
            return {"ok": False, "error": err.decode("utf-8", errors="replace")[:500]}
        return {"ok": True, "diff": out.decode("utf-8", errors="replace")[:16000]}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _spearcode_git_commit(message: str, add_all: bool = True) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    _set_plugin_user_context(uid)
    try:
        from backend.plugins.code.routes import _workspace
        import asyncio as _asyncio
        msg = (message or "").strip()
        if not msg:
            return {"ok": False, "error": "Message de commit vide."}
        ws = _workspace()
        if add_all:
            proc_add = await _asyncio.create_subprocess_exec(
                "git", "add", "-A",
                stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.PIPE, cwd=str(ws),
            )
            await proc_add.communicate()
        proc = await _asyncio.create_subprocess_exec(
            "git", "commit", "-m", msg,
            stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.PIPE, cwd=str(ws),
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            return {"ok": False, "error": (err.decode("utf-8", errors="replace") or out.decode("utf-8", errors="replace"))[:500]}
        return {"ok": True, "output": out.decode("utf-8", errors="replace")[:500]}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


EXECUTORS: dict[str, Any] = {
    "spearcode_list_files":   _spearcode_list_files,
    "spearcode_read_file":    _spearcode_read_file,
    "spearcode_write_file":   _spearcode_write_file,
    "spearcode_delete_file":  _spearcode_delete_file,
    "spearcode_search":       _spearcode_search,
    "spearcode_run":          _spearcode_run,
    "spearcode_terminal":     _spearcode_terminal,
    "spearcode_git_status":   _spearcode_git_status,
    "spearcode_git_diff":     _spearcode_git_diff,
    "spearcode_git_commit":   _spearcode_git_commit,
}
