#!/bin/bash
# One-shot : restaure le backup d'Armand (user_id=2) depuis le zip remappe.
# Usage : ./scripts/restore_armand.sh
set -e
cd "$(dirname "$0")/.."
exec ./scripts/admin_restore_user_backup.sh \
    data/backups/2/gungnir_user2_20260416_155111.zip 2
