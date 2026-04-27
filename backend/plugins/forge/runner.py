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
from typing import Any, Awaitable, Callable, Optional

# Type du callback passé à run_workflow pour streamer les events.
EventCallback = Optional[Callable[[dict], Awaitable[None]]]

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


async def _emit(on_event: EventCallback, evt: dict):
    """Pousse l'event au callback s'il est défini, en silence sur erreur
    (ne doit jamais casser l'exécution du workflow)."""
    if on_event is None:
        return
    try:
        await on_event(evt)
    except Exception as e:
        logger.warning("[forge] on_event callback failed: %s", e)


async def _run_with_retry(step: dict, exec_once, ctx: dict) -> dict:
    """Exécute `exec_once()` avec une retry policy si déclarée sur le step.

    Format : `retry: { count: 3, delay_ms: 1000, backoff: 2.0 }`
    Retry uniquement sur ok==False (pas sur succès, évidemment).
    """
    retry_cfg = step.get("retry") or {}
    count = max(0, int(retry_cfg.get("count") or 0))
    delay_ms = max(0, int(retry_cfg.get("delay_ms") or 1000))
    backoff = float(retry_cfg.get("backoff") or 1.0)
    attempt = 0
    out: dict = {}
    while True:
        out = await exec_once()
        if out.get("ok", True) or attempt >= count:
            if attempt > 0 and isinstance(out, dict):
                out["_retried"] = attempt
            return out
        attempt += 1
        wait_s = (delay_ms / 1000.0) * (backoff ** (attempt - 1))
        await asyncio.sleep(wait_s)


