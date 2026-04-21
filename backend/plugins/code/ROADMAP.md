# SpearCode — État des lieux & Roadmap d'intégration

> Document de travail sur le plugin code-editor de Gungnir.
> Mis à jour le 2026-04-21 (version backend 2.4.1 / frontend 2.2.2).

---

## 1. État des lieux

### 1.1 Métriques

| Item | Valeur |
|---|---|
| Version backend | **2.4.1** |
| Version frontend | **2.2.2** ⚠️ désaligné |
| Lignes `routes.py` | 3350 |
| Lignes `index.tsx` | 2952 |
| Routes API | 53 |
| Modèles DB | 0 (stockage filesystem pur) |
| Enabled by default | ✅ |
| Per-user isolation | ✅ stricte (workspace + config + versions + snippets) |

### 1.2 Fonctionnalités présentes

**Édition & navigation**
- Textarea custom avec syntax highlighting maison
- File explorer (arborescence)
- Onglets multiples persistés
- Recherche nom + contenu (fuzzy, ≤2 Mo/fichier)
- Preview images (≤5 Mo) + rendu Markdown
- Diff viewer avant/après (Ctrl+D)

**Gestion de fichiers**
- Create / rename / delete / move
- Upload multipart (≤50 Mo/fichier, blocage binaires exécutables via magic bytes)
- Download single ou workspace complet en zip
- Stats par langue

**Versioning local**
- Snapshots manuels (max 20 par fichier)
- List / read / delete par version
- Indépendant de Git — rollback rapide

**Git complet**
- Status / diff / commit avec auteur local
- Init / clone / branches / checkout
- Remotes (add/remove/get) + PAT credentials
- Push / pull / fetch
- Génération automatique de commit message par IA depuis le diff

**Exécution**
- `/run` : Python, Node, TypeScript, Bash, Ruby, Go, PHP, Lua, R (11 langages)
- Terminal multi-session avec historique
- Blocklist regex pour commandes dangereuses
- Env vars filtrées avant exec (secrets masqués)

**IA intégrée**
- Chat streaming avec tool-calling natif
- 6 outils chat : `create_folder`, `create_file`, `move_file`, `delete_file`, `read_file`, `list_files`
- Multi-persona : architect, debugger, reviewer, writer, tester, optimizer, hacker
- Contexte multi-fichier à la demande
- Agent agentic (boucle ≤5 rounds) avec 5 outils autonomes
- AI commit message

**Snippets per-user**
- Stockage, listing, delete

**Raccourcis clavier (11)**
- `Ctrl+S` save · `Ctrl+K` palette · `Ctrl+H` find · `Ctrl+D` diff
- `Ctrl+L` AI chat · `Ctrl+Shift+A` agent · `Ctrl+Shift+T` terminal
- `Ctrl+Shift+P` markdown preview · etc.

**Sécurité (durcie récemment)**
- `_safe_path()` + détection symlinks (fix M3)
- Magic-bytes upload (fix M8)
- `subprocess.exec` sans shell, env vars filtrées
- Blocklist regex terminal
- Per-user ContextVar strict

### 1.3 Fonctionnalités absentes

**Édition avancée**
- ❌ Autocomplétion intelligente (pas de LSP / IntelliSense)
- ❌ Linting / typage temps réel (ESLint, mypy, TS errors)
- ❌ Debugger (breakpoints, step, watch)
- ❌ Go to definition / Find references
- ❌ Refactor assisté (rename symbol, extract function)
- ❌ Fold / unfold blocs
- ❌ Split view (éditer deux fichiers côte à côte)
- ❌ Minimap

**Workflow dev**
- ❌ Test runner intégré (pytest, jest…)
- ❌ Gestion de dépendances (UI pour `package.json`, `requirements.txt`, `Cargo.toml`)
- ❌ Éditeur `.env` dédié (masquage + validation)
- ❌ Task runner (équivalent `tasks.json`)
- ❌ Deploy flow intégré

**Collaboration / Partage**
- ❌ Share link d'un fichier ou workspace
- ❌ Live collab multi-user
- ❌ Commentaires sur le code

**Indexation / Search**
- ❌ Index de symboles (walk linéaire à chaque requête)
- ❌ Regex search avec preview des matches
- ❌ Search & replace global

**Intégrations**
- ❌ GitHub PR / Issues
- ❌ CI status affiché
- ❌ DevContainer spec
- ❌ **Outils exposés à l'agent WOLF global** (enfermés dans SpearCode)

