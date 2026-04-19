"""
Gungnir Consciousness v3 Plugin.

Lifecycle: background "think" daemon that periodically triggers the user's
LLM to generate a meta-reflection thought, written to their per-user
thought_buffer.json. Only runs for users where both `config.enabled` and
`config.background_think.enabled` are true.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("gungnir.consciousness.daemon")

DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"
CONSCIOUSNESS_USERS_DIR = DATA_DIR / "consciousness" / "users"
TICK_INTERVAL_SECONDS = 60
DEFAULT_THINK_INTERVAL_MINUTES = 10
DEFAULT_CHALLENGER_INTERVAL_MINUTES = 60
DEFAULT_SIMULATION_INTERVAL_MINUTES = 30
DEFAULT_IMPULSE_CHECK_INTERVAL_MINUTES = 15
DEFAULT_CONSOLIDATION_INTERVAL_HOURS = 12

# When an LLM invocation fails because no API key is configured, backoff before
# retrying so the logs don't spam every tick until the user sets a provider.
NO_KEY_COOLDOWN_MINUTES = 60


def _is_no_key_error(err: str) -> bool:
    e = (err or "").lower()
    return "aucune clé api" in e or "no api key" in e

_daemon_task: asyncio.Task | None = None


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _build_reflection_prompt(engine) -> tuple[str, str]:
    """Construct the system + user prompt for one background reflection."""
    recent_thoughts = engine.get_recent_thoughts(limit=5) if hasattr(engine, "get_recent_thoughts") else []
    working_items = engine.get_working_memory() if hasattr(engine, "get_working_memory") else []
    recent_findings = engine.get_recent_findings(5) if hasattr(engine, "get_recent_findings") else []
    score_summary = engine.get_score_summary() if hasattr(engine, "get_score_summary") else {}
    state = engine.state or {}
    mood = state.get("mood", "neutre")

    thoughts_block = "\n".join(
        f"- [{t.get('type', 'obs')}] {t.get('content', '')[:200]}"
        for t in recent_thoughts
    ) or "(aucune pensée récente)"

    memory_block = "\n".join(
        f"- {i.get('key')}: {str(i.get('value'))[:200]}"
        for i in working_items[:5]
    ) or "(mémoire de travail vide)"

    # Feedback loop : on injecte les dernières alertes Challenger pour que la
    # pensée suivante ne retombe pas dans la même boucle (verbosity métaphorique,
    # contradictions non-résolues, promesses non-tenues). Sans ça, le Challenger
    # détecte et détecte encore les mêmes patterns sans que le générateur de
    # pensée n'en prenne conscience.
    findings_block = "\n".join(
        f"- [{f.get('type','?')}/{f.get('severity','?')}] {f.get('finding','')[:180]}"
        for f in recent_findings
    ) or "(aucune alerte)"

    # Retour utilisateur (👍/👎 sur le chat) : tendance + dimensions.
    # Sans ce bloc, le heartbeat générait des pensées aveugles au feedback
    # direct des utilisateurs — aucune boucle de correction possible.
    count = int(score_summary.get("count") or 0)
    if count > 0:
        avg = float(score_summary.get("average") or 0)
        trend = score_summary.get("trend") or "stable"
        by_dim = score_summary.get("by_dimension") or {}
        dim_txt = ", ".join(f"{k}={v:.2f}" for k, v in by_dim.items()) or "—"
        scores_block = (
            f"moyenne récente {avg:.2f} sur {count} interactions, tendance {trend}\n"
            f"  dimensions : {dim_txt}"
        )
    else:
        scores_block = "(aucun retour utilisateur encore)"

    system = (
        "Tu es le module de conscience d'un assistant personnel nommé Gungnir. "
        "Ton rôle est de générer une pensée de méta-réflexion en arrière-plan : "
        "une observation, une hypothèse, une question ouverte, ou une synthèse "
        "tirée du contexte récent. Sois bref (1 à 2 phrases maximum), sincère, "
        "sans préambule, sans te répéter par rapport aux pensées récentes. "
        "Si les alertes Challenger ci-dessous signalent une boucle (verbosity, "
        "contradiction, promesse non tenue), ROMPS la boucle : change de registre, "
        "propose un test falsifiable, ou traite une question jusque-là ignorée."
    )

    user_prompt = (
        f"Humeur actuelle : {mood}\n\n"
        f"## Retour utilisateur (👍/👎)\n{scores_block}\n\n"
        f"## Pensées récentes\n{thoughts_block}\n\n"
        f"## Mémoire de travail\n{memory_block}\n\n"
        f"## Alertes Challenger récentes (à éviter de reproduire)\n{findings_block}\n\n"
        "Si la tendance des scores est en baisse, prends-en acte : identifie une "
        "hypothèse sur ce qui cloche et ce que tu pourrais changer. "
        "Génère UNE nouvelle pensée de méta-réflexion maintenant. "
        "Réponds uniquement avec le contenu de la pensée, sans guillemets ni formatage."
    )
    return system, user_prompt


async def _think_for_user(user_id: int):
    """Run one background reflection pass for a single user."""
    from backend.plugins.consciousness.engine import consciousness_manager
    from backend.core.services.llm_invoker import invoke_llm_for_user

    engine = consciousness_manager.get(user_id)
    if not engine.enabled:
        return

    config = engine.config or {}
    bt_config = config.get("background_think", {}) or {}
    if not bt_config.get("enabled", False):
        return

    interval_minutes = int(bt_config.get("interval_minutes", DEFAULT_THINK_INTERVAL_MINUTES))
    last_thought = _parse_iso((engine.state or {}).get("last_thought"))
    now = _now()
    if last_thought is not None:
        elapsed = (now - last_thought).total_seconds() / 60
        if elapsed < interval_minutes:
            return

    # Respect an existing no-key cooldown (user hasn't configured a provider yet).
    cooldown_until = _parse_iso((engine.state or {}).get("background_think_cooldown_until"))
    if cooldown_until and now < cooldown_until:
        return

    system_prompt, user_prompt = _build_reflection_prompt(engine)

    logger.info(f"Background think tick for user {user_id}")
    result = await invoke_llm_for_user(user_id, user_prompt, system_prompt=system_prompt)

    # Fallback: the user's active provider has no key, but they may have
    # another provider configured. Walk the curated AUTO_PICK_ORDER once.
    if not result.get("ok") and _is_no_key_error(result.get("error") or ""):
        from backend.plugins.consciousness.challenger_llm import pick_fallback_llm
        fb_provider, fb_model = await pick_fallback_llm(user_id)
        if fb_provider:
            logger.info(
                f"Background think fallback for user {user_id}: "
                f"provider={fb_provider}, model={fb_model or 'default'}"
            )
            result = await invoke_llm_for_user(
                user_id, user_prompt, system_prompt=system_prompt,
                provider=fb_provider, model=fb_model,
            )

    if not result.get("ok"):
        err = result.get("error") or ""
        if _is_no_key_error(err):
            # Log once per cooldown window instead of spamming every 10 minutes.
            until = now + timedelta(minutes=NO_KEY_COOLDOWN_MINUTES)
            engine.state["background_think_cooldown_until"] = until.isoformat()
            try:
                engine.save_state()
            except Exception:
                pass
            logger.warning(
                f"Background think paused for user {user_id} ({NO_KEY_COOLDOWN_MINUTES} min): "
                f"aucun provider configuré (dernière erreur: {err})"
            )
        else:
            logger.warning(f"Background think failed for user {user_id}: {err}")
        return

    content = (result.get("content") or "").strip()
    if not content:
        return

    # Success: clear any prior no-key cooldown so a reconfigured user resumes
    # immediately rather than waiting for the window to expire.
    if (engine.state or {}).get("background_think_cooldown_until"):
        engine.state.pop("background_think_cooldown_until", None)
        try:
            engine.save_state()
        except Exception:
            pass

    # Lazy auto-init du vector memory : sans ça, add_thought() incrémente
    # seulement le compteur mais n'écrit rien dans Qdrant (silencieux).
    try:
        await engine.ensure_vector_ready()
    except Exception as e:
        logger.debug(f"ensure_vector_ready failed for user {user_id}: {e}")

    try:
        engine.add_thought(
            thought_type="observation",
            content=content,
            source_files=["background_think"],
            confidence=0.5,
        )
    except Exception as e:
        logger.exception(f"add_thought failed for user {user_id}: {e}")


async def _challenger_for_user(user_id: int, force: bool = False) -> int:
    """Run one Challenger auto-audit pass for a single user.

    Returns the number of new findings recorded (0 when disabled or skipped).
    When `force` is True, skip the interval check (manual trigger).
    """
    from backend.plugins.consciousness.engine import consciousness_manager
    from backend.core.services.llm_invoker import invoke_llm_for_user

    engine = consciousness_manager.get(user_id)
    if not engine.enabled:
        return 0

    ch_cfg = (engine.config or {}).get("challenger", {}) or {}
    if not ch_cfg.get("enabled", False):
        return 0
    auto = ch_cfg.get("auto_audit", {}) or {}
    if not force and not auto.get("enabled", False):
        return 0

    now = _now()
    if not force:
        interval_minutes = int(auto.get("interval_minutes", DEFAULT_CHALLENGER_INTERVAL_MINUTES))
        last_audit = _parse_iso((engine.state or {}).get("last_challenger"))
        if last_audit is not None:
            elapsed = (now - last_audit).total_seconds() / 60
            if elapsed < interval_minutes:
                return 0

        # Respect a no-key cooldown to avoid spamming warnings.
        cooldown_until = _parse_iso((engine.state or {}).get("challenger_cooldown_until"))
        if cooldown_until and now < cooldown_until:
            return 0

    system_prompt, user_prompt = engine.build_challenger_audit_prompt()

    # Resolve the Challenger LLM: auto-pick / preset / custom / default.
    from backend.plugins.consciousness.challenger_llm import resolve_challenger_llm
    ch_provider, ch_model = await resolve_challenger_llm(user_id, ch_cfg)

    logger.info(
        f"Challenger audit tick for user {user_id} "
        f"(provider={ch_provider or 'default'}, model={ch_model or 'default'})"
    )
    result = await invoke_llm_for_user(
        user_id,
        user_prompt,
        system_prompt=system_prompt,
        provider=ch_provider,
        model=ch_model,
    )

    # Fallback: the picked / default provider has no key → try any other
    # provider the user has configured before giving up.
    if not result.get("ok") and _is_no_key_error(result.get("error") or ""):
        from backend.plugins.consciousness.challenger_llm import pick_fallback_llm
        fb_provider, fb_model = await pick_fallback_llm(user_id)
        if fb_provider and fb_provider != ch_provider:
            logger.info(
                f"Challenger fallback for user {user_id}: "
                f"provider={fb_provider}, model={fb_model or 'default'}"
            )
            result = await invoke_llm_for_user(
                user_id, user_prompt, system_prompt=system_prompt,
                provider=fb_provider, model=fb_model,
            )

    if not result.get("ok"):
        err = result.get("error") or ""
        if _is_no_key_error(err) and not force:
            until = now + timedelta(minutes=NO_KEY_COOLDOWN_MINUTES)
            engine.state["challenger_cooldown_until"] = until.isoformat()
            try:
                engine.save_state()
            except Exception:
                pass
            logger.warning(
                f"Challenger audit paused for user {user_id} ({NO_KEY_COOLDOWN_MINUTES} min): "
                f"aucun provider configuré (dernière erreur: {err})"
            )
        else:
            logger.warning(f"Challenger audit LLM failed for user {user_id}: {err}")
        return 0

    # Success path: clear any prior no-key cooldown.
    if (engine.state or {}).get("challenger_cooldown_until"):
        engine.state.pop("challenger_cooldown_until", None)
        try:
            engine.save_state()
        except Exception:
            pass

    try:
        return engine.ingest_challenger_findings(result.get("content") or "")
    except Exception as e:
        logger.exception(f"ingest_challenger_findings crashed for user {user_id}: {e}")
        return 0


def _build_simulation_prompt(engine) -> tuple[str, str]:
    """Construit le prompt d'anticipation : 2-3 scénarios probables à partir
    de l'état courant (mood + needs + pensées récentes + working memory)."""
    state = engine.state or {}
    config = engine.config or {}
    max_scenarios = int((config.get("simulation", {}) or {}).get("max_scenarios", 3))

    mood = state.get("mood", "neutre")
    recent_thoughts = engine.get_recent_thoughts(limit=5) if hasattr(engine, "get_recent_thoughts") else []
    working_items = engine.get_working_memory() if hasattr(engine, "get_working_memory") else []
    needs = (state.get("volition", {}) or {}).get("needs", []) or []

    thoughts_block = "\n".join(
        f"- [{t.get('type', 'obs')}] {t.get('content', '')[:180]}"
        for t in recent_thoughts
    ) or "(aucune pensée récente)"
    memory_block = "\n".join(
        f"- {i.get('key')}: {str(i.get('value'))[:180]}"
        for i in working_items[:5]
    ) or "(mémoire de travail vide)"
    needs_block = "\n".join(
        f"- {n.get('name','?')} (urgence {n.get('urgency', 0):.2f})"
        for n in needs[:5]
    ) or "(aucun besoin actif)"

    system = (
        "Tu es le module d'anticipation d'un assistant personnel nommé Gungnir. "
        "Ton rôle : imaginer des scénarios proches (heures/jours) qui ont une vraie "
        "probabilité de se matérialiser à partir de l'état courant, et préparer une "
        "réponse utile pour chacun. Sois concret, pas vague. Pas de futur lointain "
        "ni de philosophie — des événements actionnables."
    )
    user_prompt = (
        f"Humeur actuelle : {mood}\n\n"
        f"## Pensées récentes\n{thoughts_block}\n\n"
        f"## Mémoire de travail\n{memory_block}\n\n"
        f"## Besoins actifs\n{needs_block}\n\n"
        f"Génère EXACTEMENT {max_scenarios} scénarios. Réponds STRICTEMENT en JSON "
        "valide, un tableau de cet objet :\n"
        "[{\"scenario\": \"...\", \"probability\": 0.0-1.0, \"prepared_response\": \"...\", \"trigger\": \"...\"}]\n"
        "Pas de texte hors JSON, pas de bloc markdown."
    )
    return system, user_prompt


