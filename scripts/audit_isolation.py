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


SECRET_KEYS = {"token", "api_key", "secret", "webhook_url", "password", "bot_token"}


def redact(obj):
    """Recursively mask values for sensitive keys."""
    if isinstance(obj, dict):
        return {
            k: ("<redacted>" if any(s in k.lower() for s in SECRET_KEYS) else redact(v))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [redact(x) for x in obj]
    return obj


def deep_channels(path: pathlib.Path) -> None:
    if not path.exists():
        return
    d = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(d, dict):
        return
    print("  --- détail canal(aux) ---")
    for cid, channel in d.items():
        if not isinstance(channel, dict):
            print(f"  {cid}: non-dict ({type(channel).__name__})")
            continue
        keys = list(channel.keys())
        has_uid = "user_id" in channel
        uid_val = channel.get("user_id") if has_uid else None
        print(f"  channel_id={cid}")
        print(f"    clés: {keys}")
        print(f"    user_id présent: {has_uid} (valeur={uid_val!r})")
        print(f"    contenu redacté: {json.dumps(redact(channel), ensure_ascii=False)[:300]}")


def logs_by_channel(path: pathlib.Path) -> None:
    if not path.exists():
        return
    d = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(d, list):
        return
    from collections import Counter
    counter = Counter(e.get("channel_id", "<missing>") for e in d if isinstance(e, dict))
    print("  --- logs groupés par channel_id ---")
    for cid, n in counter.most_common():
        print(f"    {cid}: {n} logs")


def main() -> None:
    section("Emplacement")
    print(f"  DATA = {DATA}")

    section("channels.json")
    inspect_json(DATA / "channels.json")
    deep_channels(DATA / "channels.json")

    section("channel_logs.json")
    inspect_json(DATA / "channel_logs.json")
    logs_by_channel(DATA / "channel_logs.json")

    section("code_snippets.json")
    inspect_json(DATA / "code_snippets.json")

    section("Plugins per-user filesystem")
    per_user_dirs = [
        ("scheduler", DATA / "automata"),
        ("webhooks", DATA / "webhooks"),
        ("integrations", DATA / "integrations"),
        ("voice sessions", DATA / "voice_sessions"),
        ("consciousness", DATA / "consciousness"),
    ]
    for label, base in per_user_dirs:
        if not base.exists():
            print(f"  {label} ({base.name}/): absent")
            continue
        uids = sorted(
            [p.name for p in base.iterdir() if p.is_dir()],
            key=lambda x: (not x.isdigit(), x),
        )
        print(f"  {label} ({base.name}/): uids={uids or '(vide)'}")

    code_cfg = DATA / "code_configs"
    if code_cfg.exists():
        files = sorted(p.name for p in code_cfg.iterdir() if p.is_file())
        print(f"  code configs (code_configs/): fichiers={files or '(vide)'}")
    else:
        print(f"  code configs (code_configs/): absent")

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
