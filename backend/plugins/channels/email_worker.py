"""
email_worker.py — Polling IMAP + envoi SMTP pour le canal Email.

Pour chaque channel `email` enabled, une coroutine boucle sur IMAP UNSEEN,
appelle `_process_incoming` (partagé avec les autres canaux) avec le body
extrait, puis envoie la réponse de l'agent via SMTP avec les en-têtes de
threading (In-Reply-To, References) pour que le destinataire voie la réponse
dans le même fil.

Best-effort : connexion lourde (IMAP4_SSL synchrone via imaplib enroulé
dans run_in_executor pour rester async). Si le mot de passe est faux ou le
serveur down, on log et on retente après l'intervalle.
"""
from __future__ import annotations

import asyncio
import email
import imaplib
import logging
import smtplib
from email.message import EmailMessage
from email.utils import parseaddr, formatdate, make_msgid
from typing import Any

logger = logging.getLogger("gungnir.channels.email")

# Tâches actives par channel_id pour pouvoir les annuler à la mise à jour
_workers: dict[str, asyncio.Task] = {}


def _decode_part(part) -> str:
    """Décode un Message email payload en string en gérant l'encodage."""
    try:
        payload = part.get_payload(decode=True)
        if payload is None:
            return ""
        charset = part.get_content_charset() or "utf-8"
        return payload.decode(charset, errors="replace")
    except Exception:
        return ""


def _extract_body(msg: email.message.Message) -> str:
    """Extrait le corps texte d'un message email (préfère text/plain, fallback HTML stripped)."""
    if msg.is_multipart():
        # Cherche text/plain en premier
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = (part.get("Content-Disposition") or "").lower()
            if "attachment" in disp:
                continue
            if ctype == "text/plain":
                return _decode_part(part).strip()
        # Fallback HTML (strip basique)
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                html = _decode_part(part)
                import re as _re
                text = _re.sub(r"<[^>]+>", " ", html)
                text = _re.sub(r"\s+", " ", text)
                return text.strip()
        return ""
    return _decode_part(msg).strip()


def _imap_fetch_unseen(host: str, port: int, user: str, password: str, mailbox: str = "INBOX") -> list[tuple[bytes, email.message.Message]]:
    """SYNC : connexion IMAP, récupère les messages UNSEEN, marque comme lu.
    Retourne [(uid, parsed_msg), ...]. Appelé via run_in_executor.
    """
    out: list[tuple[bytes, email.message.Message]] = []
    imap = imaplib.IMAP4_SSL(host, port)
    try:
        imap.login(user, password)
        imap.select(mailbox)
        typ, data = imap.search(None, "UNSEEN")
        if typ != "OK" or not data or not data[0]:
            return out
        uids = data[0].split()
        # Cap à 10 pour ne pas saturer le contexte agent en cas de retard
        for uid in uids[:10]:
            typ, fetched = imap.fetch(uid, "(RFC822)")
            if typ != "OK" or not fetched:
                continue
            for resp in fetched:
                if isinstance(resp, tuple) and len(resp) >= 2:
                    raw = resp[1]
                    if isinstance(raw, bytes):
                        msg = email.message_from_bytes(raw)
                        out.append((uid, msg))
                    break
            # Marque comme lu (on a pris le boulot, faut pas le re-traiter)
            imap.store(uid, "+FLAGS", "\\Seen")
    finally:
        try:
            imap.logout()
        except Exception:
            pass
    return out


def _smtp_send_reply(
    host: str, port: int, user: str, password: str,
    to_addr: str, subject: str, body: str,
    in_reply_to: str | None, references: str | None,
    from_addr: str | None = None,
) -> None:
    """SYNC : envoi SMTP avec threading correct."""
    msg = EmailMessage()
    msg["From"] = from_addr or user
    msg["To"] = to_addr
    msg["Subject"] = subject if subject.lower().startswith("re:") else f"Re: {subject}"
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid()
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = (references + " " + in_reply_to) if references else in_reply_to
    msg.set_content(body or "(réponse vide)")

    with smtplib.SMTP(host, port) as s:
        s.starttls()
        s.login(user, password)
        s.send_message(msg)


