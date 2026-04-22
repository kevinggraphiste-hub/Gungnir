"""AI endpoints: providers, analyze, personas, chat/stream/agent, code-action, multi-file, project-rules.

This module is where most of the SpearCode integration lives: project
analysis, coding personas, contextual AI chat, streaming, autonomous agent,
and the helpers supporting them.
"""
from __future__ import annotations

import asyncio
import json
import os
import platform
import re
import shutil
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import (
    AI_LOOP_TIMEOUT_S,
    IGNORE_DIRS,
    LANG_MAP,
    VERSIONS_DIR,
    _effective_user_id,
    _fetch_provider_models,
    _is_text_file,
    _models_cache,
    _resolve_user_provider,
    _safe_path,
    _versions_path,
    _workspace,
    logger,
    router,
)


# ── Provider list (for model selector) ──────────────────────────────────────

@router.get("/providers")
async def list_providers():
    """List the current user's configured LLM providers with live model lists.

    Same storage as the main Chat settings (user_settings.provider_keys), so
    any key added in the Chat settings is visible here and vice-versa.
    """
    try:
        from backend.core.config.settings import Settings
        from backend.core.db.engine import async_session
        from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key
    except ImportError:
        return {"providers": []}

    uid = await _effective_user_id()
    if uid <= 0:
        return {"providers": []}

    settings = Settings.load()
    result = []
    async with async_session() as _s:
        user_settings = await get_user_settings(uid, _s)
        for pname in (user_settings.provider_keys or {}).keys():
            decoded = get_user_provider_key(user_settings, pname)
            if not decoded or not decoded.get("api_key"):
                continue
            meta = settings.providers.get(pname)
            base_url = decoded.get("base_url") or (meta.base_url if meta else None)
            static_models = list(meta.models) if meta and meta.models else []
            default_model = meta.default_model if meta else None
            models = await _fetch_provider_models(pname, decoded["api_key"], base_url, static_models, default_model)
            # If the provider isn't registered backend-side we still list it
            # so the user sees their saved key — just flag it so the UI can
            # show a warning instead of pretending it works.
            registered = pname in getattr(settings, "providers", {})
            result.append({
                "name": pname,
                "default_model": default_model or (models[0] if models else None),
                "enabled": bool(decoded.get("enabled", True)),
                "models": models,
                "registered": registered,
            })
    return {"providers": result}


@router.get("/providers/{provider_name}/models")
async def refresh_provider_models(provider_name: str):
    """Force-refresh the current user's model list for a specific provider."""
    try:
        from backend.core.config.settings import Settings
        from backend.core.providers import get_provider
        from backend.core.db.engine import async_session
        from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key
    except ImportError:
        raise HTTPException(404, "Settings not available")

    uid = await _effective_user_id()
    if uid <= 0:
        raise HTTPException(401, "Authentification requise")

    settings = Settings.load()
    meta = settings.providers.get(provider_name)
    async with async_session() as _s:
        user_settings = await get_user_settings(uid, _s)
        decoded = get_user_provider_key(user_settings, provider_name)
        if not decoded or not decoded.get("api_key"):
            raise HTTPException(404, f"Provider '{provider_name}' non configuré pour cet utilisateur")
        api_key = decoded["api_key"]
        base_url = decoded.get("base_url") or (meta.base_url if meta else None)

    # Clear cache to force refresh
    _models_cache.pop(provider_name, None)

    try:
        provider = get_provider(provider_name, api_key, base_url)
        models = await provider.list_models()
        if models:
            _models_cache[provider_name] = {"models": models, "ts": time.time()}
            return {"provider": provider_name, "models": models, "count": len(models)}
    except Exception as e:
        logger.error(f"Failed to refresh models for {provider_name}: {e}")
        raise HTTPException(502, f"Could not fetch models from {provider_name}: {str(e)}")

    default_m = meta.default_model if meta else None
    return {"provider": provider_name, "models": [default_m] if default_m else [], "count": 1 if default_m else 0}


# ═══════════════════════════════════════════════════════════════════════════════
# SpearCode Integration — Project Analysis, Coding Personas, AI Chat
# Ported from backend/plugins/claude code/src/core/ (TypeScript → Python)
# ═══════════════════════════════════════════════════════════════════════════════


# ── Project Analysis (ported from context.ts) ────────────────────────────────

FRAMEWORK_DETECTORS = [
    (["package.json"], "node", "javascript"),
    (["tsconfig.json"], "typescript", "typescript"),
    (["Cargo.toml"], "rust", "rust"),
    (["go.mod"], "go", "go"),
    (["requirements.txt", "pyproject.toml", "setup.py"], "python", "python"),
    (["Gemfile"], "ruby", "ruby"),
    (["pom.xml", "build.gradle"], "java", "java"),
    (["composer.json"], "php", "php"),
    (["Package.swift"], "swift", "swift"),
]


def _detect_language(ws: Path) -> str:
    for files, _, language in FRAMEWORK_DETECTORS:
        for f in files:
            if (ws / f).exists():
                return language
    return "unknown"


def _detect_framework(ws: Path) -> Optional[str]:
    pkg = ws / "package.json"
    if pkg.exists():
        try:
            data = json.loads(pkg.read_text(encoding="utf-8"))
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            for name, fw in [("react", "react"), ("vue", "vue"), ("svelte", "svelte"),
                             ("next", "nextjs"), ("nuxt", "nuxt"), ("express", "express"),
                             ("fastify", "fastify"), ("@nestjs/core", "nestjs"), ("astro", "astro"),
                             ("fastapi", "fastapi"), ("flask", "flask"), ("django", "django")]:
                if name in deps:
                    return fw
        except Exception:
            pass
    if (ws / "Cargo.toml").exists(): return "rust"
    if (ws / "go.mod").exists(): return "go"
    if (ws / "pyproject.toml").exists():
        try:
            txt = (ws / "pyproject.toml").read_text(encoding="utf-8")
            if "fastapi" in txt.lower(): return "fastapi"
            if "flask" in txt.lower(): return "flask"
            if "django" in txt.lower(): return "django"
            return "python"
        except Exception:
            return "python"
    return None


def _build_tree(ws: Path, rel: str = "", depth: int = 0, max_depth: int = 3) -> list[dict]:
    target = ws / rel if rel else ws
    if depth > max_depth or not target.is_dir():
        return []
    nodes = []
    try:
        items = sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
    except PermissionError:
        return []
    for item in items:
        if item.name in IGNORE_DIRS or item.name.startswith("."):
            continue
        r = str(item.relative_to(ws)).replace("\\", "/")
        if item.is_dir():
            children = _build_tree(ws, r, depth + 1, max_depth) if depth < max_depth else []
            nodes.append({"name": item.name, "path": r, "type": "directory", "children": children})
        else:
            lang = LANG_MAP.get(item.suffix.lower(), "")
            nodes.append({"name": item.name, "path": r, "type": "file",
                          "size": item.stat().st_size, "language": lang})
    return nodes


def _render_tree(nodes: list[dict], prefix: str = "", max_items: int = 40) -> str:
    lines = []
    shown = nodes[:max_items]
    for i, node in enumerate(shown):
        is_last = i == len(shown) - 1
        connector = "└── " if is_last else "├── "
        icon = "📁 " if node["type"] == "directory" else "📄 "
        lines.append(f"{prefix}{connector}{icon}{node['name']}")
        if node["type"] == "directory" and node.get("children"):
            child_prefix = prefix + ("    " if is_last else "│   ")
            lines.append(_render_tree(node["children"], child_prefix, max_items - len(shown)))
    if len(nodes) > max_items:
        lines.append(f"{prefix}└── ... ({len(nodes) - max_items} de plus)")
    return "\n".join(lines)


