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
        f"## Pensées récentes\n{thoughts_block}\n\n"
        f"## Mémoire de travail\n{memory_block}\n\n"
        f"## Alertes Challenger récentes (à éviter de reproduire)\n{findings_block}\n\n"
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
        config_file = user_dir / "config.json"
        if config_file.exists():
            try:
                cfg = json.loads(config_file.read_text(encoding="utf-8"))
                if not cfg.get("enabled"):
                    continue
                think_on = bool(cfg.get("background_think", {}).get("enabled"))
                ch = cfg.get("challenger", {}) or {}
                challenger_on = bool(ch.get("enabled") and (ch.get("auto_audit") or {}).get("enabled"))
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
