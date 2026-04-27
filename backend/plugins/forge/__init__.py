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
from . import models  # noqa: F401  — enregistre les tables dans Base.metadata
