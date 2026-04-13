"""
Gungnir — Per-user data layer for skills, personalities, sub-agents.
All data is stored in the DB with user_id isolation.
Defaults are seeded from JSON files on first access.
"""
import json
from pathlib import Path
from datetime import datetime
from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.db.models import UserSkill, UserPersonality, UserSubAgent

DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"


# ── Seed defaults ────────────────────────────────────────────────────────────

def _load_defaults(filename: str, key: str | None = None) -> list[dict]:
    """Load default entries from a JSON file in data/.

    Files may be a plain list or a dict with a known key containing the list.
    Pass `key` to extract from a dict wrapper (e.g. "skills", "personalities", "agents").
    """
    path = DATA_DIR / filename
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                return raw
            if isinstance(raw, dict):
                # Try explicit key first, then common patterns
                if key and key in raw:
                    return raw[key]
                # Auto-detect: find the first list value
                for v in raw.values():
                    if isinstance(v, list):
                        return v
            return []
        except Exception:
            pass
    return []


async def _seed_skills(session: AsyncSession, user_id: int):
    """Seed default skills for a new user."""
    existing = await session.execute(
        select(UserSkill).where(UserSkill.user_id == user_id).limit(1)
    )
    if existing.scalars().first():
        return  # Already seeded

    defaults = _load_defaults("skills.json", "skills")
    for i, s in enumerate(defaults):
        session.add(UserSkill(
            user_id=user_id,
            name=s.get("name", f"skill_{i}"),
            data_json=s,
            is_active=False,
            position=i,
        ))
    await session.flush()


async def _seed_personalities(session: AsyncSession, user_id: int):
    """Seed default personalities for a new user."""
    existing = await session.execute(
        select(UserPersonality).where(UserPersonality.user_id == user_id).limit(1)
    )
    if existing.scalars().first():
        return

    defaults = _load_defaults("personalities.json", "personalities")
    for i, p in enumerate(defaults):
        session.add(UserPersonality(
            user_id=user_id,
            name=p.get("name", f"personality_{i}"),
            data_json=p,
            is_active=(p.get("name") == "default"),
            position=i,
        ))
    await session.flush()


async def _seed_sub_agents(session: AsyncSession, user_id: int):
    """Seed default sub-agents for a new user."""
    existing = await session.execute(
        select(UserSubAgent).where(UserSubAgent.user_id == user_id).limit(1)
    )
    if existing.scalars().first():
        return

    defaults = _load_defaults("agents.json", "agents")
    for i, a in enumerate(defaults):
        session.add(UserSubAgent(
            user_id=user_id,
            name=a.get("name", f"agent_{i}"),
            data_json=a,
            position=i,
        ))
    await session.flush()


# ── Skills CRUD ──────────────────────────────────────────────────────────────

async def list_skills(session: AsyncSession, user_id: int, category: str = None) -> list[dict]:
    """List all skills for a user, seeding defaults if needed."""
    await _seed_skills(session, user_id)
    q = select(UserSkill).where(UserSkill.user_id == user_id).order_by(UserSkill.position)
    result = await session.execute(q)
    skills = []
    for row in result.scalars().all():
        d = dict(row.data_json) if row.data_json else {}
        d["name"] = row.name
        d["is_active"] = row.is_active
        if category and d.get("category") != category:
            continue
        skills.append(d)
    return skills


async def get_skill(session: AsyncSession, user_id: int, name: str) -> dict | None:
    result = await session.execute(
        select(UserSkill).where(UserSkill.user_id == user_id, UserSkill.name == name)
    )
    row = result.scalars().first()
    if not row:
        return None
    d = dict(row.data_json) if row.data_json else {}
    d["name"] = row.name
    d["is_active"] = row.is_active
    return d


async def create_skill(session: AsyncSession, user_id: int, name: str, data: dict) -> dict:
    # Check duplicate
    existing = await session.execute(
        select(UserSkill).where(UserSkill.user_id == user_id, UserSkill.name == name)
    )
    if existing.scalars().first():
        return {"success": False, "error": f"Skill '{name}' existe déjà"}

    # Get max position
    max_pos = await session.execute(
        select(UserSkill.position).where(UserSkill.user_id == user_id).order_by(UserSkill.position.desc()).limit(1)
    )
    pos = (max_pos.scalar() or 0) + 1

    data["name"] = name
    session.add(UserSkill(user_id=user_id, name=name, data_json=data, position=pos))
    await session.flush()
    return {"success": True, "name": name}


