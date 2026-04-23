"""
Bus d'events pour les triggers de besoins (Volition Pyramid).

Les 5 besoins de la conscience (survival, integrity, progression,
comprehension, curiosity) déclarent chacun une liste de `triggers`
(backup_failed, promise_unkept, open_question, idle_heartbeat, …) qui
étaient jusque-là purement déclaratifs — aucun émetteur ne les publiait.

Ce module câble les émetteurs réels : chaque plugin (Valkyrie, backup
daemon, chat, etc.) peut appeler `emit_trigger(user_id, "promise_unkept",
...)` et le besoin correspondant voit son urgence grimper.

Design :
- **Zéro dep** : s'inscrit proprement dans l'architecture existante.
- **Idempotent** : chaque trigger-key a un cooldown (évite le spam si un
  émetteur tape 10× de suite la même info).
- **Best-effort** : une erreur d'émission ne doit jamais casser l'émetteur
  (la conscience est un bonus, pas un chemin critique).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("gungnir.consciousness.triggers")

# Cooldown par défaut entre deux émissions de la MÊME trigger-key, pour un
# user donné. Évite qu'un event qui se répète (cron, health-check) ne sature
# l'urgence d'un besoin à 1.0 en quelques ticks.
DEFAULT_TRIGGER_COOLDOWN_SECONDS = 3600  # 1h


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_trigger_map(config: dict) -> dict[str, str]:
    """Inverse la config `volition.needs` pour obtenir {trigger → need}."""
    needs = (config.get("volition", {}) or {}).get("needs", {}) or {}
    out: dict[str, str] = {}
    for need_name, cfg in needs.items():
        for trigger in (cfg.get("triggers") or []):
            out[str(trigger)] = need_name
    return out


async def emit_trigger(
    user_id: int,
    trigger: str,
    *,
    entity_id: Optional[str] = None,
    cooldown_seconds: int = DEFAULT_TRIGGER_COOLDOWN_SECONDS,
) -> bool:
    """Pousse un trigger sur le besoin associé pour un user.

    Args:
        user_id: destinataire (conscience propriétaire).
        trigger: nom du trigger tel que déclaré dans `volition.needs.<X>.triggers`.
        entity_id: identifiant optionnel de l'entité concernée. Utile quand
            on émet un trigger récurrent "par objet" (ex: `promise_unkept`
            pour la carte Valkyrie #42 → cooldown séparé par carte). Sinon,
            le cooldown est global au trigger pour ce user.
        cooldown_seconds: durée minimale entre deux émissions de la même
            (trigger, entity_id) pour éviter le spam. Défaut 1h.

    Returns:
        True si l'émission a effectivement bumpé le besoin, False sinon
        (cooldown actif, besoin inconnu, conscience désactivée, etc.).
    """
    if not user_id or not trigger:
        return False

    try:
        from backend.plugins.consciousness.engine import consciousness_manager
    except Exception:
        return False

    try:
        engine = consciousness_manager.get(int(user_id))
    except Exception as e:
        logger.debug(f"Trigger emit: engine lookup failed uid={user_id}: {e}")
        return False

    if not engine.enabled:
        return False

    trigger_map = _build_trigger_map(engine.config or {})
    need_name = trigger_map.get(trigger)
    if not need_name:
        logger.debug(f"Trigger '{trigger}' non reconnu (aucun besoin ne le déclare)")
        return False

    # Cooldown : on stocke {"recent_triggers": {"trigger:entity": "iso_ts"}}
    # dans le state engine. Si l'entry existe et n'est pas expirée, skip.
    state = engine.state
    recent = state.setdefault("recent_triggers", {})
    key = f"{trigger}:{entity_id}" if entity_id else trigger
    last_iso = recent.get(key)
    now = datetime.now(timezone.utc)
    if last_iso:
        try:
            last_dt = datetime.fromisoformat(last_iso.replace("Z", "+00:00"))
            if (now - last_dt).total_seconds() < cooldown_seconds:
                return False
        except Exception:
            pass

    # Nettoie les entrées expirées (TTL = 7j) pour ne pas faire grossir le JSON
    # indéfiniment. Fait ici pour rester lazy — pas de tâche de ménage dédiée.
    try:
        cutoff = (now.timestamp() - 7 * 86400)
        stale: list[str] = []
        for k, v in recent.items():
            try:
                t = datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
                if t < cutoff:
                    stale.append(k)
            except Exception:
                stale.append(k)
        for k in stale:
            recent.pop(k, None)
    except Exception:
        pass

    # Émission effective
    try:
        engine.trigger_need(need_name, trigger)
        recent[key] = _now_iso()
        engine.save_state()
        logger.info(f"Trigger emitted uid={user_id} '{trigger}' → need '{need_name}' (key={key})")
        return True
    except Exception as e:
        logger.warning(f"Trigger emit failed uid={user_id} '{trigger}': {e}")
        return False


def emit_trigger_sync(user_id: int, trigger: str, *, entity_id: Optional[str] = None,
                      cooldown_seconds: int = DEFAULT_TRIGGER_COOLDOWN_SECONDS) -> bool:
    """Variante sync pour les appelants hors event-loop. Retourne toujours
    False sur erreur silencieuse (best-effort). Préfère la version async
    quand possible."""
    import asyncio
    try:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is None or not loop.is_running():
            return asyncio.run(emit_trigger(
                user_id, trigger, entity_id=entity_id, cooldown_seconds=cooldown_seconds
            ))
        # Loop déjà active → on ne peut pas appeler asyncio.run ; on
        # schedule sans attendre le résultat (best-effort).
        asyncio.ensure_future(emit_trigger(
            user_id, trigger, entity_id=entity_id, cooldown_seconds=cooldown_seconds
        ))
        return True
    except Exception as e:
        logger.debug(f"emit_trigger_sync scheduling failed: {e}")
        return False
