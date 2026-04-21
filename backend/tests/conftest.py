"""
Pytest bootstrap : ajoute la racine repo au `sys.path` pour que les tests
puissent faire `import backend.core...` sans config supplémentaire.
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))
