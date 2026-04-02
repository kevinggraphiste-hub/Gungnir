from fastapi import APIRouter
from pathlib import Path
import json
import uuid as _uuid_mod

from backend.core.config.settings import Settings
from backend.core.providers import get_provider, ChatMessage
from backend.core.agents.wolf_tools import WOLF_TOOL_SCHEMAS, WOLF_EXECUTORS, READ_ONLY_TOOLS

router = APIRouter()

# Import helper functions from chat module (needed by invoke_sub_agent)
from backend.core.api.chat import (
    _parse_text_tool_calls,
    _detect_web_refusal,
    _extract_urls_from_conversation,
    _prefetch_urls_in_message,
    SOUL_FILE,
    DEFAULT_SOUL,
)


@router.get("/agent/mode")
async def get_agent_mode():
    from backend.core.agents.mode_manager import mode_manager
    return {
        "mode": mode_manager.current_mode.value,
        "pending_requests": [
            {"id": r.id, "action": r.action, "details": r.details, "status": r.status}
            for r in mode_manager.get_pending_requests()
        ]
    }


@router.post("/agent/mode/{mode}")
async def set_agent_mode(mode: str):
    from backend.core.agents.mode_manager import mode_manager, AgentMode
    try:
        mode_manager.set_mode(AgentMode(mode))
        return {"success": True, "mode": mode}
    except ValueError:
        return {"success": False, "error": "Invalid mode"}


@router.post("/agent/permission/{request_id}/approve")
async def approve_permission(request_id: str):
    from backend.core.agents.mode_manager import mode_manager
    success = await mode_manager.approve_request(request_id)
    return {"success": success}


@router.post("/agent/permission/{request_id}/deny")
async def deny_permission(request_id: str, reason: str = ""):
    from backend.core.agents.mode_manager import mode_manager
    success = await mode_manager.deny_request(request_id, reason)
    return {"success": success}


@router.get("/skills")
async def list_skills(category: str = None):
    from backend.core.agents.skills import skill_library
    skills = skill_library.list_skills(category)
    return [
        {
            "name": s.name,
            "description": s.description,
            "prompt": s.prompt,
            "category": s.category,
            "tools": s.tools,
            "usage_count": s.usage_count,
        }
        for s in skills
    ]


@router.post("/skills")
async def create_skill(data: dict):
    from backend.core.agents.creators import skill_creator
    result = await skill_creator.create_skill(
        name=data.get("name", ""),
        description=data.get("description", ""),
        prompt=data.get("prompt", ""),
        tools=data.get("tools", []),
        code=data.get("code"),
    )
    return result


@router.post("/skills/import")
async def import_skill(data: dict):
    from backend.core.agents.creators import skill_creator
    return await skill_creator.import_skill(data)


@router.post("/skills/validate")
async def validate_skills():
    from backend.core.agents.creators import skill_creator
    return await skill_creator.validate_all_skills()


@router.put("/skills/{skill_name}")
async def update_skill(skill_name: str, data: dict):
    from backend.core.agents.creators import skill_creator
    return await skill_creator.update_skill(
        skill_name,
        description=data.get("description"),
        prompt=data.get("prompt"),
        tools=data.get("tools"),
        category=data.get("category"),
    )


@router.delete("/skills/{skill_name}")
async def delete_skill(skill_name: str):
    from backend.core.agents.creators import skill_creator
    return await skill_creator.delete_skill(skill_name)


@router.get("/sub-agents")
async def list_sub_agents():
    from backend.core.agents.skills import subagent_library
    agents = subagent_library.list_agents()
    return [
        {
            "name": a.name,
            "role": a.role,
            "expertise": a.expertise,
            "system_prompt": a.system_prompt,
            "tools": a.tools,
            "description": a.role,  # compatibilite UI existante
        }
        for a in agents
    ]


@router.post("/sub-agents")
async def create_sub_agent(data: dict):
    from backend.core.agents.skills import subagent_library, SubAgent
    import uuid as _uuid
    name = data.get("name", "")
    if not name.startswith("agent_"):
        name = f"agent_{name}"
    agent = SubAgent(
        id=str(_uuid.uuid4())[:8],
        name=name,
        role=data.get("role", ""),
        expertise=data.get("expertise", ""),
        system_prompt=data.get("system_prompt", f"Tu es {data.get('role', '')}. Expertise : {data.get('expertise', '')}."),
        tools=data.get("tools", []),
        created_at=__import__("datetime").datetime.utcnow(),
    )
    subagent_library.add_agent(agent)
    return {"success": True, "name": name}


@router.put("/sub-agents/{agent_name}")
async def update_sub_agent(agent_name: str, data: dict):
    from backend.core.agents.skills import subagent_library
    agent = subagent_library.get_agent(agent_name)
    if not agent:
        return {"success": False, "error": "Agent introuvable"}
    for field in ("role", "expertise", "system_prompt", "tools", "provider", "model"):
        if field in data and data[field] is not None:
            setattr(agent, field, data[field])
    subagent_library._save()
    return {"success": True}