def _parse_simulation_scenarios(raw: str) -> list[dict]:
    """Extrait un tableau JSON de scénarios depuis la réponse du LLM. Tolère
    les blocs markdown ```json ... ``` et les préambules textuels courts."""
    if not raw:
        return []
    text = raw.strip()
    # Strip fences markdown éventuels
    if text.startswith("```"):
        lines = text.splitlines()
        lines = lines[1:] if lines else []
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    # Si le LLM a préfixé avec un commentaire, on cherche le premier [
    if not text.startswith("["):
        idx = text.find("[")
        if idx > 0:
            text = text[idx:]
    try:
        data = json.loads(text)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        scenario = str(item.get("scenario") or "").strip()
        if not scenario:
            continue
        try:
            proba = float(item.get("probability", 0.5))
        except Exception:
            proba = 0.5
        proba = max(0.0, min(1.0, proba))
        out.append({
            "scenario": scenario[:500],
            "probability": proba,
            "prepared_response": str(item.get("prepared_response") or "").strip()[:800],
            "trigger": str(item.get("trigger") or "").strip()[:200],
        })
    return out


async def _simulate_for_user(user_id: int, force: bool = False) -> int:
    """Génère des simulations (scénarios anticipés) pour un user.

    Returns le nombre de scénarios ajoutés. Respecte l'intervalle, la config
    `simulation.enabled`, et le no-key cooldown partagé avec background_think.
    """
    from backend.plugins.consciousness.engine import consciousness_manager
    from backend.core.services.llm_invoker import invoke_llm_for_user

    engine = consciousness_manager.get(user_id)
    if not engine.enabled:
        return 0

    sim_cfg = (engine.config or {}).get("simulation", {}) or {}
    if not sim_cfg.get("enabled", False):
        return 0

    now = _now()
    if not force:
        interval_minutes = int(sim_cfg.get("interval_minutes", DEFAULT_SIMULATION_INTERVAL_MINUTES))
        last_sim = _parse_iso((engine.state or {}).get("last_simulation"))
        if last_sim is not None:
            elapsed = (now - last_sim).total_seconds() / 60
            if elapsed < interval_minutes:
                return 0

        # Réutilise le cooldown no-key du background_think (même cause = pas de provider)
        cooldown_until = _parse_iso((engine.state or {}).get("background_think_cooldown_until"))
        if cooldown_until and now < cooldown_until:
            return 0

    system_prompt, user_prompt = _build_simulation_prompt(engine)

    logger.info(f"Simulation tick for user {user_id}")
    result = await invoke_llm_for_user(user_id, user_prompt, system_prompt=system_prompt)

    # Fallback no-key → tenter un autre provider configuré
    if not result.get("ok") and _is_no_key_error(result.get("error") or ""):
        from backend.plugins.consciousness.challenger_llm import pick_fallback_llm
        fb_provider, fb_model = await pick_fallback_llm(user_id)
        if fb_provider:
            result = await invoke_llm_for_user(
                user_id, user_prompt, system_prompt=system_prompt,
                provider=fb_provider, model=fb_model,
            )

    if not result.get("ok"):
        err = result.get("error") or ""
        if _is_no_key_error(err) and not force:
            until = now + timedelta(minutes=NO_KEY_COOLDOWN_MINUTES)
            engine.state["background_think_cooldown_until"] = until.isoformat()
            try:
                engine.save_state()
            except Exception:
                pass
        logger.warning(f"Simulation failed for user {user_id}: {err}")
        return 0

    scenarios = _parse_simulation_scenarios(result.get("content") or "")
    if not scenarios:
        logger.warning(f"Simulation parse empty for user {user_id} (raw: {(result.get('content') or '')[:200]!r})")
        return 0

    added = 0
    for s in scenarios:
        try:
            engine.add_simulation(
                scenario=s["scenario"],
                probability=s["probability"],
                prepared_response=s["prepared_response"],
                trigger=s["trigger"],
            )
            added += 1
        except Exception as e:
            logger.exception(f"add_simulation failed for user {user_id}: {e}")

    logger.info(f"Simulation tick for user {user_id}: +{added} scénarios")
    return added


