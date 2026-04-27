"""
Forge — modèles DB.

Deux tables, strict per-user :
- `forge_workflows` : définitions YAML versionnées
- `forge_workflow_runs` : exécutions (status, logs, durée, output)

YAML stocké en TEXT pour rester human-friendly + diff-friendly. La
représentation graphique (positions canvas React Flow) sera stockée à part
en JSON quand on attaquera la Phase 3.
"""
from __future__ import annotations

from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, Boolean,
    ForeignKey, JSON, func,
)

from backend.core.db.models import Base


class ForgeWorkflow(Base):
    """Un workflow = un YAML + sa metadata.

    `yaml_def` est la source de vérité. Le canvas (Phase 3) sera juste une
    UI alternative qui sérialise vers le même YAML — pas de drift possible.
    """
    __tablename__ = "forge_workflows"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    name = Column(String(200), nullable=False, default="Nouveau workflow")
    description = Column(Text, default="")
    # Source YAML — single source of truth.
    yaml_def = Column(Text, nullable=False, default="")
    # Activé / désactivé (le bouton "Run" ignore les workflows désactivés
    # depuis les triggers automatiques quand ils existeront — Phase 2).
    enabled = Column(Boolean, default=True)
    # Tags libres pour catégoriser (devops, marketing, daily, etc.).
    tags_json = Column(JSON, default=list)
    # Position canvas (Phase 3) : { nodes: [{id, x, y}], viewport: {x, y, zoom} }
    # Optionnel — si NULL, le canvas génère un layout auto.
    canvas_state = Column(JSON, nullable=True)
    # Dossier d'organisation : path-like ("Veille/News" ou "Personnel"). Vide
    # = racine. Les workflows peuvent vivre dans des dossiers imbriqués sans
    # avoir besoin d'une vraie hiérarchie en DB.
    folder = Column(String(200), default="", index=True)
    created_at = Column(DateTime, default=datetime.utcnow,
                        server_default=func.now())
    updated_at = Column(DateTime, default=datetime.utcnow,
                        server_default=func.now(), onupdate=datetime.utcnow)


class ForgeMarketplaceTemplate(Base):
    """Workflow publié sur la marketplace communautaire.

    Quand un user clique "Publier" sur un de ses workflows, on snapshot
    le YAML et on crée une entrée ici. Tous les autres users peuvent
    alors browser/installer (clone) le template chez eux.

    Strict per-user pour la création/modif/delete (seul l'auteur peut
    modifier ou retirer son template). La lecture est publique pour les
    templates `public=true`.
    """
    __tablename__ = "forge_marketplace_templates"

    id = Column(Integer, primary_key=True, autoincrement=True)
    author_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    name = Column(String(200), nullable=False)
    description = Column(Text, default="")
    yaml_def = Column(Text, nullable=False, default="")
    category = Column(String(80), default="Autre", index=True)
    tags_json = Column(JSON, default=list)
    public = Column(Boolean, default=True)
    downloads = Column(Integer, default=0)
    rating_sum = Column(Integer, default=0)  # somme des ratings 1-5
    rating_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow,
                        server_default=func.now())
    updated_at = Column(DateTime, default=datetime.utcnow,
                        server_default=func.now(), onupdate=datetime.utcnow)


class ForgeWorkflowVersion(Base):
    """Snapshot historique d'un workflow.

    Auto-créé à chaque PUT /workflows/{id} qui change yaml_def, avec un
    rate limit de 5 min entre snapshots (sinon l'édition live spam la table).
    Permet de visualiser l'historique et restaurer une version antérieure.

    On garde le nom + description au moment du snapshot pour que les
    rollbacks soient bien round-trip safe (sinon on perdrait le titre
    si l'user a renommé le workflow).
    """
    __tablename__ = "forge_workflow_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workflow_id = Column(Integer, ForeignKey("forge_workflows.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    version_num = Column(Integer, nullable=False)
    name = Column(String(200), default="")
    description = Column(Text, default="")
    yaml_def = Column(Text, nullable=False, default="")
    # Source du snapshot : 'auto' (à chaque save), 'manual' (bouton dédié),
    # 'pre_restore' (avant un rollback, pour pouvoir undo le rollback).
    source = Column(String(20), default="auto")
    # Message libre (optionnel, type git commit message).
    message = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow,
                        server_default=func.now())


