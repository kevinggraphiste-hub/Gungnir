from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.core.config.settings import Settings
from backend.core.db.models import Conversation, Message
from backend.core.db.engine import get_session
from backend.core.providers import get_provider, ChatMessage

router = APIRouter()


@router.get("/conversations")
async def list_conversations(user_id: int = None, session: AsyncSession = Depends(get_session)):
    query = select(Conversation).order_by(Conversation.updated_at.desc()).limit(50)
    if user_id is not None:
        query = query.where(Conversation.user_id == user_id)
    result = await session.execute(query)
    convos = result.scalars().all()
    return [
        {
            "id": c.id,
            "user_id": c.user_id,
            "title": c.title,
            "provider": c.provider,
            "model": c.model,
            "created_at": c.created_at.isoformat(),
            "updated_at": c.updated_at.isoformat(),
        }
        for c in convos
    ]


@router.post("/conversations")
async def create_conversation(data: dict, session: AsyncSession = Depends(get_session)):
    title = data.get("title", "Nouvelle conversation").strip()
    if len(title) > 500:
        return {"error": "Title too long (max 500 chars)"}
    provider = data.get("provider", "openrouter")
    if len(provider) > 100:
        return {"error": "Invalid provider name"}
    model = data.get("model", "anthropic/claude-3.5-sonnet")
    if len(model) > 200:
        return {"error": "Invalid model name"}
    conv = Conversation(
        title=title,
        provider=provider,
        model=model,
        user_id=data.get("user_id"),
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
async def delete_conversation(convo_id: int, session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Conversation).where(Conversation.id == convo_id))
    convo = result.scalar_one_or_none()
    if not convo:
        return {"error": "Conversation introuvable"}

    await session.delete(convo)
    await session.commit()
    return {"ok": True}


@router.put("/conversations/{convo_id}")
async def update_conversation(convo_id: int, data: dict, session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Conversation).where(Conversation.id == convo_id))
    convo = result.scalar_one_or_none()
    if not convo:
        return {"error": "Conversation introuvable"}

    if "title" in data:
        convo.title = data["title"]
    if "provider" in data:
        convo.provider = data["provider"]
    if "model" in data:
        convo.model = data["model"]

    convo.updated_at = __import__("datetime").datetime.utcnow()
    await session.commit()
    await session.refresh(convo)
    return {"id": convo.id, "title": convo.title, "provider": convo.provider, "model": convo.model}


@router.get("/conversations/{convo_id}/messages")
async def get_messages(convo_id: int, session: AsyncSession = Depends(get_session)):
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

    else:
        return {"error": f"Format '{fmt}' non supporté. Formats: json, txt, md, html"}


@router.post("/conversations/{convo_id}/generate-title")
async def generate_conversation_title(convo_id: int, session: AsyncSession = Depends(get_session)):
    """
    Génère un titre intelligent pour une conversation en utilisant le LLM.
    Analyse les premiers messages et génère un titre court et descriptif.
    """
    # Récupérer les premiers messages
    result = await session.execute(
        select(Message).where(Message.conversation_id == convo_id).order_by(Message.created_at).limit(6)
    )
    msgs = result.scalars().all()
    if not msgs:
        return {"error": "Conversation vide"}

    # Construire un résumé des messages
    msg_preview = ""
    for m in msgs[:6]:
        role = "User" if m.role == "user" else "Assistant"
        content = (m.content or "")[:300]
        msg_preview += f"{role}: {content}\n"

    # Utiliser le LLM configuré pour générer le titre
    settings = Settings.load()
    # Chercher un provider configuré (préférer un modèle rapide/cheap)
    provider_name = None
    provider_config = None
    for pname in ["openrouter"]:
        pcfg = settings.providers.get(pname)
        if pcfg and pcfg.enabled and pcfg.api_key:
            provider_name = pname
            provider_config = pcfg
            break

    if not provider_config:
        # Fallback: extraire un titre basique du premier message user
        first_user = next((m.content for m in msgs if m.role == "user"), "Nouvelle conversation")
        title = first_user[:60].strip()
        if len(first_user) > 60:
            title += "..."
        conv = await session.get(Conversation, convo_id)
        if conv:
            conv.title = title
            await session.commit()
        return {"title": title, "method": "fallback"}

    provider = get_provider(provider_name, provider_config.api_key, provider_config.base_url)

    # Choisir un modèle cheap pour la génération de titre
    _cheap_models = [
        "google/gemini-2.0-flash-exp:free",
        "google/gemini-2.5-flash-preview",
        "meta-llama/llama-3.1-8b-instruct:free",
        "mistralai/mistral-small",
    ]
    title_model = None
    if provider_config.models:
        for cm in _cheap_models:
            if cm in provider_config.models:
                title_model = cm
                break
    if not title_model:
        title_model = provider_config.default_model

    try:
        title_response = await provider.chat(
            [
                ChatMessage(role="system", content=(
                    "Tu es un générateur de titres. Génère UN SEUL titre court (max 50 caractères) "
                    "pour cette conversation. Le titre doit résumer le sujet principal. "
                    "Réponds UNIQUEMENT avec le titre, sans guillemets, sans explication, sans ponctuation finale."
                )),
                ChatMessage(role="user", content=f"Voici les premiers messages de la conversation :\n\n{msg_preview}"),
            ],
            title_model,
        )
        title = (title_response.content or "").strip().strip('"').strip("'").strip()[:60]
        if not title or len(title) < 3:
            first_user = next((m.content for m in msgs if m.role == "user"), "Conversation")
            title = first_user[:50].strip() + ("..." if len(first_user) > 50 else "")

        conv = await session.get(Conversation, convo_id)
        if conv:
            conv.title = title
            await session.commit()
        return {"title": title, "method": "ai"}

    except Exception as e:
        first_user = next((m.content for m in msgs if m.role == "user"), "Conversation")
        title = first_user[:50].strip() + ("..." if len(first_user) > 50 else "")
        conv = await session.get(Conversation, convo_id)
        if conv:
            conv.title = title
            await session.commit()
        import logging; logging.getLogger("gungnir").error(f"Title gen error: {e}")
        return {"title": title, "method": "fallback", "error": "Erreur lors de la génération du titre"}


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
    pcfg = settings.providers.get(provider_name)
    if not pcfg or not pcfg.api_key:
        return JSONResponse({"error": f"Provider '{provider_name}' non configuré"}, status_code=400)

    if not model_name:
        model_name = pcfg.default_model

    provider = get_provider(provider_name, pcfg.api_key, pcfg.base_url)

    try:
        resp = await provider.chat(
            [
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
            ],
            model_name,
        )
        return {"summary": resp.content, "tokens": resp.tokens_input + resp.tokens_output}
    except Exception as e:
        import logging; logging.getLogger("gungnir").error(f"Summarize error: {e}")
        return JSONResponse({"error": "Erreur lors de la génération du résumé"}, status_code=500)


@router.delete("/conversations")
async def delete_all_conversations(session: AsyncSession = Depends(get_session)):
    """Supprime TOUTES les conversations (reset complet)."""
    from sqlalchemy import delete as sql_delete
    await session.execute(sql_delete(Message))
    await session.execute(sql_delete(Conversation))
    await session.commit()
    return {"success": True, "message": "Toutes les conversations supprimées"}
