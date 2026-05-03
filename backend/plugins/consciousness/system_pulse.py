"""
Gungnir — System Pulse (étape no-LLM du tick conscience).

Daemon léger pour maintenir la conscience v4 active entre messages user, sans
consommer de tokens LLM (rapport user 2026-05-02). Mesure les métriques
système locales (disque, mémoire, load, erreurs récentes) et émet des
triggers conscience qui font monter les urgences correspondantes (besoin
``survival`` notamment). Les boucles LLM existantes (think/challenger/
impulse) gèrent ensuite ce qui mérite une vraie réflexion.

**Pas de nouveau daemon** : on s'accroche à ``_tick_once()`` existant qui
tourne déjà toutes les 60s en background pour TOUS les users. Cette étape
est exécutée AVANT les boucles LLM et est entièrement no-LLM, donc gratuite.

**Pas d'actions destructives autonomes** : on émet des triggers conscience,
on ne touche pas au système. La conscience LLM peut décider de proposer
``bash_exec`` ou demander confirmation au user. C'est volontaire — l'auto-
exécution sans humain dans la boucle est risquée et pas le scope de cette
itération.

**Métriques stockées** dans ``engine._state["system_metrics"]`` pour
visualisation UI dashboard sans avoir à refaire les measurements.

Seuils par défaut (overridables via config.system_pulse.thresholds) :
- disk_warning_pct: 75
- disk_critical_pct: 90
- memory_warning_pct: 80
- memory_critical_pct: 92
- errors_recent_warning: 3
- errors_recent_critical: 10
"""
from __future__ import annotations

import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger("gungnir.consciousness.system_pulse")


_DEFAULT_THRESHOLDS = {
    "disk_warning_pct": 75,
    "disk_critical_pct": 90,
    "memory_warning_pct": 80,
    "memory_critical_pct": 92,
    "errors_recent_warning": 3,
    "errors_recent_critical": 10,
}


def _read_disk_pct(path: str = "/") -> Optional[float]:
    """Lecture stdlib via shutil.disk_usage. Retourne le % utilisé (0-100)
    ou None si erreur (host non-Linux, montage exotique, etc.)."""
    try:
        usage = shutil.disk_usage(path)
        if usage.total <= 0:
            return None
        return round((usage.used / usage.total) * 100.0, 1)
    except Exception as e:
        logger.debug(f"disk_usage failed for {path}: {e}")
        return None


def _read_memory_pct() -> Optional[float]:
    """Parse /proc/meminfo (Linux only). Calcul : (MemTotal - MemAvailable) /
    MemTotal. MemAvailable est plus juste que MemFree car il inclut le cache
    réutilisable. Retourne None hors Linux."""
    meminfo = Path("/proc/meminfo")
    if not meminfo.exists():
        return None
    try:
        data: dict = {}
        for line in meminfo.read_text().splitlines():
            if ":" not in line:
                continue
            key, _, val = line.partition(":")
            tokens = val.strip().split()
            if tokens:
                try:
                    data[key.strip()] = int(tokens[0])  # kB
                except ValueError:
                    pass
        total = data.get("MemTotal", 0)
        available = data.get("MemAvailable", data.get("MemFree", 0))
        if total <= 0:
            return None
        return round(((total - available) / total) * 100.0, 1)
    except Exception as e:
        logger.debug(f"meminfo parse failed: {e}")
        return None


def _read_load_avg() -> Optional[float]:
    """Parse /proc/loadavg (Linux). Retourne le load 1-min."""
    loadavg = Path("/proc/loadavg")
    if not loadavg.exists():
        return None
    try:
        return float(loadavg.read_text().split()[0])
    except Exception as e:
        logger.debug(f"loadavg parse failed: {e}")
        return None


def _read_recent_errors_count() -> int:
    """Compte des erreurs runtime récentes (5 min) via error_watcher déjà
    branché sur le root logger. Cf error_watcher.py."""
    try:
        from backend.plugins.consciousness.error_watcher import recent_error_count
        return int(recent_error_count(window_seconds=300) or 0)
    except Exception:
        return 0