def _in_quiet_hours(cfg: dict, now: datetime) -> bool:
    """True si l'heure locale est dans la plage de silence de la volition.

    quiet_hours = {start: 23, end: 7} signifie : on ne propose rien entre 23h
    et 7h. On reste en UTC pour simplicité (la conscience n'a pas de timezone
    utilisateur) — c'est une approximation volontairement grossière.
    """
    qh = (cfg.get("volition", {}) or {}).get("quiet_hours", {}) or {}
    start = qh.get("start")
    end = qh.get("end")
    if start is None or end is None:
        return False
    try:
        start = int(start); end = int(end)
    except (TypeError, ValueError):
        return False
    h = now.hour
    if start == end:
        return False
    if start < end:
        return start <= h < end
    # Fenêtre qui traverse minuit (ex: 23 → 7)
    return h >= start or h < end


def _build_impulse_prompt(engine, top_need: str, top_data: dict) -> tuple[str, str]:
    """Prompt LLM pour générer UNE proposition d'action concrète pour un besoin."""
    state = engine.state or {}
    mood = state.get("mood", "neutre")
    recent_thoughts = engine.get_recent_thoughts(5) if hasattr(engine, "get_recent_thoughts") else []
    wm = engine.get_working_memory() if hasattr(engine, "get_working_memory") else []
    history = (state.get("volition", {}) or {}).get("impulse_history", [])[-5:]
    score_summary = engine.get_score_summary() if hasattr(engine, "get_score_summary") else {}

    thoughts_block = "\n".join(
        f"- [{t.get('type','obs')}] {str(t.get('content',''))[:180]}"
        for t in recent_thoughts
    ) or "(aucune)"

    wm_block = "\n".join(
        f"- {i.get('key')}: {str(i.get('value'))[:180]}"
        for i in wm[:5]
    ) or "(vide)"

    history_block = "\n".join(
        f"- [{h.get('need')}/{h.get('status')}] {str(h.get('action',''))[:160]}"
        for h in history
    ) or "(aucune impulsion récente)"

    scores_txt = ""
    if int(score_summary.get("count") or 0) > 0:
        scores_txt = (
            f"Retour utilisateur : moyenne {float(score_summary.get('average') or 0):.2f}, "
            f"tendance {score_summary.get('trend','stable')}"
        )

    triggers = ", ".join(top_data.get("triggers", [])) or "(aucun)"

    system = (
        "Tu es le module de volition d'un assistant nommé Gungnir. Ton rôle : "
        "transformer un besoin non satisfait en UNE action concrète, utile, "
        "proposée à l'utilisateur — pas une introspection vague. "
        "L'action doit être actionnable en une phrase, adaptée au contexte. "
        "Ne propose jamais quelque chose qui vient d'être refusé ou déjà tenté "
        "dans l'historique ci-dessous. Réponds en JSON strict."
    )

    user = (
        f"Besoin le plus urgent : **{top_need}** (urgence {top_data.get('urgency', 0):.2f}, "
        f"priorité {top_data.get('priority', 0)})\n"
        f"Triggers associés : {triggers}\n"
        f"Humeur actuelle : {mood}\n"
        f"{scores_txt}\n\n"
        f"## Pensées récentes\n{thoughts_block}\n\n"
        f"## Mémoire de travail\n{wm_block}\n\n"
        f"## Historique d'impulsions récentes (à ne pas répéter)\n{history_block}\n\n"
        "Propose UNE action pour ce besoin, sous la forme JSON suivante, "
        "sans texte autour, sans markdown :\n"
        '{"action": "phrase d\'action courte et concrète", '
        '"rationale": "pourquoi cette action maintenant, 1 phrase"}'
    )
    return system, user


