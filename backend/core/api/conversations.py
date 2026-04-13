from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.core.config.settings import Settings
from backend.core.db.models import Conversation, Message, User, ConversationTag, ConversationTagLink
from backend.core.db.engine import get_session
from backend.core.providers import get_provider, ChatMessage
from backend.core.api.auth_helpers import enforce_conversation_owner

router = APIRouter()


@router.get("/conversations")
async def list_conversations(request: Request, user_id: int = None, session: AsyncSession = Depends(get_session)):
    # Server-side enforcement: always filter by authenticated user
    auth_user_id = getattr(request.state, "user_id", None)
    if auth_user_id:
        # Admin can see all, regular user sees only their own
        user = await session.get(User, auth_user_id)
        if not (user and user.is_admin):
            user_id = auth_user_id  # Force filter to own conversations
    query = select(Conversation).order_by(Conversation.updated_at.desc()).limit(200)
    if user_id is not None:
        query = query.where(Conversation.user_id == user_id)
    result = await session.execute(query)
    convos = result.scalars().all()

    # Charge tous les tags liés en une seule requête pour éviter N+1
    conv_ids = [c.id for c in convos]
    tags_by_conv: dict[int, list] = {}
    if conv_ids:
        tag_result = await session.execute(
            select(ConversationTagLink.conversation_id, ConversationTag.id, ConversationTag.name, ConversationTag.color)
            .join(ConversationTag, ConversationTag.id == ConversationTagLink.tag_id)
            .where(ConversationTagLink.conversation_id.in_(conv_ids))
        )
        for conv_id, tid, tname, tcolor in tag_result.all():
            tags_by_conv.setdefault(conv_id, []).append({"id": tid, "name": tname, "color": tcolor})

    return [
        {
            "id": c.id,
            "user_id": c.user_id,
            "title": c.title,
            "provider": c.provider,
            "model": c.model,
            "created_at": c.created_at.isoformat(),
            "updated_at": c.updated_at.isoformat(),
            "folder_id": c.folder_id,
            "is_pinned": c.is_pinned,
            "tags": tags_by_conv.get(c.id, []),
        }
        for c in convos
    ]


@router.post("/conversations")
async def create_conversation(request: Request, data: dict, session: AsyncSession = Depends(get_session)):
    title = data.get("title", "Nouvelle conversation").strip()
    if len(title) > 500:
        return {"error": "Title too long (max 500 chars)"}
    provider = data.get("provider", "openrouter")
    if len(provider) > 100:
        return {"error": "Invalid provider name"}
    model = data.get("model", "anthropic/claude-3.5-sonnet")
    if len(model) > 200:
        return {"error": "Invalid model name"}
    # Always use authenticated user's ID, not client-provided
    auth_user_id = getattr(request.state, "user_id", None)
    conv = Conversation(
        title=title,
        provider=provider,
        model=model,
        user_id=auth_user_id or data.get("user_id"),
    )
    session.add(conv)
    await session.commit()
    await session.refresh(conv)
    return {
        "id": conv.id,
        "user_id": conv.user_id,
        "title": conv.title,
        "provider": conv.provider,
        "model": conv.model,
        "created_at": conv.created_at.isoformat(),
        "updated_at": conv.updated_at.isoformat(),
    }


@router.delete("/conversations/{convo_id}")
async def delete_conversation(convo_id: int, request: Request, session: AsyncSession = Depends(get_session)):
    convo = await enforce_conversation_owner(convo_id, request, session)
    if not convo:
        return JSONResponse({"error": "Conversation introuvable ou non autorisé"}, status_code=403)

    await session.delete(convo)
    await session.commit()
    return {"ok": True}