async def _exec_step(step: dict, ctx: dict, logs: list,
                     on_event: EventCallback = None) -> dict:
    """Exécute un step (atomique, parallèle, ou for_each). Retourne son output.
    `on_event` (optionnel) reçoit chaque entrée de log au fur et à mesure
    pour le streaming SSE."""
    sid = step.get("id") or f"step_{len(logs)}"

    # Condition skip ?
    if "if" in step:
        cond = step["if"]
        if not _safe_eval_condition(str(cond), ctx):
            evt = {
                "ts": datetime.utcnow().isoformat(),
                "step_id": sid, "type": "skip",
                "reason": f"condition fausse : {cond}",
            }
            logs.append(evt)
            await _emit(on_event, evt)
            return {"skipped": True, "ok": True}

    started = time.time()
    evt_start = {
        "ts": datetime.utcnow().isoformat(),
        "step_id": sid, "type": "start",
        "tool": (step.get("tool") or ("parallel" if "parallel" in step else
                  "for_each" if "for_each" in step else "?")),
    }
    logs.append(evt_start)
    await _emit(on_event, evt_start)

    # Bloc parallèle : exécute les sous-steps en asyncio.gather.
    if "parallel" in step:
        sub_outputs = await asyncio.gather(
            *[_exec_step(sub, ctx, logs, on_event) for sub in step["parallel"]],
            return_exceptions=False,
        )
        out = {"ok": all(o.get("ok", True) for o in sub_outputs),
               "results": sub_outputs}
        evt_end = {
            "ts": datetime.utcnow().isoformat(),
            "step_id": sid, "type": "end",
            "duration_ms": int((time.time() - started) * 1000),
            "ok": out["ok"],
        }
        logs.append(evt_end)
        await _emit(on_event, evt_end)
        return out

    # For each : itère sur une liste (interpolée depuis `for_each`) et
    # exécute `do` (liste de sub-steps) avec une variable nommée par `as`.
    if "for_each" in step:
        items_raw = _interpolate(step["for_each"], ctx)
        as_name = (step.get("as") or "item").strip() or "item"
        sub_steps = step.get("do") or []
        if not isinstance(items_raw, list):
            out = {"ok": False, "error": f"for_each : attendu une liste, reçu {type(items_raw).__name__}"}
        elif not isinstance(sub_steps, list):
            out = {"ok": False, "error": "for_each : champ 'do' (liste de steps) requis"}
        else:
            results: list = []
            ok_total = True
            # Sauvegarde la valeur précédente de la var pour restauration
            # (éviter d'écraser un global de même nom, surtout en nested).
            previous = ctx.get(as_name)
            try:
                for idx, item in enumerate(items_raw):
                    ctx[as_name] = item
                    item_outputs = []
                    item_ok = True
                    for ssub in sub_steps:
                        sub_id = ssub.get("id") or f"{sid}.{idx}"
                        # On ne met PAS à jour ctx.steps depuis l'intérieur
                        # d'un for_each (sinon collision entre items). On
                        # collecte les outputs séparément.
                        sout = await _exec_step({**ssub, "id": f"{sid}[{idx}].{sub_id}"},
                                                ctx, logs, on_event)
                        item_outputs.append(sout)
                        if isinstance(sout, dict) and sout.get("ok") is False and not ssub.get("continue_on_error"):
                            item_ok = False
                            break
                    results.append({"ok": item_ok, "outputs": item_outputs, "item": item})
                    if not item_ok and not step.get("continue_on_error"):
                        ok_total = False
                        break
            finally:
                if previous is None:
                    ctx.pop(as_name, None)
                else:
                    ctx[as_name] = previous
            out = {"ok": ok_total, "iterations": len(results), "results": results}
        evt_end = {
            "ts": datetime.utcnow().isoformat(),
            "step_id": sid, "type": "end",
            "duration_ms": int((time.time() - started) * 1000),
            "ok": out.get("ok", True),
            "error": out.get("error") if not out.get("ok", True) else None,
        }
        logs.append(evt_end)
        await _emit(on_event, evt_end)
        return out

    # Step atomique : invoke un tool, avec retry policy si déclarée.
    tool = step.get("tool")
    if not tool:
        out = {"ok": False, "error": "step sans 'tool', 'parallel' ni 'for_each'"}
    else:
        async def _run_atomic():
            args = _interpolate(step.get("args") or {}, ctx)
            return await _run_tool(tool, args, logs)
        out = await _run_with_retry(step, _run_atomic, ctx)

    evt_end = {
        "ts": datetime.utcnow().isoformat(),
        "step_id": sid, "type": "end",
        "duration_ms": int((time.time() - started) * 1000),
        "ok": out.get("ok", True),
        "error": out.get("error") if not out.get("ok", True) else None,
    }
    if isinstance(out, dict) and out.get("_retried"):
        evt_end["retried"] = out["_retried"]
    logs.append(evt_end)
    await _emit(on_event, evt_end)
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
                       max_seconds: int = 300,
                       on_event: EventCallback = None,
                       user_id: Optional[int] = None,
                       workflow_id: Optional[int] = None) -> ForgeRunResult:
    """Exécute un workflow YAML. Retourne ForgeRunResult.

    `max_seconds` : timeout global (défaut 5 min). Au-delà, on annule et
    on retourne status='error' avec les logs partiels.

    `on_event` (optionnel) : callback async appelé à chaque entrée de log
    pour le streaming temps réel (SSE).  Si None, run en mode batch.

    `user_id` + `workflow_id` (optionnels) : si fournis, expose
    `ctx.globals` (user-scoped) et `ctx.static` (workflow-scoped) au YAML
    via interpolation `{{ globals.X }}` / `{{ static.X }}`.
    """
    inputs = inputs or {}
    logs: list = []
    output: dict = {}
    try:
        wf = parse_workflow_yaml(yaml_text)
    except ValueError as e:
        return ForgeRunResult("error", [], {}, str(e))

    # Charge les globals/static au démarrage (snapshot — les writes
    # pendant le workflow ne sont pas relus, sauf si l'user fait un
    # forge_get_static explicite).
    globals_snapshot: dict = {}
    static_snapshot: dict = {}
    if user_id:
        try:
            from .state_tools import _all_globals_for_user, _all_static_for_workflow
            globals_snapshot = await _all_globals_for_user(user_id)
            if workflow_id:
                static_snapshot = await _all_static_for_workflow(user_id, workflow_id)
        except Exception as e:
            logger.warning("[forge] could not load globals/static : %s", e)

    ctx: dict = {
        "inputs": inputs,
        "steps": {},
        "globals": globals_snapshot,
        "static": static_snapshot,
    }

    async def _run_all():
        nonlocal output
        for step in wf.get("steps", []):
            sid = step.get("id") or f"step_{len(ctx['steps'])}"
            out = await _exec_step(step, ctx, logs, on_event)
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
