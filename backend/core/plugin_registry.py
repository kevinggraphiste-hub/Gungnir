"""
Gungnir — Plugin Registry (hub d'hooks cross-plugin)

Découple les plugins entre eux : au lieu de `from backend.plugins.X import Y`,
un plugin s'enregistre ici et un autre consomme via l'API du registry.

Trois types d'extensions supportés :

1. **conscience_block_providers** : fonctions sync qui reçoivent `user_id` et
   retournent un bloc texte à injecter dans le system prompt de la Conscience
   (ou None). Exemple : Valkyrie injecte ses deadlines overdue/today.

2. **migrations** : collectées au démarrage par `init_db()` (chaque plugin
   expose sa propre liste `MIGRATIONS` — voir `backend/plugins/*/migrations.py`).

3. **agent_tools** : chaque plugin peut exposer `TOOL_SCHEMAS` + `EXECUTORS`
   dans son module `agent_tools.py` — `wolf_tools.py` les agrège au boot.

Pattern : fire-and-forget, le registry ne connaît pas les plugins ; ce sont
les plugins qui s'enregistrent à l'import (side effect au boot).
"""
from __future__ import annotations

import logging
from typing import Callable, Optional

logger = logging.getLogger("gungnir.plugin_registry")


# ── Providers de blocs Conscience ────────────────────────────────────────
# Chaque entrée est une fonction async `fn(user_id: int) -> Optional[str]`.
_conscience_block_providers: list[Callable] = []


def register_conscience_block_provider(fn: Callable) -> Callable:
    """Enregistre une fonction async appelée à chaque tick de la conscience
    pour enrichir son prompt block. La fonction reçoit `user_id` et retourne
    un texte à injecter (ou None pour skip).
    """
    _conscience_block_providers.append(fn)
    logger.info(f"Conscience block provider registered: {fn.__module__}.{fn.__name__}")
    return fn


async def gather_conscience_blocks(user_id: int) -> list[str]:
    """Appelle tous les providers enregistrés et retourne les blocs non-vides.
    Tolère les erreurs — un provider qui throw n'empêche pas les autres.
    """
    out: list[str] = []
    for fn in _conscience_block_providers:
        try:
            import asyncio as _a
            result = fn(user_id)
            if _a.iscoroutine(result):
                result = await result
            if result:
                out.append(str(result))
        except Exception as e:
            logger.debug(f"Conscience block provider failed ({fn.__name__}): {e}")
    return out


# ── Snapshots cachés (pour usages sync comme le prompt block) ─────────────
# Certains contextes (construction de prompt) sont synchrones et ne peuvent
# pas awaiter. On cache les derniers snapshots par user_id, mis à jour par
# la boucle conscience qui elle est async.
_user_snapshots: dict[int, dict] = {}


def set_user_snapshot(user_id: int, key: str, value) -> None:
    """Stocke une valeur dans le snapshot de l'user (lecture sync)."""
    slot = _user_snapshots.setdefault(int(user_id), {})
    slot[key] = value


def get_user_snapshot(user_id: int, key: str, default=None):
    """Lit un snapshot (sync-safe, sans DB)."""
    return (_user_snapshots.get(int(user_id)) or {}).get(key, default)


# ── Plugin capability declarations ────────────────────────────────────────
# Chaque plugin peut s'enregistrer avec un dict de capabilities librement
# structuré (consommé par UI ou par d'autres plugins via lookup).
_plugin_capabilities: dict[str, dict] = {}


def declare_plugin_capabilities(plugin_name: str, capabilities: dict) -> None:
    _plugin_capabilities[plugin_name] = capabilities


def get_plugin_capabilities(plugin_name: str) -> Optional[dict]:
    return _plugin_capabilities.get(plugin_name)


def all_plugin_capabilities() -> dict[str, dict]:
    return dict(_plugin_capabilities)


# ── Consciousness accessor (plugin optionnel) ────────────────────────────
# Le core a besoin de lire/écrire l'état de la conscience à plusieurs
# endroits (chat, heartbeat, bootstrap, backup). Pour éviter un hard-import
# `from backend.plugins.consciousness.engine import consciousness_manager`
# qui casserait si le plugin est désactivé ou absent (ex: plugin tiers qui
# remplace la conscience), on passe par un provider enregistré au load.

_consciousness_provider: Optional[Callable] = None


def register_consciousness_provider(fn: Callable) -> None:
    """fn(user_id: int) -> ConsciousnessEngine | None"""
    global _consciousness_provider
    _consciousness_provider = fn
    logger.info(f"Consciousness provider registered: {fn.__module__}.{fn.__name__}")


def get_consciousness_engine(user_id: int):
    """Retourne l'engine Conscience pour cet user (créé à la demande), ou
    None si la conscience n'est pas chargée. Tolère toute erreur du provider.
    Pour ne pas créer d'instance et interroger uniquement les existants,
    voir `get_existing_consciousness_engine`."""
    if _consciousness_provider is None:
        return None
    try:
        return _consciousness_provider(int(user_id))
    except Exception as e:
        logger.debug(f"get_consciousness_engine failed for uid={user_id}: {e}")
        return None


_consciousness_existing_provider: Optional[Callable] = None


def register_existing_consciousness_provider(fn: Callable) -> None:
    """fn(user_id: int) -> ConsciousnessEngine | None, ne crée pas d'instance
    si elle n'existe pas encore (usage : heartbeat, lectures passives)."""
    global _consciousness_existing_provider
    _consciousness_existing_provider = fn


def get_existing_consciousness_engine(user_id: int):
    """Comme get_consciousness_engine mais sans création implicite."""
    if _consciousness_existing_provider is None:
        return None
    try:
        return _consciousness_existing_provider(int(user_id))
    except Exception:
        return None


def is_consciousness_available() -> bool:
    return _consciousness_provider is not None


_consciousness_evict_provider: Optional[Callable] = None


def register_consciousness_evict_provider(fn: Callable) -> None:
    """fn(user_id: int) -> None, appelé quand un user est supprimé."""
    global _consciousness_evict_provider
    _consciousness_evict_provider = fn


def evict_consciousness(user_id: int) -> None:
    """Libère les ressources conscience liées à un user (sur suppression)."""
    if _consciousness_evict_provider is None:
        return
    try:
        _consciousness_evict_provider(int(user_id))
    except Exception as e:
        logger.debug(f"evict_consciousness failed for uid={user_id}: {e}")