def _count_lines(ws: Path) -> dict:
    """Count lines by language (sampling max 200 files for speed)."""
    by_lang: dict[str, dict] = {}
    total_lines = 0
    count = 0
    for root, dirs, files in os.walk(ws):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith(".")]
        for f in files:
            if count > 200:
                break
            fp = Path(root) / f
            lang = LANG_MAP.get(fp.suffix.lower())
            if not lang or fp.stat().st_size > 1_000_000:
                continue
            try:
                lines = fp.read_text(encoding="utf-8").count("\n") + 1
                total_lines += lines
                if lang not in by_lang:
                    by_lang[lang] = {"files": 0, "lines": 0}
                by_lang[lang]["files"] += 1
                by_lang[lang]["lines"] += lines
                count += 1
            except (UnicodeDecodeError, PermissionError, OSError):
                pass
    return {"total_lines": total_lines, "by_language": by_lang}


@router.get("/analyze")
async def analyze_project():
    """Full project analysis — language, framework, tree, stats. (SpearCode context.ts port)"""
    ws = _workspace()
    language = _detect_language(ws)
    framework = _detect_framework(ws)
    tree = _build_tree(ws)
    line_stats = _count_lines(ws)

    # Load README if available
    readme = None
    for name in ["README.md", "readme.md", "README.rst", "README"]:
        rp = ws / name
        if rp.exists():
            try:
                readme = rp.read_text(encoding="utf-8")[:2000]
            except Exception:
                pass
            break

    # Detect config files
    config_files = []
    for name in ["package.json", "tsconfig.json", "Cargo.toml", "go.mod",
                  "pyproject.toml", "requirements.txt", "Dockerfile",
                  "docker-compose.yml", ".env.example", "Makefile"]:
        if (ws / name).exists():
            config_files.append(name)

    return {
        "name": ws.name,
        "language": language,
        "framework": framework,
        "tree_text": _render_tree(tree),
        "config_files": config_files,
        "readme_excerpt": readme,
        "stats": line_stats,
    }


# ── Coding Personas (ported from personas.ts) ────────────────────────────────

CODING_PERSONAS = {
    "architect": {
        "id": "architect", "name": "Architect", "icon": "🏗️",
        "description": "Design systeme, patterns d'architecture, scalabilite",
        "system_prompt": (
            "Tu es un architecte logiciel senior. Concentre-toi sur :\n"
            "- Design systeme et patterns d'architecture\n"
            "- Scalabilite et performance\n"
            "- Organisation du code et limites des modules\n"
            "- Design d'API et flux de donnees\n"
            "- Compromis entre differentes approches\n"
            "Considere toujours la vue d'ensemble avant l'implementation."
        ),
    },
    "debugger": {
        "id": "debugger", "name": "Debugger", "icon": "🐛",
        "description": "Chasse aux bugs, analyse d'erreurs, root cause",
        "system_prompt": (
            "Tu es un expert en debugging. Concentre-toi sur :\n"
            "- Analyse de la cause racine, pas juste les symptomes\n"
            "- Lecture attentive des messages d'erreur et stack traces\n"
            "- Isolation systematique du probleme\n"
            "- Verification des edge cases et race conditions\n"
            "- Verifier que le fix n'introduit pas de nouveaux bugs\n"
            "Sois methodique. Explique ton raisonnement etape par etape."
        ),
    },
    "reviewer": {
        "id": "reviewer", "name": "Reviewer", "icon": "👁️",
        "description": "Code review, qualite, securite, bonnes pratiques",
        "system_prompt": (
            "Tu es un code reviewer strict. Concentre-toi sur :\n"
            "- Vulnerabilites securite (injection, XSS, auth)\n"
            "- Goulots de performance et complexite inutile\n"
            "- Lacunes dans la gestion d'erreurs\n"
            "- Lisibilite et maintenabilite du code\n"
            "- Respect des conventions du projet\n"
            "Sois specifique. Utilise des niveaux: 🔴 Critique, 🟡 Warning, 🟢 Suggestion."
        ),
    },
    "writer": {
        "id": "writer", "name": "Writer", "icon": "📝",
        "description": "Documentation, commentaires, README, guides",
        "system_prompt": (
            "Tu es un technical writer. Concentre-toi sur :\n"
            "- Documentation claire et concise\n"
            "- Bons exemples et patterns d'usage\n"
            "- README utiles pour les nouveaux arrivants\n"
            "- Commentaires qui expliquent le POURQUOI, pas le QUOI\n"
            "- Documentation d'API avec des exemples reels"
        ),
    },
    "tester": {
        "id": "tester", "name": "Tester", "icon": "🧪",
        "description": "Generation de tests, couverture, edge cases",
        "system_prompt": (
            "Tu es un ingenieur QA. Concentre-toi sur :\n"
            "- Couverture de test exhaustive\n"
            "- Edge cases et conditions limites\n"
            "- Happy path ET chemins d'erreur\n"
            "- Lisibilite et maintenabilite des tests\n"
            "- Strategies de mocking\n"
            "Pense toujours : 'Qu'est-ce qui pourrait aller de travers ?'"
        ),
    },
    "optimizer": {
        "id": "optimizer", "name": "Optimizer", "icon": "⚡",
        "description": "Performance, profiling, optimisation",
        "system_prompt": (
            "Tu es un ingenieur performance. Concentre-toi sur :\n"
            "- Identifier les goulots par analyse de code\n"
            "- Complexite algorithmique (temps et espace)\n"
            "- Strategies de cache\n"
            "- Optimisation de requetes DB\n"
            "- Taille de bundle et performance de chargement\n"
            "Mesure avant d'optimiser. Propose des approches de profiling."
        ),
    },
    "hacker": {
        "id": "hacker", "name": "Hacker", "icon": "🔓",
        "description": "Audit securite, mentalite pentest",
        "system_prompt": (
            "Tu es un ingenieur securite. Concentre-toi sur :\n"
            "- OWASP Top 10\n"
            "- Validation et sanitisation des inputs\n"
            "- Failles d'authentification et d'autorisation\n"
            "- Gestion des secrets\n"
            "- Vulnerabilites des dependances\n"
            "Pense comme un attaquant. Qu'est-ce que tu exploiterais ?"
        ),
    },
}


@router.get("/personas")
async def list_personas():
    """List available coding personas."""
    return {"personas": list(CODING_PERSONAS.values())}


# ── AI Code Chat (contextual) ───────────────────────────────────────────────

class AIChatRequest(BaseModel):
    message: str
    file_path: Optional[str] = None    # current open file for context
    persona: Optional[str] = None       # persona ID
    selection: Optional[str] = None     # selected code snippet
    provider_name: Optional[str] = None # override provider
    model_name: Optional[str] = None    # override model
    context_mode: str = "smart"         # "smart" | "selection" | "full" | "none"
    history: list[dict] = []            # previous messages for multi-turn


# ── Context Reduction Engine ─────────────────────────────────────────────────