class ForgeGlobal(Base):
    """Variable globale user-scoped, accessible depuis tous les workflows
    de l'user via `{{ globals.<key> }}`.

    Use cases : URLs d'API persistantes, IDs de canaux, secrets non sensibles.
    Pour les vraies credentials → OAuth core.
    """
    __tablename__ = "forge_globals"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    key = Column(String(100), nullable=False, index=True)
    value_json = Column(JSON, default=None)
    created_at = Column(DateTime, default=datetime.utcnow,
                        server_default=func.now())
    updated_at = Column(DateTime, default=datetime.utcnow,
                        server_default=func.now(), onupdate=datetime.utcnow)


class ForgeStatic(Base):
    """Donnée persistante scopée à un workflow, accessible via
    `{{ static.<key> }}` et modifiable via le tool `forge_set_static`.

    Use cases : compteurs, last_id pour polling, fingerprints pour dedup.
    Reset automatique = jamais (l'user doit appeler delete explicitement).
    """
    __tablename__ = "forge_static"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workflow_id = Column(Integer, ForeignKey("forge_workflows.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    key = Column(String(100), nullable=False, index=True)
    value_json = Column(JSON, default=None)
    updated_at = Column(DateTime, default=datetime.utcnow,
                        server_default=func.now(), onupdate=datetime.utcnow)


class ForgeTrigger(Base):
    """Trigger qui déclenche automatiquement un workflow.

    Types supportés :
    - 'webhook' : un POST sur `/api/plugins/forge/webhook/{secret_token}` lance
      le workflow (le body du POST devient les inputs).
    - 'cron'    : exécution planifiée via expression cron (croniter).
    - 'manual'  : pas d'auto-déclenchement (placeholder ; le run vient du
      bouton UI ou de l'agent).

    `config_json` :
    - webhook : { "secret_token": "...", "method": "POST", "ip_allowlist": [...] }
    - cron    : { "expression": "0 9 * * *", "timezone": "Europe/Paris" }

    `last_fire_at` : last successful trigger (utilisé pour la fenêtre de cron
    et l'affichage UI).
    """
    __tablename__ = "forge_triggers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workflow_id = Column(Integer, ForeignKey("forge_workflows.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    type = Column(String(20), nullable=False, default="manual")
    config_json = Column(JSON, default=dict)
    enabled = Column(Boolean, default=True)
    last_fire_at = Column(DateTime, nullable=True)
    # Token secret pour les webhooks — indexé pour le lookup rapide depuis
    # l'endpoint public.
    secret_token = Column(String(64), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow,
                        server_default=func.now())


class ForgeWorkflowRun(Base):
    """Une exécution d'un workflow.

    `logs_json` = liste structurée d'événements step-par-step :
        [{ts, step_id, type: 'start'|'end'|'error', tool, output, error}]

    Permet replay debugging + visualisation progression dans l'UI.
    """
    __tablename__ = "forge_workflow_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workflow_id = Column(Integer, ForeignKey("forge_workflows.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    # 'running' | 'success' | 'error' | 'cancelled'
    status = Column(String(20), nullable=False, default="running")
    # Inputs passés au démarrage (dict).
    inputs_json = Column(JSON, default=dict)
    # Output final agrégé (dict, output du dernier step).
    output_json = Column(JSON, default=dict)
    # Trace step-par-step (voir docstring).
    logs_json = Column(JSON, default=list)
    # Message d'erreur top-level si status == 'error'.
    error = Column(Text, default="")
    # Source du déclenchement : 'manual' | 'agent' | 'webhook' | 'cron'
    trigger_source = Column(String(40), default="manual")
    started_at = Column(DateTime, default=datetime.utcnow,
                        server_default=func.now())
    finished_at = Column(DateTime, nullable=True)
