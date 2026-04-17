#!/usr/bin/env python3
"""
Migration idempotente des artefacts SpearCode (snippets + versions) vers une
structure per-user.

Avant:
  data/code_snippets.json              # liste globale partagée
  data/code_versions/{encoded_path}/   # snapshots globaux partagés

Après:
  data/code_snippets/{uid}.json
  data/code_versions/{uid}/{encoded_path}/

Les legacy entries sont réattribués au DEFAULT_ORPHAN_OWNER (user #1 par défaut).
Les fichiers legacy sont conservés (sauvegardés .bak.{timestamp}) puis vidés
pour ne plus servir qu'en fallback open-mode (uid=0). Ré-entrant : relance
protégée par un flag ``_migrated_at`` dans ``data/code_snippets/_index.json``.

Usage:
  python3 scripts/migrate_code_per_user.py               # dry-run
  python3 scripts/migrate_code_per_user.py --apply       # écrit + backup
  python3 scripts/migrate_code_per_user.py --apply --force
"""
import argparse
import json
import pathlib
import shutil
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

LEGACY_SNIPPETS = DATA / "code_snippets.json"
NEW_SNIPPETS_DIR = DATA / "code_snippets"
SNIPPETS_INDEX = NEW_SNIPPETS_DIR / "_index.json"

VERSIONS_DIR = DATA / "code_versions"

DEFAULT_ORPHAN_OWNER = 1


def log(msg: str) -> None:
    print(msg, flush=True)


def timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


# ── Snippets plan/apply ─────────────────────────────────────────────────────

def plan_snippets() -> dict:
    out: dict = {"exists": LEGACY_SNIPPETS.exists(), "count": 0}
    if LEGACY_SNIPPETS.exists():
        try:
            data = json.loads(LEGACY_SNIPPETS.read_text(encoding="utf-8"))
            if isinstance(data, list):
                out["count"] = len(data)
                out["payload"] = data
        except Exception as e:
            out["error"] = str(e)
    return out


def apply_snippets(plan: dict, stamp: str) -> None:
    if not plan.get("exists") or "payload" not in plan:
        return
    NEW_SNIPPETS_DIR.mkdir(parents=True, exist_ok=True)

    backup = LEGACY_SNIPPETS.with_suffix(f".json.bak.{stamp}")
    shutil.copy2(LEGACY_SNIPPETS, backup)
    log(f"  backup: {backup.relative_to(DATA)}")

    target = NEW_SNIPPETS_DIR / f"{DEFAULT_ORPHAN_OWNER}.json"
    target.write_text(
        json.dumps(plan["payload"], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    log(f"  écrit: {target.relative_to(DATA)} ({plan['count']} snippets → user {DEFAULT_ORPHAN_OWNER})")


# ── Versions plan/apply ─────────────────────────────────────────────────────

def _iter_legacy_version_dirs():
    """Yield version dirs that are at the flat root (legacy), not already
    under a numeric ``{uid}/`` subdir."""
    if not VERSIONS_DIR.exists():
        return
    for child in VERSIONS_DIR.iterdir():
        if not child.is_dir():
            continue
        # Already per-user layout: numeric top-level dir → skip
        if child.name.isdigit():
            continue
        # _index.json / .gitkeep / anything non-dir → handled by isdir check above
        yield child


def plan_versions() -> dict:
    dirs = list(_iter_legacy_version_dirs())
    total_files = 0
    for d in dirs:
        for p in d.rglob("*"):
            if p.is_file():
                total_files += 1
    return {"dirs": dirs, "count": len(dirs), "files": total_files}


def apply_versions(plan: dict) -> None:
    if plan["count"] == 0:
        return
    target_root = VERSIONS_DIR / str(DEFAULT_ORPHAN_OWNER)
    target_root.mkdir(parents=True, exist_ok=True)
    for src in plan["dirs"]:
        dst = target_root / src.name
        if dst.exists():
            log(f"  skip (déjà présent côté user {DEFAULT_ORPHAN_OWNER}): {src.name}")
            continue
        src.rename(dst)
        log(f"  déplacé: {src.name}  →  {DEFAULT_ORPHAN_OWNER}/{src.name}")


# ── Idempotency flag ────────────────────────────────────────────────────────

def already_migrated() -> bool:
    if not SNIPPETS_INDEX.exists():
        return False
    try:
        d = json.loads(SNIPPETS_INDEX.read_text(encoding="utf-8"))
        return bool(d.get("_migrated_at"))
    except Exception:
        return False


def write_flag(snippets: dict, versions: dict) -> None:
    NEW_SNIPPETS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "_migrated_at": datetime.now(timezone.utc).isoformat(),
        "_source": "scripts/migrate_code_per_user.py",
        "orphan_owner": DEFAULT_ORPHAN_OWNER,
        "snippets_migrated": snippets.get("count", 0),
        "version_dirs_migrated": versions.get("count", 0),
        "version_files_migrated": versions.get("files", 0),
    }
    SNIPPETS_INDEX.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"  écrit flag: {SNIPPETS_INDEX.relative_to(DATA)}")


# ── Main ────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Exécute l'écriture (sinon dry-run)")
    parser.add_argument("--force", action="store_true", help="Ignore le flag _migrated_at")
    args = parser.parse_args()

    log(f"ROOT = {ROOT}")
    log(f"DATA = {DATA}")

    if already_migrated() and not args.force:
        log("── Déjà migré (flag _migrated_at). Utilise --force pour relancer.")
        return 0

    snippets = plan_snippets()
    versions = plan_versions()

    log("── Plan ──")
    log(f"  snippets legacy: {snippets.get('exists')}, entries: {snippets.get('count', 0)}")
    if "error" in snippets:
        log(f"  snippets ERROR: {snippets['error']}")
    log(f"  version dirs legacy (flat): {versions['count']}  ({versions['files']} fichiers)")
    if versions["count"]:
        sample = [d.name for d in versions["dirs"][:5]]
        log(f"  exemples: {sample}{'...' if versions['count'] > 5 else ''}")

    if not snippets.get("exists") and versions["count"] == 0:
        log("── Rien à migrer.")
        return 0

    if not args.apply:
        log("── DRY-RUN : aucune écriture. Relance avec --apply.")
        return 0

    log("── Application ──")
    stamp = timestamp()
    apply_snippets(snippets, stamp)
    apply_versions(versions)
    write_flag(snippets, versions)
    log("── Migration terminée ──")
    return 0


if __name__ == "__main__":
    sys.exit(main())
