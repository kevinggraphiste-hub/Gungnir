"""
Forge — import de workflows N8N (compat partielle).

N8N exporte ses workflows en JSON :
{
  "name": "...",
  "nodes": [{ id, name, type, parameters, position, ... }],
  "connections": { <node_name>: { main: [[{node, index}]] } }
}

On mappe les types de nodes les plus courants vers les wolf_tools de
Gungnir. Pour les nodes spécifiques à N8N (Function, Code JS, etc.), on
crée un step placeholder commenté dans le YAML pour que l'user voie ce
qui n'a pas pu être traduit.

Stratégie :
1. Topo sort des nodes via les `connections.main`
2. Pour chaque node : trouve un mapper, ou fallback placeholder
3. Génère le YAML Forge équivalent
"""
from __future__ import annotations

import logging
import re
from typing import Any, Optional

logger = logging.getLogger("gungnir.plugins.forge.n8n_import")


def _slugify_id(name: str) -> str:
    """Transforme `Mon Node !` en `mon_node`."""
    s = re.sub(r"[^a-zA-Z0-9_]+", "_", (name or "").strip()).strip("_").lower()
    return s[:60] or "step"


# ── Mapping N8N type → Forge step ────────────────────────────────────────

# Chaque mapper retourne le dict step ou None si pas mappable.
def _map_http_request(node: dict) -> Optional[dict]:
    """n8n-nodes-base.httpRequest → web_fetch."""
    p = node.get("parameters") or {}
    url = p.get("url") or ""
    method = (p.get("method") or "GET").upper()
    if not url:
        return None
    args: dict = {"url": url, "max_chars": 5000}
    # Le wolf_tool web_fetch est en GET-only en MVP. Si POST, on log
    # un warning dans le step (l'user verra le placeholder).
    if method != "GET":
        return {
            "_n8n_unmapped": True,
            "_reason": f"web_fetch ne supporte pas encore {method}",
            "tool": "web_fetch", "args": args,
        }
    return {"tool": "web_fetch", "args": args}


def _map_webhook(node: dict) -> Optional[dict]:
    """n8n-nodes-base.webhook → trigger info, pas un step.

    On ne génère rien dans steps mais on remonte l'info pour que
    l'importeur puisse créer un ForgeTrigger correspondant.
    """
    return {"_is_trigger": "webhook", "config": node.get("parameters") or {}}


def _map_cron(node: dict) -> Optional[dict]:
    """n8n-nodes-base.cron → trigger cron."""
    p = node.get("parameters") or {}
    return {"_is_trigger": "cron", "config": p}


def _map_set(node: dict) -> Optional[dict]:
    """n8n-nodes-base.set → pas d'équivalent direct, placeholder."""
    return {
        "_n8n_unmapped": True,
        "_reason": "Le node 'Set' N8N n'a pas d'équivalent direct — variables Forge passent via inputs/steps",
    }


def _map_if(node: dict) -> Optional[dict]:
    """n8n-nodes-base.if → conditionnel — on génère un step vide avec if:."""
    return {
        "_n8n_unmapped": True,
        "_reason": "Conditionnel N8N — à recâbler manuellement avec `if: \"{{ ... }}\"`",
    }


def _map_function(node: dict) -> Optional[dict]:
    """n8n-nodes-base.function / code → pas d'éval JS dans Forge."""
    return {
        "_n8n_unmapped": True,
        "_reason": "Forge n'exécute pas de code JS arbitraire (sécurité). Chaîne plutôt des wolf_tools.",
    }


# Mapping par type N8N. Les types sont stables sur les versions n8n
# depuis longtemps. Pas exhaustif — on couvre le top utilisé.
N8N_TYPE_MAPPERS: dict[str, Any] = {
    "n8n-nodes-base.httpRequest":     _map_http_request,
    "n8n-nodes-base.webhook":         _map_webhook,
    "n8n-nodes-base.cron":            _map_cron,
    "n8n-nodes-base.scheduleTrigger": _map_cron,
    "n8n-nodes-base.set":             _map_set,
    "n8n-nodes-base.if":              _map_if,
    "n8n-nodes-base.switch":          _map_if,
    "n8n-nodes-base.function":        _map_function,
    "n8n-nodes-base.functionItem":    _map_function,
    "n8n-nodes-base.code":            _map_function,
}


# ── Topo sort ────────────────────────────────────────────────────────────

