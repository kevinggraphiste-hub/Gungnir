# Gungnir — Vue d'ensemble complète

> **Gungnir** est une plateforme full-stack d'assistant IA modulaire à architecture plugins. Un agent principal (identité "Wolf") orchestre des sous-agents spécialisés, appelle des outils, pilote un navigateur, exécute du code, gère sa propre mémoire et expose des intégrations via MCP et API REST — le tout avec une UI moderne à thème ScarletWolf.

---

## 1. Architecture générale

| Couche | Stack | Emplacement | Port |
|---|---|---|---|
| **Backend** | FastAPI + Python 3.12 | `backend/core/` | `8000` |
| **Frontend** | React + Vite + TypeScript + Tailwind + Zustand | `frontend/` | `5173` (dev) |
| **Base de données** | SQLite (dev) / PostgreSQL 16 (prod) | `data/gungnir.db` / service `db` | — |
| **Déploiement** | Docker Compose multi-stage | `deploy/Dockerfile` | — |
| **i18n** | Français par défaut, i18next | `frontend/src/i18n/` | — |

- **Plugin system** : 9 plugins, chacun avec `manifest.json` + `routes.py` côté back + composant React lazy-loadé côté front
- **État** : Zustand (`appStore`, `pluginStore`, `sidebarStore`) avec persistance localStorage pour les préférences (provider/modèle, favoris, thème)
- **Sécurité** : clés API chiffrées via PBKDF2 machine-specific, scanner de code/skills OWASP-inspired, mode de permissions granulaire
- **Branding** : thème ScarletWolf (rouge scarlet `#dc2626`, fonds sombres, identité lupine)

---

## 2. Le cœur : l'agent Gungnir (alias "Wolf")

### 2.1 Providers LLM supportés

Configurés dans `backend/core/providers/`, tous peuvent fonctionner en parallèle — l'utilisateur choisit le provider/modèle par conversation ou par sous-agent.

- **OpenRouter** (défaut — accès à des centaines de modèles)
- **Anthropic** (Claude 3.5, 3.7, 4.x)
- **OpenAI** (GPT-4, GPT-4o, o-series)
- **Google** (Gemini)
- **MiniMax**
- **Ollama** (modèles locaux)

### 2.2 Modes de fonctionnement

Trois modes pilotés via `mode_manager` :

| Mode | Description |
|---|---|
| **Autonomous** | L'agent agit sans demander la permission (sauf actions critiques) |
| **Ask permission** (défaut) | Demande confirmation avant les actions sensibles (write, delete, execute) |
| **Restrained** | Aucune exécution d'outil sans validation explicite |

### 2.3 Sélection de personnalité

12+ personnalités système préconfigurées + création/import/édition en direct depuis l'UI ou depuis le chat. Une personnalité active injecte son `system_prompt` à chaque message.

- Création / édition / suppression
- Réorganisation drag-and-drop avec indicateurs visuels
- Détection de commande de changement en chat ("passe en mode X")
- Persistance dans `backend/data/personalities.json`

### 2.4 Système de Skills

Skills = compétences réutilisables avec prompt spécialisé et sélection d'outils.

**Skills par défaut** : `code_reviewer`, `debugger`, `architect`, `researcher`, `writer`

**Fonctionnalités** :
- CRUD complet (création, édition, suppression, import JSON)
- Favoris (étoile, limite 5)
- Drag-and-drop pour réordonner
- **Activation** : un bouton "Utiliser" active un skill → son prompt est injecté dans le system prompt de chaque message jusqu'à désactivation
- Métadonnées standards : version, auteur, licence, tags, annotations (readOnly/destructive/idempotent), exemples, format de sortie
- Scanner de sécurité à la création/import (bloque les skills suspects)

### 2.5 Sous-agents spécialisés

Création de sous-agents avec leur propre provider/modèle/prompt/outils.

- **Invocation** : depuis le chat via l'outil `subagent_invoke`, ou depuis l'UI via le bouton de lancement
- **Hiérarchie** : un sous-agent peut lui-même invoquer d'autres sous-agents (profondeur max = 3, anti-boucle)
- **Collaboration** : tous partagent une base de connaissances (KB) via `kb_read`/`kb_write`
- **Multi-rounds** : chaque sous-agent tourne jusqu'à 8 rounds d'appels d'outils avant de répondre
- **Gateway web intégré** : pré-fetch les URLs dans la tâche, détection de refus web → force search DuckDuckGo
- **Visibilité complète** : onglet **"Conversations inter-agents"** dans Configuration Agent qui affiche l'historique complet des échanges (agent ↔ sous-agent et sous-agent ↔ sous-agent) avec messages, tool events, arborescence cliquable

