"""
Valkyrie — plugin Gungnir de suivi de tâches multi-projets.

Import des modèles au niveau du package pour que `create_all(Base.metadata)`
dans `init_db` pick les tables au boot du backend. Les tables
`valkyrie_projects`, `valkyrie_statuses` et `valkyrie_cards` sont créées
automatiquement au premier démarrage après l'installation du plugin.

Retrait propre : supprimer ce répertoire ET le dossier frontend associé,
puis DROP TABLE IF EXISTS sur les 3 tables préfixées `valkyrie_`.
"""
from . import models  # noqa: F401  — enregistre les tables dans Base.metadata
