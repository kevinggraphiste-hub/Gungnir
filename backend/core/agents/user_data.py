"""
Gungnir — Per-user data layer for skills, personalities, sub-agents.
All data is stored in the DB with user_id isolation.
Defaults are seeded from JSON files on first access, but any template the
user explicitly deleted is tombstoned in UserSettings.deleted_defaults so
it never respawns.
"""
import json
from pathlib import Path
from datetime import datetime
from sqlalchemy import select, update, delete, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from backend.core.db.models import UserSkill, UserPersonality, UserSubAgent, UserSettings

DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"
# Bundled defaults shipped with the code (not overridden by Docker volume)
BUNDLED_DEFAULTS_DIR = Path(__file__).parent.parent.parent / "data"


# ── Tombstones for deleted template defaults ───────────────────────────────

async def _get_user_settings_row(session: AsyncSession, user_id: int) -> UserSettings:
    """Fetch or create the UserSettings row for ``user_id``. Used here only to
    read/write the ``deleted_defaults`` tombstone dict; callers that also need
    provider_keys / service_keys should use backend.core.api.auth_helpers."""
    result = await session.execute(
        select(UserSettings).where(UserSettings.user_id == user_id)
    )
    row = result.scalar_one_or_none()
    if row is None:
        row = UserSettings(user_id=user_id, provider_keys={}, service_keys={}, deleted_defaults={})
        session.add(row)
        await session.flush()
    return row


async def _get_tombstoned(session: AsyncSession, user_id: int, kind: str) -> set[str]:
    """Return the set of template names the user has explicitly deleted for
    this kind (``skills`` / ``personalities`` / ``sub_agents``)."""
    row = await _get_user_settings_row(session, user_id)
    tomb = row.deleted_defaults or {}
    names = tomb.get(kind) or []
    return set(names)


async def _add_tombstone(session: AsyncSession, user_id: int, kind: str, name: str) -> None:
    """Record that the user explicitly deleted a template so the seed won't
    re-create it on the next list call."""
    row = await _get_user_settings_row(session, user_id)
    tomb = dict(row.deleted_defaults or {})
    existing = list(tomb.get(kind) or [])
    if name not in existing:
        existing.append(name)
    tomb[kind] = existing
    row.deleted_defaults = tomb
    flag_modified(row, "deleted_defaults")
    await session.flush()


async def _remove_tombstone(session: AsyncSession, user_id: int, kind: str, name: str) -> None:
    """Undo a tombstone when the user re-creates a template by the same name.
    Letting them re-insert it with its original content instead of manually
    re-filling every field."""
    row = await _get_user_settings_row(session, user_id)
    tomb = dict(row.deleted_defaults or {})
    existing = list(tomb.get(kind) or [])
    if name in existing:
        existing = [n for n in existing if n != name]
        tomb[kind] = existing
        row.deleted_defaults = tomb
        flag_modified(row, "deleted_defaults")
        await session.flush()


def _name_in_defaults(name: str, filename: str, key: str | None = None) -> bool:
    """True if ``name`` appears in the bundled/persistent defaults file —
    i.e. the item is a shipped template and deletion needs a tombstone."""
    for item in _load_defaults(filename, key):
        if item.get("name") == name:
            return True
    return False


# ── Seed defaults ────────────────────────────────────────────────────────────

def _parse_json_list(raw, key: str | None = None) -> list[dict]:
    """Extract a list from raw JSON (list or dict with known key)."""
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        if key and key in raw:
            return raw[key]
        for v in raw.values():
            if isinstance(v, list):
                return v
    return []


def _load_defaults(filename: str, key: str | None = None) -> list[dict]:
    """Load default entries from JSON files.

    Checks both the persistent data/ dir (Docker volume) and the bundled
    backend/data/ dir (shipped with code). Merges entries by name so that
    new defaults added to the codebase always appear, even if the volume
    has an older version of the file.
    """
    results_by_name: dict[str, dict] = {}

    # 1. Load from bundled defaults (always up-to-date with code)
    bundled_path = BUNDLED_DEFAULTS_DIR / filename
    if bundled_path.exists():
        try:
            raw = json.loads(bundled_path.read_text(encoding="utf-8"))
            for item in _parse_json_list(raw, key):
                name = item.get("name", "")
                if name:
                    results_by_name[name] = item
        except Exception:
            pass

    # 2. Load from persistent data/ (user may have customized)
    data_path = DATA_DIR / filename
    if data_path.exists() and data_path != bundled_path:
        try:
            raw = json.loads(data_path.read_text(encoding="utf-8"))
            for item in _parse_json_list(raw, key):
                name = item.get("name", "")
                if name:
                    results_by_name[name] = item  # Persistent overrides bundled
        except Exception:
            pass

    return list(results_by_name.values())