async def _email_loop_for_channel(channel_id: str, user_id: int) -> None:
    """Boucle de polling pour un channel email donné."""
    from backend.plugins.channels.routes import (
        _load_user_channels, _process_incoming, _add_log,
    )
    loop = asyncio.get_event_loop()
    while True:
        try:
            channels = _load_user_channels(user_id)
            ch = channels.get(channel_id)
            if not ch or ch.get("type") != "email" or not ch.get("enabled"):
                logger.info(f"email channel {channel_id} disabled/removed — stop loop")
                return
            cfg = ch.get("config", {}) or {}
            host = cfg.get("imap_host", "")
            port = int(cfg.get("imap_port") or 993)
            user = cfg.get("email_address", "")
            password = cfg.get("email_password", "")
            interval = max(30, int(cfg.get("check_interval") or 60))
            if not host or not user or not password:
                logger.warning(f"email channel {channel_id} incomplete config")
                await asyncio.sleep(interval)
                continue

            try:
                msgs = await loop.run_in_executor(
                    None, _imap_fetch_unseen, host, port, user, password
                )
            except Exception as e:
                _add_log(channel_id, ch.get("name", ""), "fetch", f"IMAP fail: {e}", "error")
                await asyncio.sleep(interval)
                continue

            for uid, msg in msgs:
                try:
                    sender_full = msg.get("From", "")
                    sender_name, sender_email = parseaddr(sender_full)
                    subject = msg.get("Subject", "(sans sujet)")
                    msg_id = msg.get("Message-ID", "")
                    refs = msg.get("References", "")
                    body = _extract_body(msg)
                    if not body:
                        continue
                    # Limite pour ne pas blow up le contexte
                    body_capped = body[:8000]
                    text_in = f"Sujet: {subject}\n\n{body_capped}"
                    _add_log(
                        channel_id, ch.get("name", ""), "incoming",
                        f"From {sender_email} — {subject[:80]}", "ok",
                    )
                    response = await _process_incoming(
                        channel_id, text_in,
                        sender_id=sender_email or "unknown",
                        sender_name=sender_name or sender_email or "unknown",
                        metadata={"email_subject": subject, "message_id": msg_id},
                    )
                    if response:
                        try:
                            smtp_host = cfg.get("smtp_host", "")
                            smtp_port = int(cfg.get("smtp_port") or 587)
                            await loop.run_in_executor(
                                None, _smtp_send_reply,
                                smtp_host, smtp_port, user, password,
                                sender_email, subject, response,
                                msg_id, refs, user,
                            )
                            _add_log(
                                channel_id, ch.get("name", ""), "outgoing",
                                f"To {sender_email}", "ok",
                            )
                        except Exception as e:
                            _add_log(
                                channel_id, ch.get("name", ""), "outgoing",
                                f"SMTP fail to {sender_email}: {e}", "error",
                            )
                except Exception as e:
                    logger.exception(f"email msg processing failed: {e}")

            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.exception(f"email loop error for {channel_id}: {e}")
            await asyncio.sleep(60)


def start_worker(channel_id: str, user_id: int) -> None:
    """Démarre la boucle de polling pour un channel email (idempotent)."""
    existing = _workers.get(channel_id)
    if existing and not existing.done():
        return
    try:
        task = asyncio.create_task(_email_loop_for_channel(channel_id, user_id))
        _workers[channel_id] = task
        logger.info(f"email worker started: channel={channel_id} user={user_id}")
    except RuntimeError:
        # Pas dans un event loop — silent (sera relancé au prochain on_startup)
        pass


def stop_worker(channel_id: str) -> None:
    task = _workers.pop(channel_id, None)
    if task and not task.done():
        task.cancel()


def stop_all() -> None:
    for cid in list(_workers.keys()):
        stop_worker(cid)


async def restart_all_active_workers() -> None:
    """Scanne tous les users, démarre un worker pour chaque channel email enabled.
    Appelé au boot via on_startup et après mise à jour de channel.
    """
    from backend.plugins.channels.routes import CHANNELS_BASE
    if not CHANNELS_BASE.exists():
        return
    for user_dir in CHANNELS_BASE.iterdir():
        if not user_dir.is_dir() or not user_dir.name.isdigit():
            continue
        try:
            uid = int(user_dir.name)
        except ValueError:
            continue
        from backend.plugins.channels.routes import _load_user_channels
        channels = _load_user_channels(uid)
        for cid, ch in channels.items():
            if ch.get("type") == "email" and ch.get("enabled"):
                start_worker(cid, uid)