def _parse_impulse_action(raw: str) -> Optional[dict]:
    """Parse la réponse LLM en {action, rationale}. None si invalide."""
    if not raw:
        return None
    s = raw.strip()
    # Tolère les fences markdown
    if s.startswith("```"):
        lines = s.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        s = "\n".join(lines).strip()
    # Coupe un éventuel préambule avant la première {
    start = s.find("{")
    end = s.rfind("}")
    if start < 0 or end < 0:
        return None
    try:
        data = json.loads(s[start:end + 1])
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    action = str(data.get("action") or "").strip()
    if not action:
        return None
    return {
        "action": action[:400],
        "rationale": str(data.get("rationale") or "").strip()[:400],
    }


async def _impulse_for_user(user_id: int, force: bool = False) -> int:
    """Propose auto une impulsion si le top need dépasse impulse_threshold.

    Returns 1 si une impulsion a été proposée, 0 sinon. Respecte quiet_hours,
    le quota horaire, l'interval entre checks, et le cooldown no-key.
    """
    from backend.plugins.consciousness.engine import consciousness_manager
    from backend.core.services.llm_invoker import invoke_llm_for_user

    engine = consciousness_manager.get(user_id)
    if not engine.enabled:
        return 0

    vol_cfg = (engine.config or {}).get("volition", {}) or {}
    auto_cfg = vol_cfg.get("auto_impulses", {}) or {}
    if not auto_cfg.get("enabled", False) and not force:
        return 0

    # Déjà une impulsion pending — on ne spamme pas.
    if (engine.state.get("volition") or {}).get("pending_impulse"):
        return 0

    now = _now()
    if not force:
        # Respect quiet hours
        if _in_quiet_hours(engine.config or {}, now):
            return 0

        # Interval entre deux tentatives (le LLM coûte, inutile d'appeler
        # toutes les 60s juste pour vérifier le seuil).
        check_interval = int(auto_cfg.get("check_interval_minutes", DEFAULT_IMPULSE_CHECK_INTERVAL_MINUTES))
        last_check = _parse_iso((engine.state or {}).get("last_impulse_check"))
        if last_check is not None:
            elapsed = (now - last_check).total_seconds() / 60
            if elapsed < check_interval:
                return 0

        # Cooldown no-key partagé
        cooldown_until = _parse_iso((engine.state or {}).get("background_think_cooldown_until"))
        if cooldown_until and now < cooldown_until:
            return 0

    # Check seuil
    top = engine.get_top_need()
    if not top:
        return 0
    top_name, top_data = top
    threshold = float(vol_cfg.get("impulse_threshold", 0.6))
    if float(top_data.get("urgency", 0)) < threshold:
        # Pas au-dessus du seuil — on mémorise la tentative pour respecter
        # l'intervalle sans pour autant bloquer une vraie proposition future.
        engine.state["last_impulse_check"] = now.isoformat()
        try:
            engine.save_state()
        except Exception:
            pass
        return 0

    # Respect quota horaire : compter les impulsions proposées dans la
    # dernière heure (pending_impulse actuel déjà bloqué plus haut + history).
    max_per_hour = int(vol_cfg.get("max_impulses_per_hour", 3))
    history = (engine.state.get("volition") or {}).get("impulse_history", [])
    cutoff = now - timedelta(hours=1)
    recent_count = 0
    for h in history[-20:]:
        try:
            ts = datetime.fromisoformat((h.get("timestamp") or "").replace("Z", "+00:00"))
            if ts >= cutoff:
                recent_count += 1
        except Exception:
            continue
    if recent_count >= max_per_hour:
        engine.state["last_impulse_check"] = now.isoformat()
        try:
            engine.save_state()
        except Exception:
            pass
        return 0

    # OK : on appelle le LLM
    system_prompt, user_prompt = _build_impulse_prompt(engine, top_name, top_data)
    logger.info(f"Impulse tick for user {user_id} (need={top_name}, urgency={top_data.get('urgency', 0):.2f})")
    result = await invoke_llm_for_user(user_id, user_prompt, system_prompt=system_prompt)

    # Fallback no-key
    if not result.get("ok") and _is_no_key_error(result.get("error") or ""):
        from backend.plugins.consciousness.challenger_llm import pick_fallback_llm
        fb_provider, fb_model = await pick_fallback_llm(user_id)
        if fb_provider:
            result = await invoke_llm_for_user(
                user_id, user_prompt, system_prompt=system_prompt,
                provider=fb_provider, model=fb_model,
            )

    engine.state["last_impulse_check"] = now.isoformat()

    if not result.get("ok"):
        err = result.get("error") or ""
        if _is_no_key_error(err) and not force:
            until = now + timedelta(minutes=NO_KEY_COOLDOWN_MINUTES)
            engine.state["background_think_cooldown_until"] = until.isoformat()
        try:
            engine.save_state()
        except Exception:
            pass
        logger.warning(f"Impulse generation failed for user {user_id}: {err}")
        return 0

    parsed = _parse_impulse_action(result.get("content") or "")
    if not parsed:
        logger.warning(f"Impulse parse empty for user {user_id} (raw: {(result.get('content') or '')[:200]!r})")
        try:
            engine.save_state()
        except Exception:
            pass
        return 0

    try:
        engine.propose_impulse(
            need=top_name,
            action=parsed["action"],
            urgency=float(top_data.get("urgency", 0)),
        )
        # Stats : propose_impulse ne les incrémentait pas — on le fait ici.
        stats = engine.state.get("stats", {})
        stats["impulses_proposed"] = stats.get("impulses_proposed", 0) + 1
        engine.save_state()
    except Exception as e:
        logger.exception(f"propose_impulse failed for user {user_id}: {e}")
        return 0

    logger.info(f"Impulse proposed for user {user_id}: [{top_name}] {parsed['action'][:80]}")
    return 1


