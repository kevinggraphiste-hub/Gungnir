"""
LspPool — cache des LspRunner per-user × per-language × per-workspace.

Stratégie :
- clé = (user_id, language, workspace_path) → 1 LspRunner
- get_or_start() : crée et démarre à la 1re demande, réutilise sinon
- idle cleanup : tâche de fond scanne toutes les N minutes, tue les runners
  sans activité depuis IDLE_TIMEOUT_S

Ce pool vit au niveau processus. En déploiement multi-worker il y aurait une
instance par worker ; c'est acceptable (chaque worker pilote ses propres
runners). La DB/filesystem reste la source de vérité pour les workspaces.
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from backend.plugins.code.lsp.runner import LspRunner, LSP_COMMANDS

logger = logging.getLogger("gungnir.plugins.code.lsp.pool")

# Un LSP inactif depuis plus de 10 min est arrêté pour libérer la RAM.
# Un process rust-analyzer / pyright peut occuper 100-300 Mo chacun, donc on
# ne veut pas les laisser tourner indéfiniment.
IDLE_TIMEOUT_S = 600
SCAN_INTERVAL_S = 120


class LspPool:
    def __init__(self):
        self._runners: dict[tuple[int, str, str], LspRunner] = {}
        self._lock = asyncio.Lock()
        self._cleaner_task: asyncio.Task | None = None

    def _key(self, user_id: int, language: str, workspace: Path) -> tuple[int, str, str]:
        return (int(user_id), language, str(workspace.resolve()))

    async def get_or_start(
        self, *, user_id: int, language: str, workspace: Path,
    ) -> LspRunner:
        """Retourne un LspRunner démarré pour cette combinaison. Spawn si besoin.

        Lève RuntimeError si le langage n'est pas dans LSP_COMMANDS, ou si
        la commande LSP n'est pas installée dans l'image Docker.
        """
        if language not in LSP_COMMANDS:
            raise RuntimeError(
                f"Langage '{language}' non supporté par le LSP "
                f"(supportés : {sorted(LSP_COMMANDS.keys())})."
            )
        key = self._key(user_id, language, workspace)
        async with self._lock:
            runner = self._runners.get(key)
            if runner is not None and runner.is_running:
                runner.last_activity = time.time()
                return runner
            runner = LspRunner(
                language=language, workspace=workspace, user_id=user_id,
            )
            await runner.start()
            self._runners[key] = runner
            self._ensure_cleaner()
            return runner

    async def stop(self, *, user_id: int, language: str, workspace: Path) -> bool:
        """Stop et retire un runner du pool."""
        key = self._key(user_id, language, workspace)
        async with self._lock:
            runner = self._runners.pop(key, None)
        if runner is None:
            return False
        await runner.stop()
        return True

    async def stop_all_for_user(self, user_id: int) -> int:
        """Stop tous les runners d'un user. Utilisé à la déconnexion ou au
        logout pour libérer la RAM immédiatement."""
        to_stop: list[LspRunner] = []
        async with self._lock:
            for k in list(self._runners.keys()):
                if k[0] == int(user_id):
                    to_stop.append(self._runners.pop(k))
        for r in to_stop:
            await r.stop()
        return len(to_stop)

    def _ensure_cleaner(self):
        if self._cleaner_task is None or self._cleaner_task.done():
            self._cleaner_task = asyncio.create_task(self._idle_cleanup_loop())

    async def _idle_cleanup_loop(self) -> None:
        """Toutes les SCAN_INTERVAL_S, tue les runners sans activité depuis
        IDLE_TIMEOUT_S. S'arrête quand le pool est vide (se relancera à la
        prochaine allocation via _ensure_cleaner)."""
        while True:
            try:
                await asyncio.sleep(SCAN_INTERVAL_S)
                now = time.time()
                to_kill: list[tuple] = []
                async with self._lock:
                    for key, runner in list(self._runners.items()):
                        if not runner.is_running:
                            to_kill.append((key, runner))
                        elif now - runner.last_activity > IDLE_TIMEOUT_S:
                            to_kill.append((key, runner))
                    for key, _ in to_kill:
                        self._runners.pop(key, None)
                    empty = not self._runners
                for key, runner in to_kill:
                    try:
                        await runner.stop()
                        logger.info(
                            f"LSP idle-killed uid={key[0]} lang={key[1]} ws={key[2]}"
                        )
                    except Exception as e:
                        logger.warning(f"LSP idle-stop failed {key}: {e}")
                if empty:
                    # Plus rien à surveiller, on sort ; sera relancé au
                    # prochain get_or_start() via _ensure_cleaner.
                    return
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.warning(f"LSP idle cleaner loop error: {e}")


# Singleton au niveau module — partagé par tous les endpoints WS.
lsp_pool = LspPool()