@router.post("/sub-agents/{agent_name}/invoke")
async def invoke_sub_agent(agent_name: str, data: dict):
    """
    Lance un sous-agent sur une tache avec son propre modele/provider.
    Le sous-agent a acces aux outils web (browser, scraping, crawl, search).
    Boucle multi-rounds : le sous-agent peut appeler des tools puis repondre.
    """
    import json as _json, uuid as _uuid
    from backend.core.agents.skills import subagent_library
    from backend.core.agents.wolf_tools import WOLF_EXECUTORS, _get_tools_for_agent

    agent = subagent_library.get_agent(agent_name)
    if not agent:
        return {"error": f"Sous-agent '{agent_name}' introuvable"}

    task = data.get("task", "")
    if not task:
        return {"error": "Tache vide"}

    settings = Settings.load()
    provider_name = agent.provider or "openrouter"
    provider_cfg = settings.providers.get(provider_name)
    if not provider_cfg or not provider_cfg.enabled or not provider_cfg.api_key:
        return {"error": f"Provider '{provider_name}' non configure"}

    model = agent.model or provider_cfg.default_model
    provider = get_provider(provider_name, provider_cfg.api_key, provider_cfg.base_url)

    # System prompt enrichi + outils web
    system = agent.system_prompt
    system += """

## TES OUTILS -- DISPONIBLES IMMEDIATEMENT
Tu as un acces COMPLET a Internet. Ne dis JAMAIS que tu n'as pas acces au web. AGIS IMMEDIATEMENT.

### Outils principaux (utilise-les EN PREMIER) :
- `web_fetch(url)` -- **OUTIL #1 : Acceder a n'importe quelle URL.** HTTP GET -> retourne le texte propre.
- `web_search(query)` -- **OUTIL #2 : Recherche web instantanee** (DuckDuckGo).
- `web_crawl(url, max_pages)` -- **OUTIL #3 : Crawler un site entier.**

### Outils avances (si web_fetch ne suffit pas) :
- `browser_navigate(url)` -> page_id (navigateur pour JS dynamique/SPA)
- `browser_get_text(page_id)` / `browser_get_links(page_id)` / `browser_screenshot(page_id)`
- `browser_extract_table(page_id)` / `browser_query_selector_all(page_id, selector, extract)`
- `browser_download(page_id, url)` -- Telecharger un fichier"""

    agent_tools = _get_tools_for_agent(agent.tools)

    # Pre-fetch URLs dans la tache du sous-agent
    tool_events = []
    _prefetched = await _prefetch_urls_in_message(task, tool_events)
    enriched_task = task
    if _prefetched:
        prefetch_content = "\n\n---\n\n".join(_prefetched)
        enriched_task = task + f"\n\n---\n**Contenu web recupere automatiquement :**\n\n{prefetch_content}"

    messages = [
        ChatMessage(role="system", content=system),
        ChatMessage(role="user", content=enriched_task),
    ]

    total_input = 0
    total_output = 0

    try:
        MAX_ROUNDS = 8
        _native_mode = True
        response = None

        for _round in range(MAX_ROUNDS):
            if _native_mode:
                try:
                    response = await provider.chat(messages, model, tools=agent_tools, tool_choice="auto")
                except Exception:
                    _native_mode = False
                    response = await provider.chat(messages, model)
            else:
                response = await provider.chat(messages, model)
            total_input += response.tokens_input
            total_output += response.tokens_output

            # Fallback 1: text parsing
            if not response.tool_calls and response.content:
                text_tools = _parse_text_tool_calls(response.content)
                if text_tools:
                    response.tool_calls = text_tools
                    print(f"[SubAgent] Parsed {len(text_tools)} tool call(s) from text")

            # Fallback 2: web refusal -> direct execution + inject as user msg
            if not response.tool_calls and response.content and _detect_web_refusal(response.content):
                _native_mode = False
                urls = _extract_urls_from_conversation(messages)
                if urls:
                    url = urls[-1]
                    print(f"[SubAgent] Web refusal -- auto web_fetch: {url}")
                    try:
                        from backend.core.agents.tools.web_fetch import web_fetch as _wf
                        tool_result = await _wf(url, extract="all")
                    except Exception as ex:
                        tool_result = {"ok": False, "error": str(ex)}
                    tool_events.append({"tool": "web_fetch", "args": {"url": url}, "result": tool_result})
                    result_text = _json.dumps(tool_result, ensure_ascii=False, indent=2)
                    messages.append(ChatMessage(role="assistant", content="J'accede au site..."))
                    messages.append(ChatMessage(
                        role="user",
                        content=f"Contenu de {url} :\n\n{result_text[:10000]}\n\nAnalyse et reponds.",
                    ))
                    continue
                # else: no URL, break

            if not response.tool_calls:
                break

            # Execute tools
            _is_text_parsed = any(
                tc.get("id", "").startswith("textparse-") for tc in response.tool_calls
            )
            all_results = []
            for tc in response.tool_calls:
                fn = tc.get("function", {})
                tool_name = fn.get("name", "")
                call_id = tc.get("id") or str(_uuid.uuid4())[:8]
                try:
                    args = _json.loads(fn.get("arguments", "{}")) if isinstance(fn.get("arguments"), str) else fn.get("arguments", {})
                except Exception:
                    args = {}

                executor = WOLF_EXECUTORS.get(tool_name)
                if executor:
                    try:
                        tool_result = await executor(**args)
                    except Exception as ex:
                        tool_result = {"ok": False, "error": str(ex)}
                else:
                    tool_result = {"ok": False, "error": f"Outil '{tool_name}' inconnu."}

                tool_events.append({"tool": tool_name, "args": args, "result": tool_result})
                all_results.append({"tool": tool_name, "args": args, "result": tool_result, "call_id": call_id})

            # Inject results
            if _is_text_parsed or not _native_mode:
                messages.append(ChatMessage(role="assistant", content=response.content or "Execution des outils..."))
                parts = []
                for r in all_results:
                    parts.append(f"**{r['tool']}** -> {_json.dumps(r['result'], ensure_ascii=False)[:6000]}")
                messages.append(ChatMessage(role="user", content="Resultats :\n\n" + "\n\n".join(parts) + "\n\nReponds avec ces donnees."))
            else:
                messages.append(ChatMessage(role="assistant", content=response.content or "", tool_calls=response.tool_calls))
                for r in all_results:
                    messages.append(ChatMessage(role="tool", content=_json.dumps(r["result"], ensure_ascii=False)[:3000], tool_call_id=r["call_id"]))

        if response and response.tool_calls:
            response = await provider.chat(messages, model)
            total_input += response.tokens_input
            total_output += response.tokens_output

        return {
            "agent": agent_name,
            "role": agent.role,
            "model": model,
            "provider": provider_name,
            "result": response.content if response else "",
            "tokens_input": total_input,
            "tokens_output": total_output,
            "tool_events": tool_events if tool_events else None,
        }
    except Exception as e:
        return {"error": str(e)}


