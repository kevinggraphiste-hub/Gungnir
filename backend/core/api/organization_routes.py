"""
Gungnir — Conversation organization routes

Gère :
- Les dossiers (ConversationFolder) avec arborescence multi-niveaux
- Les tags (ConversationTag) transversaux many-to-many
- Le déplacement d'une conversation dans un dossier
- L'attachement/détachement de tags
"""
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete as sql_delete

from backend.core.db.models import (
    Conversation, ConversationFolder, ConversationTag, ConversationTagLink,
)
from backend.core.db.engine import get_session

router = APIRouter()


def _current_user_id(request: Request) -> int | None:
    return getattr(request.state, "user_id", None)


# ── Folders ────────────────────────────────────────────────────────────────

@router.get("/folders")
async def list_folders(request: Request, session: AsyncSession = Depends(get_session)):
    """Liste les dossiers de l'utilisateur courant."""
    uid = _current_user_id(request)
    q = select(ConversationFolder).order_by(ConversationFolder.position, ConversationFolder.name)
    if uid is not None:
        q = q.where(ConversationFolder.user_id == uid)
    result = await session.execute(q)
    folders = result.scalars().all()
    return [
        {
            "id": f.id,
            "name": f.name,
            "parent_id": f.parent_id,
            "color": f.color,
            "icon": f.icon,
            "position": f.position,
        }
        for f in folders
    ]


@router.post("/folders")
async def create_folder(request: Request, data: dict, session: AsyncSession = Depends(get_session)):
    """Crée un nouveau dossier (peut être imbriqué via parent_id)."""
    uid = _current_user_id(request)
    name = (data.get("name") or "").strip()
    if not name:
        return JSONResponse({"error": "name is required"}, status_code=400)
    if len(name) > 255:
        return JSONResponse({"error": "name too long"}, status_code=400)

    parent_id = data.get("parent_id")
    # Si un parent est fourni, vérifier qu'il appartient bien à l'utilisateur
    if parent_id is not None:
        parent = await session.get(ConversationFolder, parent_id)
        if not parent or (uid is not None and parent.user_id != uid):
            return JSONResponse({"error": "parent folder not found"}, status_code=404)

    folder = ConversationFolder(
        user_id=uid,
        name=name,
        parent_id=parent_id,
        color=data.get("color", "#dc2626"),
        icon=data.get("icon", "folder"),
        position=int(data.get("position", 0)),
    )
    session.add(folder)
    await session.commit()
    await session.refresh(folder)
    return {
        "id": folder.id, "name": folder.name, "parent_id": folder.parent_id,
        "color": folder.color, "icon": folder.icon, "position": folder.position,
    }


@router.put("/folders/{folder_id}")
async def update_folder(folder_id: int, request: Request, data: dict, session: AsyncSession = Depends(get_session)):
    uid = _current_user_id(request)
    folder = await session.get(ConversationFolder, folder_id)
    if not folder or (uid is not None and folder.user_id != uid):
        return JSONResponse({"error": "not found"}, status_code=404)

    # Anti-boucle : on ne peut pas se mettre comme parent d'un de ses descendants
    if "parent_id" in data and data["parent_id"] is not None:
        new_parent = data["parent_id"]
        if new_parent == folder_id:
            return JSONResponse({"error": "cannot be own parent"}, status_code=400)
        # Vérifie qu'on ne crée pas de cycle en remontant la chaîne des parents
        cursor = await session.get(ConversationFolder, new_parent)
        guard = 0
        while cursor and guard < 50:
            if cursor.id == folder_id:
                return JSONResponse({"error": "cycle detected"}, status_code=400)
            cursor = await session.get(ConversationFolder, cursor.parent_id) if cursor.parent_id else None
            guard += 1

    for key in ("name", "color", "icon", "position", "parent_id"):
        if key in data:
            setattr(folder, key, data[key])
    await session.commit()
    await session.refresh(folder)
    return {
        "id": folder.id, "name": folder.name, "parent_id": folder.parent_id,
        "color": folder.color, "icon": folder.icon, "position": folder.position,
    }


@router.delete("/folders/{folder_id}")
async def delete_folder(folder_id: int, request: Request, session: AsyncSession = Depends(get_session)):
    """Supprime un dossier. Les conversations qu'il contient redeviennent sans dossier.
    Les sous-dossiers remontent d'un niveau (vers le parent du dossier supprimé)."""
    uid = _current_user_id(request)
    folder = await session.get(ConversationFolder, folder_id)
    if not folder or (uid is not None and folder.user_id != uid):
        return JSONResponse({"error": "not found"}, status_code=404)

    # Détache les conversations qui y étaient
    convs = await session.execute(select(Conversation).where(Conversation.folder_id == folder_id))
    for c in convs.scalars().all():
        c.folder_id = None

    # Remonte les sous-dossiers d'un niveau
    subs = await session.execute(select(ConversationFolder).where(ConversationFolder.parent_id == folder_id))
    for s in subs.scalars().all():
        s.parent_id = folder.parent_id

    await session.delete(folder)
    await session.commit()
    return {"ok": True}


