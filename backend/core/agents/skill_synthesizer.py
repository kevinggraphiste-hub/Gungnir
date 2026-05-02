"""
skill_synthesizer.py — Auto-écriture de skills après une interaction réussie.

Inspiré du closed learning loop d'Hermes Agent. Après un échange où l'agent
a réellement résolu un problème (≥ 2 tools non-triviaux, score auto correct),
un LLM résume la solution en un skill réutilisable et l'enregistre via
`ud.create_skill`. Les skills accumulés améliorent les futures réponses
puisqu'ils sont injectés dans le system prompt quand l'user les active.

Design :
- **Best-effort, fire-and-forget** : un échec de synthèse ne bloque jamais le chat.
- **Gating strict** : on n'écrit pas un skill pour chaque message — seulement
  pour les interactions vraiment substantielles (sinon on noie l'user dans
  des skills sans valeur).
- **Anti-doublon** : on skip si un skill avec un nom similaire existe déjà.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger("gungnir.skill_synthesizer")


# Tools « actifs » — leur présence dans les tool_events indique que l'agent
# a réellement fait quelque chose, pas juste lu de l'info. Les tools de
# lecture pure (web_search, file_read, kb_read, ...) seuls ne suffisent pas.
_ACTIVE_TOOLS = {
    # Écriture / création
    "kb_write", "soul_write", "file_write", "file_patch",
    "skill_create", "skill_update",
    "personality_create", "personality_update",
    "subagent_create", "subagent_update",
    # Web actif
    "browser_click", "browser_type", "browser_fill_form", "browser_select_option",
    # Spear / git
    "spearcode_write_file", "spearcode_run", "spearcode_terminal",
    "spearcode_git_commit",
    # Valkyrie
    "valkyrie_create_card", "valkyrie_update_card",
    "valkyrie_create_project", "valkyrie_update_project",
    "valkyrie_add_subtask", "valkyrie_toggle_subtask",
    # Webhooks
    "webhook_trigger",
    # Conscience write
    "consciousness_remember", "consciousness_trigger_need",
    # Bash actif
    "bash_exec",
}


def _has_substantive_work(tool_events: list[dict] | None) -> bool:
    """Détecte si l'agent a fait un vrai boulot (≥1 tool actif et ≥2 tools au total)."""
    if not tool_events or len(tool_events) < 2:
        return False
    return any(ev.get("tool") in _ACTIVE_TOOLS for ev in tool_events)


def _slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s[:60] or "skill"