def _extract_relevant_context(content: str, query: str, lang: str, max_chars: int = 4000) -> str:
    """
    Smart context reduction: extract only the parts of the file relevant to the query.
    Preserves imports, class/function signatures near the query topic, and the
    targeted code block — without sending the entire file.
    Returns reduced content that keeps precision while minimizing tokens.
    """
    if len(content) <= max_chars:
        return content

    lines = content.split("\n")
    query_lower = query.lower()
    query_words = set(re.findall(r'\w{3,}', query_lower))

    # Score each line for relevance
    scored: list[tuple[int, float]] = []
    for i, line in enumerate(lines):
        score = 0.0
        stripped = line.strip().lower()

        # Always keep imports/requires (structural context, low cost)
        if any(stripped.startswith(kw) for kw in ("import ", "from ", "require(", "use ", "#include")):
            score += 3.0

        # Keep class/function/method definitions (structural anchors)
        if re.match(r'^(class |def |function |const |let |var |export |async |pub fn |fn |impl )', stripped):
            score += 4.0

        # Direct keyword match from user query
        line_words = set(re.findall(r'\w{3,}', stripped))
        overlap = query_words & line_words
        if overlap:
            score += 5.0 * len(overlap)

        # Decorators/annotations near definitions
        if stripped.startswith("@") or stripped.startswith("#["):
            score += 2.0

        # Type definitions, interfaces
        if re.match(r'^(interface |type |struct |enum |typedef )', stripped):
            score += 3.0

        # Non-empty lines get a tiny base score
        if stripped and not stripped.startswith("#") and not stripped.startswith("//"):
            score += 0.1

        scored.append((i, score))

    # Select lines: high-scoring lines + their neighbors (context window of ±3)
    selected = set()
    for i, score in scored:
        if score >= 2.0:
            for j in range(max(0, i - 3), min(len(lines), i + 4)):
                selected.add(j)

    # Always include first 5 lines (file header/imports) and last 3
    for i in range(min(5, len(lines))):
        selected.add(i)
    for i in range(max(0, len(lines) - 3), len(lines)):
        selected.add(i)

    # Build reduced content with fold markers
    result_parts = []
    sorted_sel = sorted(selected)
    prev_i = -2
    char_count = 0

    for i in sorted_sel:
        if char_count >= max_chars:
            result_parts.append(f"  ... ({len(lines) - i} lignes restantes tronquees)")
            break
        if i > prev_i + 1:
            gap = i - prev_i - 1
            result_parts.append(f"  ... ({gap} lignes masquees)")
        line_text = lines[i]
        result_parts.append(line_text)
        char_count += len(line_text) + 1
        prev_i = i

    return "\n".join(result_parts)


def _estimate_tokens(text: str) -> int:
    """Rough token estimate (chars/3.5 for multilingual, conservative)."""
    return max(1, int(len(text) / 3.5))


# ── Native tool-calling for /ai/chat (function calling) ──────────────────

AI_CHAT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "create_folder",
            "description": "Créer un dossier dans le workspace. Crée aussi les parents si besoin.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Chemin relatif au workspace"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_file",
            "description": "Créer (ou écraser) un fichier texte avec le contenu fourni. Un snapshot est sauvegardé avant l'écrasement.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin relatif au workspace"},
                    "content": {"type": "string", "description": "Contenu complet du fichier"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "move_file",
            "description": "Déplacer ou renommer un fichier/dossier.",
            "parameters": {
                "type": "object",
                "properties": {
                    "src": {"type": "string", "description": "Chemin source relatif au workspace"},
                    "dst": {"type": "string", "description": "Chemin destination relatif au workspace"},
                },
                "required": ["src", "dst"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_file",
            "description": "Supprimer un fichier ou un dossier (récursif pour les dossiers). Action irréversible — utiliser avec prudence.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Lire le contenu d'un fichier texte du workspace.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "Lister le contenu d'un dossier du workspace. Retourne les fichiers et sous-dossiers.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Chemin relatif, vide pour la racine"}},
                "required": [],
            },
        },
    },
]