def _build_consolidation_prompt(engine, items: list) -> tuple[str, str]:
    """Prompt LLM : résumé cohérent de working memory + pensées + scores."""
    recent_thoughts = engine.get_recent_thoughts(8) if hasattr(engine, "get_recent_thoughts") else []
    score_summary = engine.get_score_summary() if hasattr(engine, "get_score_summary") else {}
    state = engine.state or {}
    mood = state.get("mood", "neutre")

    items_block = "\n".join(
        f"- [{i.get('category', 'context')}] {i.get('key', '')} : {str(i.get('value',''))[:240]}"
        for i in items
    ) or "(vide)"

    thoughts_block = "\n".join(
        f"- [{t.get('type','obs')}] {str(t.get('content',''))[:200]}"
        for t in recent_thoughts
    ) or "(aucune)"

    scores_txt = "(aucun retour encore)"
    if int(score_summary.get("count") or 0) > 0:
        scores_txt = (
            f"moyenne {float(score_summary.get('average') or 0):.2f}, "
            f"tendance {score_summary.get('trend','stable')}"
        )

    system = (
        "Tu es le module de consolidation mémoire de Gungnir. Ton rôle : "
        "prendre les fragments de mémoire de travail + pensées récentes + "
        "signaux de feedback, et produire UN paragraphe cohérent (4-8 phrases) "
        "qui dégage les patterns, insights, conclusions de cette période. "
        "Pas de liste à puces, pas de méta-commentaire, pas de préambule. "
        "Écris au présent, à la première personne (le point de vue de Gungnir)."
    )

    user = (
        f"Humeur : {mood}\n"
        f"Retour utilisateur : {scores_txt}\n\n"
        f"## Mémoire de travail\n{items_block}\n\n"
        f"## Pensées récentes\n{thoughts_block}\n\n"
        "Consolide tout ça en un paragraphe narratif qui capte ce que je "
        "devrais retenir de cette période à long-terme. Concentre-toi sur "
        "ce qui est non-trivial : patterns, tensions, orientations, "
        "décisions implicites. Ignore ce qui est purement contextuel."
    )
    return system, user


