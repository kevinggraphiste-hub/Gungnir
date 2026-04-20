"""
HuntR — Tavily search cache (per-user, in-memory, TTL 1h).

Keyed on (user_id, query_normalized, mode, max_results). Prevents redundant
Tavily API calls + LLM synthesis for identical recent queries. Classique mode
is NOT cached (DDG is free + results change fast).
"""
import time
import threading
from collections import OrderedDict


class TavilyCache:
    """Thread-safe in-memory cache with TTL and LRU eviction."""

    def __init__(self, ttl_seconds: int = 3600, max_entries: int = 500):
        self.ttl = ttl_seconds
        self.max_entries = max_entries
        self._store: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def make_key(user_id: int, query: str, mode: str, max_results: int,
                 topic: str = "web", custom_format: str = "",
                 providers: list[str] | None = None,
                 source_filters: dict | None = None) -> str:
        q = (query or "").strip().lower()
        # Hash the custom format so cache entries with different structures
        # don't collide (a user switching from "3 aspects" to "4 paragraphes"
        # must get a fresh synthesis, not the previously cached one).
        import hashlib, json
        if custom_format:
            fmt_hash = hashlib.sha1(custom_format.strip().encode("utf-8")).hexdigest()[:10]
        else:
            fmt_hash = "_"
        # Set de providers actifs : si l'user ajoute/enlève Brave, le cache doit
        # être invalidé pour cette combo. Ordre déterministe via sort.
        if providers:
            prov_hash = hashlib.sha1(",".join(sorted(providers)).encode("utf-8")).hexdigest()[:8]
        else:
            prov_hash = "_"
        # Fingerprint des filtres sources : si l'user change la blocklist /
        # allowlist, le cache doit être invalidé (résultats différents).
        if source_filters:
            sf_norm = {
                "s": bool(source_filters.get("use_starter_blocklist", False)),
                "b": sorted(source_filters.get("blocklist") or []),
                "a": sorted(source_filters.get("allowlist") or []),
                "m": source_filters.get("allowlist_mode") or "off",
            }
            sf_hash = hashlib.sha1(
                json.dumps(sf_norm, sort_keys=True).encode("utf-8")
            ).hexdigest()[:8]
        else:
            sf_hash = "_"
        return f"{user_id}|{mode}|{topic}|{max_results}|{fmt_hash}|{prov_hash}|{sf_hash}|{q}"

    def get(self, key: str) -> dict | None:
        with self._lock:
            entry = self._store.get(key)
            if not entry:
                return None
            ts, payload = entry
            if time.time() - ts > self.ttl:
                self._store.pop(key, None)
                return None
            self._store.move_to_end(key)  # LRU touch
            return payload

    def set(self, key: str, payload: dict) -> None:
        with self._lock:
            self._store[key] = (time.time(), payload)
            self._store.move_to_end(key)
            while len(self._store) > self.max_entries:
                self._store.popitem(last=False)

    def invalidate_user(self, user_id: int) -> None:
        prefix = f"{user_id}|"
        with self._lock:
            for k in [k for k in self._store if k.startswith(prefix)]:
                self._store.pop(k, None)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()


tavily_cache = TavilyCache(ttl_seconds=3600, max_entries=500)