### 2.6 "Âme" (Soul)

Chaque agent a un fichier d'identité markdown éditable depuis l'UI (nom, personnalité de base, mémoire longue). Persisté dans `backend/data/soul.md`.

---

## 3. Boîte à outils WOLF (56 outils)

L'agent a accès à 56 outils définis dans `backend/core/agents/wolf_tools.py`, appelés en mode function-calling natif (ou parsing texte fallback).

### 3.1 Gestion des skills / personnalités / sous-agents
- `skill_create`, `skill_update`, `skill_delete`, `skill_list`
- `personality_create`, `personality_update`, `personality_delete`, `personality_set_active`
- `subagent_create`, `subagent_update`, `subagent_delete`, `subagent_list`, `subagent_invoke`

### 3.2 Navigation web & scraping
- `web_fetch` — HTTP GET avec extraction Trafilatura (texte propre)
- `web_search` — Recherche DuckDuckGo
- `web_crawl` — Crawl multi-pages d'un domaine

### 3.3 Navigateur automatisé (Playwright + Chromium)
`browser_navigate`, `browser_goto`, `browser_click`, `browser_type`, `browser_press_key`, `browser_screenshot`, `browser_get_text`, `browser_get_html`, `browser_get_links`, `browser_get_page_info`, `browser_evaluate`, `browser_wait_for_selector`, `browser_scroll`, `browser_extract_table`, `browser_query_selector_all`, `browser_select_option`, `browser_fill_form`, `browser_download`, `browser_crawl`, `browser_list_pages`, `browser_close`

→ Permet login, scraping dynamique JS/SPA, captures d'écran, extraction de tables, remplissage de formulaires, téléchargement de fichiers.

### 3.4 Système de fichiers & exécution
- `file_read`, `file_write`, `file_patch`, `file_list`
- `bash_exec` — Exécution de commandes shell (sandboxée au workspace)

### 3.5 Base de connaissances partagée (KB)
- `kb_write`, `kb_read`, `kb_list` — Fichiers markdown dans `backend/data/knowledge/` accessibles à tous les agents

### 3.6 Âme & diagnostic
- `soul_read`, `soul_write`
- `doctor_check` — Diagnostic complet du système (providers, plugins, DB, MCP, scheduler)

### 3.7 Planification & tâches
- `schedule_task`, `schedule_list`, `schedule_delete` — Tâches récurrentes ou ponctuelles

### 3.8 Configuration dynamique
- `provider_manage` — Configure les providers LLM (ajout/update de clés, activation)
- `mcp_manage` — Configure les serveurs MCP (ajout/update, start/stop)
- `channel_manage` — Configure les canaux de communication (Discord, Slack, Email, etc.)
- `service_connect` — Connecte un service externe (n8n, GitHub, GitLab, Notion, Supabase, Linear, Slack, Discord, etc.) avec la clé utilisateur
- `service_call` — Effectue un appel REST authentifié sur un service connecté (avec gardes sécurité contre les URLs de métadonnées cloud)

---

## 4. Plugins (9 modules fonctionnels)

Chaque plugin = dossier `backend/plugins/<nom>/` + `frontend/src/plugins/<nom>/`, découvert automatiquement au démarrage.

### 4.1 HuntR — `browser` (v2.0)
Interface de navigation web assistée par l'IA. Permet à l'utilisateur de déléguer des tâches de recherche web à l'agent avec résultats structurés. Icône Globe.

### 4.2 Chat Vocal — `voice` (v1.0)
Mode conversationnel vocal (STT + TTS) pour discuter avec l'agent à l'oral. Icône Mic.

### 4.3 Conscience — `consciousness` (v3.0, section "core")
Module d'auto-réflexion : l'agent analyse ses propres interactions, extrait des patterns, persiste des "pensées" et les réinjecte comme contexte lors des futures conversations. Lifecycle hooks pour enregistrer chaque interaction. Icône Brain.

### 4.4 SpearCode — `code` (v1.0)
Éditeur de code intégré avec exécution, assistance IA inline, revue de code. Icône Code.

### 4.5 Automata — `scheduler` (v1.0)
Planificateur de tâches récurrentes : l'agent peut exécuter des actions à intervalles réguliers (scraping, rapports, notifications). Lifecycle hooks pour le daemon. Icône Calendar.

