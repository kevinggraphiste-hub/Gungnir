"""
Inter-agent conversation logger.

Captures every invocation of a sub-agent (from the main agent or from another
sub-agent) with the full message history, tool events and final result.
The user can then browse these conversations from the UI to see exactly
what happened between agents.

Storage: backend/data/inter_agent_conversations/
  - index.json               -> list of conversation metadata (for fast listing)
  - {conversation_id}.json   -> full conversation record

Nothing is hardcoded per user: everything lives under the existing data/ dir
and is created on demand. Works with any provider/model the user configured.
"""
from __future__ import annotations

import json
import uuid
import contextvars
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Optional


_LOG_DIR = Path(__file__).parent.parent.parent / "data" / "inter_agent_conversations"
_INDEX_FILE = _LOG_DIR / "index.json"
_MAX_INDEX_ENTRIES = 500  # keep last N in the index (files on disk are not auto-deleted)


# Contextvar so nested calls (sub-agent invoking another sub-agent) know their parent
_current_conversation_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "inter_agent_current_conversation_id", default=None
)
_current_depth: contextvars.ContextVar[int] = contextvars.ContextVar(
    "inter_agent_current_depth", default=0
)


@dataclass
class InterAgentConversation:
    id: str
    caller: str                  # "main" or sub-agent name
    callee: str                  # sub-agent name being invoked
    task: str
    parent_id: Optional[str]
    depth: int
    provider: Optional[str] = None
    model: Optional[str] = None
    started_at: str = ""
    ended_at: Optional[str] = None
    messages: list[dict] = field(default_factory=list)
    tool_events: list[dict] = field(default_factory=list)
    final_result: Optional[str] = None
    tokens_input: int = 0
    tokens_output: int = 0
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


def _ensure_dir():
    _LOG_DIR.mkdir(parents=True, exist_ok=True)


def _load_index() -> list[dict]:
    if not _INDEX_FILE.exists():
        return []
    try:
        return json.loads(_INDEX_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_index(entries: list[dict]):
    _ensure_dir()
    _INDEX_FILE.write_text(
        json.dumps(entries[-_MAX_INDEX_ENTRIES:], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _save_conversation(conv: InterAgentConversation):
    _ensure_dir()
    file = _LOG_DIR / f"{conv.id}.json"
    file.write_text(json.dumps(conv.to_dict(), ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    # Update index (overwrite existing entry if present)
    idx = _load_index()
    idx = [e for e in idx if e.get("id") != conv.id]
    idx.append({
        "id": conv.id,
        "caller": conv.caller,
        "callee": conv.callee,
        "task": conv.task[:200],
        "parent_id": conv.parent_id,
        "depth": conv.depth,
        "provider": conv.provider,
        "model": conv.model,
        "started_at": conv.started_at,
        "ended_at": conv.ended_at,
        "tokens_input": conv.tokens_input,
        "tokens_output": conv.tokens_output,
        "has_error": conv.error is not None,
    })
    _save_index(idx)


class ConversationRecorder:
    """Context manager that wires up a new InterAgentConversation and the contextvars."""

    def __init__(self, callee: str, task: str, provider: str = None, model: str = None):
        self.conv = InterAgentConversation(
            id=f"iac_{uuid.uuid4().hex[:12]}",
            caller=_current_conversation_id_caller_name(),
            callee=callee,
            task=task,
            parent_id=_current_conversation_id.get(),
            depth=_current_depth.get(),
            provider=provider,
            model=model,
            started_at=datetime.utcnow().isoformat() + "Z",
        )
        self._tok_id = None
        self._tok_depth = None

    def __enter__(self) -> "ConversationRecorder":
        self._tok_id = _current_conversation_id.set(self.conv.id)
        self._tok_depth = _current_depth.set(self.conv.depth + 1)
        _save_conversation(self.conv)  # persist immediately so UI sees the running conv
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc is not None:
            self.conv.error = f"{exc_type.__name__}: {exc}"
        self.conv.ended_at = datetime.utcnow().isoformat() + "Z"
        try:
            _save_conversation(self.conv)
        except Exception:
            pass
        if self._tok_id is not None:
            _current_conversation_id.reset(self._tok_id)
        if self._tok_depth is not None:
            _current_depth.reset(self._tok_depth)
        return False  # don't swallow exceptions

    # Recording helpers ---------------------------------------------------

    def record_message(self, role: str, content: str, tool_calls: Any = None, tool_call_id: str = None):
        entry: dict = {"role": role, "content": content or ""}
        if tool_calls:
            entry["tool_calls"] = tool_calls
        if tool_call_id:
            entry["tool_call_id"] = tool_call_id
        self.conv.messages.append(entry)

    def record_messages(self, messages: list):
        """Bulk record — accepts ChatMessage objects or dicts."""
        for m in messages:
            if hasattr(m, "role"):
                self.record_message(
                    role=getattr(m, "role", ""),
                    content=getattr(m, "content", "") or "",
                    tool_calls=getattr(m, "tool_calls", None),
                    tool_call_id=getattr(m, "tool_call_id", None),
                )
            elif isinstance(m, dict):
                self.record_message(
                    role=m.get("role", ""),
                    content=m.get("content", "") or "",
                    tool_calls=m.get("tool_calls"),
                    tool_call_id=m.get("tool_call_id"),
                )

    def record_tool_event(self, tool: str, args: dict, result: dict):
        self.conv.tool_events.append({
            "tool": tool,
            "args": args,
            "result": result,
            "at": datetime.utcnow().isoformat() + "Z",
        })

    def set_result(self, result: str, tokens_input: int = 0, tokens_output: int = 0):
        self.conv.final_result = result
        self.conv.tokens_input = tokens_input
        self.conv.tokens_output = tokens_output

    def flush(self):
        try:
            _save_conversation(self.conv)
        except Exception:
            pass


def _current_conversation_id_caller_name() -> str:
    """Determine the caller name: 'main' if no active conv, otherwise the callee of the parent."""
    parent_id = _current_conversation_id.get()
    if not parent_id:
        return "main"
    # Look up the parent's callee name from the index
    for entry in reversed(_load_index()):
        if entry.get("id") == parent_id:
            return entry.get("callee", "unknown")
    return "unknown"


# Public API ----------------------------------------------------------------

def list_conversations(limit: int = 100, parent_id: Optional[str] = None) -> list[dict]:
    idx = _load_index()
    if parent_id is not None:
        idx = [e for e in idx if e.get("parent_id") == parent_id]
    return list(reversed(idx))[:limit]


def get_conversation(conv_id: str) -> Optional[dict]:
    file = _LOG_DIR / f"{conv_id}.json"
    if not file.exists():
        return None
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except Exception:
        return None


def get_conversation_tree(root_id: str) -> Optional[dict]:
    """Return a conversation with its nested children attached under `children`."""
    root = get_conversation(root_id)
    if not root:
        return None
    idx = _load_index()
    children_ids = [e["id"] for e in idx if e.get("parent_id") == root_id]
    root["children"] = [get_conversation_tree(cid) for cid in children_ids if cid]
    return root


def delete_conversation(conv_id: str) -> bool:
    file = _LOG_DIR / f"{conv_id}.json"
    existed = file.exists()
    if existed:
        try:
            file.unlink()
        except Exception:
            pass
    idx = [e for e in _load_index() if e.get("id") != conv_id]
    _save_index(idx)
    return existed


def clear_all_conversations() -> int:
    _ensure_dir()
    count = 0
    for f in _LOG_DIR.glob("iac_*.json"):
        try:
            f.unlink()
            count += 1
        except Exception:
            pass
    _save_index([])
    return count
