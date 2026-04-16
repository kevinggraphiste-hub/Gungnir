"""
Restore admin-side d'un backup per-user, sans passer par l'endpoint HTTP.

Utile quand on veut restaurer pour le compte d'un autre utilisateur (usage
post-migration, support, etc.) sans lui demander de se connecter.

Reutilise les helpers internes de backup_routes.py :
- _delete_user_db : wipe des rows DB du user cible
- _import_user_db : reinjection depuis db_export.json (user_id force a uid)
- _wipe_user_files : suppression des fichiers data/*/<uid>/
- _extract_user_files_from_zip : extraction files/ vers DATA_DIR

Usage :
    docker compose run --rm -v "$PWD/scripts:/app/scripts:ro" app \\
        python /app/scripts/admin_restore_user_backup.py \\
        --zip data/backups/2/gungnir_user2_20260416_155111.zip \\
        --uid 2

Le zip doit deja contenir manifest.user_id = uid (utilise remap_user_backup.py
au prealable si les ids ont change).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.core.api.backup_routes import (
    _delete_user_db,
    _extract_user_files_from_zip,
    _import_user_db,
    _wipe_user_files,
)
from backend.core.db.engine import async_session

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
log = logging.getLogger("admin_restore")


async def main(zip_path: Path, uid: int) -> None:
    if not zip_path.exists():
        raise SystemExit(f"Zip introuvable : {zip_path}")

    log.info(f"Restore admin : zip={zip_path} uid={uid}")

    with zipfile.ZipFile(zip_path, "r") as zf:
        try:
            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        except KeyError:
            raise SystemExit("manifest.json manquant dans le zip")

        if manifest.get("kind") != "per_user":
            raise SystemExit(f"Zip kind invalide : {manifest.get('kind')}")

        manifest_uid = int(manifest.get("user_id") or 0)
        if manifest_uid != uid:
            raise SystemExit(
                f"manifest.user_id={manifest_uid} != uid={uid}. "
                f"Utilise d'abord scripts/remap_user_backup.py."
            )

        try:
            export = json.loads(zf.read("db_export.json").decode("utf-8"))
        except KeyError:
            raise SystemExit("db_export.json manquant")

        async with async_session() as session:
            log.info(f"→ _delete_user_db(uid={uid})")
            await _delete_user_db(session, uid)
            await session.commit()

            log.info(f"→ _import_user_db(uid={uid})")
            counts = await _import_user_db(session, uid, export)
            await session.commit()
            for table, n in counts.items():
                log.info(f"    {table}: {n}")

        log.info(f"→ _wipe_user_files(uid={uid})")
        _wipe_user_files(uid)

        log.info(f"→ _extract_user_files_from_zip(uid={uid})")
        extracted = _extract_user_files_from_zip(uid, zf)
        log.info(f"    {extracted} fichiers extraits")

    log.info("Restore admin termine.")
    log.info("Note : MCP/consciousness/mode_pool ne sont pas recharges (pas de")
    log.info("runtime actif pour cet uid ici). Au prochain login, tout sera lu")
    log.info("depuis le disque et la DB.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Admin-side restore of a per-user backup")
    parser.add_argument("--zip", required=True, help="Chemin du zip (manifest.user_id doit matcher --uid)")
    parser.add_argument("--uid", type=int, required=True, help="User ID cible")
    args = parser.parse_args()

    asyncio.run(main(Path(args.zip), args.uid))
