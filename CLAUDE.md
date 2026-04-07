# Gungnir — Project Guide

## Overview
Gungnir is a full-stack AI super-assistant platform with modular plugin architecture.
- **Backend:** FastAPI (Python) at `/backend/core/`, port 8000
- **Frontend:** React + Vite + TypeScript at `/frontend/`, port 5173 (proxies /api → 8000)
- **Database:** SQLite (dev: `data/gungnir.db`), PostgreSQL (prod)
- **Plugins:** 8 plugins in `/backend/plugins/` with manifest.json + routes.py pattern
- **Branding:** ScarletWolf theme — scarlet red #dc2626, dark backgrounds, wolf identity

## Quick Start
```bash
# Backend
python -m uvicorn backend.core.main:app --host 127.0.0.1 --port 8000 --reload
# Frontend
cd frontend && npm run dev
```

## Key Architecture
- **Plugin system:** manifest.json declares metadata, routes.py provides FastAPI endpoints, frontend lazy-loads from `src/plugins/`
- **State:** Zustand stores (appStore, pluginStore, sidebarStore)
- **API client:** `frontend/src/core/services/api.ts` — all backend calls
- **LLM providers:** OpenRouter (default), + Anthropic, OpenAI, Google, MiniMax, Ollama
- **i18n:** French default, configured in `frontend/src/i18n/`
- **Agent tools:** WOLF tool system in `backend/core/agents/` (bash, filesystem, git, browser, web_fetch)

## Code Conventions
- French UI strings throughout
- Plugin components export default React component
- Backend plugins follow manifest.json + routes.py pattern
- appStore persists provider/model selection to localStorage
- Vite aliases: `@` → src, `@core` → src/core, `@plugins` → src/plugins

## Current State
- Phase 2 in progress: core pages migrated (Chat, AgentSettings, Settings)
- Next: plugin UI wiring, auth enforcement, production hardening