@router.put("/conversations/{convo_id}")
async def update_conversation(convo_id: int, request: Request, data: dict, session: AsyncSession = Depends(get_session)):
    convo = await enforce_conversation_owner(convo_id, request, session)
    if not convo:
        return JSONResponse({"error": "Conversation introuvable ou non autorisé"}, status_code=403)

    if "title" in data:
        convo.title = data["title"]
        # Marque le titre comme édité manuellement pour éviter les régénérations auto
        meta = dict(convo.metadata_json or {})
        meta["title_manual"] = True
        convo.metadata_json = meta
    if "provider" in data:
        convo.provider = data["provider"]
    if "model" in data:
        convo.model = data["model"]

    convo.updated_at = __import__("datetime").datetime.utcnow()
    await session.commit()
    await session.refresh(convo)
    return {"id": convo.id, "title": convo.title, "provider": convo.provider, "model": convo.model}


@router.get("/conversations/{convo_id}/messages")
async def get_messages(convo_id: int, request: Request, session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(Message).where(Message.conversation_id == convo_id).order_by(Message.created_at)
    )
    msgs = result.scalars().all()
    return [
        {
            "id": m.id,
            "role": m.role,
            "content": m.content,
            "tool_calls": m.tool_calls,
            "created_at": m.created_at.isoformat(),
        }
        for m in msgs
    ]