async def _execute_ai_chat_tool(tool_name: str, args: dict) -> dict:
    """Execute an AI chat tool inside the current user's workspace.

    Uses _safe_path (which already scopes per-user via ContextVar) and
    _versions_path for auto-snapshots. Returns a JSON-able dict with
    ok/error/details fields so the LLM can adapt.
    """
    try:
        if tool_name == "create_folder":
            path = (args.get("path") or "").strip()
            if not path:
                return {"ok": False, "error": "path requis"}
            target = _safe_path(path)
            if target.exists():
                return {"ok": False, "error": f"Le dossier '{path}' existe déjà"}
            target.mkdir(parents=True, exist_ok=True)
            logger.info(f"AI tool: folder created: {path}")
            return {"ok": True, "path": path, "action": "folder_created"}

        elif tool_name == "create_file":
            path = (args.get("path") or "").strip()
            content = args.get("content") or ""
            if not path:
                return {"ok": False, "error": "path requis"}
            target = _safe_path(path)
            if target.exists() and _is_text_file(target):
                try:
                    old = target.read_text(encoding="utf-8")
                    if old:
                        vdir = _versions_path(path)
                        vdir.mkdir(parents=True, exist_ok=True)
                        ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
                        (vdir / f"{ts}.txt").write_text(old, encoding="utf-8")
                        (vdir / f"{ts}.json").write_text(json.dumps({
                            "timestamp": datetime.now().isoformat(),
                            "label": "Avant écriture IA",
                            "file_path": path,
                            "lines": old.count("\n") + 1, "size": len(old),
                        }, ensure_ascii=False), encoding="utf-8")
                        # Enforce max 20 versions per file
                        txts = sorted(vdir.glob("*.txt"))
                        while len(txts) > 20:
                            old_v = txts.pop(0)
                            old_v.unlink(missing_ok=True)
                            old_v.with_suffix(".json").unlink(missing_ok=True)
                except Exception as e:
                    logger.warning(f"AI tool snapshot failed for {path}: {e}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            logger.info(f"AI tool: file written: {path} ({len(content)} chars)")
            return {"ok": True, "path": path, "size": len(content), "action": "file_created"}

        elif tool_name == "move_file":
            src_s = (args.get("src") or "").strip()
            dst_s = (args.get("dst") or "").strip()
            if not src_s or not dst_s:
                return {"ok": False, "error": "src et dst requis"}
            src = _safe_path(src_s)
            dst = _safe_path(dst_s)
            if not src.exists():
                return {"ok": False, "error": f"Source introuvable: {src_s}"}
            if dst.exists():
                return {"ok": False, "error": f"Destination existe déjà: {dst_s}"}
            dst.parent.mkdir(parents=True, exist_ok=True)
            src.rename(dst)
            logger.info(f"AI tool: moved {src_s} -> {dst_s}")
            return {"ok": True, "src": src_s, "dst": dst_s, "action": "file_moved"}

        elif tool_name == "delete_file":
            path = (args.get("path") or "").strip()
            if not path:
                return {"ok": False, "error": "path requis"}
            target = _safe_path(path)
            if not target.exists():
                return {"ok": False, "error": f"Introuvable: {path}"}
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
            logger.info(f"AI tool: deleted {path}")
            return {"ok": True, "path": path, "action": "deleted"}

        elif tool_name == "read_file":
            path = (args.get("path") or "").strip()
            if not path:
                return {"ok": False, "error": "path requis"}
            target = _safe_path(path)
            if not target.exists() or not target.is_file():
                return {"ok": False, "error": f"Fichier introuvable: {path}"}
            if not _is_text_file(target):
                return {"ok": False, "error": "Fichier binaire — non lisible"}
            content = target.read_text(encoding="utf-8")
            capped = content[:8000]
            truncated = len(content) > 8000
            return {
                "ok": True, "path": path,
                "content": capped,
                "truncated": truncated,
                "size": len(content),
                "lines": content.count("\n") + 1,
            }

        elif tool_name == "list_files":
            path = (args.get("path") or "").strip()
            base = _safe_path(path) if path else _workspace()
            if not base.exists() or not base.is_dir():
                return {"ok": False, "error": f"Dossier introuvable: {path or '(racine)'}"}
            ws_root = _workspace().resolve()
            items = []
            for item in sorted(base.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                if item.name.startswith(".") or item.name in ("node_modules", "__pycache__"):
                    continue
                rel = str(item.relative_to(ws_root)).replace("\\", "/")
                items.append({
                    "name": item.name,
                    "path": rel,
                    "type": "folder" if item.is_dir() else "file",
                })
            return {"ok": True, "path": path or "", "items": items}

        else:
            return {"ok": False, "error": f"Outil inconnu: {tool_name}"}

    except HTTPException as he:
        return {"ok": False, "error": he.detail}
    except Exception as e:
        logger.error(f"AI tool '{tool_name}' failed: {e}")
        return {"ok": False, "error": str(e)[:200]}


async def _run_ai_chat_tool_loop(provider, chosen_model, messages, max_rounds: int = 5):
    """Native function-calling loop until the LLM stops requesting tools.

    Returns (final_response, actions_log). If the provider has
    supports_tools=False, runs a single plain chat call.
    """
    from backend.core.providers import ChatMessage
    actions: list[dict] = []
    response = None
    tools_enabled = bool(getattr(provider, "supports_tools", False))

    if not tools_enabled:
        response = await provider.chat(messages, chosen_model)
        return response, actions

    deadline = time.monotonic() + AI_LOOP_TIMEOUT_S
    rounds_used = 0
    for _round in range(max_rounds):
        if time.monotonic() >= deadline:
            logger.warning(
                "ai_chat tool loop hit %ss wall-clock timeout at round %d/%d",
                AI_LOOP_TIMEOUT_S, _round, max_rounds,
            )
            break
        rounds_used = _round + 1
        try:
            response = await provider.chat(
                messages, chosen_model,
                tools=AI_CHAT_TOOLS, tool_choice="auto",
            )
        except Exception as tool_err:
            logger.warning(f"Tool-calling failed, fallback to plain text: {tool_err}")
            clean = [ChatMessage(role=m.role, content=m.content or "") for m in messages if m.role != "tool"]
            response = await provider.chat(clean, chosen_model)
            break

        tcs = getattr(response, "tool_calls", None) or []
        if not tcs:
            break

        messages.append(ChatMessage(
            role="assistant",
            content=response.content or "",
            tool_calls=tcs,
        ))

        for tc in tcs:
            fn = tc.get("function", {}) if isinstance(tc, dict) else {}
            tname = fn.get("name", "")
            call_id = tc.get("id") or uuid.uuid4().hex[:8]
            try:
                raw_args = fn.get("arguments", "{}")
                targs = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
            except Exception:
                targs = {}

            tresult = await _execute_ai_chat_tool(tname, targs)
            actions.append({"tool": tname, "args": targs, "result": tresult})

            messages.append(ChatMessage(
                role="tool",
                content=json.dumps(tresult, ensure_ascii=False),
                tool_call_id=call_id,
            ))
    else:
        # for-else: the loop finished without `break` → max_rounds exhausted.
        logger.warning("ai_chat tool loop exhausted max_rounds=%d", max_rounds)

    if response is not None and (getattr(response, "tool_calls", None) or []):
        try:
            response = await provider.chat(messages, chosen_model)
        except Exception as final_err:
            logger.warning(f"Final no-tools wrap failed: {final_err}")

    return response, actions


@router.post("/ai/chat")
async def ai_code_chat(req: AIChatRequest):
    """
    Contextual AI coding chat with model switching and smart context reduction.
    Sends user message + optimized context + persona to the chosen LLM.
    Supports native tool-calling: the AI can create/move/delete files & folders.
    """
    # Lazy imports to maintain plugin independence
    try:
        from backend.core.providers import ChatMessage
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    provider, chosen_model, _err = await _resolve_user_provider(req.provider_name, req.model_name)
    if _err or not provider or not chosen_model:
        return {"ok": False, "error": _err or "Aucun provider LLM configuré"}

    # ── Build system prompt (optimized for token efficiency) ─────────────
    ws = _workspace()
    system_parts = [
        f"Tu es l'assistant IA integre a SpearCode, l'IDE de Gungnir. Tu operes dans le workspace '{ws.name}' ({ws.resolve()}).",
        "Tu disposes d'outils natifs (function calling) pour agir sur le workspace : create_folder, create_file, move_file, delete_file, read_file, list_files.",
        "IMPORTANT : tu ne peux PAS executer de commandes shell depuis ce chat. Pour creer/deplacer/supprimer des fichiers ou dossiers, tu DOIS appeler les outils ci-dessus — ne pretends jamais avoir effectue une action sans avoir appele l'outil correspondant.",
        "Apres execution des outils, confirme a l'utilisateur ce qui a reellement ete fait (en t'appuyant uniquement sur les resultats retournes).",
        "Tu conserves le contexte de la conversation en cours (memoire de session).",
        "Reponds en francais, concis et technique. Code dans des blocs ```language.",
    ]

    # Add persona (compact)
    persona = None
    if req.persona and req.persona in CODING_PERSONAS:
        persona = CODING_PERSONAS[req.persona]
        system_parts.append(f"\n[Persona: {persona['icon']} {persona['name']}]\n{persona['system_prompt']}")

    # ── Smart context injection based on context_mode ────────────────────
    context_tokens = 0

    if req.context_mode == "selection" and req.selection:
        # Minimal: only selected code
        system_parts.append(f"\nCode selectionne:\n```\n{req.selection[:3000]}\n```")
        context_tokens = _estimate_tokens(req.selection[:3000])

    elif req.context_mode == "none":
        # No file context at all — pure chat
        pass

    elif req.file_path:
        try:
            target = _safe_path(req.file_path)
            if target.exists() and _is_text_file(target):
                content = target.read_text(encoding="utf-8")
                lang = LANG_MAP.get(target.suffix.lower(), "text")
                total_lines = content.count("\n") + 1

                if req.context_mode == "full":
                    # Full file (capped at 8000 chars)
                    ctx = content[:8000]
                else:
                    # Smart mode: extract only relevant parts
                    if req.selection:
                        # If there's a selection, use it as primary + smart extract for surrounding context
                        ctx = f"[Selection]\n{req.selection[:2000]}\n\n[Contexte fichier]\n{_extract_relevant_context(content, req.message + ' ' + req.selection[:200], lang, 2000)}"
                    else:
                        ctx = _extract_relevant_context(content, req.message, lang, 4000)

                file_header = f"\nFichier: {req.file_path} ({lang}, {total_lines}L)"
                system_parts.append(f"{file_header}\n```{lang}\n{ctx}\n```")
                context_tokens = _estimate_tokens(ctx)
        except Exception:
            pass

        # Selection context if not already used
        if req.selection and req.context_mode not in ("selection",):
            if req.context_mode != "smart":  # smart already includes selection above
                system_parts.append(f"\nCode selectionne:\n```\n{req.selection[:2000]}\n```")

    # Project context (1-liner, very cheap)
    fw = _detect_framework(ws)
    project_info = f"Projet: {ws.name} ({_detect_language(ws)}"
    if fw:
        project_info += f", {fw}"
    project_info += ")"
    system_parts.append(f"\n{project_info}")

    system_prompt = "\n".join(system_parts)

    # ── Build messages (with history for multi-turn, capped) ─────────────
    messages = [ChatMessage(role="system", content=system_prompt)]

    # Add conversation history (keep last N messages, cap total tokens)
    history_budget = 2000  # chars for history
    history_chars = 0
    trimmed_history = []
    for h in reversed(req.history[-10:]):  # max 10 messages
        msg_len = len(h.get("content", ""))
        if history_chars + msg_len > history_budget:
            break
        trimmed_history.insert(0, h)
        history_chars += msg_len

    for h in trimmed_history:
        messages.append(ChatMessage(role=h["role"], content=h["content"]))

    messages.append(ChatMessage(role="user", content=req.message))

    # Estimate total tokens
    total_chars = sum(len(m.content) for m in messages)
    est_tokens = int(total_chars / 3.5)

    try:
        response, actions = await _run_ai_chat_tool_loop(provider, chosen_model, messages)
        resp_text = (response.content or "") if response else ""
        return {
            "ok": True,
            "response": resp_text,
            "actions": actions,
            "persona": persona["name"] if persona else None,
            "model": chosen_model,
            "token_estimate": {
                "context": _estimate_tokens(system_prompt),
                "history": _estimate_tokens(str(history_chars)),
                "query": _estimate_tokens(req.message),
                "response": _estimate_tokens(resp_text),
                "total": _estimate_tokens(total_chars + len(resp_text)),
            },
        }
    except Exception as e:
        logger.error(f"AI code chat failed: {e}")
        return {"ok": False, "error": f"Erreur LLM: {str(e)[:200]}"}


# ── Helper: build provider + messages from request ────────────────────────

async def _build_chat_context(req: AIChatRequest):
    """Shared logic for building provider, model, system prompt, and messages."""
    from backend.core.providers import ChatMessage

    provider, chosen_model, _err = await _resolve_user_provider(req.provider_name, req.model_name)
    if not provider or not chosen_model:
        return None, None, None, None

    ws = _workspace()
    system_parts = [
        f"Tu es l'assistant IA integre a SpearCode, l'IDE de Gungnir. Tu operes dans le workspace '{ws.name}' ({ws.resolve()}).",
        "Tu disposes d'outils natifs (function calling) pour agir sur le workspace : create_folder, create_file, move_file, delete_file, read_file, list_files.",
        "IMPORTANT : tu ne peux PAS executer de commandes shell depuis ce chat. Pour creer/deplacer/supprimer des fichiers ou dossiers, tu DOIS appeler les outils ci-dessus — ne pretends jamais avoir effectue une action sans avoir appele l'outil correspondant.",
        "Apres execution des outils, confirme a l'utilisateur ce qui a reellement ete fait (en t'appuyant uniquement sur les resultats retournes).",
        "Tu conserves le contexte de la conversation en cours (memoire de session).",
        "Reponds en francais, concis et technique. Code dans des blocs ```language.",
    ]

    persona = None
    if req.persona and req.persona in CODING_PERSONAS:
        persona = CODING_PERSONAS[req.persona]
        system_parts.append(f"\n[Persona: {persona['icon']} {persona['name']}]\n{persona['system_prompt']}")

    if req.context_mode == "selection" and req.selection:
        system_parts.append(f"\nCode selectionne:\n```\n{req.selection[:3000]}\n```")
    elif req.context_mode != "none" and req.file_path:
        try:
            target = _safe_path(req.file_path)
            if target.exists() and _is_text_file(target):
                content = target.read_text(encoding="utf-8")
                lang = LANG_MAP.get(target.suffix.lower(), "text")
                total_lines = content.count("\n") + 1
                if req.context_mode == "full":
                    ctx = content[:8000]
                else:
                    ctx = _extract_relevant_context(content, req.message, lang, 4000) if not req.selection else \
                        f"[Selection]\n{req.selection[:2000]}\n\n[Contexte]\n{_extract_relevant_context(content, req.message, lang, 2000)}"
                system_parts.append(f"\nFichier: {req.file_path} ({lang}, {total_lines}L)\n```{lang}\n{ctx}\n```")
        except Exception:
            pass

    fw = _detect_framework(ws)
    system_parts.append(f"\nProjet: {ws.name} ({_detect_language(ws)}{', ' + fw if fw else ''})")

    # Load .spearcode project rules if available
    rules_file = ws / ".spearcode"
    if rules_file.exists():
        try:
            rules = rules_file.read_text(encoding="utf-8")[:1500]
            system_parts.append(f"\n[Regles projet .spearcode]\n{rules}")
        except Exception:
            pass

    system_prompt = "\n".join(system_parts)
    messages = [ChatMessage(role="system", content=system_prompt)]

    history_budget, history_chars = 2000, 0
    trimmed_history = []
    for h in reversed(req.history[-10:]):
        msg_len = len(h.get("content", ""))
        if history_chars + msg_len > history_budget:
            break
        trimmed_history.insert(0, h)
        history_chars += msg_len
    for h in trimmed_history:
        messages.append(ChatMessage(role=h["role"], content=h["content"]))
    messages.append(ChatMessage(role="user", content=req.message))

    return provider, chosen_model, messages, persona


# ── Streaming AI Chat (SSE) ──────────────────────────────────────────────

@router.post("/ai/chat/stream")
async def ai_code_chat_stream(req: AIChatRequest):
    """
    Streaming AI chat via Server-Sent Events with native tool-calling.

    First runs the tool loop non-stream so actions (create_folder, create_file,
    move_file, delete_file, read_file, list_files) really execute; emits an
    `action` event per tool invocation. When the model stops calling tools,
    streams the final answer back as `token` events.
    """
    try:
        provider, chosen_model, messages, persona = await _build_chat_context(req)
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    if not provider:
        return {"ok": False, "error": "Aucun provider LLM configuré pour cet utilisateur"}

    tools_enabled = bool(getattr(provider, "supports_tools", False))

    async def event_stream():
        try:
            meta = json.dumps({
                "type": "meta",
                "model": chosen_model,
                "persona": persona["name"] if persona else None,
            }, ensure_ascii=False)
            yield f"data: {meta}\n\n"

            actions: list[dict] = []
            full_text = ""

            if tools_enabled:
                from backend.core.providers import ChatMessage
                final_text_from_loop: Optional[str] = None
                max_rounds = 5
                deadline = time.monotonic() + AI_LOOP_TIMEOUT_S
                loop_limit_reason: Optional[str] = None
                for _round in range(max_rounds):
                    if time.monotonic() >= deadline:
                        loop_limit_reason = "timeout"
                        logger.warning(
                            "stream tool loop hit %ss wall-clock timeout at round %d/%d",
                            AI_LOOP_TIMEOUT_S, _round, max_rounds,
                        )
                        break
                    try:
                        response = await provider.chat(
                            messages, chosen_model,
                            tools=AI_CHAT_TOOLS, tool_choice="auto",
                        )
                    except Exception as tool_err:
                        logger.warning(f"Stream tool-calling failed, fallback: {tool_err}")
                        break

                    tcs = getattr(response, "tool_calls", None) or []
                    if not tcs:
                        final_text_from_loop = response.content or ""
                        break

                    messages.append(ChatMessage(
                        role="assistant",
                        content=response.content or "",
                        tool_calls=tcs,
                    ))

                    for tc in tcs:
                        fn = tc.get("function", {}) if isinstance(tc, dict) else {}
                        tname = fn.get("name", "")
                        call_id = tc.get("id") or uuid.uuid4().hex[:8]
                        try:
                            raw_args = fn.get("arguments", "{}")
                            targs = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
                        except Exception:
                            targs = {}
                        tresult = await _execute_ai_chat_tool(tname, targs)
                        actions.append({"tool": tname, "args": targs, "result": tresult})

                        act_evt = json.dumps({
                            "type": "action",
                            "tool": tname, "args": targs, "result": tresult,
                        }, ensure_ascii=False)
                        yield f"data: {act_evt}\n\n"

                        messages.append(ChatMessage(
                            role="tool",
                            content=json.dumps(tresult, ensure_ascii=False),
                            tool_call_id=call_id,
                        ))
                else:
                    loop_limit_reason = "max_rounds"
                    logger.warning("stream tool loop exhausted max_rounds=%d", max_rounds)

                if loop_limit_reason:
                    limit_evt = json.dumps({
                        "type": "loop_limit",
                        "reason": loop_limit_reason,
                        "max_rounds": max_rounds,
                        "timeout_s": AI_LOOP_TIMEOUT_S,
                    }, ensure_ascii=False)
                    yield f"data: {limit_evt}\n\n"

                if final_text_from_loop is not None:
                    # Already have final text — re-chunk it for progressive UI.
                    full_text = final_text_from_loop
                    CHUNK = 64
                    for i in range(0, len(full_text), CHUNK):
                        piece = full_text[i:i + CHUNK]
                        data = json.dumps({"type": "token", "content": piece}, ensure_ascii=False)
                        yield f"data: {data}\n\n"
                else:
                    # Loop bailed or hit max_rounds — stream a plain final.
                    async for chunk in provider.chat_stream(messages, chosen_model):
                        full_text += chunk
                        data = json.dumps({"type": "token", "content": chunk}, ensure_ascii=False)
                        yield f"data: {data}\n\n"
            else:
                async for chunk in provider.chat_stream(messages, chosen_model):
                    full_text += chunk
                    data = json.dumps({"type": "token", "content": chunk}, ensure_ascii=False)
                    yield f"data: {data}\n\n"

            done = json.dumps({
                "type": "done",
                "full_text": full_text,
                "actions": actions,
                "token_estimate": _estimate_tokens(full_text),
            }, ensure_ascii=False)
            yield f"data: {done}\n\n"

        except Exception as e:
            err = json.dumps({"type": "error", "error": str(e)[:200]}, ensure_ascii=False)
            yield f"data: {err}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── Agent Mode (Autonomous coding loop) ──────────────────────────────────

AGENT_TOOLS_DESC = """PROTOCOLE OBLIGATOIRE (lis-le en entier avant toute reponse)

Tu as acces a ces outils :
- read_file(path)       — lire un fichier du workspace
- write_file(path, content) — CREER ou ECRIRE un fichier (tout type : .html, .css, .js, .py, .md, .json, binaire texte, etc.). Cree automatiquement les dossiers parents.
- make_directory(path)  — CREER un dossier (et ses parents si besoin). A utiliser pour des dossiers vides OU avant d'organiser une arborescence.
- run_command(command)  — executer une commande shell dans le workspace
- search(query)         — chercher dans le workspace
- list_files(path)      — lister le contenu d'un dossier

REGLES STRICTES — AUCUNE EXCEPTION :

1. Pour APPELER un outil, ta reponse doit etre EXACTEMENT :
   ```json
   {"tool": "<nom>", "args": {...}}
   ```
   Un seul bloc, un seul outil par tour. Rien d'autre dans la reponse a ce tour-la (pas d'autre texte, pas de bloc code en plus).

2. Pour CREER UN FICHIER (HTML, CSS, JS, etc.), tu DOIS utiliser write_file. Tu NE dois JAMAIS mettre le contenu du fichier dans ta reponse finale en texte — le contenu doit aller UNIQUEMENT dans args.content de write_file.

   Exemple CORRECT pour "cree un fichier index.html" :
   ```json
   {"tool": "write_file", "args": {"path": "index.html", "content": "<!DOCTYPE html>\\n<html>...</html>"}}
   ```

   Exemple INCORRECT (NE FAIS JAMAIS CA) : repondre avec du texte "Voici ton HTML :" suivi d'un bloc html — cela ne cree AUCUN fichier.

3. Le champ args.content est une string JSON : echappe les `"` en `\\"`, les sauts de ligne en `\\n`, et les backslashes en `\\\\`. Evite les triple-backticks DANS args.content (utilise des simples backticks si tu dois en mettre).

4. Quand tu as ecrit tous les fichiers demandes ET que le travail est termine, arrete d'appeler des outils et reponds en francais, en texte pur, en resumant ce que tu as fait (sans recoller le code). Exemple : "J'ai cree index.html et style.css dans le workspace."

5. Un outil a la fois. Attends son resultat avant d'en appeler un autre.

6. DOSSIERS : ne dis JAMAIS "je cree le dossier X" sans appeler un outil. Soit tu appelles make_directory(X), soit tu appelles write_file(X/fichier.ext, ...) (qui cree X automatiquement). Annoncer une creation de dossier sans appel d'outil = HALLUCINATION interdite.

Methodologie : analyse la demande → plan mental bref → appelle l'outil → verifie le resultat → continue ou termine."""


class AgentRequest(BaseModel):
    task: str
    file_path: Optional[str] = None
    provider_name: Optional[str] = None
    model_name: Optional[str] = None
    max_steps: int = 10


@router.post("/ai/agent")
async def ai_agent_run(req: AgentRequest):
    """
    Agentic coding mode: the AI plans, executes tools, and iterates
    autonomously. Streams each step back via SSE.
    """
    try:
        from backend.core.providers import ChatMessage
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    provider, chosen_model, _err = await _resolve_user_provider(req.provider_name, req.model_name)
    if _err or not provider or not chosen_model:
        return {"ok": False, "error": _err or "Aucun provider LLM configuré"}

    ws = _workspace()

    # Build agent system prompt
    system_prompt = (
        "Tu es un agent de programmation autonome integre dans SpearCode IDE.\n"
        "Tu peux lire, ecrire des fichiers, executer des commandes et chercher dans le code.\n"
        "Reponds en francais. Sois methodique: analyse → plan → execute → verifie.\n"
        f"\nWorkspace: {ws.name} ({_detect_language(ws)})\n"
        f"{AGENT_TOOLS_DESC}"
    )

    # Add file context if provided
    if req.file_path:
        try:
            target = _safe_path(req.file_path)
            if target.exists() and _is_text_file(target):
                content = target.read_text(encoding="utf-8")[:4000]
                lang = LANG_MAP.get(target.suffix.lower(), "text")
                system_prompt += f"\n\nFichier actif: {req.file_path}\n```{lang}\n{content}\n```"
        except Exception:
            pass

    conversation = [
        ChatMessage(role="system", content=system_prompt),
        ChatMessage(role="user", content=req.task),
    ]

    max_steps = min(max(req.max_steps, 1), 15)

    async def agent_stream():
        nonlocal conversation
        steps_done = 0
        deadline = time.monotonic() + AI_LOOP_TIMEOUT_S
        limit_reason: Optional[str] = None

        yield f"data: {json.dumps({'type': 'start', 'task': req.task, 'max_steps': max_steps, 'timeout_s': AI_LOOP_TIMEOUT_S}, ensure_ascii=False)}\n\n"

        for step in range(max_steps):
            if time.monotonic() >= deadline:
                limit_reason = "timeout"
                logger.warning(
                    "agent stream hit %ss wall-clock timeout at step %d/%d",
                    AI_LOOP_TIMEOUT_S, step, max_steps,
                )
                break
            steps_done = step + 1

            # Get AI response
            yield f"data: {json.dumps({'type': 'thinking', 'step': steps_done}, ensure_ascii=False)}\n\n"

            try:
                response = await provider.chat(conversation, chosen_model)
                ai_text = response.content or ""
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'error': str(e)[:200]}, ensure_ascii=False)}\n\n"
                break

            conversation.append(ChatMessage(role="assistant", content=ai_text))

            # Try to extract tool call
            tool_call = _extract_tool_call(ai_text)

            # Heuristic: the model produced a big fenced code block (html/css/js/etc)
            # but forgot to wrap it in a write_file tool call. Catch this and ask
            # it to reissue as a proper tool call rather than show the raw code.
            looks_like_raw_code = (
                tool_call is None
                and bool(re.search(r"```[a-zA-Z0-9_+-]{2,}\s", ai_text))
                and "```json" not in ai_text.lower()
                and len(ai_text) > 200
            )

            if tool_call:
                tool_name = tool_call.get("tool", "")
                tool_args = tool_call.get("args", {}) or {}
                if not isinstance(tool_args, dict):
                    tool_args = {}

                yield f"data: {json.dumps({'type': 'tool_call', 'step': steps_done, 'tool': tool_name, 'args': tool_args, 'reasoning': ai_text.split('```')[0].strip()}, ensure_ascii=False)}\n\n"

                # Execute the tool
                result = await _execute_agent_tool(tool_name, tool_args, ws)

                yield f"data: {json.dumps({'type': 'tool_result', 'step': steps_done, 'tool': tool_name, 'result': result[:2000]}, ensure_ascii=False)}\n\n"

                # Feed result back to AI
                conversation.append(ChatMessage(
                    role="user",
                    content=f"Resultat de {tool_name}:\n{result[:3000]}\n\nContinue ta tache. Si tu as fini, reponds en texte pur (pas de bloc ```json)."
                ))
            elif looks_like_raw_code and step < max_steps - 1:
                # Force the model to reissue via write_file instead of
                # dumping the raw code as its final answer.
                yield f"data: {json.dumps({'type': 'tool_result', 'step': steps_done, 'tool': 'format_check', 'result': 'Format invalide : du code a ete retourne en texte sans write_file. Rappel : pour creer un fichier, appelle write_file avec le contenu dans args.content.'}, ensure_ascii=False)}\n\n"
                conversation.append(ChatMessage(
                    role="user",
                    content=(
                        "Ta derniere reponse contenait du code en bloc fenced "
                        "au lieu d'un appel write_file. Rappel du protocole : "
                        "pour CREER un fichier tu DOIS repondre UNIQUEMENT avec "
                        "```json\\n{\"tool\":\"write_file\",\"args\":{\"path\":\"...\",\"content\":\"...\"}}\\n``` "
                        "Le contenu complet du fichier va dans args.content "
                        "(string JSON echappee). Reessaie maintenant pour cette "
                        "tache precisement."
                    ),
                ))
            else:
                # No tool call — AI is done
                yield f"data: {json.dumps({'type': 'response', 'step': steps_done, 'content': ai_text}, ensure_ascii=False)}\n\n"
                break
        else:
            # for-else: exhausted max_steps without hitting a `break` on a
            # plain text response — the agent kept calling tools to the end.
            limit_reason = "max_steps"
            logger.warning("agent stream exhausted max_steps=%d", max_steps)

        if limit_reason:
            yield f"data: {json.dumps({'type': 'loop_limit', 'reason': limit_reason, 'max_steps': max_steps, 'timeout_s': AI_LOOP_TIMEOUT_S}, ensure_ascii=False)}\n\n"

        yield f"data: {json.dumps({'type': 'done', 'steps': steps_done, 'limit_reason': limit_reason}, ensure_ascii=False)}\n\n"

    return StreamingResponse(agent_stream(), media_type="text/event-stream")


