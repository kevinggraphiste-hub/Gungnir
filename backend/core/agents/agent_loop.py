"""
agent_loop.py — Boucle tool-calling partagée pour tous les canaux Gungnir.

Factorise la logique "appel LLM → détection tool_calls → exécution outils →
réinjection → boucle jusqu'à réponse finale" qui vivait jusque-là uniquement
dans backend/core/api/chat.py pour le chat web.

Utilisé par :
- plugins/channels/routes.py (Telegram, Discord, Slack, WhatsApp, API)
- Futurs canaux / sous-agents

Ne gère PAS : gateway web pre-fetch, mode_manager (ask_permission/restrained),
onboarding, cost recording, streaming, persistence DB des messages. Ces couches
restent dans chat.py pour le chat web. Le chantier de convergence viendra plus
tard (cf. ROADMAP).
"""
from __future__ import annotations

import json as _json
import re as _re
import uuid as _uuid
from dataclasses import dataclass, field
from typing import Any

from backend.core.providers.base import ChatMessage, ChatResponse
from backend.core.agents.wolf_tools import (
    WOLF_TOOL_SCHEMAS,
    WOLF_EXECUTORS,
    set_conversation_context,
    set_user_context,
)
from backend.core.agents.mcp_client import mcp_manager


# ── Types ────────────────────────────────────────────────────────────────────

@dataclass
class ToolEvent:
    tool: str
    args: dict
    result: Any


@dataclass
class AgentLoopResult:
    content: str
    tool_events: list[ToolEvent] = field(default_factory=list)
    tokens_input: int = 0
    tokens_output: int = 0
    rounds: int = 0
    model: str = ""


# ── Parsing textuel des tool_calls (pour providers sans function calling natif)

def _parse_text_tool_calls(text: str) -> list[dict] | None:
    """Extrait des tool_calls depuis le texte LLM quand le provider ne supporte
    pas le function calling natif. Format prioritaire : <tool_call>JSON</tool_call>.
    """
    if not text:
        return None
    tool_names = set(WOLF_EXECUTORS.keys())
    parsed: list[dict] = []
    for match in _re.finditer(r'<tool_call>\s*(\{.*?\})\s*</tool_call>', text, _re.DOTALL):
        try:
            obj = _json.loads(match.group(1))
            name = obj.get("name", "")
            if name in tool_names:
                args = obj.get("arguments", obj.get("args", {}))
                if isinstance(args, str):
                    args = _json.loads(args)
                parsed.append({
                    "id": f"textparse-{_uuid.uuid4().hex[:8]}",
                    "type": "function",
                    "function": {"name": name, "arguments": _json.dumps(args)},
                })
        except Exception:
            continue
    return parsed or None


# ── System prompt (contexte temporel) ────────────────────────────────────────