@router.get("/conversations/{convo_id}/export/{fmt}")
async def export_conversation(convo_id: int, fmt: str, session: AsyncSession = Depends(get_session)):
    """
    Exporte une conversation dans le format demandé.
    Formats supportés : json, txt, md, html
    """
    # Récupérer la conversation + messages
    conv = await session.get(Conversation, convo_id)
    if not conv:
        return {"error": "Conversation introuvable"}

    result = await session.execute(
        select(Message).where(Message.conversation_id == convo_id).order_by(Message.created_at)
    )
    msgs = result.scalars().all()

    if fmt == "json":
        import json as _j
        data = {
            "id": conv.id,
            "title": conv.title,
            "provider": conv.provider,
            "model": conv.model,
            "created_at": conv.created_at.isoformat(),
            "updated_at": conv.updated_at.isoformat(),
            "messages": [
                {
                    "role": m.role,
                    "content": m.content,
                    "created_at": m.created_at.isoformat(),
                }
                for m in msgs
            ],
        }
        return Response(
            content=_j.dumps(data, ensure_ascii=False, indent=2),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="conversation_{convo_id}.json"'},
        )

    elif fmt == "txt":
        lines = [f"=== {conv.title} ===", f"Modèle: {conv.model}", f"Date: {conv.created_at.isoformat()}", ""]
        for m in msgs:
            prefix = "🧑 Utilisateur" if m.role == "user" else "🤖 Wolf"
            lines.append(f"--- {prefix} ({m.created_at.strftime('%H:%M:%S')}) ---")
            lines.append(m.content or "")
            lines.append("")
        return Response(
            content="\n".join(lines),
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="conversation_{convo_id}.txt"'},
        )

    elif fmt == "md":
        lines = [f"# {conv.title}", "", f"**Modèle:** {conv.model}  ", f"**Date:** {conv.created_at.isoformat()}", "", "---", ""]
        for m in msgs:
            if m.role == "user":
                lines.append(f"### 🧑 Utilisateur")
            else:
                lines.append(f"### 🤖 Wolf")
            lines.append("")
            lines.append(m.content or "")
            lines.append("")
        return Response(
            content="\n".join(lines),
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="conversation_{convo_id}.md"'},
        )

    elif fmt == "html":
        html_parts = [
            "<!DOCTYPE html><html><head><meta charset='utf-8'>",
            f"<title>{(conv.title or '').replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')}</title>",
            "<style>",
            "body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;background:#1a1a2e;color:#e0e0e0}",
            ".msg{padding:12px 16px;margin:8px 0;border-radius:12px}",
            ".user{background:#2d3561;border-left:3px solid #7c83fd}",
            ".assistant{background:#1e3a4f;border-left:3px solid #4fc3f7}",
            ".role{font-weight:bold;margin-bottom:4px;font-size:0.85em;opacity:0.7}",
            ".time{font-size:0.75em;opacity:0.5;margin-left:8px}",
            "h1{color:#7c83fd}pre{background:#111;padding:8px;border-radius:4px;overflow-x:auto}",
            "</style></head><body>",
            f"<h1>{(conv.title or '').replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')}</h1>",
            f"<p><strong>Modèle:</strong> {(conv.model or '').replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')} | <strong>Date:</strong> {conv.created_at.strftime('%d/%m/%Y %H:%M')}</p><hr>",
        ]
        for m in msgs:
            cls = "user" if m.role == "user" else "assistant"
            role = "🧑 Utilisateur" if m.role == "user" else "🤖 Wolf"
            time_str = m.created_at.strftime('%H:%M:%S')
            # Échapper le HTML basique dans le contenu
            content = (m.content or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")
            html_parts.append(f'<div class="msg {cls}"><div class="role">{role}<span class="time">{time_str}</span></div>{content}</div>')
        html_parts.append("</body></html>")
        return Response(
            content="\n".join(html_parts),
            media_type="text/html; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="conversation_{convo_id}.html"'},
        )

    elif fmt == "pdf":
        try:
            from io import BytesIO
            from reportlab.lib.pagesizes import A4
            from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
            from reportlab.lib.units import cm
            from reportlab.lib.colors import HexColor
            from reportlab.platypus import (
                SimpleDocTemplate, Paragraph, Spacer, HRFlowable
            )
            from reportlab.lib.enums import TA_LEFT
        except ImportError:
            return {"error": "reportlab non installé côté serveur"}

        buf = BytesIO()
        doc = SimpleDocTemplate(
            buf, pagesize=A4,
            leftMargin=2*cm, rightMargin=2*cm,
            topMargin=2*cm, bottomMargin=2*cm,
            title=(conv.title or "Conversation"),
            author="Gungnir",
        )

        base = getSampleStyleSheet()
        title_style = ParagraphStyle(
            "GungnirTitle", parent=base["Title"],
            textColor=HexColor("#dc2626"), fontSize=20, leading=26, spaceAfter=6,
        )
        meta_style = ParagraphStyle(
            "GungnirMeta", parent=base["Normal"],
            textColor=HexColor("#666666"), fontSize=9, leading=12, spaceAfter=10,
        )
        user_label = ParagraphStyle(
            "UserLabel", parent=base["Normal"],
            textColor=HexColor("#1e3a8a"), fontSize=10, leading=14,
            fontName="Helvetica-Bold", spaceBefore=8, spaceAfter=2,
        )
        assistant_label = ParagraphStyle(
            "AssistantLabel", parent=base["Normal"],
            textColor=HexColor("#b91c1c"), fontSize=10, leading=14,
            fontName="Helvetica-Bold", spaceBefore=8, spaceAfter=2,
        )
        body_style = ParagraphStyle(
            "Body", parent=base["BodyText"],
            fontSize=10, leading=14, alignment=TA_LEFT, spaceAfter=4,
        )

        def _escape(text: str) -> str:
            if not text:
                return ""
            safe = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            return safe.replace("\n", "<br/>")

        flow = []
        flow.append(Paragraph(_escape(conv.title or "Conversation"), title_style))
        flow.append(Paragraph(
            f"Modèle : {_escape(conv.model or '')} &nbsp;&nbsp;•&nbsp;&nbsp; "
            f"Date : {conv.created_at.strftime('%d/%m/%Y %H:%M')}",
            meta_style,
        ))
        flow.append(HRFlowable(width="100%", thickness=0.5, color=HexColor("#dc2626")))
        flow.append(Spacer(1, 0.3*cm))

        for m in msgs:
            label = "Utilisateur" if m.role == "user" else "Wolf"
            time_str = m.created_at.strftime("%H:%M:%S")
            flow.append(Paragraph(
                f"{label} <font size='8' color='#999999'>· {time_str}</font>",
                user_label if m.role == "user" else assistant_label,
            ))
            # Paragraph par ligne/bloc pour gérer les retours à la ligne correctement
            content = _escape(m.content or "")
            if content:
                flow.append(Paragraph(content, body_style))

        doc.build(flow)
        pdf_bytes = buf.getvalue()
        buf.close()
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="conversation_{convo_id}.pdf"'},
        )

    else:
        return {"error": f"Format '{fmt}' non supporté. Formats: json, txt, md, html, pdf"}


