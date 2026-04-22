"""Code execution + terminal endpoints (/run, /terminal).

Both endpoints are rate-limited per-user (30/min) via ``limiter_code``.
"""
from __future__ import annotations

import asyncio
import os
import re as _re
from datetime import datetime

from fastapi import HTTPException, Request
from pydantic import BaseModel

from . import _safe_path, _workspace, limiter_code, router


# ── Code execution (safe — uses create_subprocess_exec, no shell) ────────────

class RunRequest(BaseModel):
    path: str
    args: list[str] = []
    timeout: int = 30


RUN_COMMANDS = {
    ".py": ["python", "-u"],
    ".js": ["node"],
    ".ts": ["npx", "tsx"],
    ".sh": ["bash"],
    ".bash": ["bash"],
    ".rb": ["ruby"],
    ".go": ["go", "run"],
    ".php": ["php"],
    ".lua": ["lua"],
    ".r": ["Rscript"],
}


@router.post("/run")
@limiter_code.limit("30/minute")
async def run_file(request: Request, req: RunRequest):
    """Execute a file and return stdout/stderr. Uses subprocess_exec (no shell injection)."""
    target = _safe_path(req.path)
    if not target.exists():
        raise HTTPException(404, "Fichier introuvable")

    ext = target.suffix.lower()
    cmd_prefix = RUN_COMMANDS.get(ext)
    if not cmd_prefix:
        raise HTTPException(400, f"Extension non supportee pour l'execution: {ext}")

    cmd = cmd_prefix + [str(target)] + req.args
    timeout = min(max(req.timeout, 1), 120)

    start = datetime.now()
    try:
        # Sanitized env for code execution
        _safe_env = {k: v for k, v in os.environ.items()
                     if not any(s in k.upper() for s in ("KEY", "SECRET", "TOKEN", "PASSWORD", "DATABASE_URL"))}
        _safe_env["PYTHONUNBUFFERED"] = "1"
        _safe_env["HOME"] = str(_workspace())

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(_workspace()),
            env=_safe_env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        elapsed = (datetime.now() - start).total_seconds()

        return {
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "stdout": stdout.decode("utf-8", errors="replace")[:50000],
            "stderr": stderr.decode("utf-8", errors="replace")[:10000],
            "elapsed": round(elapsed, 2),
            "command": " ".join(cmd),
        }
    except asyncio.TimeoutError:
        proc.kill()
        return {
            "ok": False, "exit_code": -1, "stdout": "",
            "stderr": f"Timeout apres {timeout}s", "elapsed": timeout,
            "command": " ".join(cmd),
        }
    except FileNotFoundError as e:
        return {
            "ok": False, "exit_code": -1, "stdout": "",
            "stderr": f"Commande introuvable: {e}", "elapsed": 0,
            "command": " ".join(cmd),
        }


# ── Terminal (single command — uses create_subprocess_exec with shell wrapper) ──

class TerminalRequest(BaseModel):
    command: str
    timeout: int = 30


@router.post("/terminal")
@limiter_code.limit("30/minute")
async def run_terminal(request: Request, req: TerminalRequest):
    """Execute a shell command in the workspace directory.
    Uses create_subprocess_exec with explicit shell binary for safety."""
    if not req.command.strip():
        raise HTTPException(400, "Commande vide")

    cmd_lower = req.command.lower().strip()
    # Block destructive and escape patterns
    destructive_patterns = [
        r"rm\s+(-[a-z]*\s+)*(/|~|\$home)", r"del\s+/[sfq]",
        r"format\s+[a-z]:", r"mkfs", r"dd\s+if=",
        r"find\s+/\s+.*-delete", r"shred\s+", r"wipefs",
        r"remove-item\s+.*-recurse.*-force.*/",
        r"net\s+user\s+.*\s+/add", r"reg\s+(add|delete)",
        # Block access outside workspace
        r"cat\s+/app/data/config", r"cat\s+/etc/",
        r"curl\s+", r"wget\s+", r"nc\s+", r"ncat\s+",
        r"python[23]?\s+-c\s+", r"perl\s+-e\s+", r"ruby\s+-e\s+",
        r"base64\s+.*\|", r"eval\s+", r"exec\s+",
        r"docker\s+", r"kubectl\s+", r"systemctl\s+",
        r"/app/data/config",
        r"\.\./\.\./",  # directory traversal
    ]
    for pat in destructive_patterns:
        if _re.search(pat, cmd_lower):
            raise HTTPException(403, "Commande bloquée: pattern non autorisé")

    timeout = min(max(req.timeout, 1), 120)
    start = datetime.now()

    # Determine shell binary
    import platform
    if platform.system() == "Windows":
        shell_bin = "cmd.exe"
        shell_args = ["/c", req.command]
    else:
        shell_bin = "/bin/bash"
        shell_args = ["-c", req.command]

    try:
        # Sanitized env: strip sensitive vars (API keys, secrets, DB URLs)
        _safe_env = {k: v for k, v in os.environ.items()
                     if not any(s in k.upper() for s in ("KEY", "SECRET", "TOKEN", "PASSWORD", "DATABASE_URL"))}
        _safe_env["PYTHONUNBUFFERED"] = "1"
        _safe_env["HOME"] = str(_workspace())

        proc = await asyncio.create_subprocess_exec(
            shell_bin, *shell_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(_workspace()),
            env=_safe_env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        elapsed = (datetime.now() - start).total_seconds()

        return {
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "stdout": stdout.decode("utf-8", errors="replace")[:50000],
            "stderr": stderr.decode("utf-8", errors="replace")[:10000],
            "elapsed": round(elapsed, 2),
        }
    except asyncio.TimeoutError:
        proc.kill()
        return {"ok": False, "exit_code": -1, "stdout": "", "stderr": f"Timeout apres {timeout}s", "elapsed": timeout}
    except Exception as e:
        return {"ok": False, "exit_code": -1, "stdout": "", "stderr": str(e), "elapsed": 0}
