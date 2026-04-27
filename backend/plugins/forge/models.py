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
    created_at = Column(DateTime, default=datetime.utcnow,
                        server_default=func.now())
    updated_at = Column(DateTime, default=datetime.utcnow,
                        server_default=func.now(), onupdate=datetime.utcnow)


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
