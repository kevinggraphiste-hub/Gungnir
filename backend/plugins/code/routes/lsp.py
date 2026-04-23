"""
WebSocket bridge entre le client CodeMirror (frontend) et un serveur LSP.

Chaque session = une WS ouverte vers `/api/plugins/code/lsp/{lang}?token=...`.
Le code fait du passe-plat JSON entre le client et le subprocess LSP, via le
LspPool per-user+workspace.

Auth : on vérifie le `token` query param (le middleware HTTP ne s'applique
pas aux WS upgrades en FastAPI ; il faut valider manuellement ici).
"""
from __future__ import annotations

import asyncio
import hashlib
import logging

from fastapi import Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from backend.plugins.code.lsp import lsp_pool, LSP_COMMANDS

logger = logging.getLogger("gungnir.plugins.code.lsp.ws")


async def _authenticate_ws(token: str | None) -> int | None:
    """Retourne le user_id si le token est valide, None sinon.

    - Si aucun user n'a de token → open mode (setup) → retourne 0 (share).
    - Sinon : SHA256 du token + lookup dans users.api_token.
    """
    if not token:
        # Open mode : pas de token requis tant qu'aucun user n'a logué.
        try:
            from backend.core.db.engine import async_session
            from backend.core.db.models import User
            async with async_session() as s:
                result = await s.execute(
                    select(User.api_token).where(User.api_token.isnot(None)).limit(1)
                )
                has_tokens = result.scalar() is not None
                if not has_tokens:
                    return 0
        except Exception:
            return None
        return None

    try:
        from backend.core.db.engine import async_session
        from backend.core.db.models import User
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        async with async_session() as s:
            result = await s.execute(
                select(User).where(User.api_token == token_hash, User.is_active == True)
            )
            user = result.scalar()
            if not user:
                return None
            from datetime import datetime as _dt
            if user.token_expires_at is not None and user.token_expires_at < _dt.utcnow():
                return None
            return int(user.id)
    except Exception as e:
        logger.warning(f"LSP WS auth error: {e}")
        return None


def register_lsp_ws(router) -> None:
    """Ajoute l'endpoint WS au router SpearCode (appelé depuis routes/__init__.py)."""

    @router.websocket("/lsp/{lang}")
    async def lsp_ws_endpoint(
        websocket: WebSocket,
        lang: str,
        token: str | None = Query(default=None),
    ):
        # Auth explicite (middleware HTTP ne s'applique pas aux WS)
        user_id = await _authenticate_ws(token)
        if user_id is None:
            await websocket.close(code=1008, reason="unauthorized")
            return

        # Validation du langage avant d'accepter la connexion
        if lang not in LSP_COMMANDS:
            await websocket.close(code=1008, reason=f"unsupported language: {lang}")
            return

        # Résolution du workspace per-user (même que les autres routes SpearCode)
        # On importe lazy pour éviter tout cycle — `_workspace` lit le ContextVar
        # `_current_user_id`, qu'on set ici manuellement car WS n'a pas traversé
        # la dep `_inject_user_id`.
        from backend.plugins.code.routes import _workspace, _current_user_id
        _current_user_id.set(user_id)
        workspace = _workspace()

        await websocket.accept()

        try:
            runner = await lsp_pool.get_or_start(
                user_id=user_id, language=lang, workspace=workspace,
            )
        except RuntimeError as e:
            await websocket.send_json({"error": str(e)})
            await websocket.close(code=1011, reason="lsp start failed")
            return

        logger.info(f"LSP WS connected uid={user_id} lang={lang}")

        # Deux tâches parallèles : pump WS→LSP et pump LSP→WS.
        # Une tâche qui se termine annule l'autre (fin de session).
        async def pump_ws_to_lsp():
            try:
                while True:
                    msg = await websocket.receive_json()
                    ok = await runner.send(msg)
                    if not ok:
                        break
            except WebSocketDisconnect:
                pass
            except Exception as e:
                logger.debug(f"LSP WS→LSP pump ended: {e}")

        async def pump_lsp_to_ws():
            try:
                while True:
                    msg = await runner.receive()
                    if msg is None:
                        break
                    await websocket.send_json(msg)
            except WebSocketDisconnect:
                pass
            except Exception as e:
                logger.debug(f"LSP LSP→WS pump ended: {e}")

        t1 = asyncio.create_task(pump_ws_to_lsp())
        t2 = asyncio.create_task(pump_lsp_to_ws())
        done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
        for p in pending:
            p.cancel()
        logger.info(f"LSP WS disconnected uid={user_id} lang={lang}")

        # On NE stoppe PAS le runner ici — il reste dans le pool pour la
        # prochaine session (idle cleanup gère la libération).
