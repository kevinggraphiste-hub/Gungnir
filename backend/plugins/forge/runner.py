"""
Forge — DAG runner.

Exécute un workflow YAML séquentiellement (avec support `parallel:` et
`if:` conditionnel). Les steps invoquent des outils du registre WOLF
(`backend/core/agents/wolf_tools.WOLF_EXECUTORS` + plugin agent_tools
auto-discovered).

Format YAML supporté en MVP :

    name: my_workflow
    description: ...
    inputs:
      some_var: { type: string, default: "" }
    steps:
      - id: step1
        tool: web_fetch
        args:
          url: "{{ inputs.target }}"
      - id: step2
        if: "{{ steps.step1.ok }}"
        tool: valkyrie_create_card
        args:
          project_id: 1
          title: "{{ steps.step1.title }}"
      - id: parallel_block
        parallel:
          - tool: kb_write
            args: { ... }
          - tool: web_fetch
            args: { ... }

Interpolation : `{{ path.to.value }}` — résolu via lookup dans le contexte
{ inputs, steps }. Pas de Jinja2 (volontairement minimal et safe).

Conditions `if:` : eval Python restreint sur le contexte (booléens,
comparaisons, and/or/not). Pas d'appels de fonctions ni d'attributs
arbitraires.

Outputs : chaque step expose son `output` complet sous
`steps.<id>.output` ; les clés du dict output sont aussi accessibles
directement (`steps.<id>.<key>`) pour les patterns courants
(`{ ok, error, data, ... }`).
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime
from typing import Any, Optional

import yaml

logger = logging.getLogger("gungnir.plugins.forge.runner")


# ── Interpolation `{{ path }}` ────────────────────────────────────────────

# Capture `{{ ... }}` non-greedy. Espaces internes tolérés.
_TEMPLATE_RE = re.compile(r"\{\{\s*([^}]+?)\s*\}\}")


def _resolve_path(ctx: dict, path: str) -> Any:
    """Lookup `a.b.c` dans le contexte ; retourne None si chemin invalide."""
    cur: Any = ctx
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return cur


def _interpolate(value: Any, ctx: dict) -> Any:
    """Remplace les `{{ path }}` dans value (récursif sur dict/list)."""
    if isinstance(value, str):
        # Cas spécial : la chaîne est UNIQUEMENT `{{ x }}` → on retourne
        # l'objet brut (préserve les types non-string : int, list, dict).
        m = _TEMPLATE_RE.fullmatch(value.strip())
        if m:
            return _resolve_path(ctx, m.group(1).strip())
        # Sinon interpolation textuelle classique.
        return _TEMPLATE_RE.sub(
            lambda mm: str(_resolve_path(ctx, mm.group(1).strip()) or ""),
            value,
        )
    if isinstance(value, dict):
        return {k: _interpolate(v, ctx) for k, v in value.items()}
    if isinstance(value, list):
        return [_interpolate(v, ctx) for v in value]
    return value


# ── Évaluation des conditions `if:` ──────────────────────────────────────

# AST whitelist : on accepte uniquement les opérations purement logiques /
# comparatives sur des valeurs déjà interpolées. Pas d'appels, pas
# d'attributs arbitraires, pas d'imports.
import ast as _ast

_ALLOWED_NODES = {
    _ast.Expression, _ast.BoolOp, _ast.UnaryOp, _ast.Compare, _ast.Constant,
    _ast.Name, _ast.Load,
    _ast.And, _ast.Or, _ast.Not,
    _ast.Eq, _ast.NotEq, _ast.Lt, _ast.LtE, _ast.Gt, _ast.GtE,
    _ast.In, _ast.NotIn, _ast.Is, _ast.IsNot,
}


def _safe_eval_condition(expr: str, ctx: dict) -> bool:
    """Évalue une condition booléenne sur le contexte (après interpolation).

    Retourne False sur erreur (jamais d'exception remontée à l'engine).
    """
    if not expr or not expr.strip():
        return True
    # On interpole d'abord — la string contient typiquement `{{ x }} == 'foo'`
    rendered = _interpolate(expr, ctx)
    if not isinstance(rendered, str):
        return bool(rendered)
    try:
        tree = _ast.parse(rendered, mode="eval")
        for node in _ast.walk(tree):
            if type(node) not in _ALLOWED_NODES:
                logger.warning(
                    "[forge] Condition rejetée (node interdit %s) : %r",
                    type(node).__name__, expr,
                )
                return False
        # Eval avec un namespace minimal — Name nodes résolus via dict lookup.
        ns = {"true": True, "false": False, "null": None,
              "True": True, "False": False, "None": None}
        return bool(eval(compile(tree, "<forge:if>", "eval"), {"__builtins__": {}}, ns))
    except Exception as e:
        logger.warning("[forge] Condition échec %r : %s", expr, e)
        return False


# ── Exécution d'un step ──────────────────────────────────────────────────

async def _run_tool(tool_name: str, args: dict, log: list) -> dict:
    """Invoke un wolf tool par nom. Retourne le dict output (ou {ok: False, error}).

    Importe `WOLF_EXECUTORS` lazy pour éviter les cycles d'import.
    """
    from backend.core.agents.wolf_tools import WOLF_EXECUTORS, _plugin_executors_discovered  # noqa
    executor = WOLF_EXECUTORS.get(tool_name) or _plugin_executors_discovered.get(tool_name)
    if not executor:
        return {"ok": False, "error": f"Outil inconnu : {tool_name}"}
    try:
        # Tous les executors WOLF acceptent kwargs. On filtre None pour
        # laisser les défauts s'appliquer.
        clean_args = {k: v for k, v in (args or {}).items() if v is not None}
        if asyncio.iscoroutinefunction(executor):
            res = await executor(**clean_args)
        else:
            res = executor(**clean_args)
        if not isinstance(res, dict):
            res = {"ok": True, "data": res}
        return res
    except TypeError as e:
        return {"ok": False, "error": f"Arguments invalides pour {tool_name} : {e}"}
    except Exception as e:
        logger.exception("[forge] Erreur outil %s", tool_name)
        return {"ok": False, "error": f"Erreur outil {tool_name} : {e}"}


async def _exec_step(step: dict, ctx: dict, logs: list) -> dict:
    """Exécute un step (atomique ou parallèle). Retourne son output."""
    sid = step.get("id") or f"step_{len(logs)}"

    # Condition skip ?
    if "if" in step:
        cond = step["if"]
        if not _safe_eval_condition(str(cond), ctx):
            logs.append({
                "ts": datetime.utcnow().isoformat(),
                "step_id": sid, "type": "skip",
                "reason": f"condition fausse : {cond}",
            })
            return {"skipped": True, "ok": True}

    started = time.time()
    logs.append({
        "ts": datetime.utcnow().isoformat(),
        "step_id": sid, "type": "start",
        "tool": step.get("tool") or ("parallel" if "parallel" in step else "?"),
    })

    # Bloc parallèle : exécute les sous-steps en asyncio.gather.
    if "parallel" in step:
        sub_outputs = await asyncio.gather(
            *[_exec_step(sub, ctx, logs) for sub in step["parallel"]],
            return_exceptions=False,
        )
        out = {"ok": all(o.get("ok", True) for o in sub_outputs),
               "results": sub_outputs}
        logs.append({
            "ts": datetime.utcnow().isoformat(),
            "step_id": sid, "type": "end",
            "duration_ms": int((time.time() - started) * 1000),
            "ok": out["ok"],
        })
        return out

    # Step atomique : invoke un tool.
    tool = step.get("tool")
    if not tool:
        out = {"ok": False, "error": "step sans 'tool' ni 'parallel'"}
    else:
        args = _interpolate(step.get("args") or {}, ctx)
        out = await _run_tool(tool, args, logs)

    logs.append({
        "ts": datetime.utcnow().isoformat(),
        "step_id": sid, "type": "end",
        "duration_ms": int((time.time() - started) * 1000),
        "ok": out.get("ok", True),
        "error": out.get("error") if not out.get("ok", True) else None,
    })
    return out


# ── Entry point ──────────────────────────────────────────────────────────

class ForgeRunResult:
    __slots__ = ("status", "logs", "output", "error")

    def __init__(self, status: str, logs: list, output: dict, error: str = ""):
        self.status = status
        self.logs = logs
        self.output = output
        self.error = error


def parse_workflow_yaml(yaml_text: str) -> dict:
    """Parse + valide minimalement un workflow YAML. Lève ValueError sinon."""
    try:
        data = yaml.safe_load(yaml_text) or {}
    except yaml.YAMLError as e:
        raise ValueError(f"YAML invalide : {e}")
    if not isinstance(data, dict):
        raise ValueError("Le YAML doit être un objet (dict).")
    steps = data.get("steps")
    if not isinstance(steps, list):
        raise ValueError("Champ 'steps' (liste) requis.")
    for i, st in enumerate(steps):
        if not isinstance(st, dict):
            raise ValueError(f"Step #{i} doit être un dict.")
        if "tool" not in st and "parallel" not in st:
            raise ValueError(
                f"Step #{i} ('{st.get('id', '?')}') doit avoir 'tool' ou 'parallel'."
            )
    return data


async def run_workflow(yaml_text: str, inputs: Optional[dict] = None,
                       max_seconds: int = 300) -> ForgeRunResult:
    """Exécute un workflow YAML. Retourne ForgeRunResult.

    `max_seconds` : timeout global (défaut 5 min). Au-delà, on annule et
    on retourne status='error' avec les logs partiels.
    """
    inputs = inputs or {}
    logs: list = []
    output: dict = {}
    try:
        wf = parse_workflow_yaml(yaml_text)
    except ValueError as e:
        return ForgeRunResult("error", [], {}, str(e))

    ctx: dict = {"inputs": inputs, "steps": {}}

    async def _run_all():
        nonlocal output
        for step in wf.get("steps", []):
            sid = step.get("id") or f"step_{len(ctx['steps'])}"
            out = await _exec_step(step, ctx, logs)
            # Expose l'output sous steps.<id>.* + steps.<id>.output (raw).
            ctx["steps"][sid] = {**(out if isinstance(out, dict) else {}),
                                 "output": out}
            output = out  # le dernier step gagne pour `output_json` final
            # Échec dur : on stoppe (sauf si le step a un `continue_on_error`).
            if isinstance(out, dict) and out.get("ok") is False and not step.get("continue_on_error"):
                raise RuntimeError(out.get("error") or f"step {sid} a échoué")

    try:
        await asyncio.wait_for(_run_all(), timeout=max_seconds)
        return ForgeRunResult("success", logs, output, "")
    except asyncio.TimeoutError:
        return ForgeRunResult("error", logs, output,
                              f"Timeout après {max_seconds}s")
    except RuntimeError as e:
        return ForgeRunResult("error", logs, output, str(e))
    except Exception as e:
        logger.exception("[forge] Erreur run_workflow")
        return ForgeRunResult("error", logs, output, f"Erreur runtime : {e}")
