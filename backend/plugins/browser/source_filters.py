"""
HuntR — Source reliability filters

Principe : on NE décide PAS de ce qui est "fiable" pour l'utilisateur. On
livre une starter list courte et défendable (propagande d'État sanctionnée,
fermes de désinformation documentées) en opt-in, et on laisse l'user
gérer sa propre block/allowlist par-dessus.

La starter list contient UNIQUEMENT des sources :
- Sanctionnées par l'UE ou le Royaume-Uni comme média de propagande d'État
  (RT, Sputnik, PressTV, CGTN, Xinhua, People's Daily)
- Notées comme diffusant systématiquement de la désinformation par plusieurs
  fact-checkers indépendants (naturalnews, infowars, gatewaypundit)

On exclut intentionnellement :
- Les tabloïds (Daily Mail, Sun, Bild…) — ils sont biaisés mais pas propagande
- Les médias mainstream à ligne éditoriale marquée (Fox News, CNews, HuffPost,
  Libération, Le Figaro…) — contestable politiquement dans les deux sens
- Les plateformes sociales (Reddit, Facebook, Twitter/X) — selon le contexte
Ces choix sont laissés à la blocklist user.
"""
from __future__ import annotations

from urllib.parse import urlsplit


# ── Starter blocklist (opt-in, désactivée par défaut) ──────────────────────
#
# Sources documentées par des sources indépendantes multiples (UE, gov UK,
# NewsGuard, fact-checkers) comme diffusant de la propagande d'État ou
# de la désinformation systématique. Chaque entrée = domaine racine, le
# matching se fait par suffixe (donc "rt.com" matche "edition.rt.com").
STARTER_BLOCKLIST: dict[str, str] = {
    # Propagande d'État sanctionnée par l'UE (règlement 833/2014 + 2022)
    "rt.com": "Propagande d'État russe — sanctionnée UE 2022",
    "sputniknews.com": "Propagande d'État russe — sanctionnée UE 2022",
    "sputnikglobe.com": "Propagande d'État russe — sanctionnée UE 2022",
    "sputniknews.africa": "Propagande d'État russe — sanctionnée UE 2022",
    "ria.ru": "Média d'État russe (RIA Novosti)",
    "tass.com": "Média d'État russe (TASS)",
    "tass.ru": "Média d'État russe (TASS)",
    # Propagande d'État iranienne
    "presstv.ir": "Média d'État iranien — sanctionné UE",
    "presstv.com": "Média d'État iranien — sanctionné UE",
    # Propagande d'État chinoise (ofcom UK, CGTN license révoquée 2021)
    "cgtn.com": "Média d'État chinois — licence UK révoquée 2021",
    "cgtn.cn": "Média d'État chinois",
    "xinhuanet.com": "Agence d'État chinoise Xinhua",
    "chinadaily.com.cn": "Média d'État chinois",
    "globaltimes.cn": "Média d'État chinois (affilié People's Daily)",
    "peopledaily.com.cn": "Média d'État chinois (Parti communiste)",
    # Désinformation systématique (NewsGuard < 10/100, multiple fact-checkers)
    "naturalnews.com": "Désinformation santé systématique (NewsGuard 12.5/100)",
    "infowars.com": "Théories conspirationnistes documentées",
    "thegatewaypundit.com": "Désinformation politique récurrente",
    "beforeitsnews.com": "Content farm de désinformation",
    "worldtruth.tv": "Théories conspirationnistes",
}


def _normalize_host(url: str) -> str:
    """Extrait le hostname d'une URL, lowercase, sans www."""
    try:
        parts = urlsplit(url.strip())
        host = parts.netloc.lower().split(":")[0]
        if host.startswith("www."):
            host = host[4:]
        return host
    except Exception:
        return ""


def _matches_domain(host: str, domain: str) -> bool:
    """Match par suffixe : `edition.rt.com` matche `rt.com`.

    On exige soit l'égalité exacte, soit un séparateur `.` juste avant le
    domaine pour éviter les faux positifs (`notrt.com` NE matche PAS `rt.com`).
    """
    if not host or not domain:
        return False
    host = host.lower()
    domain = domain.lower().lstrip(".")
    if host == domain:
        return True
    return host.endswith("." + domain)


def _host_in_list(host: str, domains: list[str]) -> bool:
    """Vrai si `host` matche au moins un domaine de la liste."""
    for d in domains or []:
        if d and _matches_domain(host, str(d).strip()):
            return True
    return False


def get_effective_blocklist(config: dict) -> list[tuple[str, str]]:
    """Fusionne la starter list (si activée) et la blocklist user.

    Retourne une liste de (domaine, raison). La raison est utile pour le
    log et l'UI.
    """
    out: list[tuple[str, str]] = []
    cfg = config or {}
    if cfg.get("use_starter_blocklist", False):
        out.extend(STARTER_BLOCKLIST.items())
    user = cfg.get("blocklist") or []
    for d in user:
        if isinstance(d, str) and d.strip():
            out.append((d.strip().lower(), "Ajouté par l'utilisateur"))
    return out


def apply_source_filters(results: list, config: dict) -> tuple[list, dict]:
    """Filtre + re-rank la liste de SearchResult selon la config user.

    Modes d'allowlist :
      - "off"    : pas d'allowlist (défaut)
      - "boost"  : allowlistés remontent en tête, le reste suit
      - "strict" : seuls les allowlistés passent

    Retourne (results_filtrés, rapport). Le rapport contient :
      - filtered_count : nombre de résultats retirés par blocklist
      - blocked_domains : ensemble unique des domaines bloqués rencontrés
      - boosted_count / kept_only_count selon le mode allowlist
    """
    cfg = config or {}
    effective_block = get_effective_blocklist(cfg)
    block_domains = [d for d, _ in effective_block]
    allow_list = [str(d).strip().lower() for d in (cfg.get("allowlist") or []) if str(d).strip()]
    allow_mode = (cfg.get("allowlist_mode") or "off").lower()
    if allow_mode not in ("off", "boost", "strict"):
        allow_mode = "off"

    report = {
        "blocked_count": 0,
        "blocked_domains": [],
        "boosted_count": 0,
        "mode": allow_mode,
    }
    blocked_seen: dict[str, str] = {}

    # 1. Bloquer ce qui est dans la blocklist
    surviving = []
    for r in results or []:
        host = _normalize_host(getattr(r, "url", "") or "")
        matched = None
        for d in block_domains:
            if _matches_domain(host, d):
                matched = d
                break
        if matched:
            report["blocked_count"] += 1
            reason = next((why for dom, why in effective_block if dom == matched), "")
            blocked_seen[matched] = reason
            continue
        surviving.append(r)

    report["blocked_domains"] = [
        {"domain": d, "reason": why} for d, why in blocked_seen.items()
    ]

    # 2. Allowlist
    if allow_mode == "strict" and allow_list:
        before = len(surviving)
        surviving = [
            r for r in surviving
            if _host_in_list(_normalize_host(getattr(r, "url", "") or ""), allow_list)
        ]
        report["kept_only_count"] = len(surviving)
        report["strict_dropped"] = before - len(surviving)
    elif allow_mode == "boost" and allow_list:
        preferred, others = [], []
        for r in surviving:
            host = _normalize_host(getattr(r, "url", "") or "")
            (preferred if _host_in_list(host, allow_list) else others).append(r)
        report["boosted_count"] = len(preferred)
        surviving = preferred + others

    return surviving, report
