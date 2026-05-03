#!/usr/bin/env bash
#
# Gungnir — Nettoyage VPS safe (Hostinger / cohabitation N8N + openclaw + agrégateur LLM).
#
# Usage : sudo bash scripts/clean_vps.sh [--deep]
#
# Phases :
#   1. Diagnostic        — read-only, montre où ça pèse
#   2. Safe prune        — images dangling + builder cache (ne touche jamais
#                          aux containers actifs ni aux images utilisées)
#   3. Gungnir cleanup   — vire les anciennes images Gungnir non utilisées
#   4. (--deep) Logs     — tronque les logs Docker > 100 Mo
#
# Ce qui n'est JAMAIS fait, même avec --deep :
#   - docker system prune -a --volumes (vire N8N / openclaw)
#   - docker volume prune (la DB Postgres Gungnir vit dans un volume)
#   - rm sur /var/lib/docker
#
# Ne lance que les phases 2 et 3 par défaut. --deep ajoute la phase 4.

set -euo pipefail

DEEP_MODE=false
if [[ "${1:-}" == "--deep" ]]; then
  DEEP_MODE=true
fi

bold() { printf "\n\033[1m== %s ==\033[0m\n" "$1"; }
info() { printf "  → %s\n" "$1"; }

# ── Phase 1 : Diagnostic ────────────────────────────────────────────────────
bold "Phase 1 — Diagnostic disque (avant)"
df -h / 2>/dev/null | tail -1 | awk '{printf "  Disque /  : %s utilisé sur %s (%s)\n", $3, $2, $5}'
docker system df 2>/dev/null || { echo "Docker indisponible, abandon"; exit 1; }

# ── Phase 2 : Safe prune ────────────────────────────────────────────────────
bold "Phase 2 — Safe prune (images dangling + builder cache)"
info "docker image prune -f"
docker image prune -f
info "docker builder prune -f"
docker builder prune -f

# ── Phase 3 : Gungnir cleanup ───────────────────────────────────────────────
# Cible : anciennes images Gungnir taguées qui ne sont utilisées par aucun
# container running. La logique --filter sur le label compose project est
# safe : ne matche QUE les images du projet "gungnir", pas N8N/openclaw.
bold "Phase 3 — Anciennes images Gungnir non utilisées"
GUNGNIR_FILTER="label=com.docker.compose.project=gungnir"
info "docker image prune -af --filter \"$GUNGNIR_FILTER\""
docker image prune -af --filter "$GUNGNIR_FILTER" || true

# Containers stoppés (orphelins de redémarrages successifs)
info "docker container prune -f --filter \"$GUNGNIR_FILTER\""
docker container prune -f --filter "$GUNGNIR_FILTER" || true

# ── Phase 4 (deep) : Logs Docker volumineux ─────────────────────────────────
if $DEEP_MODE; then
  bold "Phase 4 — Tronque les logs Docker > 100 Mo"
  while IFS= read -r logfile; do
    [[ -f "$logfile" ]] || continue
    size=$(stat -c%s "$logfile" 2>/dev/null || echo 0)
    if (( size > 100 * 1024 * 1024 )); then
      info "Tronque $logfile ($(numfmt --to=iec "$size"))"
      truncate -s 0 "$logfile"
    fi
  done < <(find /var/lib/docker/containers -name "*-json.log" 2>/dev/null)
fi

# ── Résumé ──────────────────────────────────────────────────────────────────
bold "Résumé final"
df -h / 2>/dev/null | tail -1 | awk '{printf "  Disque /  : %s utilisé sur %s (%s)\n", $3, $2, $5}'
docker system df 2>/dev/null

bold "OK"
echo "Pour aller plus loin (logs Docker), relance avec : sudo bash scripts/clean_vps.sh --deep"
echo "Pour automatiser hebdo (dimanche 4h) :"
echo "  echo '0 4 * * 0 cd /opt/gungnir && bash scripts/clean_vps.sh > /var/log/gungnir-clean.log 2>&1' | sudo crontab -"