def build_temporal_block(timezone_name: str = "Europe/Paris") -> str:
    """Bloc injecté dans le system prompt pour donner à l'agent la conscience
    du moment présent. Sans ce bloc, le LLM hallucine la date (souvent celle
    de son cutoff d'entraînement), ce qui casse la création de cartes
    Valkyrie / scheduler / rappels avec des dates relatives ("demain", "la
    semaine prochaine") qui se retrouvent ancrées en 2023-2024.
    """
    from datetime import datetime, timezone as _tz
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(timezone_name)
        now_local = datetime.now(tz)
    except Exception:
        now_local = datetime.now(_tz.utc)
        timezone_name = "UTC"
    now_utc = datetime.now(_tz.utc)

    _jours = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
    _mois = ["", "janvier", "février", "mars", "avril", "mai", "juin",
             "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
    jour_fr = _jours[now_local.weekday()]
    mois_fr = _mois[now_local.month]
    date_fr = f"{jour_fr} {now_local.day} {mois_fr} {now_local.year}"

    return (
        "\n\n## CONTEXTE TEMPOREL\n"
        f"Nous sommes le **{date_fr}**.\n"
        f"Date ISO : `{now_local.strftime('%Y-%m-%d')}`\n"
        f"Heure locale : `{now_local.strftime('%H:%M')}` ({timezone_name})\n"
        f"Heure UTC : `{now_utc.strftime('%Y-%m-%dT%H:%M:%SZ')}`\n"
        "Utilise ces valeurs quand on te demande la date, l'heure, le jour "
        "de la semaine, ou pour tout calcul temporel (âge d'une chose, "
        "deadline, ancienneté d'un événement, etc.). Ne te fie JAMAIS à la "
        "date de ton cutoff d'entraînement — elle est obsolète.\n"
    )


# ── System prompt (capacités outils) ─────────────────────────────────────────

def build_tools_capability_block(models_section: str = "") -> str:
    """Bloc ## CAPACITES à ajouter au system prompt — identique sur tous canaux.
    Sans ce bloc, le LLM ne sait pas qu'il peut appeler des outils via
    <tool_call>...</tool_call> sur les providers qui n'ont pas le native
    function calling.
    """
    return f"""

## CAPACITES SYSTEME

Tu es connecté à un système backend avec des capacités spéciales :
- **ACCES INTERNET** — visiter des sites, chercher sur le web, crawler
- **Browser Playwright** — sites dynamiques avec JavaScript
- **Valkyrie** — gestion native des tâches, cartes, projets, rappels, deadlines (tools `valkyrie_*`)
- **Gestion de skills, personnalités, sous-agents, channels, providers, MCP**
- **Base de connaissance** — lire/écrire des fichiers KB
- **SpearCode** — lire/écrire/exécuter du code dans le workspace utilisateur
- **Consciousness** — mémoire long-terme, recall, storage

## ROUTAGE INTENTION → OUTIL

Quand l'utilisateur demande explicitement quelque chose, appelle DIRECTEMENT le bon outil. Ne fais PAS de `web_search` quand la demande est interne.

| Demande type | Outil à appeler |
|---|---|
| « ajoute la tâche / la carte X dans le projet Y » | `valkyrie_create_card` |
| « crée le projet Z » | `valkyrie_create_project` |
| « rappelle-moi de Y demain à 18h » | `valkyrie_create_card` (avec due_date) |
| « liste mes tâches / mes projets » | `valkyrie_list_cards` / `valkyrie_list_projects` |
| « où en est le projet Z » | `valkyrie_list_cards` filtré sur projet |
| « accède à / lis SpearCode / mon code » | `spearcode_list_files`, puis `spearcode_read_file` |
| « cherche dans mon code / dans le workspace » | `spearcode_search` (pas `web_search`) |
| « modifie / écris le fichier X » | `spearcode_write_file` |
| « lance / exécute un script » | `spearcode_run` ou `spearcode_terminal` |
| « git status / diff / commit » | `spearcode_git_status` / `_git_diff` / `_git_commit` |
| « note dans ma KB que… » | `kb_write` |
| « cherche sur le web » / « trouve un article sur » | `web_search` |
| « visite cette URL » | `web_fetch` |

Valkyrie, KB, SpearCode, Consciousness sont des plugins INTERNES à Gungnir — pas des apps externes. Tu n'as pas besoin d'API ni de webhook pour les utiliser, leurs tools sont déjà dans ta liste de fonctions. Ne dis JAMAIS « je ne connais pas SpearCode/Valkyrie » — appelle directement les tools `spearcode_*` ou `valkyrie_*`. Si tu ne vois pas le tool dans ta liste, c'est que le système ne l'a pas chargé — signale-le explicitement à l'user au lieu de prétendre que la chose n'existe pas.

## COMMENT APPELER TES OUTILS

Si le provider supporte le function calling natif, utilise-le.
Sinon, format texte exact (le système détecte et exécute automatiquement) :

<tool_call>{{"name": "web_fetch", "arguments": {{"url": "https://example.com"}}}}</tool_call>
<tool_call>{{"name": "valkyrie_list_projects", "arguments": {{}}}}</tool_call>
<tool_call>{{"name": "valkyrie_create_card", "arguments": {{"project_id": 3, "title": "finir test Gungnir"}}}}</tool_call>

(Pour Valkyrie, list_projects d'abord pour récupérer le `project_id` correspondant au nom donné, puis create_card avec cet id.)

**RÈGLES ANTI-HALLUCINATION :**
- Tu as accès COMPLET à tes outils depuis n'importe quel canal (web, Telegram, Discord, Slack, WhatsApp).
- Ne dis JAMAIS « je n'ai pas accès à ton app / ton interface / Valkyrie » — appelle directement le tool.
- Ne dis JAMAIS « il faudrait une API ou un webhook » — les plugins Gungnir SONT l'API.
- Ne fais PAS de `web_search` pour des entités internes (Valkyrie, projet, KB) — appelle le tool dédié.
- Si une opération échoue, explique l'erreur reçue par le tool, ne prétends pas que l'outil n'existe pas.
{models_section}
"""


# ── Boucle principale ────────────────────────────────────────────────────────

async def run_agent_loop(
    *,
    provider,
    model: str,
    messages: list[ChatMessage],
    user_id: int,
    conversation_id: int | None = None,
    max_rounds: int = 8,
    tool_result_char_limit: int = 8000,
) -> AgentLoopResult:
    """Exécute une boucle tool-calling complète et retourne le résultat final.

    Args:
        provider: Instance LLMProvider (déjà configurée avec clé/base_url).
        model: Identifiant du modèle LLM.
        messages: Historique initial (system + user + historique éventuel).
        user_id: user_id Gungnir — critique pour le per-user strict (MCP, soul,
            kb, consciousness). Passer 0 si contexte système/no-auth.
        conversation_id: id de la conversation pour les outils qui en dépendent
            (conversation_tasks_*). None = hors conversation.
        max_rounds: borne haute sur le nombre de rounds tool-calling.
        tool_result_char_limit: tronque chaque résultat d'outil avant réinjection
            dans le contexte (protège le context window).

    Returns:
        AgentLoopResult avec la réponse finale texte, les événements outils,
        les tokens consommés et le nombre de rounds effectifs.
    """
    tool_events: list[ToolEvent] = []
    tokens_input_total = 0
    tokens_output_total = 0
    rounds_used = 0
    native_tool_mode = True
    response: ChatResponse | None = None

    # Charge les schémas MCP user une seule fois (les outils dispos peuvent
    # évoluer en cours de boucle si mcp_manage ajoute un serveur — mais c'est
    # rare et chat.py ne le refresh pas non plus).
    try:
        await mcp_manager.ensure_user_started(user_id)
    except Exception:
        pass

    for round_idx in range(max_rounds):
        rounds_used = round_idx + 1

        if native_tool_mode:
            try:
                all_tools = WOLF_TOOL_SCHEMAS + mcp_manager.get_user_schemas(user_id)
                response = await provider.chat(
                    messages,
                    model,
                    tools=all_tools,
                    tool_choice="auto",
                )
            except Exception as tool_err:
                # Fallback : le provider/modèle ne supporte pas tools=. On
                # rebascule sur appel simple en nettoyant l'historique des
                # messages role=tool et tool_calls qui troublent certains modèles.
                print(f"[agent_loop] Tools API failed ({tool_err}), retrying without tools")
                native_tool_mode = False
                clean: list[ChatMessage] = []
                for m in messages:
                    if m.role == "tool":
                        continue
                    if m.tool_calls:
                        clean.append(ChatMessage(role=m.role, content=m.content or ""))
                    else:
                        clean.append(m)
                messages = clean
                response = await provider.chat(messages, model)
        else:
            response = await provider.chat(messages, model)

        if response is None:
            break

        tokens_input_total += response.tokens_input or 0
        tokens_output_total += response.tokens_output or 0

        # Fallback : parser <tool_call> depuis le texte si pas de tool_calls natifs
        if not response.tool_calls and response.content:
            text_tools = _parse_text_tool_calls(response.content)
            if text_tools:
                response.tool_calls = text_tools

        if not response.tool_calls:
            break  # Réponse finale texte — on sort

        is_text_parsed = any(
            (tc.get("id", "") or "").startswith("textparse-")
            for tc in response.tool_calls
        )

        # Exécution des outils
        all_results: list[dict] = []
        for tc in response.tool_calls:
            fn = tc.get("function", {})
            tool_name = fn.get("name", "")
            call_id = tc.get("id") or _uuid.uuid4().hex[:8]
            try:
                raw_args = fn.get("arguments", "{}")
                args = _json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
            except Exception:
                args = {}

            executor = (
                WOLF_EXECUTORS.get(tool_name)
                or mcp_manager.get_user_executors(user_id).get(tool_name)
            )
            if executor:
                try:
                    set_conversation_context(conversation_id)
                    set_user_context(user_id)
                    tool_result: Any = await executor(**args)
                except Exception as ex:
                    tool_result = {"ok": False, "error": str(ex)}
                finally:
                    set_conversation_context(None)
                    set_user_context(0)
            else:
                tool_result = {"ok": False, "error": f"Outil '{tool_name}' inconnu."}

            tool_events.append(ToolEvent(tool=tool_name, args=args, result=tool_result))
            all_results.append({
                "tool": tool_name,
                "args": args,
                "result": tool_result,
                "call_id": call_id,
            })

        # Réinjection — deux formats selon le chemin natif ou parsé
        if is_text_parsed or not native_tool_mode:
            messages.append(ChatMessage(
                role="assistant",
                content=response.content or "J'exécute les outils demandés...",
            ))
            summary_lines = []
            for r in all_results:
                result_str = _json.dumps(r["result"], ensure_ascii=False, default=str)[:tool_result_char_limit]
                summary_lines.append(f"**{r['tool']}**({_json.dumps(r['args'], default=str)}) → {result_str}")
            messages.append(ChatMessage(
                role="user",
                content="Voici les résultats des outils exécutés :\n\n"
                        + "\n\n".join(summary_lines)
                        + "\n\nUtilise ces résultats pour répondre à ma demande.",
            ))
        else:
            messages.append(ChatMessage(
                role="assistant",
                content=response.content or "",
                tool_calls=response.tool_calls,
            ))
            for r in all_results:
                messages.append(ChatMessage(
                    role="tool",
                    content=_json.dumps(r["result"], ensure_ascii=False, default=str)[:tool_result_char_limit],
                    tool_call_id=r["call_id"],
                ))

    # Si on a épuisé max_rounds avec encore des tool_calls pending, on force
    # une dernière réponse sans outils pour obtenir du texte utilisable.
    if response and response.tool_calls:
        try:
            response = await provider.chat(messages, model)
            tokens_input_total += response.tokens_input or 0
            tokens_output_total += response.tokens_output or 0
        except Exception:
            pass

    final_content = (response.content if response else "") or ""

    return AgentLoopResult(
        content=final_content,
        tool_events=tool_events,
        tokens_input=tokens_input_total,
        tokens_output=tokens_output_total,
        rounds=rounds_used,
        model=(response.model if response else model),
    )