@router.post("/conversations/{convo_id}/generate-title")
async def generate_conversation_title(convo_id: int, request: Request, session: AsyncSession = Depends(get_session)):
    """
    Génère un titre court (max 6 mots) basé sur le sujet dominant.
    Le front envoie le provider/model actif pour garantir que ça marche.
    """
    import logging as _logging
    _log = _logging.getLogger("gungnir.title")

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    # Charge toute la conversation
    result = await session.execute(
        select(Message).where(Message.conversation_id == convo_id).order_by(Message.created_at)
    )
    all_msgs = result.scalars().all()
    if not all_msgs:
        return {"error": "Conversation vide"}

    # Sélection intelligente : on priorise les DERNIERS messages (sujet actuel)
    # et un petit extrait du début pour le contexte d'origine
    total = len(all_msgs)
    if total <= 6:
        sampled = all_msgs
    else:
        # 2 premiers (contexte d'origine) + les N derniers (sujet dominant)
        tail_count = min(total - 2, 18)
        sampled = list(all_msgs[:2]) + list(all_msgs[-tail_count:])

    # Construire un résumé compact — on donne plus de budget aux messages récents
    msg_preview = ""
    budget_chars = 6000
    # D'abord les messages récents (les derniers) en priorité
    recent_msgs = sampled[2:] if total > 6 else sampled
    opening_msgs = sampled[:2] if total > 6 else []

    recent_preview = ""
    for m in recent_msgs:
        role = "User" if m.role == "user" else "Assistant"
        content = (m.content or "")[:600]
        line = f"{role}: {content}\n"
        if len(recent_preview) + len(line) > budget_chars - 1000:
            break
        recent_preview += line

    opening_preview = ""
    for m in opening_msgs:
        role = "User" if m.role == "user" else "Assistant"
        content = (m.content or "")[:300]
        opening_preview += f"{role}: {content}\n"

    if total > 6:
        msg_preview = (
            f"[Conversation de {total} messages]\n\n"
            f"--- Début de conversation ---\n{opening_preview}\n"
            f"--- Messages récents (sujet principal) ---\n{recent_preview}"
        )
    else:
        msg_preview = recent_preview

    msgs = sampled  # pour compatibilité avec le fallback en bas

    import re as _re

    def _clean_fallback(messages_list) -> str:
        for m in messages_list:
            if m.role == "user":
                t = _re.sub(r'^/\w+\s*', '', (m.content or '')).strip()
                t = _re.sub(r'^(salut|bonjour|hello|hey|coucou|yo)\b[,!\s]*', '', t, flags=_re.IGNORECASE).strip()
                if len(t) > 3:
                    return t[:40].strip() + ("..." if len(t) > 40 else "")
        return "Nouvelle conversation"

    # ── Résolution provider/model ──
    # Le front envoie le provider + model actifs de l'utilisateur
    settings = Settings.load()
    req_provider = body.get("provider", "openrouter")
    req_model = body.get("model")

    # 1) Utiliser le provider demandé par le front
    provider_config = settings.providers.get(req_provider)
    provider_name = req_provider

    # 2) Si pas configuré, essayer tous les providers
    if not provider_config or not provider_config.api_key:
        provider_config = None
        for pname, pcfg in settings.providers.items():
            if pcfg and pcfg.enabled and pcfg.api_key:
                provider_name = pname
                provider_config = pcfg
                break

    if not provider_config or not provider_config.api_key:
        _log.warning(f"Title gen: no provider found, falling back")
        title = _clean_fallback(msgs)
        conv = await session.get(Conversation, convo_id)
        if conv:
            conv.title = title
            await session.commit()
        return {"title": title, "method": "fallback", "reason": "no_provider"}

    # Modèle : utiliser celui du front, sinon le default du provider
    title_model = req_model or provider_config.default_model
    if not title_model and provider_config.models:
        title_model = provider_config.models[0]

    if not title_model:
        _log.warning(f"Title gen: no model for provider {provider_name}")
        title = _clean_fallback(msgs)
        conv = await session.get(Conversation, convo_id)
        if conv:
            conv.title = title
            await session.commit()
        return {"title": title, "method": "fallback", "reason": "no_model"}

    _log.info(f"Title gen: using {provider_name}/{title_model} for convo {convo_id} ({total} msgs)")

    provider = get_provider(provider_name, provider_config.api_key, provider_config.base_url)

    try:
        title_response = await provider.chat(
            [
                ChatMessage(role="system", content=(
                    "Tu dois résumer une conversation en UN TITRE de max 5 mots.\n"
                    "Réponds UNIQUEMENT le titre. Rien d'autre. Pas de guillemets.\n\n"
                    "Règles :\n"
                    "- Identifie LE SUJET CENTRAL dont on parle le plus\n"
                    "- Ignore salutations, remerciements, commandes /skill\n"
                    "- Style : groupe nominal court, comme un tag\n"
                    "- TOUJOURS en français\n\n"
                    "Exemples entrée → sortie :\n"
                    "Discussion qui fixe des bugs d'authentification → Fix authentification\n"
                    "On parle de déployer sur un VPS avec Docker → Déploiement Docker VPS\n"
                    "L'user demande de chercher des infos sur le marché IA → Recherche marché IA\n"
                    "Conversation sur le design d'une sidebar → Design sidebar\n"
                    "Debug d'un problème de drag and drop → Debug drag & drop"
                )),
                ChatMessage(role="user", content=msg_preview),
            ],
            title_model,
        )
        title = (title_response.content or "").strip().strip('"\'«»').strip()
        # Nettoyer les préfixes parasites que certains LLM ajoutent
        title = _re.sub(r'^(titre\s*[:—–\-]\s*|voici\s*[:]\s*)', '', title, flags=_re.IGNORECASE).strip()
        # Prendre uniquement la première ligne si le LLM a bavardé
        title = title.split('\n')[0].strip()
        title = title[:50]

        _log.info(f"Title gen result: '{title}' (method=ai)")

        if not title or len(title) < 2:
            title = _clean_fallback(msgs)

        conv = await session.get(Conversation, convo_id)
        if conv:
            conv.title = title
            await session.commit()
        return {"title": title, "method": "ai", "model": title_model}

    except Exception as e:
        _log.error(f"Title gen LLM error ({provider_name}/{title_model}): {e}")
        title = _clean_fallback(msgs)
        conv = await session.get(Conversation, convo_id)
        if conv:
            conv.title = title
            await session.commit()
        return {"title": title, "method": "fallback", "error": str(e)}