def _topo_sort_nodes(nodes: list[dict], connections: dict) -> list[dict]:
    """Trie les nodes selon l'ordre topologique des connections.

    `connections` format n8n :
        { <source_name>: { main: [ [ {node: <target_name>, index: 0} ], ... ] } }
    """
    by_name = {n.get("name"): n for n in nodes}
    # Comptage entrants
    incoming = {n.get("name"): 0 for n in nodes}
    out_map: dict[str, list[str]] = {n.get("name"): [] for n in nodes}
    for src, conn in (connections or {}).items():
        mains = conn.get("main") or []
        for branch in mains:
            for tgt in branch or []:
                tname = tgt.get("node") if isinstance(tgt, dict) else None
                if tname and tname in incoming:
                    incoming[tname] = incoming.get(tname, 0) + 1
                    out_map[src] = out_map.get(src, []) + [tname]

    ordered: list[dict] = []
    visited: set[str] = set()

    def walk(name: str):
        if name in visited or name not in by_name:
            return
        visited.add(name)
        ordered.append(by_name[name])
        for nxt in out_map.get(name, []):
            walk(nxt)

    # Démarre par les roots (sans incoming).
    for n in nodes:
        if incoming.get(n.get("name"), 0) == 0:
            walk(n.get("name"))
    # Catch isolés.
    for n in nodes:
        walk(n.get("name"))
    return ordered


# ── Entrée publique ──────────────────────────────────────────────────────

def n8n_to_forge(payload: dict) -> dict:
    """Convertit un export N8N (dict JSON) en un dict Forge.

    Retourne :
        {
          "name": "...",
          "description": "Importé de N8N (X nodes mappés, Y placeholders)",
          "yaml_steps": [... liste prête pour yaml.dump ...],
          "triggers": [{ "type": "webhook"|"cron", "config": {...} }, ...],
          "warnings": [str, ...]
        }
    """
    name = payload.get("name") or "Workflow N8N importé"
    nodes = payload.get("nodes") or []
    connections = payload.get("connections") or {}
    if not isinstance(nodes, list):
        raise ValueError("Format N8N invalide : 'nodes' n'est pas une liste.")

    ordered = _topo_sort_nodes(nodes, connections)

    yaml_steps: list[dict] = []
    triggers: list[dict] = []
    warnings: list[str] = []
    used_ids: set[str] = set()

    for n in ordered:
        ntype = n.get("type") or ""
        nname = n.get("name") or ntype
        sid_base = _slugify_id(nname) or "step"
        sid = sid_base
        i = 1
        while sid in used_ids:
            i += 1; sid = f"{sid_base}_{i}"
        used_ids.add(sid)

        mapper = N8N_TYPE_MAPPERS.get(ntype)
        if not mapper:
            yaml_steps.append({
                "id": sid,
                "tool": "_n8n_unmapped_",
                "args": {
                    "n8n_type": ntype,
                    "original_name": nname,
                    "parameters": n.get("parameters") or {},
                },
            })
            warnings.append(f"Type N8N non mappé : '{ntype}' (node '{nname}') → placeholder à recâbler.")
            continue

        result = mapper(n)
        if result is None:
            warnings.append(f"Impossible de mapper '{nname}' ({ntype}).")
            continue

        # Trigger info → on l'extrait, pas un step.
        if "_is_trigger" in result:
            triggers.append({"type": result["_is_trigger"], "config": result.get("config", {})})
            continue

        if result.get("_n8n_unmapped"):
            warnings.append(f"Node '{nname}' ({ntype}) : {result.get('_reason', 'non mappé')}")
            yaml_steps.append({
                "id": sid,
                "tool": result.get("tool", "_n8n_unmapped_"),
                "args": result.get("args", {"n8n_type": ntype, "original_name": nname}),
            })
            continue

        step = {"id": sid, "tool": result["tool"], "args": result.get("args", {})}
        yaml_steps.append(step)

    description = (
        f"Importé de N8N — {len([s for s in yaml_steps if not s['tool'].startswith('_')])} "
        f"nodes mappés, {len([s for s in yaml_steps if s['tool'].startswith('_')])} placeholders"
        f"{', ' + str(len(triggers)) + ' triggers' if triggers else ''}."
    )

    return {
        "name": name,
        "description": description,
        "yaml_steps": yaml_steps,
        "triggers": triggers,
        "warnings": warnings,
    }