def _scan_balanced_json(text: str, start: int) -> Optional[str]:
    """Scan text[start:] and return the first balanced {...} block.

    Respects JSON string literals so that a `{` inside `"..."` is not counted,
    and handles backslash escapes. This lets us safely extract a tool call
    whose args.content contains braces, quotes, newlines or even backticks.
    """
    if start < 0 or start >= len(text) or text[start] != "{":
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[start:i + 1]
    return None


_SMART_QUOTES = str.maketrans({
    "‘": "'", "’": "'",  # single curly
    "“": '"', "”": '"',  # double curly
    "«": '"', "»": '"',  # guillemets
})


def _try_json_tool(candidate: str) -> Optional[dict]:
    """Try every tolerant variant to parse `candidate` as a tool-call dict.

    Returns the dict if it has a "tool" key, else None. Never raises.
    """
    if not candidate:
        return None
    normalised = candidate.translate(_SMART_QUOTES)
    for attempt in (normalised, normalised.replace("'", '"')):
        try:
            data = json.loads(attempt)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(data, dict) and "tool" in data:
            return data
    return None


def _extract_tool_call(text: str) -> Optional[dict]:
    """Extract a JSON tool call from an AI response, resilient to formatting.

    Accepts:
    - a raw JSON object occupying the whole response (strict mode LLMs)
    - ```json {"tool": ..., "args": {...}} ``` fenced blocks
    - any fenced block whose payload parses as JSON with a "tool" key
    - a bare {"tool": ...} anywhere in the text, even if followed by prose

    The parser is balanced-brace-aware (respects string literals), tolerates
    single-quoted keys and smart/curly quotes (LLMs sometimes produce them),
    and logs a debug line when extraction fails but the text *looked* like a
    tool call attempt — so mismatches are diagnosable without silent drift.
    """
    if not text:
        return None

    # 0) Whole-text JSON (some models reply with JSON only, no fence/prose).
    stripped = text.strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        data = _try_json_tool(stripped)
        if data:
            return data

    # 1) Fenced blocks first (most explicit).
    for match in re.finditer(r"```[a-zA-Z0-9_-]*\s*(.*?)```", text, re.DOTALL):
        payload = match.group(1).strip()
        if not payload.startswith("{"):
            continue
        data = _try_json_tool(payload)
        if data:
            return data
        # Payload had extra prose after the JSON — try a balanced scan.
        candidate = _scan_balanced_json(payload, 0)
        data = _try_json_tool(candidate) if candidate else None
        if data:
            return data

    # 2) Bare inline JSON anywhere in the text.
    for m in re.finditer(r'\{\s*["\']tool["\']', text):
        candidate = _scan_balanced_json(text, m.start())
        data = _try_json_tool(candidate) if candidate else None
        if data:
            return data

    # Diagnostic: the response mentioned a tool but we couldn't parse it.
    # Log a short preview so the mismatch is visible without leaking payload.
    if "tool" in text.lower() and ("{" in text or "```" in text):
        preview = text[:200].replace("\n", " ")
        logger.debug("agent tool_call extraction failed; preview=%r", preview)

    return None