@router.post("/conversations/{convo_id}/auto-title")
async def auto_title_if_needed(convo_id: int, session: AsyncSession = Depends(get_session)):
    """
    Déclenche la régénération auto du titre si et seulement si :
    - le titre actuel est le titre par défaut (ou l'ancien titre basé sur le premier message)
    - l'utilisateur n'a PAS édité le titre manuellement (metadata.title_manual != true)
    - la conversation a au moins 4 messages

    Utilisé par le frontend après quelques échanges pour rafraîchir un titre
    qui serait devenu obsolète par rapport au sujet actuel.
    """
    conv = await session.get(Conversation, convo_id)
    if not conv:
        return {"ok": False, "reason": "not_found"}

    meta = dict(conv.metadata_json or {})
    if meta.get("title_manual"):
        return {"ok": False, "reason": "manual_title"}

    current_title = (conv.title or "").strip()
    if current_title and current_title != "Nouvelle conversation":
        # On ne régénère que si c'est encore le titre par défaut
        # (sinon le premier auto-title a déjà eu lieu)
        return {"ok": False, "reason": "already_titled", "title": current_title}

    result = await session.execute(
        select(Message).where(Message.conversation_id == convo_id)
    )
    msgs = result.scalars().all()
    if len(msgs) < 4:
        return {"ok": False, "reason": "too_few_messages", "count": len(msgs)}

    # Délègue à la logique existante
    return await generate_conversation_title(convo_id, session)


