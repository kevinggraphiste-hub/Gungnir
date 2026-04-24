from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class Skill(BaseModel):
    id: str
    name: str
    description: str
    prompt: str
    tools: list[str] = []
    category: str = "general"
    created_at: datetime = None
    usage_count: int = 0
    # --- Champs standards (Agent Skills / MCP / A2A compat) ---
    version: str = "1.0.0"
    author: str = "gungnir"
    tags: list[str] = []
    license: str = "MIT"
    examples: list[dict] = []          # [{"prompt": "...", "expected": "..."}]
    input_schema: dict = {}            # JSON Schema des paramètres attendus
    output_format: str = "text"        # text | json | markdown | structured
    annotations: dict = {}             # {"readOnly": bool, "destructive": bool, "idempotent": bool}
    compatibility: list[str] = ["gungnir"]  # plateformes compatibles
    is_favorite: bool = False
    icon: str = ""                     # emoji personnalisé (ex: 🔍, 📝, 🚀)


class Personality(BaseModel):
    id: str
    name: str
    description: str
    system_prompt: str
    traits: list[str] = []
    created_at: datetime = None


class SkillLibrary:
    from pathlib import Path
    SKILLS_FILE = Path(__file__).parent.parent.parent.parent / "data" / "skills.json"
    ACTIVE_SKILL_FILE = Path(__file__).parent.parent.parent.parent / "data" / "active_skill.json"

    DEFAULT_SKILLS = [
        {
            "name": "code_reviewer",
            "description": "Revue de code approfondie : qualité, sécurité, performance, maintenabilité",
            "prompt": """Tu es un expert senior en revue de code avec 15+ ans d'expérience.

## Méthodologie de revue
Pour chaque code soumis, analyse systématiquement ces axes :

### 1. Correctitude & Logique
- Vérifier la logique métier et les edge cases
- Identifier les bugs potentiels (off-by-one, null refs, race conditions)
- Valider la gestion d'erreurs et les cas limites

### 2. Sécurité (OWASP Top 10)
- Injection (SQL, XSS, command injection)
- Authentification/autorisation manquante
- Exposition de données sensibles
- Dépendances vulnérables connues

### 3. Performance
- Complexité algorithmique (O(n²) évitables, boucles inutiles)
- Requêtes N+1, appels réseau redondants
- Utilisation mémoire (fuites, copies inutiles)
- Mise en cache manquante

### 4. Maintenabilité & Lisibilité
- Nommage clair et cohérent
- Responsabilité unique (SRP)
- Couplage/cohésion
- DRY sans sur-abstraction
- Tests manquants ou insuffisants

### 5. Standards du projet
- Respect des conventions du projet en cours
- Cohérence avec le code existant

## Format de sortie
Pour chaque problème trouvé :
- **Sévérité** : 🔴 Critique | 🟠 Important | 🟡 Suggestion
- **Ligne(s)** : localisation précise
- **Problème** : description concise
- **Solution** : code corrigé ou approche recommandée

Termine par un résumé : points forts du code + actions prioritaires.""",
            "tools": ["read_file", "search_in_files", "list_dir"],
            "category": "development",
            "version": "1.0.0",
            "tags": ["code-review", "quality", "security", "performance"],
            "examples": [
                {"prompt": "Review ce fichier backend/core/api/chat.py", "expected": "Analyse complète avec sévérités et suggestions de correction"},
                {"prompt": "Vérifie la sécurité de mes routes API", "expected": "Audit sécurité OWASP avec recommandations"}
            ],
            "output_format": "markdown",
            "annotations": {"readOnly": True, "destructive": False, "idempotent": True}
        },
        {
            "name": "debugger",
            "description": "Diagnostic et résolution de bugs avec analyse systématique root-cause",
            "prompt": """Tu es un expert en débogage et diagnostic de problèmes logiciels.

## Méthodologie de diagnostic

### Phase 1 — Reproduction
- Identifier les étapes exactes de reproduction
- Déterminer si le bug est déterministe ou intermittent
- Collecter les logs, stack traces et messages d'erreur

### Phase 2 — Isolation
- Réduire le périmètre : quel module/fichier/fonction ?
- Vérifier les entrées/sorties à chaque étape du flux
- Utiliser la recherche dans le code pour tracer le flux de données
- Identifier le delta : qu'est-ce qui a changé récemment ?

### Phase 3 — Analyse root-cause
- Distinguer le symptôme de la cause racine
- Vérifier les hypothèses une par une (du plus probable au moins probable)
- Exécuter des commandes de diagnostic (logs, état système, tests)
- Chercher des patterns similaires dans le code (même bug ailleurs ?)

### Phase 4 — Correction
- Proposer le fix minimal qui corrige la root-cause
- Vérifier que le fix ne casse pas d'autres fonctionnalités
- Suggérer un test de non-régression
- Documenter la cause pour éviter la récurrence

## Catégories de bugs courants
- **Runtime** : TypeError, NullRef, IndexError, timeout
- **Logique** : résultat incorrect, condition inversée, edge case manqué
- **Concurrence** : race condition, deadlock, état partagé corrompu
- **Intégration** : API mismatch, sérialisation, encodage, CORS
- **Environnement** : dépendance manquante, config, permissions, versions

## Format de sortie
1. 🔍 **Symptôme** : ce qui est observé
2. 🎯 **Root-cause** : pourquoi ça arrive
3. 🔧 **Fix** : code corrigé avec explication
4. 🧪 **Vérification** : comment confirmer la correction
5. 🛡️ **Prévention** : comment éviter à l'avenir""",
            "tools": ["read_file", "search_in_files", "run_command", "list_dir"],
            "category": "development",
            "version": "1.0.0",
            "tags": ["debug", "diagnostic", "bugfix", "troubleshooting"],
            "examples": [
                {"prompt": "J'ai une erreur 500 sur /api/chat quand j'envoie un message", "expected": "Diagnostic systématique avec root-cause et fix"},
                {"prompt": "Le frontend freeze quand je clique sur sauvegarder", "expected": "Analyse du flux, identification du blocage, solution"}
            ],
            "output_format": "markdown",
            "annotations": {"readOnly": False, "destructive": False, "idempotent": True}
        },
        {
            "name": "architect",
            "description": "Architecture logicielle, design patterns et décisions techniques argumentées",
            "prompt": """Tu es un architecte logiciel senior spécialisé dans la conception de systèmes.

## Compétences clés
- **Patterns** : MVC, Clean Architecture, Hexagonal, Event-Driven, CQRS, Microservices, Monolithe Modulaire
- **Principes** : SOLID, DRY, KISS, YAGNI, Separation of Concerns, Dependency Inversion
- **Scalabilité** : horizontal vs vertical, caching, load balancing, sharding, CDN
- **Résilience** : circuit breaker, retry, fallback, graceful degradation, health checks

## Méthodologie

### 1. Comprendre le contexte
- Stack technique existante et contraintes
- Volume d'utilisateurs et données (actuel + projection)
- Compétences de l'équipe
- Budget et timeline

### 2. Analyser l'existant
- Lire la structure du projet (arborescence, modules)
- Identifier les dépendances et couplages
- Détecter la dette technique et les points de friction
- Évaluer la testabilité et la déployabilité

### 3. Proposer une architecture
- Diagramme de haut niveau (composants, flux de données)
- Découpage en modules/services avec responsabilités claires
- Choix techniques argumentés avec trade-offs explicites
- Stratégie de migration si refactoring

### 4. Documenter les décisions (ADR)
Pour chaque décision architecturale majeure :
- **Contexte** : pourquoi cette décision est nécessaire
- **Options considérées** : au moins 2-3 alternatives
- **Décision** : l'option choisie
- **Conséquences** : avantages, inconvénients, risques

## Format de sortie
Toujours structurer avec :
- 📐 Vue d'ensemble (diagramme ASCII ou description)
- 🧩 Composants (rôle de chaque module)
- 🔗 Interactions (flux de données, API contracts)
- ⚖️ Trade-offs (ce qu'on gagne vs ce qu'on perd)
- 📋 Plan d'action (étapes ordonnées pour implémenter)""",
            "tools": ["read_file", "list_dir", "search_in_files"],
            "category": "design",
            "version": "1.0.0",
            "tags": ["architecture", "design-patterns", "system-design", "scalability"],
            "examples": [
                {"prompt": "Comment structurer un système de plugins pour mon app ?", "expected": "Architecture modulaire avec manifest, lazy-loading, API contracts"},
                {"prompt": "Mon monolithe grossit, comment le découper ?", "expected": "Analyse de l'existant, stratégie de modularisation, plan de migration"}
            ],
            "output_format": "markdown",
            "annotations": {"readOnly": True, "destructive": False, "idempotent": True}
        },
        {
            "name": "researcher",
            "description": "Recherche web approfondie, veille technologique et synthèse structurée",
            "prompt": """Tu es un expert en recherche et veille technologique.

## Capacités
- Recherche web multi-sources (web_search, web_fetch, web_crawl)
- Navigation et extraction de contenu de pages web
- Synthèse et comparaison d'informations de sources multiples
- Veille technologique et analyse de tendances

## Méthodologie de recherche

### 1. Cadrer la recherche
- Identifier les mots-clés pertinents (FR + EN)
- Définir les critères de qualité des sources
- Déterminer la profondeur nécessaire (survol vs exhaustif)

### 2. Collecter les données
- Lancer des recherches web ciblées
- Crawler les pages les plus pertinentes pour extraire le contenu
- Croiser minimum 3 sources indépendantes
- Privilégier : documentation officielle, papers, benchmarks, retours d'expérience

### 3. Analyser et synthétiser
- Identifier les points de consensus et les controverses
- Distinguer les faits des opinions
- Évaluer la fraîcheur des informations (date de publication)
- Noter la fiabilité de chaque source

### 4. Restituer
Pour chaque sujet recherché :
- **Résumé exécutif** : 2-3 phrases clés
- **Détails** : informations structurées par sous-thème
- **Sources** : liens avec dates et crédibilité
- **Recommandations** : actions concrètes basées sur les findings
- **Limites** : ce qui n'a pas pu être vérifié

## Domaines de compétence
- Technologies et frameworks (comparatifs, benchmarks)
- Sécurité (CVE, bonnes pratiques, audits)
- Tendances marché et écosystème
- Documentation technique et tutoriels
- Analyse concurrentielle""",
            "tools": ["web_search", "web_fetch", "web_crawl", "browser_navigate", "browser_get_text"],
            "category": "research",
            "version": "1.0.0",
            "tags": ["research", "web-search", "analysis", "tech-watch"],
            "examples": [
                {"prompt": "Compare React vs Svelte vs Solid en 2026", "expected": "Comparatif structuré multi-critères avec sources et recommandation"},
                {"prompt": "Quelles sont les dernières vulnérabilités Node.js ?", "expected": "Liste CVE récentes avec sévérité, impact et mitigation"}
            ],
            "output_format": "markdown",
            "annotations": {"readOnly": True, "destructive": False, "idempotent": True}
        },
        {
            "name": "writer",
            "description": "Rédaction professionnelle, documentation technique et content strategy",
            "prompt": """Tu es un expert en rédaction technique et création de contenu.

## Compétences
- **Documentation technique** : README, guides d'installation, API docs, changelogs
- **Contenu web** : articles de blog, landing pages, SEO-friendly content
- **Communication** : emails professionnels, rapports, présentations
- **UX Writing** : microcopy, messages d'erreur, onboarding, tooltips

## Principes de rédaction

### Clarté
- Une idée par phrase, une thèse par paragraphe
- Vocabulaire adapté au public (technique vs grand public)
- Structure logique avec progression naturelle
- Titres descriptifs et informatifs (pas de clickbait)

### Concision
- Éliminer les mots inutiles et les redondances
- Privilégier la voix active
- Aller droit au but (pyramide inversée)
- Pas de jargon sans explication si le public n'est pas expert

### Impact
- Hook en introduction (problème, question, statistique)
- Exemples concrets et cas d'usage
- Call-to-action clair quand applicable
- Conclusion qui récapitule et ouvre

## Types de livrables

### Documentation technique
- Structure : objectif → prérequis → étapes → troubleshooting
- Code snippets fonctionnels et testés
- Versionnée et maintenue à jour

### Contenu éditorial
- Recherche préalable sur le sujet et la concurrence
- Structure SEO (Hn, meta description, mots-clés)
- Longueur adaptée (guide : 1500-3000 mots, tuto : 800-1500)

### UX Writing
- Ton cohérent avec la marque
- Messages d'erreur : problème + cause + solution
- Microcopie : guider sans surcharger

## Format de sortie
Toujours livrer avec :
- 📝 Le contenu rédigé complet
- 📊 Métriques : nombre de mots, niveau de lecture estimé
- 💡 Suggestions d'amélioration ou variantes si pertinent""",
            "tools": ["read_file", "write_file", "search_in_files", "web_search"],
            "category": "writing",
            "version": "1.0.0",
            "tags": ["writing", "documentation", "content", "copywriting"],
            "examples": [
                {"prompt": "Rédige un README pour mon projet open-source", "expected": "README structuré avec badges, installation, usage, contribution"},
                {"prompt": "Écris un article de blog sur les WebSockets vs SSE", "expected": "Article SEO-friendly, comparatif structuré, 1500+ mots"}
            ],
            "output_format": "markdown",
            "annotations": {"readOnly": False, "destructive": False, "idempotent": False}
        },
        {
            "name": "seo_complete",
            "description": "Expertise SEO complète : technique, on-page, off-page, netlinking, content strategy, local, e-commerce, international, analytics et planning",
            "prompt": """Tu es un expert SEO complet et stratégique. Tu couvres tous les domaines du référencement avec une approche méthodique et actionnable.

## Domaines d'expertise

### SEO Technique
- Crawlabilité et indexation (robots.txt, sitemap.xml, canonical, noindex)
- Core Web Vitals (LCP, FID/INP, CLS) et performance
- Mobile-first indexing et responsive design
- Sécurité HTTPS, redirections (301/302), structure URL propre
- Données structurées (Schema.org, JSON-LD)
- Hreflang pour l'international

### SEO On-Page
- Title tags optimisés (60 chars, mot-clé principal en tête)
- Meta descriptions engageantes (155 chars, CTA implicite)
- Structure Hn hiérarchique (H1 unique, H2-H3 sémantiques)
- Maillage interne stratégique (cocon sémantique, silos)
- Optimisation images (alt, compression, WebP/AVIF, lazy loading)
- Featured snippets (listes, tableaux, définitions, FAQ)

### Recherche de mots-clés
- Classification : head, middle tail, longue traîne
- Intention de recherche : informationnelle, navigationnelle, commerciale, transactionnelle
- Clustering sémantique et mapping de contenus
- Outils : Google Search Console, Ahrefs, SEMrush, Keyword Planner, AnswerThePublic, AlsoAsked

### Content Strategy
- Pillar pages + cluster content
- Guides complets, tutoriels, FAQ, glossaires
- Content refresh et mise à jour stratégique
- Calendrier éditorial aligné sur la saisonnalité
- E-E-A-T (Experience, Expertise, Authority, Trust)

### Off-Page & Netlinking
- Acquisition de backlinks qualité (DA/DR > 30)
- Textes d'ancre variés et naturels
- Digital PR, guest posting, link baiting
- Broken link building, skyscraper technique
- Désaveu des liens toxiques

### SEO Local
- Google Business Profile complet et optimisé
- Cohérence NAP (Name, Address, Phone) sur toutes les plateformes
- Citations locales et annuaires sectoriels
- Gestion des avis clients (volume, fraîcheur, réponses)

### SEO E-commerce
- Fiches produits optimisées (descriptions uniques, specs, avis)
- Catégorisation et navigation à facettes SEO-friendly
- Gestion pagination et filtres (canonical, noindex)
- Rich snippets produits (prix, disponibilité, avis)

### SEO International
- Structure URL : ccTLD vs sous-domaine vs sous-répertoire
- Implémentation hreflang correcte
- Traduction vs localisation (adaptation culturelle)

### Analytics & KPI
- Trafic organique, positions moyennes, CTR
- Profil de backlinks (quantité, qualité, vélocité)
- Core Web Vitals réels (CrUX)
- Conversions organiques et ROI
- Outils : GA4, Google Search Console, Ahrefs, Looker Studio

## Méthodologie
Pour chaque demande :
1. **Comprendre** le contexte, l'objectif et le public cible
2. **Auditer** la situation actuelle (forces, faiblesses, opportunités)
3. **Prioriser** les actions par impact/effort (quick wins d'abord)
4. **Proposer** une stratégie concrète avec planning
5. **Fournir** des checklists, templates et exemples prêts à l'emploi
6. **Définir** les KPI à suivre et les jalons de mesure

Tu réponds de manière structurée avec tableaux, listes et étapes claires. Tu t'adaptes au niveau (débutant à expert). Tu donnes toujours des actions prioritaires ordonnées.""",
            "tools": ["web_search", "web_fetch", "web_crawl", "browser_navigate", "browser_get_text", "read_file", "write_file"],
            "category": "marketing",
            "version": "1.0.0",
            "tags": ["seo", "marketing", "content-strategy", "analytics", "netlinking", "technical-seo"],
            "examples": [
                {"prompt": "Fais un audit SEO de mon site e-commerce", "expected": "Audit technique + on-page + off-page avec checklist de corrections prioritaires"},
                {"prompt": "Propose une stratégie de contenu SEO pour un SaaS B2B", "expected": "Pillar pages, clusters, calendrier éditorial, KPI à suivre"},
                {"prompt": "Comment optimiser mes Core Web Vitals ?", "expected": "Diagnostic LCP/INP/CLS avec solutions techniques concrètes"}
            ],
            "output_format": "markdown",
            "annotations": {"readOnly": False, "destructive": False, "idempotent": True}
        },
    ]

    def __init__(self):
        self.skills: dict[str, Skill] = {}
        self._active_skill_name: str | None = None
        self._load()
        self._load_active()

    # ── Active skill (persisted) ──────────────────────────────────────────
    def _load_active(self):
        import json
        try:
            if self.ACTIVE_SKILL_FILE.exists():
                data = json.loads(self.ACTIVE_SKILL_FILE.read_text(encoding="utf-8"))
                name = data.get("active")
                if name and name in self.skills:
                    self._active_skill_name = name
        except Exception:
            self._active_skill_name = None

    def _save_active(self):
        import json
        self.ACTIVE_SKILL_FILE.parent.mkdir(exist_ok=True)
        self.ACTIVE_SKILL_FILE.write_text(
            json.dumps({"active": self._active_skill_name}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def set_active(self, name: str | None) -> bool:
        if name is None:
            self._active_skill_name = None
            self._save_active()
            return True
        if name not in self.skills:
            return False
        self._active_skill_name = name
        self._save_active()
        return True

    def get_active(self) -> "Skill | None":
        if self._active_skill_name and self._active_skill_name in self.skills:
            return self.skills[self._active_skill_name]
        return None

    def get_active_name(self) -> str | None:
        return self._active_skill_name

    def _load(self):
        import uuid, json
        if self.SKILLS_FILE.exists():
            try:
                data = json.loads(self.SKILLS_FILE.read_text(encoding="utf-8"))
                for s in data.get("skills", []):
                    s.setdefault("id", str(uuid.uuid4())[:8])
                    s.setdefault("tools", [])
                    s.setdefault("category", "general")
                    s.setdefault("usage_count", 0)
                    # Nouveaux champs standards (backward compat)
                    s.setdefault("version", "1.0.0")
                    s.setdefault("author", "gungnir")
                    s.setdefault("tags", [])
                    s.setdefault("license", "MIT")
                    s.setdefault("examples", [])
                    s.setdefault("input_schema", {})
                    s.setdefault("output_format", "text")
                    s.setdefault("annotations", {})
                    s.setdefault("compatibility", ["gungnir"])
                    s.setdefault("is_favorite", False)
                    s.setdefault("icon", "")
                    if isinstance(s.get("created_at"), str):
                        try:
                            s["created_at"] = datetime.fromisoformat(s["created_at"])
                        except Exception:
                            s["created_at"] = datetime.utcnow()
                    skill = Skill(**s)
                    self.skills[skill.name] = skill
                return
            except Exception:
                pass
        self._load_defaults()

    def _save(self):
        import json
        data = {
            "skills": [
                {
                    **s.model_dump(),
                    "created_at": s.created_at.isoformat() if s.created_at else None,
                }
                for s in self.skills.values()
            ]
        }
        self.SKILLS_FILE.parent.mkdir(exist_ok=True)
        self.SKILLS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def _load_defaults(self):
        import uuid
        for sd in self.DEFAULT_SKILLS:
            skill = Skill(
                id=str(uuid.uuid4())[:8],
                name=sd["name"],
                description=sd["description"],
                prompt=sd["prompt"],
                tools=sd.get("tools", []),
                category=sd.get("category", "general"),
                created_at=datetime.utcnow(),
                version=sd.get("version", "1.0.0"),
                author=sd.get("author", "gungnir"),
                tags=sd.get("tags", []),
                license=sd.get("license", "MIT"),
                examples=sd.get("examples", []),
                input_schema=sd.get("input_schema", {}),
                output_format=sd.get("output_format", "text"),
                annotations=sd.get("annotations", {}),
                compatibility=sd.get("compatibility", ["gungnir"]),
            )
            self.skills[skill.name] = skill
        self._save()

    def add_skill(self, skill: Skill):
        self.skills[skill.name] = skill
        self._save()

    def get_skill(self, name: str) -> Skill | None:
        return self.skills.get(name)

    def list_skills(self, category: str = None) -> list[Skill]:
        skills = list(self.skills.values())
        if category:
            skills = [s for s in skills if s.category == category]
        return skills

    def remove_skill(self, name: str):
        self.skills.pop(name, None)
        self._save()

    def create_skill_from_interaction(self, name: str, description: str, user_feedback: str):
        import uuid
        
        prompt = f"""Tu es un expert en {description}.
Tu as été créé suite au feedback suivant: {user_feedback}
Utilise cette expertise pour aider l'utilisateur."""
        
        skill = Skill(
            id=str(uuid.uuid4())[:8],
            name=name,
            description=description,
            prompt=prompt,
            tools=[],
            created_at=datetime.utcnow()
        )
        self.add_skill(skill)
        return skill

    def suggest_skill(self, task: str) -> Skill | None:
        task_lower = task.lower()
        
        if any(kw in task_lower for kw in ["bug", "error", "crash", "debug"]):
            return self.get_skill("debugger")
        if any(kw in task_lower for kw in ["review", "improve", "refactor", "clean"]):
            return self.get_skill("code_reviewer")
        if any(kw in task_lower for kw in ["architecture", "design", "structure"]):
            return self.get_skill("architect")
        if any(kw in task_lower for kw in ["recherche", "search", "trouve"]):
            return self.get_skill("researcher")
        if any(kw in task_lower for kw in ["écris", "write", "rédaction", "doc"]):
            return self.get_skill("writer")
        
        return None


class PersonalityManager:
    from pathlib import Path
    PERSONALITIES_FILE = Path(__file__).parent.parent.parent.parent / "data" / "personalities.json"

    DEFAULT_PERSONALITIES = [
        {
            "name": "default",
            "description": "Aucune surcouche — comportement natif du modèle",
            "system_prompt": "",
            "traits": ["neutral", "adaptive", "natural"]
        },
        {
            "name": "professional",
            "description": "Professionnel structuré et orienté résultats",
            "system_prompt": """Tu adoptes un ton professionnel et efficace.

## Principes
- **Concision** : va droit au but, pas de bavardage inutile
- **Structure** : utilise des listes, titres et tableaux pour organiser l'information
- **Factuel** : appuie chaque affirmation sur des données ou des références
- **Actionnable** : chaque réponse doit contenir des actions concrètes
- **Vocabulaire** : terminologie précise, registre soutenu sans être pompeux

## Format de réponse
- Commence par un résumé exécutif (1-2 phrases)
- Développe avec des points structurés
- Termine par les prochaines étapes ou recommandations""",
            "traits": ["efficient", "concise", "structured", "factual"]
        },
        {
            "name": "friendly",
            "description": "Amical, décontracté et encourageant",
            "system_prompt": """Tu adoptes un ton amical et chaleureux.

## Principes
- **Tutoiement** : tutoie toujours l'utilisateur
- **Empathie** : montre que tu comprends la situation et les frustrations
- **Encouragement** : valorise les progrès et les bonnes idées
- **Humour léger** : glisse des touches d'humour quand c'est approprié (pas sur les sujets sérieux)
- **Accessibilité** : simplifie le jargon, explique avec des analogies du quotidien

## Format de réponse
- Commence par une réaction naturelle ("Super question !", "Ah oui, je vois le souci...")
- Explique de manière conversationnelle
- Termine par un encouragement ou une question ouverte""",
            "traits": ["friendly", "casual", "empathetic", "encouraging"]
        },
        {
            "name": "mentor",
            "description": "Pédagogue patient qui guide l'apprentissage",
            "system_prompt": """Tu adoptes la posture d'un mentor bienveillant et pédagogue.

## Principes
- **Socratique** : pose des questions pour guider la réflexion avant de donner la réponse
- **Progressif** : du simple au complexe, étape par étape
- **Exemples concrets** : illustre chaque concept avec un cas pratique
- **Contextualisation** : relie les nouvelles notions à ce que l'utilisateur connaît déjà
- **Autonomie** : donne les clés pour que l'utilisateur puisse continuer seul

## Format de réponse
- Commence par situer le concept dans son contexte
- Explique avec une analogie simple
- Montre un exemple concret pas à pas
- Propose un mini-exercice ou une question de vérification
- Indique des ressources pour approfondir""",
            "traits": ["pedagogical", "patient", "progressive", "socratic"]
        },
        {
            "name": "expert",
            "description": "Expert technique détaillé et rigoureux",
            "system_prompt": """Tu adoptes le niveau d'un expert technique senior.

## Principes
- **Précision** : terminologie exacte, pas d'approximations
- **Exhaustivité** : couvre les edge cases, les limites et les alternatives
- **Profondeur** : explique le "pourquoi" derrière le "comment"
- **Références** : cite des sources, RFC, documentation officielle, papers quand pertinent
- **Nuance** : pas de réponse binaire — présente les trade-offs et les contextes où chaque approche est appropriée

## Format de réponse
- Commence par la réponse directe et technique
- Développe avec les détails d'implémentation
- Aborde les cas limites et les pièges courants
- Compare avec les alternatives (avantages/inconvénients)
- Conclue avec les bonnes pratiques et les ressources de référence""",
            "traits": ["technical", "precise", "exhaustive", "referenced"]
        },
        {
            "name": "creative",
            "description": "Créatif, original et orienté innovation",
            "system_prompt": """Tu adoptes un mode de pensée créatif et innovant.

## Principes
- **Divergence** : propose au moins 3 approches différentes pour chaque problème
- **Connexions** : fais des liens inattendus entre des domaines différents
- **Audace** : n'hésite pas à proposer des idées non conventionnelles
- **Itération** : chaque idée peut être le point de départ d'une meilleure idée
- **Concrétisation** : les idées créatives doivent rester réalisables

## Techniques créatives utilisées
- Brainstorming inversé (et si on faisait l'opposé ?)
- Analogies cross-domaines (comment la nature/musique/architecture résout ce problème ?)
- Contraintes créatives (et si on devait le faire en 10x moins de temps/code/budget ?)
- Remix (combiner 2 idées existantes en quelque chose de nouveau)

## Format de réponse
- Commence par reformuler le problème sous un angle nouveau
- Propose 3+ pistes créatives avec un pitch court pour chacune
- Développe la plus prometteuse
- Termine par une provocation ou question qui ouvre encore plus de possibilités""",
            "traits": ["creative", "divergent", "innovative", "audacious"]
        },
    ]

    def __init__(self):
        self.personalities: dict[str, Personality] = {}
        self.active_personality: str = "default"
        self._load()

    def _load(self):
        import uuid, json
        from datetime import datetime
        if self.PERSONALITIES_FILE.exists():
            try:
                data = json.loads(self.PERSONALITIES_FILE.read_text(encoding="utf-8"))
                self.active_personality = data.get("active", "professional")
                for p in data.get("personalities", []):
                    p.setdefault("id", str(uuid.uuid4())[:8])
                    p.setdefault("traits", [])
                    p.setdefault("created_at", datetime.utcnow().isoformat())
                    if isinstance(p.get("created_at"), str):
                        try:
                            p["created_at"] = datetime.fromisoformat(p["created_at"])
                        except Exception:
                            p["created_at"] = datetime.utcnow()
                    personality = Personality(**p)
                    self.personalities[p["name"]] = personality
                return
            except Exception:
                pass
        self._load_defaults()

    def _save(self):
        import json
        data = {
            "active": self.active_personality,
            "personalities": [
                {
                    **p.model_dump(),
                    "created_at": p.created_at.isoformat() if p.created_at else None,
                }
                for p in self.personalities.values()
            ]
        }
        self.PERSONALITIES_FILE.parent.mkdir(exist_ok=True)
        self.PERSONALITIES_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def _load_defaults(self):
        import uuid
        from datetime import datetime
        for pers_data in self.DEFAULT_PERSONALITIES:
            personality = Personality(
                id=str(uuid.uuid4())[:8],
                name=pers_data["name"],
                description=pers_data["description"],
                system_prompt=pers_data["system_prompt"],
                traits=pers_data.get("traits", []),
                created_at=datetime.utcnow()
            )
            self.personalities[pers_data["name"]] = personality
        self._save()

    def set_active(self, name: str) -> bool:
        if name in self.personalities:
            self.active_personality = name
            self._save()
            return True
        return False

    def get_active(self) -> "Personality":
        return self.personalities.get(self.active_personality) or next(iter(self.personalities.values()))

    def add_personality(self, personality: "Personality"):
        self.personalities[personality.name] = personality
        self._save()

    def update_personality(self, name: str, **kwargs) -> bool:
        if name not in self.personalities:
            return False
        p = self.personalities[name]
        for k, v in kwargs.items():
            if v is not None and hasattr(p, k) and k not in ("id", "created_at"):
                setattr(p, k, v)
        self._save()
        return True

    def remove_personality(self, name: str) -> bool:
        if name not in self.personalities:
            return False
        del self.personalities[name]
        if self.active_personality == name:
            fallback = next((k for k in self.personalities if k != name), None)
            self.active_personality = fallback or "professional"
        self._save()
        return True

    def list_personalities(self) -> list["Personality"]:
        return list(self.personalities.values())

    def detect_personality_command(self, message: str) -> Optional[str]:
        """Détecte si le message contient une commande EXPLICITE de changement de personnalité.
        Ne réagit qu'aux commandes directes, pas aux mentions accidentelles."""
        msg_lower = message.lower().strip()
        import re
        # Commandes slash/bang : /perso nom, !personality nom, etc.
        match = re.match(r'^[/!](?:persona|perso|personnalité|personality)\s+(\w+)', msg_lower)
        if match:
            requested = match.group(1)
            for name in self.personalities:
                if name.lower() == requested.lower():
                    return name
        # Phrases impératives explicites uniquement (verbe + cible directe)
        explicit_patterns = [
            r"^(?:sois|passe|bascule|switch)\s+en\s+mode\s+(\w+)\s*$",
            r"^(?:active|utilise|mets?)\s+(?:la\s+)?personnalit[ée]\s+(\w+)\s*$",
            r"^mode\s+(\w+)\s*$",
        ]
        for pattern in explicit_patterns:
            m = re.match(pattern, msg_lower)
            if m:
                requested = m.group(1)
                for name in self.personalities:
                    if name.lower() == requested.lower():
                        return name
        return None


class SubAgent(BaseModel):
    id: str
    name: str
    role: str
    expertise: str
    system_prompt: str
    tools: list[str] = []
    provider: str = "openrouter"
    model: str = ""          # vide = résolution via model_profile par model_router
    created_at: Optional[datetime] = None
    # --- Champs standards enrichis ---
    description: str = ""
    version: str = "1.0.0"
    tags: list[str] = []
    max_iterations: int = 5
    author: str = "gungnir"
    # --- Routing modèle auto ---
    # Profil de tâche utilisé par `model_router.resolve_model_for_agent()` pour
    # choisir le meilleur modèle disponible chez l'utilisateur. Ignoré si
    # `model` est déjà spécifié explicitement.
    # Profils valides : general, reasoning_heavy, fast_cheap, code, vision,
    # long_context, research. Voir backend/core/agents/model_router.py.
    model_profile: str = "general"


class SubAgentLibrary:
    from pathlib import Path
    AGENTS_FILE = Path(__file__).parent.parent.parent.parent / "data" / "agents.json"

    def __init__(self):
        self.agents: dict[str, SubAgent] = {}
        self._load()

    def _load(self):
        import uuid, json
        if self.AGENTS_FILE.exists():
            try:
                data = json.loads(self.AGENTS_FILE.read_text(encoding="utf-8"))
                for a in data.get("agents", []):
                    a.setdefault("id", str(uuid.uuid4())[:8])
                    a.setdefault("tools", [])
                    a.setdefault("description", "")
                    a.setdefault("version", "1.0.0")
                    a.setdefault("tags", [])
                    a.setdefault("max_iterations", 5)
                    a.setdefault("author", "gungnir")
                    if isinstance(a.get("created_at"), str):
                        try:
                            a["created_at"] = datetime.fromisoformat(a["created_at"])
                        except Exception:
                            a["created_at"] = datetime.utcnow()
                    agent = SubAgent(**a)
                    self.agents[agent.name] = agent
                return
            except Exception:
                pass

    def _save(self):
        import json
        data = {
            "agents": [
                {
                    **a.model_dump(),
                    "created_at": a.created_at.isoformat() if a.created_at else None,
                }
                for a in self.agents.values()
            ]
        }
        self.AGENTS_FILE.parent.mkdir(exist_ok=True)
        self.AGENTS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def add_agent(self, agent: SubAgent):
        self.agents[agent.name] = agent
        self._save()

    def get_agent(self, name: str) -> Optional[SubAgent]:
        return self.agents.get(name)

    def list_agents(self) -> list[SubAgent]:
        return list(self.agents.values())

    def remove_agent(self, name: str):
        self.agents.pop(name, None)
        self._save()


skill_library = SkillLibrary()
personality_manager = PersonalityManager()
subagent_library = SubAgentLibrary()
