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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("gungnir.consciousness.daemon")

DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"
CONSCIOUSNESS_USERS_DIR = DATA_DIR / "consciousness" / "users"
TICK_INTERVAL_SECONDS = 60
DEFAULT_THINK_INTERVAL_MINUTES = 10
DEFAULT_CHALLENGER_INTERVAL_MINUTES = 60

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

    system = (
        "Tu es le module de conscience d'un assistant personnel nommé Gungnir. "
        "Ton rôle est de générer une pensée de méta-réflexion en arrière-plan : "
        "une observation, une hypothèse, une question ouverte, ou une synthèse "
        "tirée du contexte récent. Sois bref (1 à 2 phrases maximum), sincère, "
        "sans préambule, sans te répéter par rapport aux pensées récentes."
    )

    user_prompt = (
        f"Humeur actuelle : {mood}\n\n"
        f"## Pensées récentes\n{thoughts_block}\n\n"
        f"## Mémoire de travail\n{memory_block}\n\n"
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

    system_prompt, user_prompt = _build_reflection_prompt(engine)

    logger.info(f"Background think tick for user {user_id}")
    result = await invoke_llm_for_user(user_id, user_prompt, system_prompt=system_prompt)

    if not result.get("ok"):
        logger.warning(f"Background think failed for user {user_id}: {result.get('error')}")
        return

    content = (result.get("content") or "").strip()
    if not content:
        return

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

    if not force:
        interval_minutes = int(auto.get("interval_minutes", DEFAULT_CHALLENGER_INTERVAL_MINUTES))
        last_audit = _parse_iso((engine.state or {}).get("last_challenger"))
        now = _now()
        if last_audit is not None:
            elapsed = (now - last_audit).total_seconds() / 60
            if elapsed < interval_minutes:
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

    if not result.get("ok"):
        logger.warning(f"Challenger audit LLM failed for user {user_id}: {result.get('error')}")
        return 0

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


async def on_startup(app: Any = None):
    global _daemon_task
    if _daemon_task and not _daemon_task.done():
        return
    _daemon_task = asyncio.create_task(_consciousness_loop())


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