@router.post("/conversations/{convo_id}/summarize")
async def summarize_conversation(convo_id: int, request: Request, session: AsyncSession = Depends(get_session)):
    """Résume une conversation via le LLM. Retourne un résumé structuré."""
    body = await request.json()
    provider_name = body.get("provider", "openrouter")
    model_name = body.get("model")

    result = await session.execute(
        select(Message).where(Message.conversation_id == convo_id).order_by(Message.created_at)
    )
    msgs = result.scalars().all()
    if not msgs:
        return JSONResponse({"error": "Conversation vide"}, status_code=400)

    # Construire le transcript
    transcript = ""
    for m in msgs:
        role = "User" if m.role == "user" else "Assistant"
        transcript += f"{role}: {(m.content or '')[:2000]}\n\n"

    # Limiter à ~12000 chars pour le contexte
    if len(transcript) > 12000:
        transcript = transcript[:12000] + "\n[... tronqué ...]"

    settings = Settings.load()

    # Build ordered list of providers to try: requested first, then all enabled ones
    providers_to_try: list[tuple[str, str]] = []
    pcfg = settings.providers.get(provider_name)
    if pcfg and pcfg.enabled and pcfg.api_key:
        providers_to_try.append((provider_name, model_name or pcfg.default_model or ""))
    for pname, pconf in settings.providers.items():
        if pname != provider_name and pconf.enabled and pconf.api_key:
            providers_to_try.append((pname, pconf.default_model or ""))

    if not providers_to_try:
        return JSONResponse({"error": "Aucun provider configuré"}, status_code=400)

    import logging as _logging
    _log = _logging.getLogger("gungnir.summarize")

    summary_messages = [
        ChatMessage(role="system", content=(
            "Tu es un assistant de résumé. Génère un résumé structuré de cette conversation. "
            "Le résumé doit contenir :\n"
            "1. **Sujet principal** (1 phrase)\n"
            "2. **Points clés** (3-5 bullets)\n"
            "3. **Décisions/Actions** (si applicable)\n"
            "4. **Contexte utile** pour reprendre la discussion plus tard\n\n"
            "Sois concis mais complet. Réponds en français."
        )),
        ChatMessage(role="user", content=f"Voici la conversation à résumer :\n\n{transcript}"),
    ]

    last_error = None
    for pname, mname in providers_to_try:
        try:
            pconf = settings.providers[pname]
            provider = get_provider(pname, pconf.api_key, pconf.base_url)
            resp = await provider.chat(summary_messages, mname)
            if resp.content and len(resp.content.strip()) > 20:
                return {"summary": resp.content, "tokens": resp.tokens_input + resp.tokens_output}
        except Exception as e:
            _log.warning(f"Summarize failed with {pname}/{mname}: {e}")
            last_error = e

    _log.error(f"Summarize failed on all providers. Last error: {last_error}")
    return JSONResponse({"error": "Erreur lors de la génération du résumé"}, status_code=500)


@router.delete("/conversations")
async def delete_all_conversations(session: AsyncSession = Depends(get_session)):
    """Supprime TOUTES les conversations (reset complet)."""
    from sqlalchemy import delete as sql_delete
    await session.execute(sql_delete(Message))
    await session.execute(sql_delete(Conversation))
    await session.commit()
    return {"success": True, "message": "Toutes les conversations supprimées"}