async def _seed_skills(session: AsyncSession, user_id: int):
    """Seed default skills on first access + backfill any new template that
    the user hasn't explicitly deleted. Templates in the tombstone are skipped
    so deletion is permanent even though the seed runs on every list call."""
    existing = await session.execute(
        select(UserSkill).where(UserSkill.user_id == user_id)
    )
    existing_names = {s.name for s in existing.scalars().all()}
    tombstoned = await _get_tombstoned(session, user_id, "skills")

    defaults = _load_defaults("skills.json", "skills")
    max_pos = len(existing_names)
    added = 0
    for i, s in enumerate(defaults):
        name = s.get("name", f"skill_{i}")
        if name in existing_names or name in tombstoned:
            continue
        session.add(UserSkill(
            user_id=user_id,
            name=name,
            data_json=s,
            is_active=False,
            position=max_pos + added,
        ))
        added += 1
    if added:
        await session.flush()


async def _seed_personalities(session: AsyncSession, user_id: int):
    """Seed + backfill personalities. Tombstoned defaults are skipped."""
    existing = await session.execute(
        select(UserPersonality).where(UserPersonality.user_id == user_id)
    )
    existing_names = {p.name for p in existing.scalars().all()}
    tombstoned = await _get_tombstoned(session, user_id, "personalities")

    defaults = _load_defaults("personalities.json", "personalities")
    max_pos = len(existing_names)
    added = 0
    for i, p in enumerate(defaults):
        name = p.get("name", f"personality_{i}")
        if name in existing_names or name in tombstoned:
            continue
        session.add(UserPersonality(
            user_id=user_id,
            name=name,
            data_json=p,
            is_active=(not existing_names and p.get("name") == "default"),
            position=max_pos + added,
        ))
        added += 1
    if added:
        await session.flush()


async def _seed_sub_agents(session: AsyncSession, user_id: int):
    """Seed + backfill sub-agents. Tombstoned defaults are skipped."""
    existing = await session.execute(
        select(UserSubAgent).where(UserSubAgent.user_id == user_id)
    )
    existing_names = {a.name for a in existing.scalars().all()}
    tombstoned = await _get_tombstoned(session, user_id, "sub_agents")

    defaults = _load_defaults("agents.json", "agents")
    max_pos = len(existing_names)
    added = 0
    for i, a in enumerate(defaults):
        name = a.get("name", f"agent_{i}")
        if name in existing_names or name in tombstoned:
            continue
        session.add(UserSubAgent(
            user_id=user_id,
            name=name,
            data_json=a,
            position=max_pos + added,
        ))
        added += 1
    if added:
        await session.flush()


# ── Skills CRUD ──────────────────────────────────────────────────────────────


# Cache des noms de tools natifs (extrait de WOLF_TOOL_SCHEMAS au premier appel,
# pas au top-level pour éviter le circular import wolf_tools → user_data).
_NATIVE_TOOL_NAMES: set[str] | None = None


def _native_tool_names() -> set[str]:
    global _NATIVE_TOOL_NAMES
    if _NATIVE_TOOL_NAMES is None:
        try:
            from backend.core.agents.wolf_tools import WOLF_TOOL_SCHEMAS
            _NATIVE_TOOL_NAMES = {
                s.get("function", {}).get("name", "")
                for s in WOLF_TOOL_SCHEMAS
                if s.get("function", {}).get("name")
            }
        except Exception:
            _NATIVE_TOOL_NAMES = set()
    return _NATIVE_TOOL_NAMES