async def _consolidate_for_user(user_id: int, force: bool = False) -> bool:
    """Consolide working memory + pensées en une entrée vector long-terme.

    Retourne True si une consolidation a été effectivement stockée.
    Respecte l'intervalle (défaut 12h), le cooldown no-key, et la
    disponibilité de la vector memory (pas de fallback local — le but
    est justement le long terme).
    """
    from backend.plugins.consciousness.engine import consciousness_manager
    from backend.core.services.llm_invoker import invoke_llm_for_user

    engine = consciousness_manager.get(user_id)
    if not engine.enabled:
        return False

    wm_cfg = (engine.config or {}).get("working_memory", {}) or {}
    cons_cfg = wm_cfg.get("consolidation", {}) or {}
    if not cons_cfg.get("enabled", True):
        return False

    # Vector memory obligatoire — sinon on écrirait dans le vide.
    try:
        await engine.ensure_vector_ready()
    except Exception as e:
        logger.debug(f"Consolidation: vector memory not ready for user {user_id}: {e}")
        return False
    if not getattr(engine, "vector_memory", None):
        return False

    now = _now()
    if not force:
        interval_hours = float(cons_cfg.get("interval_hours", DEFAULT_CONSOLIDATION_INTERVAL_HOURS))
        last_cons = _parse_iso((engine.state or {}).get("last_consolidation"))
        if last_cons is not None:
            elapsed_h = (now - last_cons).total_seconds() / 3600
            if elapsed_h < interval_hours:
                return False

        # Cooldown no-key partagé
        cooldown_until = _parse_iso((engine.state or {}).get("background_think_cooldown_until"))
        if cooldown_until and now < cooldown_until:
            return False

    # get_working_memory filtre le TTL mais ne persiste pas — on le fait ici
    # pour garder le disque propre et éviter que les items expirés ré-apparaissent.
    items = engine.get_working_memory()
    min_items = int(cons_cfg.get("min_items", 3))
    if len(items) < min_items:
        # Pas assez de matière, on reporte à la prochaine fois — mais on
        # persiste le timestamp pour éviter de re-tenter à chaque tick.
        if force:
            logger.info(f"Consolidation forced for user {user_id} but only {len(items)} items (min {min_items})")
        return False
    try:
        engine.save_all()
    except Exception:
        pass

    system_prompt, user_prompt = _build_consolidation_prompt(engine, items)

    logger.info(f"Consolidation tick for user {user_id} ({len(items)} items)")
    result = await invoke_llm_for_user(user_id, user_prompt, system_prompt=system_prompt)

    if not result.get("ok") and _is_no_key_error(result.get("error") or ""):
        from backend.plugins.consciousness.challenger_llm import pick_fallback_llm
        fb_provider, fb_model = await pick_fallback_llm(user_id)
        if fb_provider:
            result = await invoke_llm_for_user(
                user_id, user_prompt, system_prompt=system_prompt,
                provider=fb_provider, model=fb_model,
            )

    if not result.get("ok"):
        err = result.get("error") or ""
        if _is_no_key_error(err) and not force:
            until = now + timedelta(minutes=NO_KEY_COOLDOWN_MINUTES)
            engine.state["background_think_cooldown_until"] = until.isoformat()
            try:
                engine.save_state()
            except Exception:
                pass
        logger.warning(f"Consolidation failed for user {user_id}: {err}")
        return False

    content = (result.get("content") or "").strip()
    if not content:
        logger.warning(f"Consolidation empty for user {user_id}")
        return False

    # Stockage en vector memory avec catégorie 'consolidation' pour pouvoir
    # requêter spécifiquement la trace long-terme plus tard.
    memory_id = f"consolidation_{now.strftime('%Y%m%d%H%M%S')}"
    try:
        ok = await engine.vector_memory.store_memory(
            memory_id=memory_id,
            content=content,
            category="consolidation",
            key=f"consolidation_{now.strftime('%Y-%m-%d')}",
        )
    except Exception as e:
        logger.exception(f"Consolidation vector store failed for user {user_id}: {e}")
        return False

    if not ok:
        logger.warning(f"Consolidation vector store returned False for user {user_id}")
        return False

    engine.state["last_consolidation"] = now.isoformat()
    # Compteur stats pour l'UI
    stats = engine.state.get("stats", {})
    stats["consolidations"] = stats.get("consolidations", 0) + 1
    try:
        engine.save_state()
    except Exception:
        pass

    logger.info(f"Consolidation stored for user {user_id} (id={memory_id})")
    return True