async def update_skill(session: AsyncSession, user_id: int, name: str, updates: dict) -> dict:
    result = await session.execute(
        select(UserSkill).where(UserSkill.user_id == user_id, UserSkill.name == name)
    )
    row = result.scalars().first()
    if not row:
        return {"success": False, "error": "Skill introuvable"}

    d = dict(row.data_json) if row.data_json else {}
    for k, v in updates.items():
        if v is not None:
            d[k] = v
    d["name"] = name
    row.data_json = d
    await session.flush()
    return {"success": True}


async def delete_skill(session: AsyncSession, user_id: int, name: str) -> dict:
    result = await session.execute(
        delete(UserSkill).where(UserSkill.user_id == user_id, UserSkill.name == name)
    )
    if result.rowcount == 0:
        return {"success": False, "error": "Skill introuvable"}
    return {"success": True}


async def set_active_skill(session: AsyncSession, user_id: int, name: str | None) -> dict:
    """Set the active skill for a user (only one at a time)."""
    # Deactivate all
    await session.execute(
        update(UserSkill).where(UserSkill.user_id == user_id).values(is_active=False)
    )
    if name:
        result = await session.execute(
            select(UserSkill).where(UserSkill.user_id == user_id, UserSkill.name == name)
        )
        row = result.scalars().first()
        if not row:
            return {"success": False, "error": "Skill introuvable"}
        row.is_active = True
    await session.flush()
    return {"success": True, "active": name}


async def get_active_skill(session: AsyncSession, user_id: int) -> dict | None:
    """Get the active skill for a user."""
    await _seed_skills(session, user_id)
    result = await session.execute(
        select(UserSkill).where(UserSkill.user_id == user_id, UserSkill.is_active == True)
    )
    row = result.scalars().first()
    if not row:
        return None
    d = dict(row.data_json) if row.data_json else {}
    d["name"] = row.name
    return d


async def reorder_skills(session: AsyncSession, user_id: int, order: list[str]) -> dict:
    for i, name in enumerate(order):
        await session.execute(
            update(UserSkill).where(
                UserSkill.user_id == user_id, UserSkill.name == name
            ).values(position=i)
        )
    await session.flush()
    return {"success": True}


# ── Personalities CRUD ───────────────────────────────────────────────────────

async def list_personalities(session: AsyncSession, user_id: int) -> list[dict]:
    await _seed_personalities(session, user_id)
    q = select(UserPersonality).where(UserPersonality.user_id == user_id).order_by(UserPersonality.position)
    result = await session.execute(q)
    personalities = []
    for row in result.scalars().all():
        d = dict(row.data_json) if row.data_json else {}
        d["name"] = row.name
        d["active"] = row.is_active
        personalities.append(d)
    return personalities


async def create_personality(session: AsyncSession, user_id: int, name: str, data: dict) -> dict:
    existing = await session.execute(
        select(UserPersonality).where(UserPersonality.user_id == user_id, UserPersonality.name == name)
    )
    if existing.scalars().first():
        return {"success": False, "error": f"Personnalité '{name}' existe déjà"}

    max_pos = await session.execute(
        select(UserPersonality.position).where(UserPersonality.user_id == user_id).order_by(UserPersonality.position.desc()).limit(1)
    )
    pos = (max_pos.scalar() or 0) + 1

    data["name"] = name
    session.add(UserPersonality(user_id=user_id, name=name, data_json=data, position=pos))
    await session.flush()
    return {"success": True}


async def update_personality(session: AsyncSession, user_id: int, name: str, updates: dict) -> dict:
    result = await session.execute(
        select(UserPersonality).where(UserPersonality.user_id == user_id, UserPersonality.name == name)
    )
    row = result.scalars().first()
    if not row:
        return {"success": False, "error": "Personnalité introuvable"}

    d = dict(row.data_json) if row.data_json else {}
    for k, v in updates.items():
        if v is not None:
            d[k] = v
    d["name"] = name
    row.data_json = d
    await session.flush()
    return {"success": True}


async def delete_personality(session: AsyncSession, user_id: int, name: str) -> dict:
    if name == "default":
        return {"success": False, "error": "Impossible de supprimer la personnalité par défaut"}
    result = await session.execute(
        delete(UserPersonality).where(UserPersonality.user_id == user_id, UserPersonality.name == name)
    )
    if result.rowcount == 0:
        return {"success": False, "error": "Personnalité introuvable"}
    return {"success": True}