def _is_native_action_duplicate(name: str) -> str | None:
    """Détecte si ``name`` duplique un tool natif. Renvoie le nom du tool en
    conflit, ou None.

    Le skill_synthesizer générait régulièrement des noms style
    ``create_valkyrie_card`` ou ``valkyrie_create_card_skill`` qui faisaient
    doublon avec les tools natifs (``valkyrie_create_card`` ici). On bloque
    ces patterns au niveau create_skill (DB) — couvre à la fois l'UI et
    l'auto-synthesizer sans avoir à corriger les 2 chemins.

    Patterns détectés (case-insensitive, après normalisation des underscores) :
    1. ``name == tool`` exact
    2. ``name`` est un suffixe/préfixe du tool, ou inversement, avec ≥ 80%
       de tokens en commun (capture les variantes ``create_valkyrie_*``)
    3. ``name`` contient ``tool`` comme substring ≥ 12 chars (anti-faux
       positifs sur des tools courts type ``kb_read``)
    """
    if not name:
        return None
    norm_name = name.lower().replace("-", "_").strip("_")
    name_tokens = set(t for t in norm_name.split("_") if len(t) >= 3)
    if not name_tokens:
        return None

    for tool in _native_tool_names():
        norm_tool = tool.lower().replace("-", "_").strip("_")
        if not norm_tool:
            continue
        # 1. Exact (post-normalization)
        if norm_name == norm_tool:
            return tool
        # 2. Tokens overlap ≥ 80% AND tool name long enough (anti faux positif
        # sur tools courts type "kb_read" qui matcheraient trop facilement).
        if len(norm_tool) >= 8:
            tool_tokens = set(t for t in norm_tool.split("_") if len(t) >= 3)
            if tool_tokens and tool_tokens.issubset(name_tokens):
                # Tous les tokens du tool sont dans le name → forte présomption
                # de doublon (ex: name="create_valkyrie_card" contient tous les
                # tokens de "valkyrie_create_card").
                return tool
        # 3. Substring ≥ 12 chars (capture les variantes type _skill / skill_)
        if len(norm_tool) >= 12 and norm_tool in norm_name:
            return tool
    return None


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
    # Duplicate check is case-insensitive so "MySkill" and "myskill" collide
    existing = await session.execute(
        select(UserSkill).where(
            UserSkill.user_id == user_id,
            func.lower(UserSkill.name) == name.lower(),
        )
    )
    if existing.scalars().first():
        return {"success": False, "error": f"Skill '{name}' existe déjà"}

    # Guardrail anti-doublon avec actions natives. Le skill_synthesizer générait
    # des skills "create_valkyrie_card" qui dupliquaient le tool natif
    # `valkyrie_create_card` → l'agent finissait par invoquer le skill au lieu
    # du tool, ce qui fait perdre du temps + pollue l'UI.
    conflict = _is_native_action_duplicate(name)
    if conflict:
        return {
            "success": False,
            "error": (
                f"Le nom '{name}' duplique l'action native '{conflict}' — "
                "utilise directement le tool natif, pas besoin de skill."
            ),
            "conflicting_tool": conflict,
        }

    # Get max position
    max_pos = await session.execute(
        select(UserSkill.position).where(UserSkill.user_id == user_id).order_by(UserSkill.position.desc()).limit(1)
    )
    pos = (max_pos.scalar() or 0) + 1

    data["name"] = name
    session.add(UserSkill(user_id=user_id, name=name, data_json=data, position=pos))
    await _remove_tombstone(session, user_id, "skills", name)
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
    # If this name is a shipped default, tombstone it so the seed won't
    # respawn it on the next list call.
    if _name_in_defaults(name, "skills.json", "skills"):
        await _add_tombstone(session, user_id, "skills", name)
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
        select(UserPersonality).where(
            UserPersonality.user_id == user_id,
            func.lower(UserPersonality.name) == name.lower(),
        )
    )
    if existing.scalars().first():
        return {"success": False, "error": f"Personnalité '{name}' existe déjà"}

    max_pos = await session.execute(
        select(UserPersonality.position).where(UserPersonality.user_id == user_id).order_by(UserPersonality.position.desc()).limit(1)
    )
    pos = (max_pos.scalar() or 0) + 1

    data["name"] = name
    session.add(UserPersonality(user_id=user_id, name=name, data_json=data, position=pos))
    await _remove_tombstone(session, user_id, "personalities", name)
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
    if _name_in_defaults(name, "personalities.json", "personalities"):
        await _add_tombstone(session, user_id, "personalities", name)
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
        select(UserSubAgent).where(
            UserSubAgent.user_id == user_id,
            func.lower(UserSubAgent.name) == name.lower(),
        )
    )
    if existing.scalars().first():
        return {"success": False, "error": f"Agent '{name}' existe déjà"}

    max_pos = await session.execute(
        select(UserSubAgent.position).where(UserSubAgent.user_id == user_id).order_by(UserSubAgent.position.desc()).limit(1)
    )
    pos = (max_pos.scalar() or 0) + 1

    data["name"] = name
    session.add(UserSubAgent(user_id=user_id, name=name, data_json=data, position=pos))
    await _remove_tombstone(session, user_id, "sub_agents", name)
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
    if _name_in_defaults(name, "agents.json", "agents"):
        await _add_tombstone(session, user_id, "sub_agents", name)
    return {"success": True}
