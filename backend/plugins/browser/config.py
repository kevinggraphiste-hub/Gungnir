"""
HuntR v3 — Plugin Configuration

Minimal config. API keys are per-user (stored in UserSettings),
not in this plugin config.
"""
import json
import logging
from pathlib import Path
from dataclasses import dataclass

logger = logging.getLogger("gungnir.plugins.huntr")

CONFIG_PATH = Path(__file__).parent / "huntr_config.json"

DEFAULTS = {
    "max_history": 50,
}


@dataclass
class HuntRConfig:
    max_history: int = 50

    @classmethod
    def load(cls) -> "HuntRConfig":
        try:
            if CONFIG_PATH.exists():
                data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                merged = {**DEFAULTS, **data}
                return cls(**{k: v for k, v in merged.items() if k in cls.__dataclass_fields__})
        except Exception as e:
            logger.warning(f"HuntR config load error: {e}")
        return cls(**DEFAULTS)

    def save(self):
        try:
            data = {k: getattr(self, k) for k in self.__dataclass_fields__}
            CONFIG_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception as e:
            logger.warning(f"HuntR config save error: {e}")
