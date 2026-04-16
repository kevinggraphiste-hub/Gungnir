#!/bin/bash
# Gungnir — Docker entrypoint
# Fix data directory permissions (volume mount may have root-owned files)
# Then drop to gungnir user. If arguments are passed (e.g. via
# `docker compose run --rm app python scripts/...`), exec them instead
# of uvicorn — allows one-shot scripts like the SQLite→PG migrator.

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
