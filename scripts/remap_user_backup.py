"""
Remap un backup per-user d'un ancien user_id vers un nouveau user_id.

Cas d'usage : apres migration SQLite -> PG, les user_id peuvent avoir change.
Un backup fait sous ancien_uid=3 doit etre "relocalise" vers nouveau_uid=2
pour que l'endpoint /backup/restore de l'utilisateur cible l'accepte.

Operations :
- Copie du zip source vers data/backups/<new_uid>/
- manifest.json : user_id = new_uid
- Chemins files/<category>/<old_uid>/... -> files/<category>/<new_uid>/...
- db_export.json : laisse tel quel (l'import force user_id = caller au restore)

Usage :
    python scripts/remap_user_backup.py \\
        --src data/backups/3/gungnir_user3_20260416_155111.zip \\
        --old-uid 3 --new-uid 2
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path


def remap(src: Path, old_uid: int, new_uid: int, data_dir: Path) -> Path:
    if not src.exists():
        raise SystemExit(f"Zip source introuvable : {src}")

    dst_dir = data_dir / "backups" / str(new_uid)
    dst_dir.mkdir(parents=True, exist_ok=True)

    # Nouveau nom : remplace "_userX_" par "_user<new_uid>_" dans le nom
    new_name = src.name.replace(f"_user{old_uid}_", f"_user{new_uid}_")
    dst = dst_dir / new_name

    if dst.exists():
        raise SystemExit(f"Destination existe deja : {dst} (supprime-la d'abord)")

    old_seg = str(old_uid)
    new_seg = str(new_uid)
    remapped_files = 0

    with zipfile.ZipFile(src, "r") as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            new_path = info.filename

            if info.filename == "manifest.json":
                manifest = json.loads(data.decode("utf-8"))
                manifest["user_id"] = new_uid
                data = json.dumps(manifest, indent=2).encode("utf-8")
                print(f"  manifest.json : user_id {old_uid} -> {new_uid}")

            elif info.filename.startswith("files/"):
                parts = info.filename.split("/")
                # Remplace le premier segment egal a old_uid (le dossier user)
                for i, p in enumerate(parts):
                    if p == old_seg:
                        parts[i] = new_seg
                        remapped_files += 1
                        break
                new_path = "/".join(parts)

            zout.writestr(new_path, data)

    print(f"\nOK — backup remappe cree :")
    print(f"  Source : {src}")
    print(f"  Dest   : {dst}")
    print(f"  Chemins files/ remappes : {remapped_files}")
    print(f"\nArmand peut maintenant se connecter (uid={new_uid}) et restaurer ce zip depuis l'UI.")
    return dst


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Remap per-user backup to another user_id")
    parser.add_argument("--src", required=True, help="Chemin du zip source")
    parser.add_argument("--old-uid", type=int, required=True)
    parser.add_argument("--new-uid", type=int, required=True)
    parser.add_argument("--data-dir", default="data", help="Racine data/ (defaut: data)")
    args = parser.parse_args()

    remap(Path(args.src), args.old_uid, args.new_uid, Path(args.data_dir))