@router.delete("/sub-agents/{agent_name}")
async def delete_sub_agent(agent_name: str):
    from backend.core.agents.skills import subagent_library
    subagent_library.remove_agent(agent_name)
    return {"success": True}


@router.get("/security/scan")
async def security_scan():
    from backend.core.agents.security import security_scanner
    return {
        "score": security_scanner._calculate_score(),
        "violations": security_scanner.violations,
    }


@router.post("/security/scan/code")
async def scan_code(data: dict):
    from backend.core.agents.security import security_scanner
    result = security_scanner.scan_code(data.get("code", ""), data.get("file_path"))
    return result


@router.post("/security/scan/skill")
async def scan_skill(data: dict):
    from backend.core.agents.security import security_scanner
    result = security_scanner.scan_skill(data.get("prompt", ""), data.get("code", ""))
    return result


@router.get("/soul")
async def get_soul():
    content = SOUL_FILE.read_text(encoding="utf-8") if SOUL_FILE.exists() else DEFAULT_SOUL
    return {"content": content}


@router.post("/soul")
async def save_soul(data: dict):
    content = data.get("content", "").strip()
    if not content:
        return {"success": False, "error": "Contenu vide"}
    SOUL_FILE.parent.mkdir(exist_ok=True)
    SOUL_FILE.write_text(content, encoding="utf-8")
    return {"success": True}


@router.get("/personality")
async def list_personalities():
    from backend.core.agents.skills import personality_manager
    return [
        {
            "name": p.name,
            "description": p.description,
            "system_prompt": p.system_prompt,
            "traits": p.traits,
            "active": p.name == personality_manager.active_personality,
        }
        for p in personality_manager.list_personalities()
    ]


@router.post("/personality/{name}")
async def set_personality(name: str):
    from backend.core.agents.skills import personality_manager
    personality_manager.set_active(name)
    return {"success": True, "active_personality": name}


@router.post("/personality")
async def create_personality(data: dict):
    from backend.core.agents.skills import personality_manager, Personality
    import uuid
    from datetime import datetime
    name = data.get("name", "").strip()
    if not name:
        return {"success": False, "error": "Nom requis"}
    personality = Personality(
        id=str(uuid.uuid4())[:8],
        name=name,
        description=data.get("description", ""),
        system_prompt=data.get("system_prompt", ""),
        traits=data.get("traits", []),
        created_at=datetime.utcnow()
    )
    personality_manager.add_personality(personality)
    return {"success": True}


@router.put("/personality/{name}")
async def update_personality(name: str, data: dict):
    from backend.core.agents.skills import personality_manager
    ok = personality_manager.update_personality(
        name,
        description=data.get("description"),
        system_prompt=data.get("system_prompt"),
        traits=data.get("traits"),
    )
    return {"success": ok}


@router.delete("/personality/{name}")
async def delete_personality(name: str):
    from backend.core.agents.skills import personality_manager
    ok = personality_manager.remove_personality(name)
    return {"success": ok}
