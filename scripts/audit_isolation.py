#!/usr/bin/env python3
"""
Audit read-only de l'état per-user avant migration P0 isolation.
Aucune écriture, aucune mutation — juste introspection.
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def inspect_json(path: pathlib.Path) -> None:
    if not path.exists():
        print(f"  {path.name}: absent")
        return
    size = path.stat().st_size
    print(f"  {path.name}: {size} octets")
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  parse error: {e}")
        return
    print(f"  type racine: {type(d).__name__}")
    if isinstance(d, list):
        print(f"  nb entrées: {len(d)}")
        if d and isinstance(d[0], dict):
            print(f"  clés 1ère entrée: {list(d[0].keys())}")
            uids = {e.get("user_id") for e in d if isinstance(e, dict)}
            print(f"  user_id distincts trouvés: {uids}")
    elif isinstance(d, dict):
        print(f"  clés top-level: {list(d.keys())[:15]}")
        for k, v in list(d.items())[:3]:
            if isinstance(v, list) and v and isinstance(v[0], dict):
                print(f"  clés entrée sous {k!r}: {list(v[0].keys())}")
                uids = {e.get("user_id") for e in v if isinstance(e, dict)}
                print(f"  user_id distincts sous {k!r}: {uids}")


def main() -> None:
    section("Emplacement")
    print(f"  DATA = {DATA}")

    section("channels.json")
    inspect_json(DATA / "channels.json")

    section("channel_logs.json")
    inspect_json(DATA / "channel_logs.json")

    section("code_snippets.json")
    inspect_json(DATA / "code_snippets.json")

    section("config.json → voice")
    cfg = DATA / "config.json"
    if not cfg.exists():
        print("  absent")
        return
    d = json.loads(cfg.read_text(encoding="utf-8"))
    voice = d.get("voice", {})
    if not voice:
        print("  section voice absente ou vide")
        return
    for provider, conf in voice.items():
        if not isinstance(conf, dict):
            continue
        has_key = bool(conf.get("api_key"))
        agent = conf.get("agent_id", "") or ""
        other = [k for k in conf.keys() if k not in ("api_key",)]
        print(
            f"  {provider}: has_api_key={has_key}, "
            f"agent_id={(agent[:10] + '…') if agent else '(vide)'}, "
            f"autres_clés={other}"
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"audit failed: {e}", file=sys.stderr)
        sys.exit(1)
