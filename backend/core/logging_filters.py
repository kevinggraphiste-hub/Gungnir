"""
Filtre de logs Gungnir — masque les secrets dans les messages avant qu'ils
ne soient écrits (stdout, fichier, agrégateur). Attaché au root logger au
boot dans `main.py`.

Ce qu'on redacte :
- `api_key=...`, `api-key=...`, `apikey=...`
- `token=...`, `access_token=...`, `refresh_token=...`
- `password=...`
- `secret=...`, `client_secret=...`
- Header `Authorization: Bearer <token>`
- Valeurs chiffrées (`GCM:v3:...` AES-GCM ; `FERNET:...` Fernet legacy) —
  déjà chiffrées, mais inutile en logs
- Tokens hexadécimaux longs (32+ caractères) qui ressemblent à des clés

Fix sécu M9. Non-intrusif : si un pattern n'est pas matché, le message
passe tel quel. Les tracebacks restent lisibles.
"""
from __future__ import annotations

import logging
import re

# Patterns compilés une fois
_PATTERNS: list[tuple[re.Pattern, str]] = [
    # Paires clé=valeur communes (séparateurs : =, :, "=", ': ')
    (re.compile(
        r'(?i)\b('
        r'api[_-]?key|api_token|access[_-]?token|refresh[_-]?token|'
        r'bearer|auth|token|password|passwd|secret|client[_-]?secret|'
        r'private[_-]?key'
        r')\b\s*[:=]\s*["\']?([A-Za-z0-9._\-+/=]{8,})["\']?'
    ), r'\1=***REDACTED***'),
    # Authorization: Bearer <token>
    (re.compile(r'(?i)(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._\-+/=]+'),
     r'\1***REDACTED***'),
    # Valeurs FERNET:xxx (legacy)
    (re.compile(r'FERNET:[A-Za-z0-9._\-+/=]{20,}'), 'FERNET:***REDACTED***'),
    # Valeurs GCM:v3:xxx (AES-256-GCM, format courant)
    (re.compile(r'GCM:v\d+:[A-Za-z0-9._\-+/=]{20,}'), 'GCM:***REDACTED***'),
    # Tokens hex longs (32+ hex chars) — typiquement nos `secrets.token_hex(32)`
    (re.compile(r'\b[0-9a-f]{64,}\b'), '***REDACTED_HEX***'),
]


def _redact(text: str) -> str:
    if not text:
        return text
    for pat, repl in _PATTERNS:
        text = pat.sub(repl, text)
    return text


class RedactSecretsFilter(logging.Filter):
    """Filtre logging qui masque les patterns sensibles dans msg + args.

    Appliqué au niveau du root logger ⇒ tous les handlers héritent (console,
    fichier, etc.).
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            # On redacte le message formaté final. La propriété `msg` peut être
            # une string template (%s) avec args dans record.args ; on redacte
            # les deux pour couvrir les deux styles d'appel.
            if isinstance(record.msg, str):
                record.msg = _redact(record.msg)
            if record.args:
                if isinstance(record.args, dict):
                    record.args = {k: _redact(str(v)) for k, v in record.args.items()}
                elif isinstance(record.args, tuple):
                    record.args = tuple(
                        _redact(str(a)) if isinstance(a, (str, bytes)) else a
                        for a in record.args
                    )
        except Exception:
            # Un filtre qui crash ne doit jamais empêcher le log d'être émis.
            pass
        return True


def install_redaction_filter() -> None:
    """À appeler au boot pour attacher le filtre au root logger."""
    root = logging.getLogger()
    # Idempotent : ne pas en ajouter deux si déjà installé
    for f in root.filters:
        if isinstance(f, RedactSecretsFilter):
            return
    root.addFilter(RedactSecretsFilter())
    # Et sur chaque handler déjà attaché (plus sûr — certains loggers
    # héritent via un chemin qui ne passe pas par root.filters).
    for h in root.handlers:
        already = any(isinstance(f, RedactSecretsFilter) for f in h.filters)
        if not already:
            h.addFilter(RedactSecretsFilter())