### 4.6 Channels — `channels` (v1.0, section "integrations")
Gestion des canaux de communication : l'agent peut recevoir/envoyer des messages via Discord, Slack, Email, Telegram, Webhooks, etc. Icône RadioTower.

### 4.7 Intégrations — `webhooks` (v2.0, section "integrations")
Catalogue d'intégrations tierces (n8n, Zapier, Make, services REST) avec gestion des clés API chiffrées. Icône Plug.

### 4.8 Modèles — `model_guide` (v1.0)
Catalogue documenté des modèles LLM disponibles, benchmarks, recommandations par cas d'usage. Icône BookOpen.

### 4.9 Analytics — `analytics` (v1.0)
Tableau de bord : usage par provider/modèle, coûts (tokens in/out), historique des appels d'outils, conversations inter-agents, stats des sous-agents. Lifecycle hooks. Icône BarChart3.

---

## 5. Pages core du front

### 5.1 Chat (`/`)
- Conversations multi-sessions persistées en DB
- Sélection provider/modèle par conversation
- Favoris modèles (localStorage, max 5)
- Upload d'images (vision), affichage multimodal
- Streaming des réponses
- Détection de commandes inline (`change de modèle`, `passe en mode X`)
- Affichage des tool calls en temps réel avec résultats repliables
- Gateway web automatique : pré-fetch des URLs citées dans les messages
- Parsing texte fallback pour les modèles sans function-calling natif

### 5.2 Configuration Agent (`/agent-settings`)
Onglets :
- **Mode** — Sélection du mode (autonomous / ask_permission / restrained)
- **Modèle** — Provider + modèle actif, favoris, recherche
- **Skills** — CRUD, activation (Utiliser/Désactiver), favoris, drag-and-drop, scanner de sécurité, import JSON
- **Sous-agents** — CRUD, invocation, import JSON
- **Personnalité** — CRUD, drag-and-drop avec indicateurs visuels, édition de l'Âme
- **Conversations inter-agents** — Historique complet des échanges entre agents, arborescence des sous-appels, tool events, messages complets par rôle
- **Sécurité** — Score global, scanner de code, scanner de skill, liste des violations

### 5.3 Paramètres (`/settings`)
- Providers LLM : ajout/édition des clés API (chiffrées), test de connexion, découverte des modèles
- Serveurs MCP : ajout/édition, auto-démarrage, état
- Apparence : thème, langue, nom d'agent, avatar
- Utilisateurs : CRUD (multi-user), auth
- Backup : sauvegardes automatiques + restauration