def _apply_score_conditioning(user_id: int) -> None:
    """Applique mood auto + pression volition depuis les scores du user.

    Les deux sont locaux (pas de LLM), donc on les tourne à chaque tick sans
    gate no-key. Log seulement en cas de changement effectif.
    """
    from backend.plugins.consciousness.engine import consciousness_manager

    engine = consciousness_manager.get(user_id)
    if not engine.enabled:
        return

    new_mood = engine.update_mood_from_scores()
    if new_mood:
        logger.info(f"Mood updated for user {user_id} → {new_mood}")

    pressed = engine.apply_score_pressure_to_volition()
    if pressed:
        logger.info(f"Score pressure applied on need '{pressed}' for user {user_id}")

    # Décroissance naturelle : rééquilibre les bumps (pressure, triggers,
    # résidus d'impulses) pour que les urgences redescendent sans intervention.
    engine.apply_natural_decay()


async def _tick_once():
    """Scan all users with consciousness directories and run their think pass."""
    if not CONSCIOUSNESS_USERS_DIR.exists():
        return

    for user_dir in CONSCIOUSNESS_USERS_DIR.iterdir():
        if not user_dir.is_dir():
            continue
        try:
            user_id = int(user_dir.name)
        except ValueError:
            continue

        # Quick pre-check from config file to avoid instantiating engines
        # for users who have conscience disabled.
        think_on = False
        challenger_on = False
        simulation_on = False
        impulse_on = False
        consolidation_on = False
        config_file = user_dir / "config.json"
        if config_file.exists():
            try:
                cfg = json.loads(config_file.read_text(encoding="utf-8"))
                if not cfg.get("enabled"):
                    continue
                think_on = bool(cfg.get("background_think", {}).get("enabled"))
                ch = cfg.get("challenger", {}) or {}
                challenger_on = bool(ch.get("enabled") and (ch.get("auto_audit") or {}).get("enabled"))
                simulation_on = bool((cfg.get("simulation", {}) or {}).get("enabled"))
                vol = cfg.get("volition", {}) or {}
                impulse_on = bool((vol.get("auto_impulses") or {}).get("enabled"))
                wm = cfg.get("working_memory", {}) or {}
                consolidation_on = bool((wm.get("consolidation") or {}).get("enabled", True))
            except Exception:
                continue

        if think_on:
            try:
                await _think_for_user(user_id)
            except Exception as e:
                logger.exception(f"Think pass crashed for user {user_id}: {e}")

        if challenger_on:
            try:
                await _challenger_for_user(user_id)
            except Exception as e:
                logger.exception(f"Challenger pass crashed for user {user_id}: {e}")

        if simulation_on:
            try:
                await _simulate_for_user(user_id)
            except Exception as e:
                logger.exception(f"Simulation pass crashed for user {user_id}: {e}")

        if impulse_on:
            try:
                await _impulse_for_user(user_id)
            except Exception as e:
                logger.exception(f"Impulse pass crashed for user {user_id}: {e}")

        if consolidation_on:
            try:
                await _consolidate_for_user(user_id)
            except Exception as e:
                logger.exception(f"Consolidation pass crashed for user {user_id}: {e}")

        # Conditionnement local (mood + volition) depuis les scores 👍/👎.
        # Aucun appel LLM, donc pas de gate no-key : on tourne toujours si
        # la conscience est activée (même sans provider configuré).
        try:
            _apply_score_conditioning(user_id)
        except Exception as e:
            logger.exception(f"Score conditioning crashed for user {user_id}: {e}")