async def _skill_name_exists(session, user_id: int, name: str) -> bool:
    from backend.core.db.models import UserSkill
    from sqlalchemy import select, func
    target = name.lower()
    result = await session.execute(
        select(UserSkill).where(UserSkill.user_id == user_id)
    )
    for row in result.scalars().all():
        existing = (row.name or "").lower()
        # Match exact ou très proche (préfixe ≥ 80% commun)
        if existing == target or existing.startswith(target[:max(8, len(target) * 4 // 5)]):
            return True
    return False


async def synthesize_skill(
    *,
    user_id: int,
    convo_id: int | None,
    user_msg: str,
    assistant_msg: str,
    tool_events: list[dict] | None,
) -> dict | None:
    """Tente d'écrire un skill auto à partir d'une interaction.

    Retourne le dict skill créé ou None si gated/échec/doublon.
    """
    if not user_id or not (assistant_msg or "").strip():
        return None
    if not _has_substantive_work(tool_events):
        return None

    try:
        from backend.core.services.llm_invoker import invoke_llm_for_user
    except Exception:
        return None

    # Liste compacte des tools utilisés pour donner le contexte au synthétiseur
    used_tools = []
    seen = set()
    for ev in tool_events or []:
        t = ev.get("tool")
        if t and t not in seen:
            seen.add(t)
            used_tools.append(t)

    # Standard de qualité aligné sur la doc officielle Claude Skills
    # (rapport user 2026-05-02). Avant : "5-15 lignes" → produisait des
    # "skill-stubs" trop courts pour vraiment guider l'IA. Maintenant :
    # 40-150 lignes structurées en 6 sections obligatoires (rôle,
    # méthodologie, règles, format, critères de succès, exemples).
    system = (
        "Tu écris des skills réutilisables pour un agent IA nommé Gungnir, "
        "alignés sur le standard officiel Anthropic Claude Skills. À partir "
        "d'une interaction où l'agent a réussi une tâche, tu produis un mode "
        "d'emploi détaillé qui permettra à l'agent de re-résoudre des tâches "
        "similaires plus efficacement.\n\n"
        "## Critères de QUALITÉ d'un skill\n"
        "- **Étoffé** : 40 à 150 lignes (pas un stub de 5 lignes)\n"
        "- **Généralisable** : couvre une famille de tâches, pas un cas unique\n"
        "- **Actionnable** : méthodologie en étapes numérotées explicites\n"
        "- **Cite les tools** existants utilisés (web_search, kb_write, etc.)\n"
        "- **Vérifiable** : critères de succès en fin de tâche\n\n"
        "## Structure obligatoire du champ `prompt` (6 sections)\n"
        "1. **Rôle + posture** — Qui est le skill, expertise, ton\n"
        "   ex: \"Tu es un expert SEO senior avec 10 ans d'expérience...\"\n"
        "2. **Méthodologie** — Étapes numérotées (3 à 7 étapes)\n"
        "   ex: \"### 1. Analyse du sujet\\n- Identifier le mot-clé principal...\"\n"
        "3. **Règles strictes** — Anti-patterns à éviter, qualité attendue\n"
        "   ex: \"- Pas de générique \\\"selon les experts\\\"\\n- Toujours sourcer\"\n"
        "4. **Format de sortie imposé** — Sections markdown, longueur, ton\n"
        "   ex: \"## Format de sortie\\nMarkdown structuré : H1 titre, H2 sections...\"\n"
        "5. **Critères de succès** — Checklist vérifiable en fin de tâche\n"
        "   ex: \"## Vérifications\\n- [ ] Sources citées\\n- [ ] 3+ exemples concrets\"\n"
        "6. **2 à 3 exemples** — Mini cas d'usage avec input → output attendu\n"
        "   ex: \"## Exemples\\n\\n### Cas 1: ...\\n**Input:** ...\\n**Output:** ...\"\n\n"
        "Si l'interaction est trop spécifique pour être généralisée, retourne "
        "{\"skip\": true, \"reason\": \"<justif>\"}. "
        "Réponds STRICTEMENT en JSON valide (pas de prose autour)."
    )
    user_prompt = (
        f"## Demande user\n{(user_msg or '')[:500]}\n\n"
        f"## Réponse agent (extrait)\n{(assistant_msg or '')[:1200]}\n\n"
        f"## Tools utilisés\n{', '.join(used_tools)}\n\n"
        "Écris un skill au format suivant, ou skip si pas généralisable :\n"
        "{\n"
        '  "name": "<snake_case court, ex: scrape_and_summarize>",\n'
        '  "description": "<1 phrase, ce que fait le skill>",\n'
        '  "category": "<general|development|research|automation|writing|other>",\n'
        '  "tags": ["<3 tags max>"],\n'
        '  "prompt": "<contenu structuré 40-150 lignes avec les 6 sections — utilise \\n pour les sauts de ligne dans le JSON>"\n'
        "}\n"
        "OU si non-généralisable : {\"skip\": true, \"reason\": \"<courte justif>\"}"
    )

    try:
        result = await invoke_llm_for_user(user_id, user_prompt, system_prompt=system)
    except Exception as e:
        logger.debug(f"skill_synthesizer LLM call failed: {e}")
        return None

    if not result.get("ok"):
        return None
    raw = (result.get("content") or "").strip()
    if not raw:
        return None
    if raw.startswith("```"):
        # Strip fences
        lines = raw.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        raw = "\n".join(lines).strip()
    # On capture uniquement le premier bloc JSON
    try:
        first = raw.find("{")
        last = raw.rfind("}")
        if first == -1 or last == -1:
            return None
        data = json.loads(raw[first:last + 1])
    except Exception:
        return None

    if data.get("skip"):
        logger.info(f"skill_synthesizer skip user={user_id}: {data.get('reason', 'no reason')}")
        return None

    name = _slugify(str(data.get("name") or ""))
    description = str(data.get("description") or "").strip()[:300]
    # Cap 8k chars : ~150 lignes possibles (la nouvelle structure 6 sections
    # demande 40-150 lignes). 4k précédent caillait à ~80 lignes max.
    prompt_text = str(data.get("prompt") or "").strip()[:8000]
    # Plancher minimal : un skill doit faire au moins 200 chars (≈ 5 lignes)
    # pour ne pas dégénérer en stub. Sinon, skip — mieux vaut pas de skill
    # qu'un skill creux qui pollue.
    if not name or not prompt_text or len(prompt_text) < 200:
        return None

    # Anti-doublon — vérifie qu'aucun skill similaire n'existe
    try:
        from backend.core.db.engine import async_session
        async with async_session() as session:
            if await _skill_name_exists(session, user_id, name):
                logger.info(f"skill_synthesizer dedup user={user_id} name={name}")
                return None

            from backend.core.agents import user_data as ud
            skill_data = {
                "description": description,
                "prompt": prompt_text,
                "tools": [],
                "category": str(data.get("category") or "general")[:40],
                "tags": [str(t)[:30] for t in (data.get("tags") or [])[:5]],
                "version": "1.0.0",
                "author": "gungnir-auto",
                "license": "MIT",
                "examples": [],
                "output_format": "text",
                "annotations": {},
                "icon": "✨",
                "is_favorite": False,
                "usage_count": 0,
            }
            res = await ud.create_skill(session, user_id, name, skill_data)
            if res.get("success"):
                await session.commit()
                logger.info(f"skill_synthesizer created user={user_id} name={name}")
                return {"name": name, "description": description, "auto": True}
    except Exception as e:
        logger.debug(f"skill_synthesizer create failed: {e}")
    return None
