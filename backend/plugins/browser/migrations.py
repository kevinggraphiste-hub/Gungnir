"""
HuntR (plugin browser) — migrations ALTER TABLE propres au plugin.
"""
from __future__ import annotations

MIGRATIONS: list[tuple[str, str]] = [
    ("ALTER TABLE huntr_searches ADD COLUMN topic VARCHAR(20) DEFAULT 'web'", "topic -> huntr_searches"),
]