async def system_pulse_for_user(user_id: int) -> dict:
    """Lit les métriques système + émet les triggers conscience selon les
    seuils. Met à jour ``engine._state["system_metrics"]`` pour visu UI.

    Renvoie un snapshot pour les logs/tests :
    ``{"disk_pct": ..., "memory_pct": ..., "load_avg": ..., "errors_recent": ...,
       "triggers_emitted": [...]}``.

    Idempotent : appelable à chaque tick sans effet de bord cumulé (les
    triggers ont leur propre cooldown via ``emit_trigger``).
    """
    from backend.plugins.consciousness.engine import consciousness_manager
    from backend.plugins.consciousness.triggers import emit_trigger

    engine = consciousness_manager.get(user_id)
    if not engine or not engine.enabled:
        return {"skipped": True, "reason": "engine off"}

    cfg = (engine._config.get("system_pulse") or {}) if hasattr(engine, "_config") else {}
    if not cfg.get("enabled", True):
        return {"skipped": True, "reason": "system_pulse off in config"}

    thresholds = {**_DEFAULT_THRESHOLDS, **(cfg.get("thresholds") or {})}

    # Mesures (best-effort — None si non disponible)
    disk_pct = _read_disk_pct("/")
    memory_pct = _read_memory_pct()
    load_avg = _read_load_avg()
    errors_recent = _read_recent_errors_count()

    triggers_emitted: list[str] = []

    # Disk → besoin survival
    if disk_pct is not None:
        if disk_pct >= thresholds["disk_critical_pct"]:
            await emit_trigger(user_id, "disk_low")
            # Double-tap au critique pour forcer une urgence plus forte
            # (chaque trigger bump l'urgence du besoin associé).
            await emit_trigger(user_id, "disk_low")
            triggers_emitted.append("disk_low(critical)")
        elif disk_pct >= thresholds["disk_warning_pct"]:
            await emit_trigger(user_id, "disk_low")
            triggers_emitted.append("disk_low(warning)")

    # Memory → besoin survival (même trigger : le bump de besoin survival
    # est cohérent — saturation RAM = même menace existence-side que disque
    # plein du point de vue de l'agent qui a besoin de tourner).
    if memory_pct is not None:
        if memory_pct >= thresholds["memory_critical_pct"]:
            await emit_trigger(user_id, "disk_low")  # alias survival
            triggers_emitted.append("memory_high(critical)")
        elif memory_pct >= thresholds["memory_warning_pct"]:
            triggers_emitted.append("memory_high(observed)")  # pas de trigger, juste tracking

    # Erreurs récentes → besoin integrity
    if errors_recent >= thresholds["errors_recent_critical"]:
        await emit_trigger(user_id, "error_in_logs")
        await emit_trigger(user_id, "error_in_logs")
        triggers_emitted.append("error_in_logs(critical)")
    elif errors_recent >= thresholds["errors_recent_warning"]:
        await emit_trigger(user_id, "error_in_logs")
        triggers_emitted.append("error_in_logs(warning)")

    # Snapshot dans le state pour UI dashboard et auto-introspection LLM via
    # ``consciousness_status`` (le LLM peut consulter ces données via le tool
    # plutôt que via le <self_state> compact qui reste minimal).
    snapshot = {
        "last_pulse_at": datetime.now(timezone.utc).isoformat(),
        "disk_pct": disk_pct,
        "memory_pct": memory_pct,
        "load_avg": load_avg,
        "errors_recent": errors_recent,
        "thresholds": thresholds,
        "triggers_emitted": triggers_emitted,
    }
    try:
        engine._state["system_metrics"] = snapshot
        engine.save_state()
    except Exception as e:
        logger.debug(f"save system_metrics failed for user {user_id}: {e}")

    if triggers_emitted:
        logger.info(
            f"[system_pulse uid={user_id}] disk={disk_pct}% mem={memory_pct}% "
            f"load={load_avg} err5min={errors_recent} → {triggers_emitted}"
        )
    return snapshot
