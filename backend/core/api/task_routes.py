"""
Gungnir — Conversation task routes

Gère la todo-list interne liée à une conversation (style Claude Code).
L'agent peut créer/modifier ses tâches via le tool WOLF `conversation_tasks`,
et l'utilisateur peut les manipuler depuis le panneau latéral du Chat.
"""
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete as sql_delete

from backend.core.db.models import Conversation, ConversationTask
from backend.core.db.engine import get_session

router = APIRouter()


VALID_STATUSES = {"pending", "in_progress", "completed"}


async def _ensure_conversation(convo_id: int, session: AsyncSession) -> Conversation | None:
    return await session.get(Conversation, convo_id)


def _serialize(t: ConversationTask) -> dict:
    return {
        "id": t.id,
        "conversation_id": t.conversation_id,
        "content": t.content,
        "active_form": t.active_form,
        "status": t.status,
        "position": t.position,
        "created_by": t.created_by,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


@router.get("/conversations/{convo_id}/tasks")
async def list_tasks(convo_id: int, session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(ConversationTask)
        .where(ConversationTask.conversation_id == convo_id)
        .order_by(ConversationTask.position, ConversationTask.id)
    )
    return [_serialize(t) for t in result.scalars().all()]


@router.post("/conversations/{convo_id}/tasks")
async def create_task(convo_id: int, data: dict, session: AsyncSession = Depends(get_session)):
    conv = await _ensure_conversation(convo_id, session)
    if not conv:
        return JSONResponse({"error": "conversation not found"}, status_code=404)

    content = (data.get("content") or "").strip()
    if not content:
        return JSONResponse({"error": "content is required"}, status_code=400)
    status = data.get("status", "pending")
    if status not in VALID_STATUSES:
        return JSONResponse({"error": f"invalid status (expected: {VALID_STATUSES})"}, status_code=400)

    # Position par défaut = max actuel + 1
    pos_q = await session.execute(
        select(ConversationTask.position)
        .where(ConversationTask.conversation_id == convo_id)
        .order_by(ConversationTask.position.desc())
        .limit(1)
    )
    last_pos = pos_q.scalar_one_or_none() or 0

    task = ConversationTask(
        conversation_id=convo_id,
        content=content,
        active_form=(data.get("active_form") or "").strip() or None,
        status=status,
        position=int(data.get("position", last_pos + 1)),
        created_by=data.get("created_by", "user"),
    )
    session.add(task)
    await session.commit()
    await session.refresh(task)
    return _serialize(task)


@router.put("/conversations/{convo_id}/tasks/{task_id}")
async def update_task(convo_id: int, task_id: int, data: dict, session: AsyncSession = Depends(get_session)):
    task = await session.get(ConversationTask, task_id)
    if not task or task.conversation_id != convo_id:
        return JSONResponse({"error": "task not found"}, status_code=404)

    if "content" in data:
        task.content = (data["content"] or "").strip() or task.content
    if "active_form" in data:
        task.active_form = (data["active_form"] or "").strip() or None
    if "status" in data:
        if data["status"] not in VALID_STATUSES:
            return JSONResponse({"error": "invalid status"}, status_code=400)
        task.status = data["status"]
    if "position" in data:
        task.position = int(data["position"])

    await session.commit()
    await session.refresh(task)
    return _serialize(task)


@router.delete("/conversations/{convo_id}/tasks/{task_id}")
async def delete_task(convo_id: int, task_id: int, session: AsyncSession = Depends(get_session)):
    task = await session.get(ConversationTask, task_id)
    if not task or task.conversation_id != convo_id:
        return JSONResponse({"error": "task not found"}, status_code=404)
    await session.delete(task)
    await session.commit()
    return {"ok": True}


@router.put("/conversations/{convo_id}/tasks")
async def bulk_replace_tasks(convo_id: int, data: dict, session: AsyncSession = Depends(get_session)):
    """
    Remplace l'intégralité de la liste de tâches d'une conversation.
    Utilisé par l'agent pour synchroniser son état interne en un seul appel.

    Body: {"tasks": [{"content": "...", "active_form": "...", "status": "pending"}, ...], "created_by": "agent"}
    """
    conv = await _ensure_conversation(convo_id, session)
    if not conv:
        return JSONResponse({"error": "conversation not found"}, status_code=404)

    tasks_data = data.get("tasks")
    if not isinstance(tasks_data, list):
        return JSONResponse({"error": "tasks must be a list"}, status_code=400)

    created_by = data.get("created_by", "agent")

    # Wipe existing
    await session.execute(
        sql_delete(ConversationTask).where(ConversationTask.conversation_id == convo_id)
    )

    # Insert new
    new_tasks = []
    for i, t in enumerate(tasks_data):
        content = (t.get("content") or "").strip()
        if not content:
            continue
        status = t.get("status", "pending")
        if status not in VALID_STATUSES:
            status = "pending"
        row = ConversationTask(
            conversation_id=convo_id,
            content=content,
            active_form=(t.get("active_form") or "").strip() or None,
            status=status,
            position=i,
            created_by=created_by,
        )
        session.add(row)
        new_tasks.append(row)

    await session.commit()
    for t in new_tasks:
        await session.refresh(t)
    return [_serialize(t) for t in new_tasks]
