"""
Format on save — endpoint `/format` qui appelle un formatter CLI sur le
contenu d'un fichier et renvoie la version formatée.

Design volontairement stateless : on passe le contenu en POST (pas besoin
de toucher au filesystem), le frontend récupère le résultat et le ré-applique
dans CodeMirror avant de faire son `onSave()`. Comme ça :
- zéro risque de corruption fichier si le formatter plante
- fonctionne même sur un fichier jamais sauvegardé sur disque
- le diff est visible immédiatement dans l'éditeur
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from pydantic import BaseModel
from backend.plugins.code.routes import router

logger = logging.getLogger("gungnir.plugins.code.format")


# Map langage SpearCode → commande CLI + args (stdin → stdout). Le formatter
# doit lire le code sur stdin et produire le résultat sur stdout.
# `None` = pas de formatter pour ce langage → renvoie le contenu inchangé.
FORMATTERS: dict[str, list[str]] = {
    "python": ["black", "--quiet", "-"],
    "javascript": ["prettier", "--parser", "babel"],
    "typescript": ["prettier", "--parser", "typescript"],
    "tsx": ["prettier", "--parser", "typescript"],
    "jsx": ["prettier", "--parser", "babel"],
    "json": ["prettier", "--parser", "json"],
    "html": ["prettier", "--parser", "html"],
    "css": ["prettier", "--parser", "css"],
    "scss": ["prettier", "--parser", "scss"],
    "markdown": ["prettier", "--parser", "markdown"],
    "yaml": ["prettier", "--parser", "yaml"],
    "go": ["gofmt"],
    # rust-analyzer a un `textDocument/formatting` via LSP, mais pour garder
    # la même stratégie CLI ici on essaie `rustfmt` (souvent installé avec
    # cargo ; absent si pas de toolchain Rust). Fallback = contenu inchangé.
    "rust": ["rustfmt", "--emit", "stdout"],
}


class FormatRequest(BaseModel):
    language: str
    content: str


@router.post("/format")
async def format_code(req: FormatRequest):
    """Format le contenu reçu via le formatter du langage. Retourne le
    contenu (formaté si le formatter a tourné, inchangé sinon) + un flag
    `changed` pour que le frontend sache s'il doit remplacer le buffer.

    Ne lève jamais — un formatter manquant ou en erreur renvoie juste le
    contenu d'origine avec `ok=False` + message d'erreur.
    """
    cmd = FORMATTERS.get(req.language)
    if not cmd:
        return {
            "ok": False, "changed": False, "content": req.content,
            "error": f"Pas de formatter pour le langage '{req.language}'",
        }
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=req.content.encode("utf-8")),
            timeout=10.0,
        )
    except FileNotFoundError:
        return {
            "ok": False, "changed": False, "content": req.content,
            "error": f"Formatter '{cmd[0]}' absent de l'image (Dockerfile).",
        }
    except asyncio.TimeoutError:
        return {
            "ok": False, "changed": False, "content": req.content,
            "error": f"Timeout formatter ({cmd[0]} > 10 s)",
        }
    except Exception as e:
        return {
            "ok": False, "changed": False, "content": req.content,
            "error": f"Erreur formatter: {str(e)[:180]}",
        }

    if proc.returncode != 0:
        err_msg = stderr.decode("utf-8", errors="replace").strip()[:400]
        return {
            "ok": False, "changed": False, "content": req.content,
            "error": err_msg or f"Exit code {proc.returncode}",
        }

    formatted = stdout.decode("utf-8", errors="replace")
    # Certains formatters émettent un trailing newline que l'éditeur a peut-être
    # déjà ajouté. On respecte ce que le formatter renvoie, sans trim — sinon
    # on génère un diff artificiel à chaque save.
    changed = formatted != req.content
    return {"ok": True, "changed": changed, "content": formatted}


@router.get("/format/available")
async def format_available():
    """Retourne la liste des langages pour lesquels un formatter est installé.
    Sonde chaque binaire via `which` (ou son équivalent Python) — utile pour
    l'UI pour n'activer le toggle "format on save" que quand c'est réel."""
    import shutil
    out: dict[str, bool] = {}
    for lang, cmd in FORMATTERS.items():
        out[lang] = shutil.which(cmd[0]) is not None
    return {"formatters": out}