async def _execute_agent_tool(tool_name: str, args: dict, ws: Path) -> str:
    """Execute an agent tool and return the result as text."""
    try:
        if tool_name == "read_file":
            path = args.get("path", "")
            target = (ws / path).resolve()
            if not str(target).startswith(str(ws.resolve())):
                return "ERREUR: Chemin hors du workspace"
            if not target.exists():
                return f"ERREUR: Fichier introuvable: {path}"
            if not _is_text_file(target):
                return "ERREUR: Fichier binaire"
            content = target.read_text(encoding="utf-8")
            return f"Contenu de {path} ({len(content)} chars, {content.count(chr(10))+1} lignes):\n{content[:6000]}"

        elif tool_name == "write_file":
            path = args.get("path", "")
            content = args.get("content", "")
            target = (ws / path).resolve()
            if not str(target).startswith(str(ws.resolve())):
                return "ERREUR: Chemin hors du workspace"
            # Auto-version before writing
            if target.exists():
                old_content = target.read_text(encoding="utf-8")
                vdir = VERSIONS_DIR / path.replace("/", "__").replace("\\", "__")
                vdir.mkdir(parents=True, exist_ok=True)
                ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
                (vdir / f"{ts}.txt").write_text(old_content, encoding="utf-8")
                (vdir / f"{ts}.json").write_text(json.dumps({
                    "timestamp": datetime.now().isoformat(),
                    "label": "Avant ecriture agent",
                    "file_path": path, "lines": old_content.count("\n")+1, "size": len(old_content),
                }, ensure_ascii=False), encoding="utf-8")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            return f"OK: {path} ecrit ({len(content)} chars)"

        elif tool_name == "make_directory":
            path = args.get("path", "")
            if not path or path.strip() in (".", "/", "./"):
                return "ERREUR: Chemin vide"
            target = (ws / path).resolve()
            if not str(target).startswith(str(ws.resolve())):
                return "ERREUR: Chemin hors du workspace"
            if target.exists():
                if target.is_dir():
                    return f"OK: dossier {path} existe deja"
                return f"ERREUR: {path} existe et n'est pas un dossier"
            target.mkdir(parents=True, exist_ok=True)
            return f"OK: dossier {path} cree"

        elif tool_name == "run_command":
            command = args.get("command", "")
            if not command:
                return "ERREUR: Commande vide"
            if platform.system() == "Windows":
                proc = await asyncio.create_subprocess_exec(
                    "cmd.exe", "/c", command,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    cwd=str(ws),
                )
            else:
                proc = await asyncio.create_subprocess_exec(
                    "/bin/bash", "-c", command,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    cwd=str(ws),
                )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            out = stdout.decode("utf-8", errors="replace")[:3000]
            err = stderr.decode("utf-8", errors="replace")[:1000]
            return f"Exit code: {proc.returncode}\nStdout:\n{out}\n{f'Stderr:\n{err}' if err else ''}"

        elif tool_name == "search":
            query = args.get("query", "")
            if not query:
                return "ERREUR: Requete vide"
            results = []
            q_lower = query.lower()
            for root, dirs, files in os.walk(ws):
                dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith(".")]
                for f in files:
                    if len(results) >= 10:
                        break
                    fp = Path(root) / f
                    rel = str(fp.relative_to(ws)).replace("\\", "/")
                    if q_lower in f.lower():
                        results.append(f"[Fichier] {rel}")
                    elif _is_text_file(fp) and fp.stat().st_size < 500_000:
                        try:
                            content = fp.read_text(encoding="utf-8")
                            if q_lower in content.lower():
                                idx = content.lower().find(q_lower)
                                snippet = content[max(0,idx-30):idx+len(query)+30].replace("\n", " ")
                                results.append(f"[Match] {rel}: ...{snippet}...")
                        except Exception:
                            pass
            return f"Resultats pour '{query}' ({len(results)}):\n" + "\n".join(results) if results else f"Aucun resultat pour '{query}'"

        elif tool_name == "list_files":
            path = args.get("path", "")
            target = (ws / path).resolve() if path else ws
            if not str(target).startswith(str(ws.resolve())):
                return "ERREUR: Chemin hors du workspace"
            if not target.is_dir():
                return "ERREUR: Pas un dossier"
            items = []
            for item in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                if item.name.startswith(".") or item.name in IGNORE_DIRS:
                    continue
                rel = str(item.relative_to(ws)).replace("\\", "/")
                if item.is_dir():
                    items.append(f"  [D] {rel}/")
                else:
                    items.append(f"  [F] {rel} ({item.stat().st_size}o)")
            return f"Contenu de {path or '.'}:\n" + "\n".join(items[:50])

        else:
            return f"ERREUR: Outil inconnu: {tool_name}"

    except Exception as e:
        return f"ERREUR: {str(e)[:200]}"


