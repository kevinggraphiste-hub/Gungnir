#!/bin/bash
# Wrapper court pour admin_restore_user_backup.py — evite le wrap de ligne
# qui casse la commande docker compose run quand collee depuis un navigateur.
#
# Usage :
#   ./scripts/admin_restore_user_backup.sh <zip_relatif> <uid>
#
# Exemple :
#   ./scripts/admin_restore_user_backup.sh data/backups/2/gungnir_user2_20260416_155111.zip 2

set -e

ZIP="$1"
UID_="$2"

if [ -z "$ZIP" ] || [ -z "$UID_" ]; then
    echo "Usage: $0 <zip_relatif> <uid>"
    exit 1
fi

if [ ! -f "$ZIP" ]; then
    echo "Zip introuvable : $ZIP"
    exit 1
fi

cd "$(dirname "$0")/.."

exec docker compose run --rm \
    -v "$PWD/scripts:/app/scripts:ro" \
    app python /app/scripts/admin_restore_user_backup.py \
    --zip "$ZIP" --uid "$UID_"
