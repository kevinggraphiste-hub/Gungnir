"""
Valkyrie — migrations ALTER TABLE propres au plugin.

Collectées par `backend/core/db/models.py::init_db()` via le scan des plugins :
chaque plugin qui expose `MIGRATIONS: list[tuple[str, str]]` voit ses
migrations exécutées une à une (chacune dans sa propre transaction pour ne
pas poisoner le batch si une colonne existe déjà).

Format : `(sql, label)` — le label est affiché dans les logs.
"""
from __future__ import annotations

MIGRATIONS: list[tuple[str, str]] = [
    ("ALTER TABLE valkyrie_cards ADD COLUMN subtitle VARCHAR(300) DEFAULT ''", "subtitle -> valkyrie_cards"),
    ("ALTER TABLE valkyrie_cards ADD COLUMN subtasks2_json JSONB DEFAULT '[]'::jsonb", "subtasks2_json -> valkyrie_cards"),
    ("ALTER TABLE valkyrie_cards ADD COLUMN tags_json JSONB DEFAULT '[]'::jsonb", "tags_json -> valkyrie_cards"),
    ("ALTER TABLE valkyrie_cards ADD COLUMN subtasks2_title VARCHAR(60) DEFAULT ''", "subtasks2_title -> valkyrie_cards"),
    ("ALTER TABLE valkyrie_cards ADD COLUMN due_date TIMESTAMP NULL", "due_date -> valkyrie_cards"),
    ("ALTER TABLE valkyrie_cards ADD COLUMN archived_at TIMESTAMP NULL", "archived_at -> valkyrie_cards"),
    ("ALTER TABLE valkyrie_cards ADD COLUMN origin VARCHAR(80) DEFAULT ''", "origin -> valkyrie_cards"),
    ("ALTER TABLE valkyrie_cards ADD COLUMN recurrence_rule VARCHAR(40) DEFAULT ''", "recurrence_rule -> valkyrie_cards"),
]