# ═══════════════════════════════════════════════════════════════════════════════
# Code Actions (contextual AI actions on selection)
# ═══════════════════════════════════════════════════════════════════════════════

class CodeActionRequest(BaseModel):
    action: str         # "explain" | "refactor" | "tests" | "document" | "optimize" | "fix"
    code: str           # selected code
    file_path: Optional[str] = None
    language: Optional[str] = None
    provider_name: Optional[str] = None
    model_name: Optional[str] = None


CODE_ACTION_PROMPTS = {
    "explain": "Explique ce code en detail. Que fait-il, comment, et pourquoi ? Mentionne les edge cases potentiels.",
    "refactor": "Refactorise ce code pour ameliorer sa lisibilite, maintenabilite et performance. Garde la meme fonctionnalite. Montre le code refactorise dans un bloc ```.",
    "tests": "Genere des tests unitaires exhaustifs pour ce code. Couvre le happy path, les edge cases et les erreurs. Utilise le framework de test standard du langage.",
    "document": "Ajoute une documentation complete a ce code : docstrings/JSDoc, commentaires inline pour les parties complexes, et un resume en tete.",
    "optimize": "Analyse et optimise ce code pour la performance. Identifie les goulots, propose des ameliorations avec le code optimise dans un bloc ```.",
    "fix": "Analyse ce code pour des bugs potentiels. Identifie les problemes et propose des corrections avec le code corrige dans un bloc ```.",
}


