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


# ── Enregistrement auprès du plugin_registry (cross-plugin hooks) ────────
# On enregistre ici un "conscience block provider" : à chaque tick de la
# conscience, elle appelle notre fonction pour savoir s'il y a des rappels
# deadlines à mentionner. L'import se fait en lazy pour éviter tout couple
# dur au boot si le core est lancé sans conscience.
try:
    from backend.core.plugin_registry import (
        register_conscience_block_provider,
        set_user_snapshot,
    )
    from .reminders_probe import _probe_reminders_async

    async def _valkyrie_conscience_block(user_id: int):
        """Met à jour le snapshot reminders et retourne un bloc prompt si
        overdue/today détecté. La conscience est appelée async, pas de souci
        pour awaiter ici."""
        rem = await _probe_reminders_async(user_id)
        if not rem:
            return None
        # Cache synchrone pour lectures futures hors event-loop
        set_user_snapshot(user_id, "valkyrie_reminders", rem)
        over = rem.get("overdue", [])
        tod = rem.get("today", [])
        if not over and not tod:
            return None
        lines: list[str] = []
        for r in over[:3]:
            lines.append(
                f"  - ⚠️ {r['title']} (retard {abs(r['days_diff'])}j, "
                f"projet: {r['project_title']})"
            )
        for r in tod[:3]:
            lines.append(
                f"  - 📌 {r['title']} (aujourd'hui, projet: {r['project_title']})"
            )
        return (
            "\n**Deadlines Valkyrie à rappeler** (mentionne-les spontanément "
            "si pertinent — pas de formule creuse, juste un nudge utile) :\n"
            + "\n".join(lines)
        )

    register_conscience_block_provider(_valkyrie_conscience_block)
except Exception:
    # Registry ou sonde indispo → fallback silencieux.
    # L'ancienne voie (import direct dans engine.py) a été supprimée.
    pass
