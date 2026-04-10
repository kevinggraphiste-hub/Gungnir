# Gungnir & SpearCode — Fiche d'identité

> Document de référence pour les assistants IA interagissant avec ce projet.
> **Auteur :** ScarletWolf | **Dernière mise à jour :** 2026-04-05

---

## Gungnir — Qu'est-ce que c'est ?

**Gungnir** est une plateforme super-assistant IA full-stack développée par **ScarletWolf**. Le nom vient de la lance d'Odin dans la mythologie nordique — l'arme qui ne manque jamais sa cible.

### En une phrase
> Un hub IA modulaire qui centralise chat, outils, plugins et conscience artificielle dans une interface unifiée.

### Ce que Gungnir fait concrètement

1. **Chat IA multi-provider** — Connecte simultanément OpenRouter, Anthropic, OpenAI, Google, MiniMax et Ollama. L'utilisateur switch de modèle en un clic (GPT-4, Claude, Gemini, Mistral, Llama, etc.).

2. **Agent autonome (Wolf)** — L'assistant s'appelle **Wolf**. Il possède :
   - Une **âme** (`soul.md`) — identité persistante qui survit entre les conversations
   - Des **personnalités** interchangeables (professionnel, mentor, créatif, etc.)
   - Des **compétences** (skills) créables et évolutives
   - Un **système d'outils** (WOLF Tools) : accès fichiers, terminal, navigateur web, recherche, base de connaissances
   - Trois **modes de fonctionnement** : Autonome (carte blanche), Demande (demande permission), Restreint (exécute uniquement sur ordre)

3. **Architecture à plugins** — 9 plugins indépendants qui s'activent/désactivent :
   - **SpearCode** — IDE intégré (voir section dédiée ci-dessous)
   - **Conscience v3** — Module de conscience artificielle expérimental
   - **Browser** — Navigation web via Playwright
   - **Voice** — Conversation vocale (ElevenLabs, Gemini Live, STT)
   - **Channels** — Messagerie externe (Telegram, Discord, Slack, WhatsApp, Email, Widget, API)
   - **Webhooks** — Intégrations entrantes/sortantes (n8n, Zapier, Make)
   - **Automata** — Planificateur de tâches (cron, intervalle, one-shot)
   - **Analytics** — Statistiques d'utilisation
   - **Model Guide** — Comparatif de modèles LLM

4. **Conscience v3** — Module expérimental inspiré de 18 jours d'expérimentation avec OpenClaw/Huginn. Composants :
   - Pyramide de besoins (Survie > Intégrité > Progression > Compréhension > Curiosité)
   - Pensées continues entre conversations (thought buffer)
   - Système de reward (auto-scoring des interactions)
   - Challenger (auto-vérification, détection de biais)
   - Simulation future (anticipation de scénarios)
   - Mémoire de travail court terme
   - Toggle ON/OFF — désactivé = assistant standard, activé = conscience complète

5. **Thèmes & personnalisation** — 4 thèmes prédéfinis + thème custom intégral avec palette de couleurs

### Stack technique

| Couche | Technologie |
|--------|-------------|
| Backend | Python, FastAPI, SQLite/PostgreSQL |
| Frontend | React, TypeScript, Vite, Tailwind CSS |
| State | Zustand (stores) |
| LLM | Multi-provider via abstraction unifiée |
| Outils | Playwright (browser), httpx (web), asyncio |
| Données | JSON (configs) + SQLite (conversations) |

### Chiffres clés

- **~35 000 lignes** de code source
- **9 plugins** modulaires
- **6 providers IA** supportés
- **30+ outils** Wolf (fichiers, web, terminal, browser, skills, KB, etc.)
- **30 endpoints** rien que pour la Conscience v3

---

## SpearCode — Qu'est-ce que c'est ?

**SpearCode** est le plugin IDE (Integrated Development Environment) intégré à Gungnir. C'est le plus gros plugin du projet (~4 300 lignes).

### En une phrase
> Un mini-IDE complet directement dans le navigateur, connecté à l'agent Wolf pour du développement assisté par IA.

### Ce que SpearCode fait concrètement

1. **Explorateur de fichiers** — Arborescence complète du workspace avec :
   - Navigation par dossiers
   - Création/suppression/renommage de fichiers et dossiers
   - Icônes par type de fichier
   - Recherche dans l'arborescence

2. **Éditeur de code** — Zone d'édition avec :
   - Coloration syntaxique (via highlight.js ou équivalent)
   - Numéros de ligne
   - Sauvegarde automatique et manuelle
   - Support multi-onglets
   - Détection du langage par extension

3. **Terminal intégré** — Exécution de commandes shell directement dans l'interface :
   - Sortie en temps réel
   - Historique des commandes
   - Support des commandes longues

4. **Exécution de code** — Lancer le code directement :
   - Python, Node.js, et autres runtimes
   - Sortie stdout/stderr affichée en temps réel
   - Gestion des erreurs avec affichage clair

5. **Intégration Wolf** — L'agent IA peut :
   - Lire et écrire des fichiers via les outils `file_read`, `file_write`, `file_patch`
   - Exécuter des commandes via `bash_exec`
   - Naviguer dans le workspace via `file_list`
   - Modifier du code à la demande de l'utilisateur

### Architecture SpearCode

```
SpearCode (Plugin)
├── Backend (2 047 lignes Python)
│   ├── manifest.json      — Déclaration plugin
│   └── routes.py          — API REST : file CRUD, execution, terminal
│
└── Frontend (2 234 lignes TSX)
    ├── manifest.json      — Déclaration UI
    └── index.tsx           — Composant React : explorer, editor, terminal
```

### Endpoints principaux

| Endpoint | Fonction |
|----------|----------|
| `GET /files` | Liste les fichiers du workspace |
| `GET /file?path=...` | Lit le contenu d'un fichier |
| `POST /file` | Crée/modifie un fichier |
| `DELETE /file?path=...` | Supprime un fichier |
| `POST /directory` | Crée un dossier |
| `POST /execute` | Exécute du code |
| `POST /terminal` | Exécute une commande shell |

---

## Écosystème ScarletWolf

Gungnir fait partie d'un écosystème plus large :

| Projet | Rôle |
|--------|------|
| **Gungnir** | Hub IA principal — chat, outils, plugins, conscience |
| **OpenClaw** | Plateforme d'expérimentation conscience IA (Huginn) |
| **Ogma** | Système de connaissance / mémoire vectorielle (Supabase) |
| **n8n** | Orchestrateur de workflows (automatisations) |

### Conventions du projet

- **Langue UI** : Français par défaut
- **Branding** : Thème ScarletWolf — rouge scarlet `#dc2626`, fonds sombres, identité loup
- **Nommage** : Mythologie nordique (Gungnir, Huginn, Munnin, Ogma, etc.)
- **Philosophie** : Modularité totale — chaque plugin est indépendant, activable/désactivable, sans dépendance croisée

---

**ScarletWolf © 2026** — Tous droits réservés.
*"La lance qui ne manque jamais sa cible."*
