"""
Valkyrie — modèles DB.

Les Walkyries choisissent qui va où. Ce plugin choisit quelle tâche va
dans quel statut — tableau de suivi multi-projets, 100% per-user.

Tables isolées (préfixées `valkyrie_`) pour qu'un futur retrait du plugin
soit propre : il suffit de DROP TABLE IF EXISTS sur les 3 tables et le
plugin disparaît sans résidu.
"""
from __future__ import annotations

from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, Boolean,
    ForeignKey, JSON, func,
)

# On réutilise la Base du core pour que `init_db` + `create_all`
# picke les tables automatiquement au prochain boot.
from backend.core.db.models import Base


class ValkyrieProject(Base):
    """Un projet = un tableau de tâches. Plusieurs projets par user."""
    __tablename__ = "valkyrie_projects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(200), nullable=False, default="Nouveau projet")
    description = Column(Text, default="")
    archived = Column(Boolean, default=False)
    position = Column(Integer, default=0)  # ordre dans la liste user
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())
    updated_at = Column(DateTime, default=datetime.utcnow, server_default=func.now(),
                         onupdate=datetime.utcnow)


class ValkyrieStatus(Base):
    """Statut de carte : built-in (todo/doing/done) ou personnalisé par user.

    Les built-in ne sont pas en DB — ils sont renvoyés par l'API en
    complément des custom. Cette table ne stocke QUE les statuts custom
    créés par l'user (ex: "en pause", "à valider", "bloqué").

    `project_id` nullable : un statut custom peut être global à l'user
    (partagé entre tous ses projets) si NULL, sinon scoped au projet.
    Pour la v1 on part sur global uniquement (project_id toujours NULL).
    """
    __tablename__ = "valkyrie_statuses"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    project_id = Column(Integer, ForeignKey("valkyrie_projects.id", ondelete="CASCADE"),
                         nullable=True)
    # Identifiant stable utilisé comme clé étrangère logique dans les cards
    # (on évite l'ID numérique pour permettre aux built-in et aux custom de
    # cohabiter dans le même champ `status_key`).
    key = Column(String(60), nullable=False)
    label = Column(String(60), nullable=False)
    color = Column(String(20), nullable=False, default="#7a8a9b")
    position = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())


class ValkyrieCard(Base):
    """Carte de tâche dans un projet. Subtasks stockées en JSON inline pour
    éviter une 4e table (accès toujours couplé card↔subtasks)."""
    __tablename__ = "valkyrie_cards"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("valkyrie_projects.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(300), nullable=False, default="")
    subtitle = Column(String(300), default="")  # ligne d'accroche sous le titre
    description = Column(Text, default="")
    status_key = Column(String(60), nullable=False, default="todo")
    position = Column(Integer, default=0)  # rang dans la grille
    expanded = Column(Boolean, default=False)
    # Deadline optionnelle (date pure — pas d'heure pour éviter les fuseaux).
    due_date = Column(DateTime, nullable=True)
    # Archive logique : quand != NULL, la carte n'apparaît plus sur le board
    # par défaut. On garde la ligne en DB pour ne rien perdre.
    archived_at = Column(DateTime, nullable=True)
    # D'où vient la carte (manuel, conscience:goal:<id>, template, etc.).
    # Permet de dédupliquer les imports Conscience et d'afficher un badge.
    origin = Column(String(80), default="")
    # Règle de récurrence optionnelle. Format simple :
    #   ""                       → pas de récurrence
    #   "daily"                  → chaque jour
    #   "weekly"                 → chaque semaine (même jour que due_date)
    #   "weekly:1,3,5"           → lundi/mercredi/vendredi (1=lun, 7=dim)
    #   "monthly"                → chaque mois (même jour de mois)
    # Quand la carte est marquée "done", on crée automatiquement la
    # prochaine occurrence avec la due_date suivante, puis on archive l'instance
    # complétée pour garder l'historique.
    recurrence_rule = Column(String(40), default="")
    # Deux listes de sous-tâches côte à côte (ex: "livrables" + "preuves").
    # Format commun : [{id, label, done}]
    subtasks_json = Column(JSON, default=list)
    subtasks2_title = Column(String(60), default="")  # header éditable de la 2e liste
    subtasks2_json = Column(JSON, default=list)
    # Tags libres : liste de strings (couleur dérivée en UI via hash du label)
    tags_json = Column(JSON, default=list)
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())
    updated_at = Column(DateTime, default=datetime.utcnow, server_default=func.now(),
                         onupdate=datetime.utcnow)


# ── Statuts built-in exposés par l'API (pas stockés en DB) ───────────────

BUILTIN_STATUSES = [
    {"key": "todo",  "label": "À faire",  "color": "#7a8a9b", "builtin": True, "position": 0},
    {"key": "doing", "label": "En cours", "color": "#dc2626", "builtin": True, "position": 1},
    {"key": "done",  "label": "Fait",     "color": "#10b981", "builtin": True, "position": 2},
]

# Palette pour la création de statuts custom côté UI (shared entre backend
# et frontend, mais le frontend l'a aussi en dur — liste courte 12 couleurs).
STATUS_COLOR_PALETTE = [
    "#dc2626", "#ef4444", "#f97316", "#f59e0b",
    "#10b981", "#14b8a6", "#0ea5e9", "#6366f1",
    "#8b5cf6", "#ec4899", "#7a8a9b", "#737373",
]
