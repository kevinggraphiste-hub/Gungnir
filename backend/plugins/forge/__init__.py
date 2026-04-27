"""
Forge — orchestrateur de workflows visuels Gungnir.

Plugin indépendant qui permet de définir des workflows en YAML, les exécuter
via un DAG runner, et les piloter depuis un éditeur visuel (Phase 3).

Convention plugin Gungnir : `from . import models` au niveau package pour
que `create_all(Base.metadata)` picke `forge_workflows` + `forge_workflow_runs`
au boot.

Retrait propre : supprimer ce répertoire ET le dossier frontend associé,
puis DROP TABLE IF EXISTS sur les 2 tables préfixées `forge_`.
"""
from typing import Any
from . import models  # noqa: F401  — enregistre les tables dans Base.metadata


async def on_startup(app: Any = None):
    """Démarre le worker cron en background à l'init du backend.

    Idempotent : safe d'être appelé plusieurs fois (start_cron_worker
    check `_started`). Pas de teardown explicite — le task meurt avec
    le processus, ce qui est ok puisqu'on n'a pas de ressource externe
    à libérer (juste asyncio.sleep + DB sessions auto-fermées).
    """
    try:
        from .cron_worker import start_cron_worker
        start_cron_worker()
    except Exception as e:
        import logging
        logging.getLogger("gungnir.plugins.forge").warning(
            f"Forge cron worker non démarré : {e}"
        )