@router.post("/ai/code-action")
async def ai_code_action(req: CodeActionRequest):
    """Execute a contextual AI action on selected code."""
    try:
        from backend.core.providers import ChatMessage
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    provider, chosen_model, _err = await _resolve_user_provider(req.provider_name, req.model_name)
    if _err or not provider or not chosen_model:
        return {"ok": False, "error": _err or "Aucun provider LLM configuré"}

    action_prompt = CODE_ACTION_PROMPTS.get(req.action, f"Action: {req.action}")
    lang = req.language or "text"
    file_info = f" (fichier: {req.file_path})" if req.file_path else ""

    messages = [
        ChatMessage(role="system", content=f"Assistant de programmation. Reponds en francais. Code dans des blocs ```{lang}."),
        ChatMessage(role="user", content=f"{action_prompt}\n\nCode ({lang}{file_info}):\n```{lang}\n{req.code[:6000]}\n```"),
    ]

    try:
        response = await provider.chat(messages, chosen_model)
        return {"ok": True, "response": response.content or "", "action": req.action}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


# ═══════════════════════════════════════════════════════════════════════════════
# Multi-file context support
# ═══════════════════════════════════════════════════════════════════════════════

class MultiFileContextRequest(BaseModel):
    message: str
    files: list[dict] = []          # [{path, content?}] — up to 5 files
    persona: Optional[str] = None
    provider_name: Optional[str] = None
    model_name: Optional[str] = None
    context_mode: str = "smart"
    history: list[dict] = []


@router.post("/ai/chat/multi")
async def ai_multi_file_chat(req: MultiFileContextRequest):
    """AI chat with multiple file contexts."""
    try:
        from backend.core.providers import ChatMessage
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    provider, chosen_model, _err = await _resolve_user_provider(req.provider_name, req.model_name)
    if _err or not provider or not chosen_model:
        return {"ok": False, "error": _err or "Aucun provider LLM configuré"}

    system_parts = [
        "Assistant de programmation IDE multi-fichiers. Reponds en francais, concis et technique.",
        "Code dans des blocs ```language.",
    ]

    persona = None
    if req.persona and req.persona in CODING_PERSONAS:
        persona = CODING_PERSONAS[req.persona]
        system_parts.append(f"\n[Persona: {persona['icon']} {persona['name']}]\n{persona['system_prompt']}")

    # Load .spearcode project rules if available
    ws = _workspace()
    rules_file = ws / ".spearcode"
    if rules_file.exists():
        try:
            rules = rules_file.read_text(encoding="utf-8")[:1500]
            system_parts.append(f"\n[Regles projet .spearcode]\n{rules}")
        except Exception:
            pass

    # Add multi-file context
    total_ctx_chars = 0
    max_ctx = 8000  # total budget for all files
    per_file_budget = max_ctx // max(len(req.files), 1)

    for f_info in req.files[:5]:  # max 5 files
        fpath = f_info.get("path", "")
        if not fpath:
            continue
        try:
            target = _safe_path(fpath)
            if not target.exists() or not _is_text_file(target):
                continue
            content = f_info.get("content") or target.read_text(encoding="utf-8")
            lang = LANG_MAP.get(target.suffix.lower(), "text")
            lines = content.count("\n") + 1

            if req.context_mode == "smart":
                ctx = _extract_relevant_context(content, req.message, lang, per_file_budget)
            elif req.context_mode == "full":
                ctx = content[:per_file_budget]
            else:
                ctx = content[:per_file_budget]

            if total_ctx_chars + len(ctx) > max_ctx:
                ctx = ctx[:max_ctx - total_ctx_chars]
            total_ctx_chars += len(ctx)
            system_parts.append(f"\nFichier: {fpath} ({lang}, {lines}L)\n```{lang}\n{ctx}\n```")
        except Exception:
            pass

    fw = _detect_framework(ws)
    system_parts.append(f"\nProjet: {ws.name} ({_detect_language(ws)}{', ' + fw if fw else ''})")

    system_prompt = "\n".join(system_parts)
    messages = [ChatMessage(role="system", content=system_prompt)]

    # History
    history_chars = 0
    for h in reversed(req.history[-8:]):
        hl = len(h.get("content", ""))
        if history_chars + hl > 2000:
            break
        messages.insert(1, ChatMessage(role=h["role"], content=h["content"]))
        history_chars += hl
    messages.append(ChatMessage(role="user", content=req.message))

    try:
        response = await provider.chat(messages, chosen_model)
        return {
            "ok": True,
            "response": response.content or "",
            "model": chosen_model,
            "files_used": len(req.files),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


# ═══════════════════════════════════════════════════════════════════════════════
# .spearcode Project Rules
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/project-rules")
async def get_project_rules():
    """Get .spearcode project rules file."""
    ws = _workspace()
    rules_file = ws / ".spearcode"
    if rules_file.exists():
        try:
            content = rules_file.read_text(encoding="utf-8")
            return {"ok": True, "content": content, "exists": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    return {"ok": True, "content": "", "exists": False}


@router.put("/project-rules")
async def save_project_rules(data: dict):
    """Save .spearcode project rules file."""
    ws = _workspace()
    rules_file = ws / ".spearcode"
    content = data.get("content", "")
    try:
        rules_file.write_text(content, encoding="utf-8")
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}