### 1.4 Points d'attention

- Monolithes `routes.py` + `index.tsx` (plus de 3000 lignes chacun) → refactor en modules souhaitable
- Pas d'indexation pour la recherche → `/search` fait `os.walk()` complet à chaque requête
- Limites de taille : 2 Mo search, 5 Mo preview, 8 Ko lecture IA → gros projets fragmentés
- Textarea maison → perf dégradée sur fichiers >100 Ko, pas d'infra pour brancher un LSP
- Extracteur JSON de l'agent `_extract_tool_call()` est regex-based → brittle si le LLM change de format
- PAT credentials passés en env vars aux subprocess Git → audit de fuite dans les logs/erreurs à faire
- Boucle agent max_rounds=5 → vérifier condition d'exit stricte

---

## 2. Programme d'intégration

### Phase 0 — Ajustements de l'existant (avant tout nouveau chantier)

**Objectif** : consolider la base actuelle avant d'empiler de nouvelles features.

| # | Tâche | Effort | Priorité |
|---|---|---|---|
| 0.1 | Aligner les versions backend/frontend (2.4.1 → 2.5.0 ou inverse) + audit des commits de décalage | 1 h | 🔴 |
| 0.2 | Exposer les outils SpearCode au WOLF global via `backend/plugins/code/agent_tools.py` (read/write/run/search/make_dir) — l'agent principal Gungnir pourra coder depuis le chat | 2 h | 🔴 |
| 0.3 | Splitter `routes.py` en modules : `routes/files.py`, `routes/git.py`, `routes/exec.py`, `routes/ai.py`, `routes/versions.py`, `routes/snippets.py` — import relatif dans `__init__.py` | 3 h | 🟠 |
| 0.4 | Splitter `index.tsx` en composants : `<FileExplorer>`, `<Editor>`, `<GitPanel>`, `<AIChat>`, `<Terminal>`, `<DiffViewer>`, `<VersionsPanel>` | 4 h | 🟠 |
| 0.5 | Audit PAT Git env vars : vérifier qu'aucun `git clone`/`push` ne loggue le token en cas d'erreur | 1 h | 🟠 |
| 0.6 | Rendre robuste l'extracteur JSON de l'agent : fallback sur `json.loads` direct si le regex échoue, logging du mismatch | 1 h | 🟡 |
| 0.7 | Condition d'exit stricte sur la boucle agent max_rounds (actuellement 5) + timeout total 60s | 1 h | 🟡 |
| 0.8 | Rate limiting sur les endpoints `subprocess.exec` (`/run`, `/terminal`) : 30 req/min per-user via slowapi | 30 min | 🟡 |

**Total Phase 0** : ~13 h. Zéro nouvelle feature, juste consolidation.

---

### Phase 1 — Édition avancée (transformer le textarea en vrai IDE)

**Objectif** : passer d'un "éditeur maison simple" à un "IDE léger professionnel".

| # | Tâche | Effort |
|---|---|---|
| 1.1 | Installer `@codemirror/view` + `@codemirror/lang-*` (Python, JS, TS, Go, Rust, etc.) | 2 h |
| 1.2 | Composant `<CodeEditor>` avec CodeMirror 6 : syntax highlighting natif, fold, search/replace intégré, multi-cursor | 6 h |
| 1.3 | Auto-indent + brackets matching | inclus dans 1.2 |
| 1.4 | Minimap (via `@codemirror/minimap`) | 1 h |
| 1.5 | Split view horizontal + vertical (diff, side-by-side) | 4 h |
| 1.6 | Intégration d'un **LSP** léger via `@codemirror/lsp` + serveur `pyright` / `typescript-language-server` / `rust-analyzer` lancé côté backend via subprocess | 10 h |
| 1.7 | Autocomplétion, go-to-definition, find-references, hover tooltips (via LSP) | inclus dans 1.6 |
| 1.8 | Linting temps réel (via LSP diagnostics) | inclus dans 1.6 |

**Total Phase 1** : ~23 h. **Gros chantier**, plus grosse transformation UX.

---

### Phase 2 — Workflow dev

**Objectif** : outils concrets pour le cycle code → test → debug → release.

