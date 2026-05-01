"""
Gungnir — Service d'envoi d'emails transactionnels.

Utilisé pour la vérification d'email à la création de compte et pour la
récupération de mot de passe. Deux backends supportés, dans l'ordre :

1. **Resend** (recommandé) — API HTTP REST, set ``RESEND_API_KEY`` dans
   l'env. Plus simple à déployer, dashboard pour debug, free tier 3k/mois.
2. **SMTP générique** (fallback) — set ``SMTP_HOST`` + ``SMTP_PORT`` +
   ``SMTP_USER`` + ``SMTP_PASSWORD``. Utilise ``smtplib`` de la stdlib.

Si aucun des deux n'est configuré, ``send_email()`` log un warning et
renvoie ``False`` sans crasher — la route appelante doit gérer le cas
(typiquement : répondre 200 OK quand même pour ne pas révéler l'absence
de SMTP côté client).

Variables d'env supplémentaires (utiles dans tous les cas) :
- ``MAIL_FROM`` (défaut: ``Gungnir <noreply@gungnir.scarletwolf.ch>``)
- ``PUBLIC_BASE_URL`` (défaut: ``https://gungnir.scarletwolf.ch``) —
  utilisé pour construire les liens dans les emails.
"""
from __future__ import annotations

import logging
import os
import smtplib
import ssl
from email.message import EmailMessage
from typing import Final

import httpx

logger = logging.getLogger("gungnir.mail")

DEFAULT_FROM: Final = "Gungnir <noreply@gungnir.scarletwolf.ch>"
DEFAULT_BASE_URL: Final = "https://gungnir.scarletwolf.ch"


def public_base_url() -> str:
    return os.environ.get("PUBLIC_BASE_URL", DEFAULT_BASE_URL).rstrip("/")


def mail_from() -> str:
    return os.environ.get("MAIL_FROM", DEFAULT_FROM)


def is_configured() -> bool:
    """True si au moins un backend mail est configuré."""
    return bool(os.environ.get("RESEND_API_KEY") or os.environ.get("SMTP_HOST"))


async def send_email(*, to: str, subject: str, text: str, html: str | None = None) -> bool:
    """Envoie un email. Renvoie True si succès, False si échec ou non configuré.

    Ne lève jamais — les erreurs sont loggées. Le caller décide quoi faire
    (typiquement : continuer comme si tout allait bien pour ne pas leak
    d'info à l'attaquant).
    """
    if not to or "@" not in to:
        logger.warning("send_email: invalid recipient %r", to)
        return False

    api_key = os.environ.get("RESEND_API_KEY")
    if api_key:
        return await _send_resend(api_key=api_key, to=to, subject=subject, text=text, html=html)

    smtp_host = os.environ.get("SMTP_HOST")
    if smtp_host:
        return _send_smtp(host=smtp_host, to=to, subject=subject, text=text, html=html)

    logger.warning(
        "send_email: aucun backend configuré (RESEND_API_KEY ou SMTP_HOST). "
        "Mail vers %r non envoyé. Sujet: %r",
        to, subject,
    )
    return False


async def _send_resend(*, api_key: str, to: str, subject: str, text: str, html: str | None) -> bool:
    """Backend Resend (https://resend.com/docs/api-reference/emails/send-email)."""
    payload: dict = {
        "from": mail_from(),
        "to": [to],
        "subject": subject,
        "text": text,
    }
    if html:
        payload["html"] = html
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
        if r.status_code >= 400:
            logger.error("Resend %d: %s (to=%s)", r.status_code, r.text[:200], to)
            return False
        return True
    except Exception as e:
        logger.error("Resend send failed (to=%s): %s", to, e)
        return False


def _send_smtp(*, host: str, to: str, subject: str, text: str, html: str | None) -> bool:
    """Backend SMTP générique (Hostinger Mail, Gmail SMTP, etc.)."""
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASSWORD", "")
    use_ssl = os.environ.get("SMTP_SSL", "").lower() in {"1", "true", "yes"}

    msg = EmailMessage()
    msg["From"] = mail_from()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")

    try:
        if use_ssl or port == 465:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=context, timeout=15) as s:
                if user:
                    s.login(user, password)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=15) as s:
                s.ehlo()
                try:
                    s.starttls(context=ssl.create_default_context())
                    s.ehlo()
                except Exception:
                    pass
                if user:
                    s.login(user, password)
                s.send_message(msg)
        return True
    except Exception as e:
        logger.error("SMTP send failed (to=%s, host=%s): %s", to, host, e)
        return False


# ── Templates ─────────────────────────────────────────────────────────────


async def send_password_reset(*, to: str, display_name: str, token: str) -> bool:
    link = f"{public_base_url()}/reset-password?token={token}"
    subject = "Gungnir — Réinitialisation de mot de passe"
    text = (
        f"Salut {display_name or to},\n\n"
        f"Tu as demandé à réinitialiser ton mot de passe Gungnir.\n"
        f"Clique sur le lien ci-dessous (valable 1 heure) :\n\n"
        f"{link}\n\n"
        f"Si tu n'es pas à l'origine de cette demande, ignore cet email — "
        f"ton mot de passe actuel reste inchangé.\n\n"
        f"— Gungnir"
    )
    html = (
        f"<p>Salut {display_name or to},</p>"
        f"<p>Tu as demandé à réinitialiser ton mot de passe Gungnir.</p>"
        f"<p><a href=\"{link}\">Réinitialiser mon mot de passe</a> (valable 1 heure)</p>"
        f"<p>Si tu n'es pas à l'origine de cette demande, ignore cet email — "
        f"ton mot de passe actuel reste inchangé.</p>"
        f"<p>— Gungnir</p>"
    )
    return await send_email(to=to, subject=subject, text=text, html=html)


async def send_email_verification(*, to: str, display_name: str, token: str) -> bool:
    link = f"{public_base_url()}/verify-email?token={token}"
    subject = "Gungnir — Confirme ton adresse email"
    text = (
        f"Salut {display_name or to},\n\n"
        f"Bienvenue sur Gungnir. Pour activer la récupération de mot de passe, "
        f"confirme ton adresse en cliquant sur le lien ci-dessous (valable 24h) :\n\n"
        f"{link}\n\n"
        f"Si tu n'as pas créé de compte Gungnir, ignore cet email.\n\n"
        f"— Gungnir"
    )
    html = (
        f"<p>Salut {display_name or to},</p>"
        f"<p>Bienvenue sur Gungnir. Pour activer la récupération de mot de passe, "
        f"confirme ton adresse :</p>"
        f"<p><a href=\"{link}\">Confirmer mon adresse email</a> (valable 24h)</p>"
        f"<p>Si tu n'as pas créé de compte Gungnir, ignore cet email.</p>"
        f"<p>— Gungnir</p>"
    )
    return await send_email(to=to, subject=subject, text=text, html=html)
