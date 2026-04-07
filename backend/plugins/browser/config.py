"""
HuntR — Plugin Configuration

Self-contained config stored alongside the plugin.
No core dependencies for config management.
"""
import json
import logging
from pathlib import Path
from dataclasses import dataclass, field

logger = logging.getLogger("gungnir.plugins.huntr")

CONFIG_PATH = Path(__file__).parent / "huntr_config.json"

DEFAULTS = {
    "brave_api_key": "",
    "searxng_url": "",          # e.g. "http://localhost:8888"
    "max_history": 100,
    "default_focus": "web",
    "scrape_concurrency": 8,
    "scrape_timeout": 12,
    "rerank_method": "auto",    # "auto", "tfidf", "keyword"
    "max_follow_ups": 5,        # max conversation turns kept
}


@dataclass
class HuntRConfig:
    brave_api_key: str = ""
    searxng_url: str = ""
    max_history: int = 100
    default_focus: str = "web"
    scrape_concurrency: int = 8
    scrape_timeout: int = 12
    rerank_method: str = "auto"
    max_follow_ups: int = 5

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

    def to_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}
