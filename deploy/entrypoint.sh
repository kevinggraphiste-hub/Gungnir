#!/bin/bash
# Gungnir — Docker entrypoint
# Fix data directory permissions (volume mount may have root-owned files)
# Then drop to gungnir user. If arguments are passed (e.g. via
# `docker compose run --rm app python scripts/...`), exec them instead
# of uvicorn — allows one-shot scripts like the SQLite→PG migrator.

# ── Sécurité M13 : exiger GUNGNIR_SECRET_KEY ────────────────────────────
# Sans cette clé, Fernet tombe sur un fallback dérivé du hostname/path —
# instable (change au rebuild → toutes les clés API user deviennent
# illisibles). On refuse de démarrer pour forcer une config correcte.
if [ -z "$GUNGNIR_SECRET_KEY" ]; then
    echo "ERROR: GUNGNIR_SECRET_KEY n'est pas défini." >&2
    echo "       Génère-en une avec : openssl rand -hex 32" >&2
    echo "       Puis ajoute dans .env :  GUNGNIR_SECRET_KEY=<valeur>" >&2
    echo "       Sans cette clé, les API keys chiffrées ne peuvent pas être lues de manière stable entre redémarrages." >&2
    exit 1
fi

# Ensure data dirs exist and are writable by gungnir user
mkdir -p /app/data/backups /app/data/workspace /app/data/consciousness /app/data/channels
chown -R gungnir:gungnir /app/data 2>/dev/null || true
chmod -R 775 /app/data 2>/dev/null || true

if [ $# -gt 0 ]; then
    # One-shot command mode
    exec gosu gungnir "$@"
fi

# Default: start the uvicorn app
exec gosu gungnir python -m uvicorn backend.core.main:app \
    --host 0.0.0.0 --port 8000 \
    --workers 1 --loop uvloop \
    --limit-concurrency 50
