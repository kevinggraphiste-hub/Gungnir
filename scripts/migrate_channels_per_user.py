#!/usr/bin/env python3
"""
Migration idempotente channels.json + channel_logs.json → structure per-user.

Avant:
  data/channels.json          # dict {channel_id: channel_obj (incl. user_id)}
  data/channel_logs.json      # list [{id, channel_id, ...}] sans user_id

Après:
  data/channels/_index.json                        # {channel_id: user_id}
  data/channels/{uid}/channels.json                # dict user-scoped
  data/channels/{uid}/channel_logs.json            # list user-scoped

Logs orphelins (channel_id inconnu) → rattachés à user #1 (fallback admin).

Usage:
  python3 scripts/migrate_channels_per_user.py               # dry-run (no write)
  python3 scripts/migrate_channels_per_user.py --apply       # writes + backups
"""
import argparse
import json
import pathlib
import shutil
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

LEGACY_CHANNELS = DATA / "channels.json"
LEGACY_LOGS = DATA / "channel_logs.json"
NEW_BASE = DATA / "channels"
NEW_INDEX = NEW_BASE / "_index.json"

DEFAULT_ORPHAN_OWNER = 1


def log(msg: str) -> None:
    print(msg, flush=True)


def build_plan() -> dict:
    """Read legacy files, return split plan per-user. No writes."""
    plan: dict = {
        "channels_by_user": {},          # {uid: {channel_id: channel_obj}}
        "logs_by_user": {},               # {uid: [log_entries]}
        "index": {},                      # {channel_id: uid}
        "orphan_logs": 0,
        "legacy_channels_exists": LEGACY_CHANNELS.exists(),
        "legacy_logs_exists": LEGACY_LOGS.exists(),
    }

    if LEGACY_CHANNELS.exists():
        channels = json.loads(LEGACY_CHANNELS.read_text(encoding="utf-8"))
        if not isinstance(channels, dict):
            raise SystemExit(f"Expected dict in {LEGACY_CHANNELS}, got {type(channels).__name__}")
        for cid, ch in channels.items():
            if not isinstance(ch, dict):
                continue
            uid = ch.get("user_id") or DEFAULT_ORPHAN_OWNER
            plan["index"][cid] = uid
            plan["channels_by_user"].setdefault(uid, {})[cid] = ch

    if LEGACY_LOGS.exists():
        logs = json.loads(LEGACY_LOGS.read_text(encoding="utf-8"))
        if not isinstance(logs, list):
            raise SystemExit(f"Expected list in {LEGACY_LOGS}, got {type(logs).__name__}")
        for entry in logs:
            if not isinstance(entry, dict):
                continue
            cid = entry.get("channel_id")
            uid = plan["index"].get(cid)
            if uid is None:
                uid = DEFAULT_ORPHAN_OWNER
                plan["orphan_logs"] += 1
            plan["logs_by_user"].setdefault(uid, []).append(entry)

    return plan


def already_migrated() -> bool:
    """Idempotency: if _index.json exists with _migrated_at flag, skip."""
    if not NEW_INDEX.exists():
        return False
    try:
        d = json.loads(NEW_INDEX.read_text(encoding="utf-8"))
        return bool(d.get("_migrated_at"))
    except Exception:
        return False


def print_plan(plan: dict) -> None:
    log("── Plan de migration ──")
    log(f"  legacy channels.json exists: {plan['legacy_channels_exists']}")
    log(f"  legacy channel_logs.json exists: {plan['legacy_logs_exists']}")
    log(f"  channels trouvés: {sum(len(v) for v in plan['channels_by_user'].values())}")
    log(f"  index channel_id→user_id: {len(plan['index'])} entrées")
    log(f"  logs orphelins (channel_id inconnu, fallback user {DEFAULT_ORPHAN_OWNER}): {plan['orphan_logs']}")
    log("  ventilation par user:")
    all_uids = set(plan["channels_by_user"].keys()) | set(plan["logs_by_user"].keys())
    for uid in sorted(all_uids, key=int):
        c = len(plan["channels_by_user"].get(uid, {}))
        l = len(plan["logs_by_user"].get(uid, []))
        log(f"    user {uid}: {c} channels, {l} logs")


def apply_plan(plan: dict) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    if LEGACY_CHANNELS.exists():
        backup = LEGACY_CHANNELS.with_suffix(f".json.bak.{stamp}")
        shutil.copy2(LEGACY_CHANNELS, backup)
        log(f"  backup: {backup.name}")
    if LEGACY_LOGS.exists():
        backup = LEGACY_LOGS.with_suffix(f".json.bak.{stamp}")
        shutil.copy2(LEGACY_LOGS, backup)
        log(f"  backup: {backup.name}")

    NEW_BASE.mkdir(parents=True, exist_ok=True)

    index_payload = {
        "_migrated_at": datetime.now(timezone.utc).isoformat(),
        "_source": "scripts/migrate_channels_per_user.py",
        "channel_owner": plan["index"],
    }
    NEW_INDEX.write_text(json.dumps(index_payload, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"  écrit: {NEW_INDEX.relative_to(DATA)}")

    for uid, channels in plan["channels_by_user"].items():
        udir = NEW_BASE / str(uid)
        udir.mkdir(parents=True, exist_ok=True)
        target = udir / "channels.json"
        target.write_text(json.dumps(channels, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        log(f"  écrit: {target.relative_to(DATA)} ({len(channels)} channels)")

    for uid, logs in plan["logs_by_user"].items():
        udir = NEW_BASE / str(uid)
        udir.mkdir(parents=True, exist_ok=True)
        target = udir / "channel_logs.json"
        target.write_text(json.dumps(logs, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        log(f"  écrit: {target.relative_to(DATA)} ({len(logs)} logs)")

    log("  (les fichiers legacy sont conservés, lus en fallback tant que non purgés)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Exécuter l'écriture (sinon dry-run)")
    parser.add_argument("--force", action="store_true", help="Ignorer le flag _migrated_at")
    args = parser.parse_args()

    log(f"ROOT = {ROOT}")
    log(f"DATA = {DATA}")

    if already_migrated() and not args.force:
        log("── Déjà migré (flag _migrated_at présent dans _index.json). Utilise --force pour relancer.")
        return 0

    plan = build_plan()
    print_plan(plan)

    if not plan["legacy_channels_exists"] and not plan["legacy_logs_exists"]:
        log("── Rien à migrer (aucun fichier legacy).")
        return 0

    if not args.apply:
        log("── DRY-RUN : aucune écriture. Relance avec --apply pour exécuter.")
        return 0

    log("── Application ──")
    apply_plan(plan)
    log("── Migration terminée ──")
    return 0


if __name__ == "__main__":
    sys.exit(main())