@router.put("/conversations/{convo_id}/folder")
async def move_conversation_to_folder(convo_id: int, request: Request, data: dict, session: AsyncSession = Depends(get_session)):
    """Déplace une conversation dans un dossier (ou la retire si folder_id = null)."""
    uid = _current_user_id(request)
    conv = await session.get(Conversation, convo_id)
    if not conv:
        return JSONResponse({"error": "conversation not found"}, status_code=404)
    if uid is not None and conv.user_id is not None and conv.user_id != uid:
        return JSONResponse({"error": "Acces non autorise"}, status_code=403)

    folder_id = data.get("folder_id")
    if folder_id is not None:
        folder = await session.get(ConversationFolder, folder_id)
        if not folder or (uid is not None and folder.user_id != uid):
            return JSONResponse({"error": "folder not found"}, status_code=404)
    conv.folder_id = folder_id
    await session.commit()
    return {"ok": True, "folder_id": folder_id}


# ── Tags ───────────────────────────────────────────────────────────────────

@router.get("/tags")
async def list_tags(request: Request, session: AsyncSession = Depends(get_session)):
    uid = _current_user_id(request)
    q = select(ConversationTag).order_by(ConversationTag.name)
    if uid is not None:
        q = q.where(ConversationTag.user_id == uid)
    result = await session.execute(q)
    return [{"id": t.id, "name": t.name, "color": t.color} for t in result.scalars().all()]


@router.post("/tags")
async def create_tag(request: Request, data: dict, session: AsyncSession = Depends(get_session)):
    uid = _current_user_id(request)
    name = (data.get("name") or "").strip()
    if not name:
        return JSONResponse({"error": "name is required"}, status_code=400)
    # Anti-doublon : si le tag existe déjà pour cet user, on le réutilise
    existing = await session.execute(
        select(ConversationTag).where(ConversationTag.name == name, ConversationTag.user_id == uid)
    )
    existing_tag = existing.scalar_one_or_none()
    if existing_tag:
        return {"id": existing_tag.id, "name": existing_tag.name, "color": existing_tag.color}

    tag = ConversationTag(user_id=uid, name=name[:100], color=data.get("color", "#6366f1"))
    session.add(tag)
    await session.commit()
    await session.refresh(tag)
    return {"id": tag.id, "name": tag.name, "color": tag.color}


@router.delete("/tags/{tag_id}")
async def delete_tag(tag_id: int, request: Request, session: AsyncSession = Depends(get_session)):
    uid = _current_user_id(request)
    tag = await session.get(ConversationTag, tag_id)
    if not tag or (uid is not None and tag.user_id != uid):
        return JSONResponse({"error": "not found"}, status_code=404)
    # Détruit aussi les liens
    await session.execute(sql_delete(ConversationTagLink).where(ConversationTagLink.tag_id == tag_id))
    await session.delete(tag)
    await session.commit()
    return {"ok": True}


@router.get("/conversations/{convo_id}/tags")
async def get_conversation_tags(convo_id: int, session: AsyncSession = Depends(get_session)):
    """Liste les tags attachés à une conversation."""
    result = await session.execute(
        select(ConversationTag).join(
            ConversationTagLink, ConversationTagLink.tag_id == ConversationTag.id
        ).where(ConversationTagLink.conversation_id == convo_id)
    )
    return [{"id": t.id, "name": t.name, "color": t.color} for t in result.scalars().all()]


@router.post("/conversations/{convo_id}/tags/{tag_id}")
async def attach_tag(convo_id: int, tag_id: int, request: Request, session: AsyncSession = Depends(get_session)):
    uid = _current_user_id(request)
    conv = await session.get(Conversation, convo_id)
    tag = await session.get(ConversationTag, tag_id)
    if not conv or not tag:
        return JSONResponse({"error": "not found"}, status_code=404)
    if uid is not None and tag.user_id is not None and tag.user_id != uid:
        return JSONResponse({"error": "forbidden"}, status_code=403)

    # Vérifier qu'il n'existe pas déjà
    existing = await session.execute(
        select(ConversationTagLink).where(
            ConversationTagLink.conversation_id == convo_id,
            ConversationTagLink.tag_id == tag_id,
        )
    )
    if existing.scalar_one_or_none():
        return {"ok": True, "already": True}

    link = ConversationTagLink(conversation_id=convo_id, tag_id=tag_id)
    session.add(link)
    await session.commit()
    return {"ok": True}


@router.delete("/conversations/{convo_id}/tags/{tag_id}")
async def detach_tag(convo_id: int, tag_id: int, session: AsyncSession = Depends(get_session)):
    await session.execute(
        sql_delete(ConversationTagLink).where(
            ConversationTagLink.conversation_id == convo_id,
            ConversationTagLink.tag_id == tag_id,
        )
    )
    await session.commit()
    return {"ok": True}