async def set_active_personality(session: AsyncSession, user_id: int, name: str) -> dict:
    await session.execute(
        update(UserPersonality).where(UserPersonality.user_id == user_id).values(is_active=False)
    )
    result = await session.execute(
        select(UserPersonality).where(UserPersonality.user_id == user_id, UserPersonality.name == name)
    )
    row = result.scalars().first()
    if not row:
        return {"success": False, "error": f"Personnalité '{name}' introuvable"}
    row.is_active = True
    await session.flush()
    return {"success": True, "active_personality": name}


async def get_active_personality(session: AsyncSession, user_id: int) -> dict | None:
    await _seed_personalities(session, user_id)
    result = await session.execute(
        select(UserPersonality).where(UserPersonality.user_id == user_id, UserPersonality.is_active == True)
    )
    row = result.scalars().first()
    if not row:
        return None
    d = dict(row.data_json) if row.data_json else {}
    d["name"] = row.name
    return d


async def reorder_personalities(session: AsyncSession, user_id: int, order: list[str]) -> dict:
    for i, name in enumerate(order):
        await session.execute(
            update(UserPersonality).where(
                UserPersonality.user_id == user_id, UserPersonality.name == name
            ).values(position=i)
        )
    await session.flush()
    return {"success": True}


# ── Sub-agents CRUD ──────────────────────────────────────────────────────────

async def list_sub_agents(session: AsyncSession, user_id: int) -> list[dict]:
    await _seed_sub_agents(session, user_id)
    q = select(UserSubAgent).where(UserSubAgent.user_id == user_id).order_by(UserSubAgent.position)
    result = await session.execute(q)
    agents = []
    for row in result.scalars().all():
        d = dict(row.data_json) if row.data_json else {}
        d["name"] = row.name
        agents.append(d)
    return agents


async def create_sub_agent(session: AsyncSession, user_id: int, name: str, data: dict) -> dict:
    existing = await session.execute(
        select(UserSubAgent).where(UserSubAgent.user_id == user_id, UserSubAgent.name == name)
    )
    if existing.scalars().first():
        return {"success": False, "error": f"Agent '{name}' existe déjà"}

    max_pos = await session.execute(
        select(UserSubAgent.position).where(UserSubAgent.user_id == user_id).order_by(UserSubAgent.position.desc()).limit(1)
    )
    pos = (max_pos.scalar() or 0) + 1

    data["name"] = name
    session.add(UserSubAgent(user_id=user_id, name=name, data_json=data, position=pos))
    await session.flush()
    return {"success": True, "name": name}


async def update_sub_agent(session: AsyncSession, user_id: int, name: str, updates: dict) -> dict:
    result = await session.execute(
        select(UserSubAgent).where(UserSubAgent.user_id == user_id, UserSubAgent.name == name)
    )
    row = result.scalars().first()
    if not row:
        return {"success": False, "error": "Agent introuvable"}

    d = dict(row.data_json) if row.data_json else {}
    for k, v in updates.items():
        if v is not None:
            d[k] = v
    d["name"] = name
    row.data_json = d
    await session.flush()
    return {"success": True}


async def get_sub_agent(session: AsyncSession, user_id: int, name: str) -> dict | None:
    """Get a single sub-agent by name."""
    result = await session.execute(
        select(UserSubAgent).where(UserSubAgent.user_id == user_id, UserSubAgent.name == name)
    )
    row = result.scalars().first()
    if not row:
        return None
    d = dict(row.data_json) if row.data_json else {}
    d["name"] = row.name
    return d


async def reorder_sub_agents(session: AsyncSession, user_id: int, order: list[str]) -> dict:
    for i, name in enumerate(order):
        await session.execute(
            update(UserSubAgent).where(
                UserSubAgent.user_id == user_id, UserSubAgent.name == name
            ).values(position=i)
        )
    await session.flush()
    return {"success": True}


async def delete_sub_agent(session: AsyncSession, user_id: int, name: str) -> dict:
    result = await session.execute(
        delete(UserSubAgent).where(UserSubAgent.user_id == user_id, UserSubAgent.name == name)
    )
    if result.rowcount == 0:
        return {"success": False, "error": "Agent introuvable"}
    return {"success": True}