| # | Tâche | Effort |
|---|---|---|
| 2.1 | **Test runner** : bouton "Run tests" détecte `pytest.ini`, `jest.config.js`, etc. Exécute + parse le résultat + affiche un panneau "Tests" avec pass/fail/skip. Ctrl+Shift+R pour lancer. | 4 h |
| 2.2 | **Dependency manager** : UI pour `package.json`/`requirements.txt`/`Cargo.toml` → install, upgrade, remove packages sans quitter l'éditeur | 6 h |
| 2.3 | **`.env` editor** : vue dédiée avec masquage des valeurs, validation, injection sécurisée dans `/run` | 2 h |
| 2.4 | **Task runner** : fichier `.gungnir/tasks.json` avec shortcuts Ctrl+Shift+1..9 pour lancer des commandes nommées | 3 h |
| 2.5 | **Debugger** (Python seulement d'abord) : breakpoints via panel, step-in/over/out, watch vars. Repose sur `debugpy`. UI complexe. | 12 h |

**Total Phase 2** : ~27 h, livrable progressif (2.1 utile seul).

---

### Phase 3 — Indexation & Search avancée

**Objectif** : recherche rapide même sur gros workspace.

| # | Tâche | Effort |
|---|---|---|
| 3.1 | **Index inversé** : ripgrep lancé en background + cache en mémoire invalidé sur change | 3 h |
| 3.2 | **Regex search** : input regex + preview des matches avec contexte ±2 lignes | 2 h |
| 3.3 | **Search & replace global** : remplace sur tout le workspace avec preview et confirmation avant apply | 3 h |
| 3.4 | **Index de symboles** (fonctions, classes) via LSP (hérite Phase 1) | 2 h |

**Total Phase 3** : ~10 h.

---

### Phase 4 — Intégrations GitHub / CI

**Objectif** : workflow git/CI sans quitter SpearCode.

| # | Tâche | Effort |
|---|---|---|
| 4.1 | **GitHub PR panel** : list des PRs ouvertes, status CI, review, merge depuis l'UI. API via token PAT déjà stocké | 6 h |
| 4.2 | **GitHub Issues panel** : list, create, comment | 4 h |
| 4.3 | **CI status badge** affiché sur chaque commit dans la timeline Git | 2 h |
| 4.4 | **DevContainer** : détection `.devcontainer/devcontainer.json` + lancement du container de dev | 8 h |

**Total Phase 4** : ~20 h.

---

### Phase 5 — Collaboration (optionnel / à priorité faible)

**Objectif** : partage et collab si le projet Gungnir ouvre aux équipes.

| # | Tâche | Effort |
|---|---|---|
| 5.1 | **Share link** en read-only (URL publique de lecture d'un fichier/folder) | 6 h |
| 5.2 | **Commentaires** ancrés sur une ligne (stockés en DB) | 8 h |
| 5.3 | **Live collab** (Yjs + WebSocket CRDT) | 20 h+ |

**Total Phase 5** : ~35 h. À skipper sauf besoin collab avéré.

---

## 3. Ordre de bataille recommandé

1. **Phase 0 complète** (13 h) — consolidation. Avant tout le reste.
2. **Phase 1.1 → 1.5** (13 h) — passer à CodeMirror sans LSP d'abord. Gros gain UX immédiat.
3. **Phase 2.1 + 2.3** (6 h) — test runner + `.env` editor. Quick wins très concrets.
4. **Phase 3** (10 h) — recherche propre, nécessaire dès ~50 fichiers.
5. **Phase 1.6 → 1.8** LSP (10 h) — complète CodeMirror avec les features IDE.
6. **Phase 2.2, 2.4** (9 h) — dependency manager + task runner.
7. **Phase 4** (20 h) — intégrations GitHub si besoin régulier.
8. **Phase 2.5 debugger** (12 h) — si tu veux vraiment debug Python dans l'outil.
9. **Phase 5** (35 h+) — seulement si cas collab confirmé.

**Total réaliste hors Phase 5** : ~100 h de dev, livrables intermédiaires à chaque phase.

---

## 4. Note sur le versionnement

Chaque phase terminée = **bump mineur** du plugin (2.4.1 → 2.5.0 → 2.6.0 …) + bump app mineur si features user-facing significatives. Sous-tâches = bump patch (.x.y+1). Toujours aligner `backend/plugins/code/manifest.json` + `frontend/src/plugins/code/manifest.json` + `backend/core/__version__.py` + `frontend/package.json` — cf. règle de versioning ABSOLUE du projet.
