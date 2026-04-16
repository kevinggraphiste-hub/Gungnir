#!/bin/bash
# ============================================================================
# Gungnir — Migration cle-en-main SQLite legacy → PostgreSQL.
#
# A lancer depuis la racine du projet (/opt/gungnir sur le VPS).
#
# Usage :
#   chmod +x scripts/migrate_from_sqlite.sh
#   ./scripts/migrate_from_sqlite.sh [chemin/vers/gungnir.db]
#
# Par defaut cherche : data/gungnir.db
#
# Le script :
#   1. Verifie que le .db existe
#   2. Lance Postgres via docker compose (service `db`)
#   3. Attend que Postgres soit pret
#   4. Execute le migrator Python dans le container `app`
#   5. Affiche un recap
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SQLITE_PATH="${1:-data/gungnir.db}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[Migrate]${NC} $1"; }
warn() { echo -e "${YELLOW}[Migrate]${NC} $1"; }
err()  { echo -e "${RED}[Migrate]${NC} $1"; }

cd "$PROJECT_DIR"

# 1. Verif du .db source
if [ ! -f "$SQLITE_PATH" ]; then
    err "Fichier SQLite introuvable : $SQLITE_PATH"
    err ""
    err "Si ton ancien .db est dans un volume Docker, rapatrie-le d'abord :"
    err "  docker cp <ancien-container>:/app/data/gungnir.db ./data/gungnir.db"
    err ""
    err "Ou indique le chemin en argument :"
    err "  ./scripts/migrate_from_sqlite.sh /chemin/vers/gungnir.db"
    exit 1
fi

SIZE=$(du -h "$SQLITE_PATH" | cut -f1)
log "Source trouvee : $SQLITE_PATH ($SIZE)"

# 2. Demarrer Postgres si pas deja en route
log "Demarrage de Postgres…"
docker compose up -d db

# 3. Attendre que Postgres reponde
log "Attente de Postgres (pg_isready)…"
for i in {1..30}; do
    if docker compose exec -T db pg_isready -U gungnir -d gungnir &>/dev/null; then
        log "Postgres pret."
        break
    fi
    if [ "$i" = "30" ]; then
        err "Postgres n'a pas demarre apres 30s. Check : docker compose logs db"
        exit 1
    fi
    sleep 1
done

# 4. S'assurer que l'image `app` est build
log "Verification de l'image app…"
if ! docker compose images app 2>/dev/null | grep -q gungnir; then
    log "Image app absente, build en cours…"
    docker compose build app
fi

# 5. Wipe optionnel de la base Postgres — si le container `app` a deja tourne,
#    il a pu semer des donnees (users, user_settings...) qui bloqueront le
#    migrator via ON CONFLICT DO NOTHING (tu garderais les seeds au lieu de
#    tes donnees legacy).
ROWCOUNT=$(docker compose exec -T db psql -U gungnir -d gungnir -tAc \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "0")
if [ "$ROWCOUNT" -gt "0" ]; then
    warn "La base Postgres contient deja $ROWCOUNT table(s)."
    warn "Pour une migration propre depuis SQLite, il faut reinitialiser le schema."
    read -p "  → Vider la base Postgres avant migration ? [oui/NON] : " CONFIRM
    if [ "$CONFIRM" = "oui" ] || [ "$CONFIRM" = "OUI" ] || [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
        log "Wipe du schema Postgres…"
        docker compose exec -T db psql -U gungnir -d gungnir -c \
            "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO gungnir;"
        log "Schema vide."
    else
        warn "Skip du wipe — le migrator va probablement skipper des lignes (ON CONFLICT)."
    fi
fi

# 6. Lancer le migrator Python dans un container `app` ephemere
log "Lancement du migrator…"
log ""
docker compose run --rm \
    -v "$PROJECT_DIR/$SQLITE_PATH:/app/migrate_source.db:ro" \
    app python scripts/migrate_sqlite_to_pg.py --sqlite /app/migrate_source.db

# 6. Recap
log ""
log "========================================="
log "  Migration terminee !"
log "========================================="
log ""
log "  Prochaines etapes :"
log "  1. Lancer l'app :  docker compose up -d app"
log "  2. Health check :  curl http://127.0.0.1:8000/api/health"
log "  3. Si OK, le .db SQLite peut etre archive puis supprime"
log ""
log "  Le script est idempotent : tu peux le relancer sans risque."
log ""
