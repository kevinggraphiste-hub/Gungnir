#!/bin/bash
# ============================================================================
# Gungnir — Deploy script pour Hostinger VPS
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh setup     # Premier deploiement
#   ./deploy.sh update    # Mise a jour apres git pull
#   ./deploy.sh ssl       # Generer certificat SSL
#   ./deploy.sh logs      # Voir les logs
#   ./deploy.sh status    # Etat du container + health
#   ./deploy.sh backup    # Backup des donnees
#   ./deploy.sh stop      # Arreter Gungnir
# ============================================================================

set -e

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$DEPLOY_DIR")"
DOMAIN="gungnir.scarletwolf.cloud"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[Gungnir]${NC} $1"; }
warn() { echo -e "${YELLOW}[Gungnir]${NC} $1"; }
err() { echo -e "${RED}[Gungnir]${NC} $1"; }

# ── Setup initial ──────────────────────────────────────────────────────────
cmd_setup() {
    log "Setup de Gungnir sur $DOMAIN..."

    # 1. Verifier que Docker tourne
    if ! docker info &>/dev/null; then
        err "Docker n'est pas accessible. Verifiez l'installation."
        exit 1
    fi

    # 2. Installer le site nginx
    if [ ! -f /etc/nginx/sites-available/gungnir ]; then
        log "Installation de la config nginx..."
        cp "$DEPLOY_DIR/nginx-gungnir.conf" /etc/nginx/sites-available/gungnir
        ln -sf /etc/nginx/sites-available/gungnir /etc/nginx/sites-enabled/gungnir

        # Tester la config (ignorer erreur SSL si pas encore de cert)
        if nginx -t 2>&1 | grep -q "OK"; then
            systemctl reload nginx
            log "Nginx configure pour $DOMAIN"
        else
            # Commenter temporairement le bloc SSL pour certbot
            warn "Config nginx OK mais SSL pas encore actif — lancez ./deploy.sh ssl apres"
        fi
    else
        log "Config nginx deja en place."
    fi

    # 3. Build et lancement du container
    cd "$PROJECT_DIR"
    log "Build du container Gungnir..."
    docker compose build
    docker compose up -d

    log ""
    log "========================================="
    log "  Gungnir deploye !"
    log "========================================="
    log "  Container: http://127.0.0.1:8000"
    log "  URL:       https://$DOMAIN (apres SSL)"
    log ""
    log "  Prochaines etapes:"
    log "  1. Pointer le DNS $DOMAIN vers 31.97.116.142"
    log "  2. Lancer: ./deploy.sh ssl"
    log "========================================="
}

# ── Mise a jour ────────────────────────────────────────────────────────────
cmd_update() {
    log "Mise a jour de Gungnir..."
    cd "$PROJECT_DIR"

    # Backup avant update
    cmd_backup

    # Rebuild et redemarrer
    docker compose build --no-cache
    docker compose up -d

    # Cleanup
    docker image prune -f 2>/dev/null

    # Recharger nginx au cas ou la conf a change
    if [ -f /etc/nginx/sites-available/gungnir ]; then
        cp "$DEPLOY_DIR/nginx-gungnir.conf" /etc/nginx/sites-available/gungnir
        nginx -t && systemctl reload nginx
    fi

    log "Mise a jour terminee !"
    cmd_status
}

# ── SSL (Let's Encrypt via Certbot) ───────────────────────────────────────
cmd_ssl() {
    log "Generation du certificat SSL pour $DOMAIN..."

    # D'abord, mettre une config nginx temporaire HTTP-only pour certbot
    cat > /tmp/gungnir-temp.conf <<TMPEOF
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
TMPEOF

    cp /tmp/gungnir-temp.conf /etc/nginx/sites-available/gungnir
    nginx -t && systemctl reload nginx

    # Obtenir le certificat
    certbot --nginx -d "$DOMAIN"

    # Remettre la config complete
    cp "$DEPLOY_DIR/nginx-gungnir.conf" /etc/nginx/sites-available/gungnir
    nginx -t && systemctl reload nginx

    log "SSL active pour $DOMAIN !"
}

# ── Logs ───────────────────────────────────────────────────────────────────
cmd_logs() {
    cd "$PROJECT_DIR"
    docker compose logs -f --tail=100
}

# ── Status ─────────────────────────────────────────────────────────────────
cmd_status() {
    cd "$PROJECT_DIR"
    echo ""
    docker compose ps
    echo ""

    # Health check
    if curl -sf http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
        HEALTH=$(curl -s http://127.0.0.1:8000/api/health)
        log "Backend: OK — $HEALTH"
    else
        err "Backend: DOWN"
    fi

    # Check nginx
    if curl -sf -o /dev/null "http://127.0.0.1:80" -H "Host: $DOMAIN" 2>/dev/null; then
        log "Nginx: OK"
    fi

    # Check SSL
    if curl -sf -o /dev/null "https://$DOMAIN/api/health" 2>/dev/null; then
        log "SSL: OK — https://$DOMAIN"
    else
        warn "SSL: pas encore actif ou DNS non pointe"
    fi
}

# ── Backup ─────────────────────────────────────────────────────────────────
cmd_backup() {
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_DIR="$DEPLOY_DIR/backups"
    BACKUP_FILE="$BACKUP_DIR/gungnir_backup_$TIMESTAMP.tar.gz"
    mkdir -p "$BACKUP_DIR"

    log "Backup des donnees..."

    if docker compose ps --format json 2>/dev/null | grep -q "running"; then
        docker compose exec -T app tar czf - -C /app data/ > "$BACKUP_FILE"
    else
        # Container down — backup depuis le volume (Postgres 16 via service `db`)
        docker compose exec -T db pg_dump -U gungnir gungnir > "${BACKUP_FILE%.tar.gz}.sql" && \
            gzip "${BACKUP_FILE%.tar.gz}.sql" || true
    fi

    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    log "Backup: $BACKUP_FILE ($SIZE)"

    # Garder les 10 derniers
    ls -t "$BACKUP_DIR/"gungnir_backup_*.tar.gz 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
}

# ── Stop ───────────────────────────────────────────────────────────────────
cmd_stop() {
    cd "$PROJECT_DIR"
    docker compose down
    log "Gungnir arrete."
}

# ── Shell (debug) ─────────────────────────────────────────────────────────
cmd_shell() {
    cd "$PROJECT_DIR"
    docker compose exec app /bin/bash
}

# ── Dispatch ───────────────────────────────────────────────────────────────
case "${1:-help}" in
    setup)  cmd_setup ;;
    update) cmd_update ;;
    ssl)    cmd_ssl ;;
    logs)   cmd_logs ;;
    status) cmd_status ;;
    backup) cmd_backup ;;
    stop)   cmd_stop ;;
    shell)  cmd_shell ;;
    *)
        echo ""
        echo "  Gungnir Deploy — https://$DOMAIN"
        echo ""
        echo "  Usage: $0 {command}"
        echo ""
        echo "  setup   Premier deploiement (build + nginx + lancement)"
        echo "  update  Rebuild apres git pull"
        echo "  ssl     Certificat Let's Encrypt"
        echo "  logs    Logs en temps reel"
        echo "  status  Etat container + health check"
        echo "  backup  Sauvegarder les donnees"
        echo "  stop    Arreter le container"
        echo "  shell   Ouvrir un bash dans le container"
        echo ""
        ;;
esac