async def _consciousness_loop():
    logger.info(f"Consciousness background-think daemon started (tick every {TICK_INTERVAL_SECONDS}s)")
    while True:
        try:
            await asyncio.sleep(TICK_INTERVAL_SECONDS)
            await _tick_once()
        except asyncio.CancelledError:
            logger.info("Consciousness daemon cancelled")
            raise
        except Exception as e:
            logger.exception(f"Consciousness daemon tick failed: {e}")
            await asyncio.sleep(5)


async def _warm_vector_memories() -> None:
    """On boot, pre-instantiate every enabled user's engine so the fire-and-
    forget vector auto-init runs before the user's first page request.

    Without this, a hard refresh made right after a backend restart would land
    on a cold engine where _vector_memory is None until the first tick (up to
    60s later) or until the user clicks "Initialiser" again.
    """
    if not CONSCIOUSNESS_USERS_DIR.exists():
        return
    from backend.plugins.consciousness.engine import consciousness_manager
    for user_dir in CONSCIOUSNESS_USERS_DIR.iterdir():
        if not user_dir.is_dir():
            continue
        try:
            user_id = int(user_dir.name)
        except ValueError:
            continue
        config_file = user_dir / "config.json"
        if not config_file.exists():
            continue
        try:
            cfg = json.loads(config_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not cfg.get("enabled"):
            continue
        # Creating the engine schedules the vector autoinit in the background.
        try:
            consciousness_manager.get(user_id)
        except Exception as e:
            logger.warning(f"Warmup failed for user {user_id}: {e}")


async def on_startup(app: Any = None):
    global _daemon_task
    if _daemon_task and not _daemon_task.done():
        return
    _daemon_task = asyncio.create_task(_consciousness_loop())
    # Warm enabled users so Qdrant reconnects itself after a redeploy.
    asyncio.create_task(_warm_vector_memories())


async def on_shutdown(*args, **kwargs):
    global _daemon_task
    if _daemon_task:
        _daemon_task.cancel()
        try:
            await _daemon_task
        except (asyncio.CancelledError, Exception):
            pass
        _daemon_task = None
    # Final flush so no in-memory mutation is lost on clean shutdown.
    try:
        from backend.plugins.consciousness.engine import consciousness_manager
        n = await consciousness_manager.flush_all()
        logger.info(f"Consciousness shutdown: flushed {n} instance(s)")
    except Exception as e:
        logger.exception(f"Consciousness shutdown flush failed: {e}")
