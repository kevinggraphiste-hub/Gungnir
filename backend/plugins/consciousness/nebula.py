"""
Gungnir — Nebula : agrégateur graphe de l'écosystème.

Spec user 2026-05-03 : visualisation des interconnexions
outils/workflows/agents/MCP/channels/services dans le module Conscience.

Format de sortie adapté à Cytoscape.js :
- ``nodes`` : liste de ``{id, label, type, category, color, description, ...}``
- ``edges`` : liste de ``{source, target, label}``
- ``stats`` : compteurs par type pour le panneau de filtres

**Per-user strict** : tout est scopé au ``user_id`` passé. Aucune fuite
cross-user — on lit la DB pour workflows / sub-agents / MCP servers et
les fichiers ``data/<resource>/<uid>/`` pour channels / services.

**Imports lazy** des autres plugins (forge, channels) pour ne pas créer
de hard dependency : si un plugin est désactivé pour ce user, on skip
ses entités sans crash.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

logger = logging.getLogger("gungnir.consciousness.nebula")

DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"


# ── Catégorisation et coloration des outils ──────────────────────────────────
# Une convention de couleur cohérente facilite la lecture du graphe.
# Inspirée du thème scarlet de Gungnir + une palette cool pour les autres.

# Labels / descriptions humains des catégories pour les nœuds level 1
_CATEGORY_LABELS: dict[str, str] = {
    "web": "Web",
    "browser": "Navigateur",
    "valkyrie": "Valkyrie",
    "workflow": "Workflows",
    "agents": "Agents & Skills",
    "memory": "Mémoire & KB",
    "system": "Système",
    "automation": "Automatisation",
    "manage": "Gestion",
    "service": "Services externes",
    "consciousness": "Conscience",
    "code": "Code",
    "meta": "Méta",
    "mcp": "MCP",
    "channel": "Canaux",
    "other": "Autres",
}

_CATEGORY_DESCRIPTIONS: dict[str, str] = {
    "web": "Recherche, fetch et crawl web (DuckDuckGo, scraping, APIs HTTP)",
    "browser": "Browser Playwright — navigation, clic, formulaires, JS dynamique",
    "valkyrie": "Plugin Valkyrie — gestion de cartes, projets, tâches",
    "workflow": "Plugin Forge — workflows YAML orchestrés",
    "agents": "Skills, personnalités, sous-agents, communication inter-agents",
    "memory": "Base de connaissances et identité (kb_*, soul_*)",
    "system": "Système de fichiers, exécution bash sandboxée",
    "automation": "Tâches planifiées, queue background, todo conversation",
    "manage": "Gestion providers, channels, MCP, voice",
    "service": "Connexions externes (n8n, GitHub, Notion, Slack…)",
    "consciousness": "Outils introspection (recall, findings, goals)",
    "code": "SpearCode — édition projet, git, exécution",
    "meta": "Diagnostic, onboarding",
}

_TOOL_CATEGORIES: list[tuple[str, str, str]] = [
    # (préfixe ou nom exact, category_id, color)
    ("web_", "web", "#10b981"),
    ("huntr_", "web", "#10b981"),
    ("browser_", "browser", "#14b8a6"),
    ("valkyrie_", "valkyrie", "#dc2626"),
    ("forge_", "workflow", "#3b82f6"),
    ("skill_", "agents", "#8b5cf6"),
    ("personality_", "agents", "#8b5cf6"),
    ("subagent_", "agents", "#8b5cf6"),
    ("bus_post", "agents", "#8b5cf6"),
    ("kb_", "memory", "#eab308"),
    ("soul_", "memory", "#eab308"),
    ("file_", "system", "#64748b"),
    ("bash_exec", "system", "#64748b"),
    ("schedule_", "automation", "#6366f1"),
    ("conversation_tasks_", "automation", "#6366f1"),
    ("task_queue_", "automation", "#6366f1"),
    ("channel_manage", "manage", "#ec4899"),
    ("provider_manage", "manage", "#ec4899"),
    ("voice_manage", "manage", "#ec4899"),
    ("mcp_manage", "manage", "#ec4899"),
    ("service_connect", "service", "#06b6d4"),
    ("service_call", "service", "#06b6d4"),
    ("consciousness_", "consciousness", "#f97316"),
    ("doctor_check", "meta", "#94a3b8"),
    ("finalize_onboarding", "meta", "#94a3b8"),
    ("spearcode_", "code", "#0ea5e9"),
    ("agentic_", "code", "#0ea5e9"),
]


def _classify_tool(name: str) -> tuple[str, str]:
    """Retourne ``(category, color)`` pour un nom de tool."""
    lower = name.lower()
    for prefix, cat, color in _TOOL_CATEGORIES:
        if lower.startswith(prefix) or lower == prefix:
            return cat, color
    return "other", "#475569"


# ── Parsing YAML léger pour extraire les tools utilisés par un workflow ─────
# Pas de dep PyYAML — on extrait juste les références ``tool: <name>`` qui
# nous intéressent. Si le YAML est plus complexe, ce parser missera des cas
# bordure mais pour Nebula on veut juste la connexion globale.
_TOOL_REF_RE = re.compile(
    r"^[ \t-]*tool\s*:\s*[\"']?([\w_\-]+)[\"']?\s*$",
    re.MULTILINE,
)


def _extract_tools_from_yaml(yaml_def: str) -> list[str]:
    if not yaml_def:
        return []
    found = _TOOL_REF_RE.findall(yaml_def)
    # Dedup tout en préservant l'ordre d'apparition (utile pour debug)
    seen: set[str] = set()
    out: list[str] = []
    for t in found:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


# ── Builder principal ───────────────────────────────────────────────────────


async def build_nebula_graph(user_id: int) -> dict:
    """Agrège le graphe complet pour ``user_id``. Renvoie ``{nodes, edges, stats}``.

    Structure hiérarchique en 3 niveaux pour layout radial/concentric
    (spec user 2026-05-03 — "core central + tout gravite autour, tout
    relié à au moins un point") :

    - **Level 0** (centre) : 1 nœud ``core:gungnir`` — le coeur du système
    - **Level 1** (orbite proche) : nœuds catégorie (web, valkyrie,
      workflow, agents, memory, system, automation, manage, service,
      consciousness, code, browser…) — créés synthétiquement, regroupent
      les tools de chaque famille. Edges core → category.
    - **Level 2** (orbite externe) : tools individuels + workflows Forge +
      sub-agents user + MCP + channels + services. Edges category → tool
      (chaque tool est rattaché à sa catégorie → zéro orphelin) +
      workflow→tool quand le tool est utilisé + subagent→tool idem.

    Le ``level`` est posé sur chaque nœud pour que le frontend puisse
    appliquer un layout concentric (cytoscape ``concentric`` ou tree).

    Best-effort : un échec sur une section ne casse pas les autres.
    """
    nodes: list[dict] = []
    edges: list[dict] = []
    seen_tool_ids: set[str] = set()
    seen_categories: set[str] = set()

    # ── Level 0 : Core ──────────────────────────────────────────────────────
    nodes.append({
        "id": "core:gungnir",
        "label": "Gungnir",
        "type": "core",
        "category": "core",
        "color": "#06b6d4",  # cyan vif comme le core de l'image de réf
        "description": "Coeur du système — toute l'écosystème gravite autour",
        "level": 0,
    })

    def _ensure_category(cat: str, color: str) -> str:
        """Crée le nœud catégorie s'il n'existe pas, retourne son id."""
        cat_id = f"category:{cat}"
        if cat in seen_categories:
            return cat_id
        seen_categories.add(cat)
        nodes.append({
            "id": cat_id,
            "label": _CATEGORY_LABELS.get(cat, cat.title()),
            "type": "category",
            "category": cat,
            "color": color,
            "description": _CATEGORY_DESCRIPTIONS.get(cat, ""),
            "level": 1,
        })
        # Tous les nœuds catégorie sont reliés au core
        edges.append({
            "source": "core:gungnir",
            "target": cat_id,
            "label": "regroupe",
        })
        return cat_id

    # ── 1. Tools natifs (level 2) reliés à leur catégorie (level 1) ────────
    try:
        from backend.core.agents.wolf_tools import WOLF_TOOL_SCHEMAS
        for s in WOLF_TOOL_SCHEMAS:
            fn = s.get("function") or {}
            name = fn.get("name", "")
            if not name:
                continue
            cat, color = _classify_tool(name)
            cat_id = _ensure_category(cat, color)
            nid = f"tool:{name}"
            seen_tool_ids.add(name)
            nodes.append({
                "id": nid,
                "label": name,
                "type": "tool",
                "category": cat,
                "color": color,
                "description": (fn.get("description") or "")[:300],
                "level": 2,
            })
            # Edge synthétique tool → catégorie (assure que tout tool est
            # connecté à au moins 1 point — pas d'orphelin dans le graphe).
            edges.append({
                "source": cat_id,
                "target": nid,
                "label": "contient",
            })
    except Exception as e:
        logger.warning(f"nebula: load WOLF_TOOL_SCHEMAS failed: {e}")

    # ── 2. Workflows Forge ──────────────────────────────────────────────────
    try:
        from backend.core.db.engine import async_session
        from backend.plugins.forge.models import ForgeWorkflow
        from sqlalchemy import select
        async with async_session() as session:
            rs = await session.execute(
                select(ForgeWorkflow).where(ForgeWorkflow.user_id == user_id)
            )
            for wf in rs.scalars().all():
                wf_id = f"workflow:{wf.id}"
                cat_id = _ensure_category("workflow", "#3b82f6")
                nodes.append({
                    "id": wf_id,
                    "label": wf.name or f"Workflow #{wf.id}",
                    "type": "workflow",
                    "category": "workflow",
                    "color": "#3b82f6",
                    "description": (wf.description or "")[:300],
                    "enabled": bool(wf.enabled),
                    "level": 2,
                })
                # Rattachement à la catégorie workflow
                edges.append({
                    "source": cat_id,
                    "target": wf_id,
                    "label": "contient",
                })
                # Edges vers les tools référencés dans le YAML
                for tool_name in _extract_tools_from_yaml(wf.yaml_def or ""):
                    if tool_name in seen_tool_ids:
                        edges.append({
                            "source": wf_id,
                            "target": f"tool:{tool_name}",
                            "label": "utilise",
                        })
    except Exception as e:
        logger.debug(f"nebula: forge workflows skipped: {e}")

    # ── 3. Sub-agents user ──────────────────────────────────────────────────
    try:
        from backend.core.db.engine import async_session
        from backend.core.agents import user_data as ud
        async with async_session() as session:
            agents = await ud.list_sub_agents(session, user_id)
        for a in agents:
            ag_id = f"agent:{a.get('name', '?')}"
            cat_id = _ensure_category("agents", "#8b5cf6")
            nodes.append({
                "id": ag_id,
                "label": a.get("name", "?"),
                "type": "subagent",
                "category": "agents",
                "color": "#8b5cf6",
                "description": (a.get("role") or a.get("expertise") or "")[:300],
                "level": 2,
            })
            edges.append({
                "source": cat_id,
                "target": ag_id,
                "label": "contient",
            })
            for tool_name in (a.get("tools") or []):
                if tool_name in seen_tool_ids:
                    edges.append({
                        "source": ag_id,
                        "target": f"tool:{tool_name}",
                        "label": "utilise",
                    })
    except Exception as e:
        logger.debug(f"nebula: subagents skipped: {e}")

    # ── 4. MCP servers ──────────────────────────────────────────────────────
    try:
        from backend.core.db.engine import async_session
        from backend.core.db.models import MCPServerConfig
        from sqlalchemy import select
        async with async_session() as session:
            rs = await session.execute(
                select(MCPServerConfig).where(MCPServerConfig.user_id == user_id)
            )
            for m in rs.scalars().all():
                cat_id = _ensure_category("mcp", "#ec4899")
                mcp_nid = f"mcp:{m.name}"
                nodes.append({
                    "id": mcp_nid,
                    "label": m.name,
                    "type": "mcp",
                    "category": "mcp",
                    "color": "#ec4899",
                    "description": f"{m.command} {' '.join(list(m.args_json or [])[:3])}"[:300],
                    "enabled": bool(m.enabled),
                    "level": 2,
                })
                edges.append({"source": cat_id, "target": mcp_nid, "label": "contient"})
    except Exception as e:
        logger.debug(f"nebula: mcp skipped: {e}")

    # ── 5. Channels user (filesystem JSON) ──────────────────────────────────
    try:
        ch_file = DATA_DIR / "integrations" / str(user_id) / "channels.json"
        if ch_file.exists():
            import json
            channels = json.loads(ch_file.read_text(encoding="utf-8"))
            if isinstance(channels, list):
                for c in channels:
                    if not isinstance(c, dict):
                        continue
                    cid = c.get("id") or ""
                    if not cid:
                        continue
                    cat_id = _ensure_category("channel", "#f59e0b")
                    ch_nid = f"channel:{cid}"
                    nodes.append({
                        "id": ch_nid,
                        "label": c.get("name") or cid,
                        "type": "channel",
                        "category": "channel",
                        "color": "#f59e0b",
                        "description": f"{c.get('type', '?')} — {'enabled' if c.get('enabled') else 'disabled'}",
                        "enabled": bool(c.get("enabled")),
                        "level": 2,
                    })
                    edges.append({"source": cat_id, "target": ch_nid, "label": "contient"})
    except Exception as e:
        logger.debug(f"nebula: channels skipped: {e}")

    # ── 6. Services connectés (UserSettings.service_keys) ───────────────────
    try:
        from backend.core.db.engine import async_session
        from backend.core.db.models import UserSettings
        from sqlalchemy import select
        async with async_session() as session:
            rs = await session.execute(
                select(UserSettings).where(UserSettings.user_id == user_id)
            )
            us = rs.scalar_one_or_none()
            if us and us.service_keys:
                for svc_name, cfg in (us.service_keys or {}).items():
                    if isinstance(cfg, dict) and (cfg.get("api_key") or cfg.get("token")):
                        cat_id = _ensure_category("service", "#06b6d4")
                        svc_nid = f"service:{svc_name}"
                        nodes.append({
                            "id": svc_nid,
                            "label": svc_name,
                            "type": "service",
                            "category": "service",
                            "color": "#06b6d4",
                            "description": f"Service externe : {svc_name}",
                            "level": 2,
                        })
                        edges.append({"source": cat_id, "target": svc_nid, "label": "contient"})
    except Exception as e:
        logger.debug(f"nebula: services skipped: {e}")

    # ── Stats par type pour le panneau filtres ──────────────────────────────
    stats: dict[str, int] = {}
    for n in nodes:
        stats[n["type"]] = stats.get(n["type"], 0) + 1
    stats["edges"] = len(edges)

    return {
        "nodes": nodes,
        "edges": edges,
        "stats": stats,
        "user_id": user_id,
    }