### 5.4 Login (`/login`)
Authentification multi-utilisateur. Support onboarding first-run (configuration initiale de l'agent).

---

## 6. Fonctionnalités transverses

### 6.1 MCP (Model Context Protocol)
- Client JSON-RPC 2.0 sur stdio (`mcp_client.py`)
- `MCPManager` singleton qui auto-démarre les serveurs au boot
- L'agent peut appeler les outils MCP comme ses propres outils (merge avec WOLF_TOOL_SCHEMAS)
- Gestion via l'UI ou via l'outil `mcp_manage` en chat

### 6.2 Base de connaissances partagée
Dossier `backend/data/knowledge/` — fichiers markdown lus/écrits par tous les agents. Sert de mémoire longue commune.

### 6.3 Mémoire de l'agent
Classe `AgentMemory` avec :
- `KnowledgeEntry` (titre, contenu, tags, source)
- Création automatique depuis les interactions (`create_memory_from_interaction`)
- Injection des top-3 souvenirs dans le system prompt

### 6.4 Sécurité
- **Clés API** : chiffrées PBKDF2 machine-specific (même nom de machine → même clé de dérivation)
- **Security scanner** : détection de patterns dangereux (exec arbitraire, path traversal, regex malveillants, imports sensibles) sur code et prompts de skills
- **Workspace isolation** : toutes les opérations filesystem sont confinées au workspace de l'agent
- **Permissions** : mode `ask_permission` demande validation pour chaque action sensible (write, delete, bash, git push, etc.)
- **Gardes cloud** : `service_call` bloque les URLs de métadonnées (`169.254.169.254`, `metadata.google`, etc.) et les paths système (`/etc/`, `/proc/`, `/sys/`)
- **Anti-loop** : les invocations de sous-agents sont tracées via contextvars, boucles circulaires bloquées, profondeur max = 3

### 6.5 Onboarding first-run
Au tout premier lancement (aucun message en DB, pas de soul file), l'agent injecte un prompt d'onboarding qui guide l'utilisateur pour configurer provider, personnalité, nom d'agent.

### 6.6 Consciousness engine
Plugin qui à chaque interaction enregistre des "pensées" et les restitue dans le system prompt sous forme de bloc `consciousness_block`. L'agent a donc un sens de continuité entre sessions.

### 6.7 Gateway web
Avant tout envoi au LLM, les messages utilisateur sont analysés : si une URL est présente, elle est fetchée en amont et son contenu injecté dans le contexte. Si le LLM tente de refuser une requête web ("je n'ai pas accès à internet"), une **force search** est déclenchée automatiquement.

### 6.8 Backups
- Backups auto en SQL dump ou JSON de `data/`
- UI de restauration avec prévisualisation
- Conservé dans `data/backups/`

### 6.9 Heartbeat
Unités de battement pour surveiller la santé des composants critiques (DB, providers, MCP, scheduler). Exposé via `/api/heartbeat`.

### 6.10 Doctor
Diagnostic complet du système via `GET /api/doctor?scope=full` — vérifie providers, DB, plugins chargés, MCP, scheduler, permissions fichiers. Utilisable aussi par l'agent via l'outil `doctor_check`.

### 6.11 Multi-utilisateur
- CRUD users avec avatar, mot de passe
- Chaque user a son propre workspace et sa propre conversation history
- Auth via session token

### 6.12 Conversations inter-agents (nouveau)
- Logger contextuel qui trace chaque appel agent → sous-agent
- Persistance JSON dans `backend/data/inter_agent_conversations/`
- UI dédiée : liste + détail avec arborescence, messages par rôle, tool events
- Endpoints REST : list / get (avec `?tree=true` pour l'arbo récursif) / delete / clear

---

## 7. API REST (routes principales)

Toutes les routes sont préfixées par `/api`.

### Core
- `GET /api/health` — health check
- `GET /api/doctor?scope=full` — diagnostic complet

### Chat & conversations
- `POST /api/chat` — envoi d'un message (stream SSE)
- `GET /api/conversations` / `POST` / `DELETE /{id}` — CRUD conversations
- `GET /api/conversations/{id}/messages` — historique

### Config
- `GET/POST /api/config` — settings globaux
- `GET/POST /api/providers` — providers LLM
- `GET/POST /api/mcp/servers` — serveurs MCP

### Agent
- `GET/POST /api/agent/mode` — mode de permissions
- `GET/POST /api/skills` — CRUD skills
- `GET /api/skills/active` / `POST /api/skills/active/{name}` / `DELETE /api/skills/active` — activation skill
- `PUT /api/skills/favorite/{name}` — favori
- `PUT /api/skills/reorder` — drag-drop
- `GET/POST/PUT/DELETE /api/sub-agents` — CRUD sous-agents
- `POST /api/sub-agents/{name}/invoke` — lancement
- `GET/POST /api/personality` — CRUD personnalités
- `GET /api/inter-agent/conversations` / `/{id}?tree=true` / DELETE — historique inter-agents
- `GET/POST /api/soul` — âme de l'agent
- `GET/POST /api/security/scan` — scanner

### Users & auth
- `GET/POST/PUT/DELETE /api/users`
- `POST /api/auth/login`

### Plugins
- `/api/plugins/analytics/*`
- `/api/plugins/browser/*`
- `/api/plugins/channels/*`
- `/api/plugins/code/*`
- `/api/plugins/consciousness/*`
- `/api/plugins/model_guide/*`
- `/api/plugins/scheduler/*`
- `/api/plugins/voice/*`
- `/api/plugins/webhooks/*`

### Backup & heartbeat
- `GET/POST /api/backup`
- `GET /api/heartbeat`

---

## 8. Structure des dossiers

```
Gungnir/
├── backend/
│   ├── core/
│   │   ├── main.py                  # Entry point FastAPI
│   │   ├── api/                     # Routes REST
│   │   │   ├── router.py            # Mount point
│   │   │   ├── chat.py              # Chat endpoint + tool loop
│   │   │   ├── agent_routes.py      # Agent config, skills, sous-agents, inter-agent
│   │   │   ├── config_routes.py     # Providers, MCP
│   │   │   ├── conversations.py     # Historique
│   │   │   ├── users.py             # Multi-user
│   │   │   └── ...
│   │   ├── agents/
│   │   │   ├── super_agent.py       # Classe SuperAgent
│   │   │   ├── wolf_tools.py        # 56 outils WOLF
│   │   │   ├── skills.py            # SkillLibrary, PersonalityManager, SubAgentLibrary
│   │   │   ├── creators.py          # Factories skills / sous-agents
│   │   │   ├── memory.py            # AgentMemory, KnowledgeEntry
│   │   │   ├── mode_manager.py      # Modes de permission
│   │   │   ├── security.py          # Scanner OWASP
│   │   │   ├── mcp_client.py        # Client MCP JSON-RPC
│   │   │   ├── inter_agent_log.py   # Logger conversations inter-agents
│   │   │   └── tools/               # Outils Python (bash, fs, git, browser, web_fetch)
│   │   ├── providers/               # 7 providers LLM
│   │   ├── config/                  # Settings chiffrés
│   │   ├── db/                      # SQLAlchemy async
│   │   └── gateway/                 # Web gateway (pré-fetch, force search)
│   ├── plugins/                     # 9 plugins backend
│   └── data/                        # Skills, personas, soul, KB, inter-agent logs
│
├── frontend/
│   ├── src/
│   │   ├── core/
│   │   │   ├── pages/               # Chat, AgentSettings, Settings, Login
│   │   │   ├── components/          # Sidebar, etc.
│   │   │   ├── services/api.ts      # Client HTTP typé
│   │   │   ├── stores/              # Zustand
│   │   │   └── layouts/
│   │   ├── plugins/                 # 9 plugins frontend (lazy-loaded)
│   │   └── i18n/                    # Traductions (fr défaut)
│   └── vite.config.ts               # Proxy /api → :8000
│
├── data/                            # Workspace utilisateur + backups
├── deploy/
│   ├── Dockerfile                   # Multi-stage Node→Python+Chromium
│   └── requirements.txt
├── docker-compose.yml               # postgres + app
└── CLAUDE.md                        # Guide projet
```

---

## 9. Points clés d'architecture

1. **Tout est modulaire** : aucun hardcoding — les providers, MCP, plugins, skills, personnalités, sous-agents sont tous chargés dynamiquement depuis des fichiers de config / JSON / manifest.
2. **Chaque user fournit ses propres clés** : Gungnir n'embarque aucune clé API. Phase 2 = beta testers qui utilisent leurs propres comptes.
3. **L'agent se configure lui-même** : via les outils `provider_manage`, `mcp_manage`, `service_connect`, l'agent peut lui-même ajouter des providers, connecter des services externes et exécuter des appels REST à partir d'instructions utilisateur en chat.
4. **Plugins indépendants** : chaque plugin doit rester autonome (pas de dépendance inter-plugins au-delà du manifest).
5. **UI en français** : toutes les chaînes d'interface sont en français par défaut, configurable via i18n.
6. **Thème ScarletWolf** : rouge scarlet `#dc2626`, fonds sombres, identité lupine cohérente entre UI et prompts système.

---

## 10. Stack de déploiement

### Dev local
```bash
# Backend
python -m uvicorn backend.core.main:app --host 127.0.0.1 --port 8000 --reload

# Frontend
cd frontend && npm run dev
```

### Production (VPS)
```bash
cd /opt/gungnir
git pull
docker compose up -d --build app
```

Le Dockerfile multi-stage :
1. **Stage 1** : build du frontend avec Node 20
2. **Stage 2** : Python 3.12-slim + Node.js (pour MCP via npx) + Chromium pour Playwright + frontend statique + backend

Variables clés :
- `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` (partagé entre utilisateurs container)
- Container tourne en user `gungnir` (UID 1000) — les volumes mount doivent respecter cet owner
- Volumes : `./data:/app/data`, `./backend/plugins:/app/backend/plugins`, `./backend/data:/app/backend/data`
- Health check : `curl /api/health` toutes les 30s

---

## 11. État actuel (Phase 2)

**Terminé** :
- Migration Core pages (Chat, AgentSettings, Settings)
- Système de skills avec activation/désactivation + favoris + drag-drop
- Système de personnalités avec drag-drop visuel
- Inter-agent conversations visibles dans l'UI
- Playwright/Chromium dans Docker pour browser automation
- Service_connect + service_call pour intégrations API dynamiques
- Backup system avec heartbeat units
- Providers multiples, switching à la volée
- OAuth + multi-user + onboarding first-run
- 12 personnalités préconfigurées
- Soul editor

**En cours / à venir** :
- Wiring complet des plugins UI
- Durcissement production
- N8N network isolation fix
- Task runner daemon pour Automata
- Vue workflow n8n dans Automata
- Fix page intégrations (actuellement `data/integrations.json` vide)
