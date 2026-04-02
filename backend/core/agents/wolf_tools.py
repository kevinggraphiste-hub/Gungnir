"""
wolf_tools.py — Outils que Wolf peut appeler lui-même via function calling.
Chaque outil a un schéma OpenAI-compatible et un exécuteur Python async.
"""
from pathlib import Path
from datetime import datetime
from typing import Any
import json, uuid

DATA_DIR = Path(__file__).parent.parent.parent / "data"

# ── Schémas envoyés au LLM ─────────────────────────────────────────────────────

WOLF_TOOL_SCHEMAS = [
    # ── Skills ────────────────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "skill_create",
            "description": "Crée une nouvelle compétence (skill) pour Wolf. Appelle ceci quand l'utilisateur demande de créer un skill ou une capacité spécifique.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name":        {"type": "string", "description": "Identifiant unique (snake_case)"},
                    "description": {"type": "string", "description": "Description courte"},
                    "prompt":      {"type": "string", "description": "Prompt système détaillé pour ce skill"},
                    "category":    {"type": "string", "description": "Catégorie: development, research, writing, design, general", "default": "general"},
                },
                "required": ["name", "description", "prompt"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "skill_update",
            "description": "Met à jour un skill existant (description ou prompt).",
            "parameters": {
                "type": "object",
                "properties": {
                    "name":        {"type": "string"},
                    "description": {"type": "string"},
                    "prompt":      {"type": "string"},
                    "category":    {"type": "string"},
                },
                "required": ["name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "skill_delete",
            "description": "Supprime un skill.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "skill_list",
            "description": "Liste tous les skills disponibles.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    # ── Personnalités ──────────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "personality_create",
            "description": "Crée une nouvelle personnalité pour Wolf.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name":          {"type": "string", "description": "Identifiant (snake_case)"},
                    "description":   {"type": "string"},
                    "system_prompt": {"type": "string", "description": "Instructions de personnalité complètes"},
                    "traits":        {"type": "array", "items": {"type": "string"}, "description": "Liste de traits"},
                },
                "required": ["name", "description", "system_prompt"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "personality_update",
            "description": "Met à jour une personnalité existante.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name":          {"type": "string"},
                    "description":   {"type": "string"},
                    "system_prompt": {"type": "string"},
                    "traits":        {"type": "array", "items": {"type": "string"}},
                },
                "required": ["name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "personality_delete",
            "description": "Supprime une personnalité (sauf 'professional').",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "personality_set_active",
            "description": "Active une personnalité pour les prochaines conversations.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"]
            }
        }
    },
    # ── Base de connaissance (fichiers .md dans data/) ─────────────────────────
    {
        "type": "function",
        "function": {
            "name": "kb_write",
            "description": "Crée ou met à jour un fichier .md dans la base de connaissance (data/knowledge/). Utilise ceci pour noter des informations importantes, créer des documents de référence.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string", "description": "Nom du fichier (ex: projet_x.md, contexte_client.md)"},
                    "content":  {"type": "string", "description": "Contenu Markdown"},
                    "subdir":   {"type": "string", "description": "Sous-dossier optionnel dans data/ (ex: 'knowledge', 'notes')", "default": "knowledge"},
                },
                "required": ["filename", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "kb_read",
            "description": "Lit un fichier depuis la base de connaissance.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string"},
                    "subdir":   {"type": "string", "default": "knowledge"},
                },
                "required": ["filename"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "kb_list",
            "description": "Liste les fichiers disponibles dans la base de connaissance.",
            "parameters": {
                "type": "object",
                "properties": {
                    "subdir": {"type": "string", "default": "knowledge"}
                }
            }
        }
    },
    # ── Sous-agents ────────────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "subagent_create",
            "description": "Crée un nouveau sous-agent spécialisé pour Wolf. Appelle ceci quand l'utilisateur demande de créer un agent ou un sous-agent. OBLIGATOIRE : toujours spécifier provider et model en choisissant le modèle le moins cher suffisant pour la tâche.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name":          {"type": "string", "description": "Identifiant unique snake_case (ex: agent_seo, agent_redacteur)"},
                    "role":          {"type": "string", "description": "Rôle principal (ex: 'Expert SEO', 'Analyste financier')"},
                    "expertise":     {"type": "string", "description": "Domaines d'expertise détaillés"},
                    "system_prompt": {"type": "string", "description": "Instructions système complètes et détaillées pour ce sous-agent"},
                    "provider":      {"type": "string", "description": "OBLIGATOIRE. Provider LLM à utiliser. Utiliser 'openrouter' pour accéder à tous les modèles."},
                    "model":         {"type": "string", "description": "OBLIGATOIRE. Modèle exact à utiliser (ex: 'google/gemini-2.0-flash', 'anthropic/claude-3.5-haiku'). Choisir le moins cher suffisant pour la mission : tâche simple→gemini-flash/gpt-4o-mini, tâche complexe→claude-haiku, expert→claude-sonnet."},
                    "tools":         {"type": "array", "items": {"type": "string"}, "description": "Outils disponibles pour ce sous-agent"},
                },
                "required": ["name", "role", "expertise", "system_prompt", "provider", "model"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "subagent_invoke",
            "description": "Délègue une tâche à un sous-agent spécialisé. Le sous-agent utilise son propre modèle/provider configuré et retourne son résultat.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Nom du sous-agent à invoquer"},
                    "task": {"type": "string", "description": "Tâche ou question complète à soumettre au sous-agent"},
                },
                "required": ["name", "task"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "subagent_update",
            "description": "Met à jour un sous-agent existant.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name":          {"type": "string"},
                    "role":          {"type": "string"},
                    "expertise":     {"type": "string"},
                    "system_prompt": {"type": "string"},
                    "tools":         {"type": "array", "items": {"type": "string"}},
                },
                "required": ["name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "subagent_delete",
            "description": "Supprime un sous-agent.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "subagent_list",
            "description": "Liste tous les sous-agents disponibles.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    # ── Web Fetch (léger, sans Playwright) — PRIORITAIRE ─────────────────────
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "Accède à n'importe quelle URL et retourne son contenu en texte propre. C'est l'outil LE PLUS SIMPLE et LE PLUS RAPIDE pour lire une page web. Utilise TOUJOURS cet outil en premier quand l'utilisateur demande de visiter un site, lire une page, ou analyser une URL. Pas besoin de browser.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL à accéder (ex: https://scarletwolf.fr, google.com)"},
                    "extract": {"type": "string", "description": "Mode: 'text' (défaut, texte propre), 'html' (HTML brut), 'all' (texte + meta + liens)", "default": "text"},
                },
                "required": ["url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_crawl",
            "description": "Crawle un site web entier — suit les liens et collecte le titre + texte de chaque page. Utilise cet outil pour explorer un site complet.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL de départ du crawl"},
                    "max_pages": {"type": "integer", "description": "Nombre max de pages (défaut: 10)", "default": 10},
                    "same_domain": {"type": "boolean", "description": "Rester sur le même domaine (défaut: true)", "default": True},
                },
                "required": ["url"]
            }
        }
    },
    # ── Navigation Web (Browser Playwright) — pour cas avancés ───────────────
    {
        "type": "function",
        "function": {
            "name": "browser_navigate",
            "description": "Ouvre une URL dans le browser Playwright (navigateur complet). Utilise ceci uniquement pour les cas avancés : sites avec JavaScript dynamique, SPA, formulaires, login. Pour simplement lire une page → utilise web_fetch à la place.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL complète à ouvrir (ex: https://google.com)"},
                },
                "required": ["url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_get_text",
            "description": "Récupère le contenu textuel d'une page ou d'un élément CSS. Utilise pour scraper le contenu d'une page web.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string", "description": "ID de la page retourné par browser_navigate"},
                    "selector": {"type": "string", "description": "Sélecteur CSS optionnel (défaut: 'body' = page entière)", "default": "body"},
                },
                "required": ["page_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_click",
            "description": "Clique sur un élément de la page par sélecteur CSS.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "selector": {"type": "string", "description": "Sélecteur CSS de l'élément à cliquer (ex: 'button[type=submit]', '#btn-ok')"},
                },
                "required": ["page_id", "selector"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_type",
            "description": "Saisit du texte dans un champ input ou textarea.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "selector": {"type": "string", "description": "Sélecteur CSS du champ (ex: 'input[name=q]', '#search')"},
                    "text": {"type": "string", "description": "Texte à saisir"},
                },
                "required": ["page_id", "selector", "text"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_screenshot",
            "description": "Prend une capture d'écran de la page et retourne l'image en base64.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                },
                "required": ["page_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_evaluate",
            "description": "Exécute du JavaScript dans le contexte de la page et retourne le résultat.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "script": {"type": "string", "description": "Expression JS à évaluer (ex: 'document.title', 'document.querySelectorAll(\"a\").length')"},
                },
                "required": ["page_id", "script"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_close",
            "description": "Ferme une page du browser.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                },
                "required": ["page_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_get_links",
            "description": "Extrait tous les liens (<a href>) d'une page web avec leur texte. Utile pour explorer la structure d'un site ou trouver des pages pertinentes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                },
                "required": ["page_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_get_page_info",
            "description": "Récupère les métadonnées complètes d'une page : title, URL, meta description, Open Graph, nombre de liens/images/scripts/formulaires.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                },
                "required": ["page_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_press_key",
            "description": "Appuie sur une touche clavier (Enter, Tab, Escape, ArrowDown, etc.). Utile après avoir saisi du texte dans un champ de recherche pour valider.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "key": {"type": "string", "description": "Nom de la touche: Enter, Tab, Escape, ArrowDown, ArrowUp, Space, Backspace..."},
                },
                "required": ["page_id", "key"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_crawl",
            "description": "Crawler : part d'une URL, suit les liens, collecte le titre et le texte de chaque page visitée. Limité à max_pages. Utilise pour explorer un site web entier.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL de départ du crawl"},
                    "max_pages": {"type": "integer", "description": "Nombre max de pages à visiter (défaut: 10, max: 50)", "default": 10},
                    "same_domain": {"type": "boolean", "description": "Rester sur le même domaine ? (défaut: true)", "default": True},
                },
                "required": ["url"]
            }
        }
    },
    # ── Recherche web directe ─────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Recherche web instantanée (DuckDuckGo). Retourne une liste de résultats {title, url, snippet}. Utilise TOUJOURS cet outil quand l'utilisateur demande de chercher quelque chose sur Internet.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Termes de recherche"},
                    "num_results": {"type": "integer", "description": "Nombre de résultats (défaut: 10)", "default": 10},
                },
                "required": ["query"]
            }
        }
    },
    # ── Outils browser avancés ────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "browser_goto",
            "description": "Navigue vers une nouvelle URL sur une page déjà ouverte (sans créer un nouvel onglet).",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "url": {"type": "string", "description": "Nouvelle URL"},
                },
                "required": ["page_id", "url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_get_html",
            "description": "Récupère le code HTML d'une page entière ou d'un élément CSS. Utile pour analyser la structure DOM.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "selector": {"type": "string", "description": "Sélecteur CSS optionnel (défaut: page entière)"},
                },
                "required": ["page_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_wait_for_selector",
            "description": "Attend qu'un élément apparaisse dans le DOM (indispensable pour les pages dynamiques / SPA).",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "selector": {"type": "string", "description": "Sélecteur CSS à attendre"},
                    "timeout": {"type": "integer", "description": "Timeout en ms (défaut: 10000)", "default": 10000},
                },
                "required": ["page_id", "selector"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_scroll",
            "description": "Scroll la page vers le haut ou le bas. Utile pour déclencher le lazy-loading ou l'infinite scroll.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "direction": {"type": "string", "enum": ["down", "up"], "description": "Direction (défaut: down)", "default": "down"},
                    "amount": {"type": "integer", "description": "Pixels à scroller (défaut: 500)", "default": 500},
                },
                "required": ["page_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_extract_table",
            "description": "Extrait un tableau HTML en données structurées (headers + rows). Parfait pour scraper des tableaux de données.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "selector": {"type": "string", "description": "Sélecteur CSS du tableau (défaut: 'table')", "default": "table"},
                },
                "required": ["page_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_query_selector_all",
            "description": "Extrait une valeur de TOUS les éléments correspondant à un sélecteur CSS. Retourne une liste. Très puissant pour scraper des listes, des prix, des titres, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "selector": {"type": "string", "description": "Sélecteur CSS (ex: '.product-title', 'h2 a', 'li.item')"},
                    "extract": {"type": "string", "description": "Quoi extraire: 'text' (innerText), 'html' (innerHTML), ou un attribut ('href', 'src', 'data-id'...)", "default": "text"},
                },
                "required": ["page_id", "selector"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_select_option",
            "description": "Sélectionne une option dans un menu déroulant <select>.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "selector": {"type": "string", "description": "Sélecteur CSS du <select>"},
                    "value": {"type": "string", "description": "Valeur de l'option à sélectionner"},
                },
                "required": ["page_id", "selector", "value"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_fill_form",
            "description": "Remplit un formulaire entier en une fois (champs multiples) et optionnellement le soumet.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "fields": {"type": "object", "description": "Paires {sélecteur_CSS: valeur} pour chaque champ à remplir"},
                    "submit_selector": {"type": "string", "description": "Sélecteur du bouton submit (optionnel)"},
                },
                "required": ["page_id", "fields"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_download",
            "description": "Télécharge un fichier depuis une URL (PDF, image, etc.) et le sauve dans data/downloads/.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "url": {"type": "string", "description": "URL du fichier à télécharger"},
                    "filename": {"type": "string", "description": "Nom de fichier de destination (optionnel, déduit de l'URL sinon)"},
                },
                "required": ["page_id", "url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_list_pages",
            "description": "Liste tous les onglets/pages ouverts dans le browser avec leur ID, URL et titre.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    # ── Soul (identité permanente) ─────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "soul_read",
            "description": "Lit l'identité permanente (soul.md) de Wolf.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "soul_write",
            "description": "Met à jour l'identité permanente (soul.md) de Wolf. Attention : change la personnalité de base pour TOUTES les conversations.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Nouveau contenu complet de soul.md"}
                },
                "required": ["content"]
            }
        }
    },
]

# ── Exécuteurs ─────────────────────────────────────────────────────────────────

async def _skill_create(name: str, description: str, prompt: str, category: str = "general") -> dict:
    from backend.core.agents.skills import skill_library, Skill
    skill = Skill(
        id=str(uuid.uuid4())[:8],
        name=name, description=description,
        prompt=prompt, category=category,
        created_at=datetime.utcnow()
    )
    skill_library.add_skill(skill)
    # Persister dans un fichier .md pour traçabilité
    skill_file = DATA_DIR / "skills" / f"{name}.md"
    skill_file.parent.mkdir(exist_ok=True)
    skill_file.write_text(
        f"# Skill : {name}\n\n**Catégorie :** {category}\n\n**Description :** {description}\n\n## Prompt\n\n{prompt}\n",
        encoding="utf-8"
    )
    return {"ok": True, "skill": name, "message": f"Skill '{name}' créé et sauvegardé."}


async def _skill_update(name: str, description: str = None, prompt: str = None, category: str = None) -> dict:
    from backend.core.agents.skills import skill_library
    skill = skill_library.get_skill(name)
    if not skill:
        return {"ok": False, "error": f"Skill '{name}' introuvable."}
    if description: skill.description = description
    if prompt:      skill.prompt = prompt
    if category:    skill.category = category
    skill_library._save()
    return {"ok": True, "skill": name, "message": f"Skill '{name}' mis à jour."}


async def _skill_delete(name: str) -> dict:
    from backend.core.agents.skills import skill_library
    skill_library.remove_skill(name)
    skill_file = DATA_DIR / "skills" / f"{name}.md"
    if skill_file.exists():
        skill_file.unlink()
    return {"ok": True, "message": f"Skill '{name}' supprimé."}


async def _skill_list() -> dict:
    from backend.core.agents.skills import skill_library
    skills = skill_library.list_skills()
    return {"skills": [{"name": s.name, "description": s.description, "category": s.category} for s in skills]}


async def _personality_create(name: str, description: str, system_prompt: str, traits: list = None) -> dict:
    from backend.core.agents.skills import personality_manager, Personality
    p = Personality(
        id=str(uuid.uuid4())[:8],
        name=name, description=description,
        system_prompt=system_prompt,
        traits=traits or [],
        created_at=datetime.utcnow()
    )
    personality_manager.add_personality(p)
    return {"ok": True, "personality": name, "message": f"Personnalité '{name}' créée et sauvegardée."}


async def _personality_update(name: str, description: str = None, system_prompt: str = None, traits: list = None) -> dict:
    from backend.core.agents.skills import personality_manager
    ok = personality_manager.update_personality(name, description=description, system_prompt=system_prompt, traits=traits)
    if not ok:
        return {"ok": False, "error": f"Personnalité '{name}' introuvable."}
    return {"ok": True, "personality": name, "message": f"Personnalité '{name}' mise à jour."}


async def _personality_delete(name: str) -> dict:
    if name == "professional":
        return {"ok": False, "error": "La personnalité 'professional' ne peut pas être supprimée."}
    from backend.core.agents.skills import personality_manager
    ok = personality_manager.remove_personality(name)
    return {"ok": ok, "message": f"Personnalité '{name}' {'supprimée' if ok else 'introuvable'}."}


async def _personality_set_active(name: str) -> dict:
    from backend.core.agents.skills import personality_manager
    ok = personality_manager.set_active(name)
    return {"ok": ok, "message": f"Personnalité active : '{name}'." if ok else f"Personnalité '{name}' introuvable."}


async def _subagent_create(name: str, role: str, expertise: str, system_prompt: str,
                           tools: list = None, provider: str = "openrouter", model: str = "") -> dict:
    from backend.core.agents.skills import subagent_library, SubAgent
    if not name.startswith("agent_"):
        name = f"agent_{name}"
    agent = SubAgent(
        id=str(uuid.uuid4())[:8],
        name=name, role=role, expertise=expertise,
        system_prompt=system_prompt,
        tools=tools or [],
        provider=provider,
        model=model,
        created_at=datetime.utcnow()
    )
    subagent_library.add_agent(agent)
    return {"ok": True, "agent": name, "message": f"Sous-agent '{name}' créé (modèle: {model or 'défaut'})."}


def _get_tools_for_agent(agent_tools: list[str] | None) -> list[dict]:
    """
    Retourne les schemas d'outils disponibles pour un sous-agent.
    Si agent.tools est vide → tous les outils web (browser_*, web_search).
    Si agent.tools liste des noms → uniquement ceux-là.
    """
    if agent_tools:
        name_set = set(agent_tools)
        return [s for s in WOLF_TOOL_SCHEMAS if s["function"]["name"] in name_set]
    # Par défaut : tous les outils de navigation/scraping web + KB
    web_tool_names = {
        "web_fetch", "web_search", "web_crawl",
        "browser_navigate", "browser_goto", "browser_get_text", "browser_get_html",
        "browser_click", "browser_type", "browser_press_key", "browser_scroll",
        "browser_screenshot", "browser_evaluate", "browser_close", "browser_list_pages",
        "browser_get_links", "browser_get_page_info",
        "browser_wait_for_selector", "browser_extract_table", "browser_query_selector_all",
        "browser_select_option", "browser_fill_form",
        "browser_crawl", "browser_download",
        "kb_write", "kb_read", "kb_list",
    }
    return [s for s in WOLF_TOOL_SCHEMAS if s["function"]["name"] in web_tool_names]


async def _subagent_invoke(name: str, task: str) -> dict:
    from backend.core.agents.skills import subagent_library
    from backend.core.config.settings import Settings
    from backend.core.providers import get_provider
    from backend.core.providers.base import ChatMessage as CM
    agent = subagent_library.get_agent(name)
    if not agent:
        return {"ok": False, "error": f"Sous-agent '{name}' introuvable."}
    settings = Settings.load()
    provider_cfg = settings.providers.get(agent.provider or "openrouter")
    if not provider_cfg or not provider_cfg.api_key:
        return {"ok": False, "error": f"Provider '{agent.provider}' non configuré."}
    model = agent.model or provider_cfg.default_model
    llm = get_provider(agent.provider, provider_cfg.api_key, provider_cfg.base_url)

    # Construire le system prompt avec les capacités web + format <tool_call>
    system = agent.system_prompt
    system += """

## COMMENT APPELER TES OUTILS

Pour appeler un outil, écris ce format dans ta réponse :
<tool_call>
{"name": "web_fetch", "arguments": {"url": "https://example.com"}}
</tool_call>

## TES OUTILS DISPONIBLES
- **web_fetch** : Accéder à n'importe quelle URL (HTTP GET → texte). Params: url, extract ("text"/"all")
- **web_search** : Recherche web DuckDuckGo. Params: query
- **web_crawl** : Crawler un site. Params: url, max_pages
- **browser_navigate** / **browser_get_text** / **browser_screenshot** (pour JS dynamique)

TU AS INTERNET. Ne dis JAMAIS que tu n'as pas accès au web."""

    agent_tools = _get_tools_for_agent(agent.tools)

    # ── Gateway web : pré-fetch le contenu AVANT d'envoyer au sous-agent ──
    from backend.core.gateway import WebGateway, detect_web_refusal, extract_original_query
    from backend.api.routes import _parse_text_tool_calls

    gw = WebGateway()
    gw_result = await gw.process_message(task)
    enriched_task = task
    if gw_result["has_web_content"]:
        enriched_task = gw_result["enriched_message"]
        print(f"[SubAgent] Gateway enriched task with {len(gw_result['web_content'])} blocks")

    messages = [CM(role="system", content=system), CM(role="user", content=enriched_task)]

    try:
        MAX_ROUNDS = 8
        _native_mode = True

        for _round in range(MAX_ROUNDS):
            if _native_mode:
                try:
                    resp = await llm.chat(messages, model, tools=agent_tools, tool_choice="auto")
                except Exception:
                    _native_mode = False
                    resp = await llm.chat(messages, model)
            else:
                resp = await llm.chat(messages, model)

            # Fallback 1: text parsing
            if not resp.tool_calls and resp.content:
                text_tools = _parse_text_tool_calls(resp.content)
                if text_tools:
                    resp.tool_calls = text_tools

            # Fallback 2: web refusal → Gateway force search
            if not resp.tool_calls and resp.content and detect_web_refusal(resp.content):
                _native_mode = False
                user_query = extract_original_query(messages) or task
                gw_force = WebGateway()
                force_result = await gw_force.force_search(user_query)
                if force_result["has_content"]:
                    messages.append(CM(role="assistant", content="Je récupère les informations..."))
                    messages.append(CM(role="user", content=f"[SYSTÈME — CONTENU GATEWAY]\n\n{force_result['enriched_content']}\n\n---\nRéponds avec ce contenu."))
                    continue

            if not resp.tool_calls:
                return {"ok": True, "agent": name, "model": model, "result": resp.content}

            # Execute tools
            _is_text = any(tc.get("id", "").startswith("textparse-") for tc in resp.tool_calls)
            all_results = []
            for tc in resp.tool_calls:
                fn = tc.get("function", {})
                tool_name = fn.get("name", "")
                call_id = tc.get("id") or str(uuid.uuid4())[:8]
                try:
                    args = json.loads(fn.get("arguments", "{}")) if isinstance(fn.get("arguments"), str) else fn.get("arguments", {})
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
                all_results.append({"tool": tool_name, "result": tool_result, "call_id": call_id})

            if _is_text or not _native_mode:
                messages.append(CM(role="assistant", content=resp.content or "Exécution..."))
                parts = [f"**{r['tool']}** → {json.dumps(r['result'], ensure_ascii=False)[:6000]}" for r in all_results]
                messages.append(CM(role="user", content="Résultats :\n\n" + "\n\n".join(parts) + "\n\nRéponds."))
            else:
                messages.append(CM(role="assistant", content=resp.content or "", tool_calls=resp.tool_calls))
                for r in all_results:
                    messages.append(CM(role="tool", content=json.dumps(r["result"], ensure_ascii=False)[:3000], tool_call_id=r["call_id"]))

        resp = await llm.chat(messages, model)
        return {"ok": True, "agent": name, "model": model, "result": resp.content}
    except Exception as ex:
        return {"ok": False, "error": str(ex)}


async def _subagent_update(name: str, role: str = None, expertise: str = None, system_prompt: str = None, tools: list = None) -> dict:
    from backend.core.agents.skills import subagent_library
    agent = subagent_library.get_agent(name)
    if not agent:
        return {"ok": False, "error": f"Sous-agent '{name}' introuvable."}
    if role:          agent.role = role
    if expertise:     agent.expertise = expertise
    if system_prompt: agent.system_prompt = system_prompt
    if tools is not None: agent.tools = tools
    subagent_library._save()
    return {"ok": True, "agent": name, "message": f"Sous-agent '{name}' mis à jour."}


async def _subagent_delete(name: str) -> dict:
    from backend.core.agents.skills import subagent_library
    subagent_library.remove_agent(name)
    return {"ok": True, "message": f"Sous-agent '{name}' supprimé."}


async def _subagent_list() -> dict:
    from backend.core.agents.skills import subagent_library
    agents = subagent_library.list_agents()
    return {"agents": [{"name": a.name, "role": a.role, "expertise": a.expertise} for a in agents]}


def _safe_path(subdir: str, filename: str) -> Path:
    """Retourne un chemin sécurisé dans data/ (pas de traversal)."""
    subdir_clean = Path(subdir).name  # empêche ../../../etc
    filename_clean = Path(filename).name
    path = DATA_DIR / subdir_clean / filename_clean
    # S'assurer que le chemin résolu reste dans DATA_DIR
    if not str(path.resolve()).startswith(str(DATA_DIR.resolve())):
        raise ValueError("Chemin non autorisé.")
    return path


async def _kb_write(filename: str, content: str, subdir: str = "knowledge") -> dict:
    if not filename.endswith(".md"):
        filename = filename + ".md"
    path = _safe_path(subdir, filename)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return {"ok": True, "path": str(path.relative_to(DATA_DIR)), "message": f"Fichier '{filename}' sauvegardé dans data/{subdir}/"}


async def _kb_read(filename: str, subdir: str = "knowledge") -> dict:
    if not filename.endswith(".md"):
        filename = filename + ".md"
    path = _safe_path(subdir, filename)
    if not path.exists():
        return {"ok": False, "error": f"Fichier '{filename}' introuvable dans data/{subdir}/"}
    return {"ok": True, "content": path.read_text(encoding="utf-8")}


async def _kb_list(subdir: str = "knowledge") -> dict:
    subdir_clean = Path(subdir).name
    directory = DATA_DIR / subdir_clean
    if not directory.exists():
        return {"files": []}
    files = [f.name for f in directory.iterdir() if f.is_file()]
    return {"files": files, "directory": f"data/{subdir_clean}/"}


async def _browser_navigate(url: str) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    if not browser_tool.browser:
        start_result = await browser_tool.start(headless=True)
        if not start_result.get("success"):
            return {"ok": False, "error": f"Impossible de démarrer le browser : {start_result.get('error', '')}"}
    result = await browser_tool.new_page(url)
    if result.get("success"):
        return {"ok": True, "page_id": result["page_id"], "title": result.get("title", ""), "url": url,
                "message": f"Page ouverte : '{result.get('title', url)}' (page_id={result['page_id']})"}
    return {"ok": False, "error": result.get("error", "Erreur lors de l'ouverture de la page")}


async def _browser_get_text(page_id: str, selector: str = "body") -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.get_text(page_id, selector)
    if result.get("success"):
        text = result.get("text", "")
        return {"ok": True, "text": text[:8000], "length": len(text), "truncated": len(text) > 8000}
    return {"ok": False, "error": result.get("error", "Erreur extraction texte")}


async def _browser_click(page_id: str, selector: str) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.click(page_id, selector)
    if result.get("success"):
        return {"ok": True, "message": f"Click réussi sur '{selector}'"}
    return {"ok": False, "error": result.get("error", "Erreur click")}


async def _browser_type(page_id: str, selector: str, text: str) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.type_text(page_id, selector, text)
    if result.get("success"):
        return {"ok": True, "message": f"Texte saisi dans '{selector}'"}
    return {"ok": False, "error": result.get("error", "Erreur saisie")}


async def _browser_screenshot(page_id: str) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.screenshot(page_id)  # retourne image_b64 directement
    if result.get("success"):
        return {"ok": True, "image_b64": result.get("image_b64", "")[:50000], "message": "Capture d'écran réalisée"}
    return {"ok": False, "error": result.get("error", "Erreur screenshot")}


async def _browser_evaluate(page_id: str, script: str) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.evaluate(page_id, script)
    if result.get("success"):
        return {"ok": True, "result": result.get("result", "")}
    return {"ok": False, "error": result.get("error", "Erreur JS")}


async def _browser_close(page_id: str) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.close_page(page_id)
    if result.get("success"):
        return {"ok": True, "message": f"Page {page_id} fermée"}
    return {"ok": False, "error": result.get("error", "Erreur fermeture")}


async def _browser_get_links(page_id: str) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.get_links(page_id)
    if result.get("success"):
        links = result.get("links", [])
        return {"ok": True, "links": links[:100], "total": result.get("total", 0)}
    return {"ok": False, "error": result.get("error", "Erreur extraction liens")}


async def _browser_get_page_info(page_id: str) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.get_page_info(page_id)
    if result.get("success"):
        result.pop("success", None)
        return {"ok": True, **result}
    return {"ok": False, "error": result.get("error", "Erreur info page")}


async def _browser_press_key(page_id: str, key: str) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.press_key(page_id, key)
    if result.get("success"):
        return {"ok": True, "message": f"Touche '{key}' pressée"}
    return {"ok": False, "error": result.get("error", "Erreur touche")}


async def _browser_crawl(url: str, max_pages: int = 10, same_domain: bool = True) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.crawl(url, max_pages=min(max_pages, 50), same_domain=same_domain)
    if result.get("success"):
        return {
            "ok": True,
            "pages_crawled": result.get("pages_crawled", 0),
            "results": result.get("results", []),
        }
    return {"ok": False, "error": result.get("error", "Erreur crawl")}


async def _web_fetch(url: str, extract: str = "text") -> dict:
    """Fetch léger — HTTP GET + extraction de contenu (pas besoin de Playwright)."""
    from backend.core.agents.tools.web_fetch import web_fetch
    return await web_fetch(url, extract=extract)


async def _web_crawl_lite(url: str, max_pages: int = 10, same_domain: bool = True) -> dict:
    """Crawl léger — suit les liens via HTTP (pas besoin de Playwright)."""
    from backend.core.agents.tools.web_fetch import web_crawl_lite
    return await web_crawl_lite(url, max_pages=min(max_pages, 50), same_domain=same_domain)


async def _web_search(query: str, num_results: int = 10) -> dict:
    """Recherche web via DuckDuckGo — version légère sans Playwright."""
    from backend.core.agents.tools.web_fetch import web_search_lite
    result = await web_search_lite(query, num_results=num_results)
    if result.get("ok"):
        return result
    # Fallback: essayer avec Playwright si la version lite échoue
    try:
        from backend.core.agents.tools.browser import browser_tool
        result2 = await browser_tool.web_search(query, num_results=num_results)
        if result2.get("success"):
            return {"ok": True, "query": query, "results": result2.get("results", [])}
    except Exception:
        pass
    return result  # Retourner l'erreur originale


async def _browser_goto(page_id: str, url: str) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.goto(page_id, url)
    if result.get("success"):
        return {"ok": True, "url": result.get("url", url), "title": result.get("title", "")}
    return {"ok": False, "error": result.get("error", "Erreur navigation")}


async def _browser_get_html(page_id: str, selector: str = None) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.get_html(page_id, selector)
    if result.get("success"):
        html = result.get("html", "")
        return {"ok": True, "html": html[:15000], "length": len(html), "truncated": len(html) > 15000}
    return {"ok": False, "error": result.get("error", "Erreur HTML")}


async def _browser_wait_for_selector(page_id: str, selector: str, timeout: int = 10000) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.wait_for_selector(page_id, selector, timeout=timeout)
    if result.get("success"):
        return {"ok": True, "message": f"Élément '{selector}' trouvé"}
    return {"ok": False, "error": result.get("error", "Élément non trouvé (timeout)")}


async def _browser_scroll(page_id: str, direction: str = "down", amount: int = 500) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.scroll(page_id, direction=direction, amount=amount)
    if result.get("success"):
        return {"ok": True, "scrollY": result.get("scrollY", 0), "scrollHeight": result.get("scrollHeight", 0)}
    return {"ok": False, "error": result.get("error", "Erreur scroll")}


async def _browser_extract_table(page_id: str, selector: str = "table") -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.extract_table(page_id, selector=selector)
    if result.get("success"):
        return {"ok": True, "headers": result.get("headers", []), "rows": result.get("rows", [])}
    return {"ok": False, "error": result.get("error", "Erreur extraction tableau")}


async def _browser_query_selector_all(page_id: str, selector: str, extract: str = "text") -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.query_selector_all(page_id, selector, extract=extract)
    if result.get("success"):
        return {"ok": True, "items": result.get("items", []), "count": result.get("count", 0)}
    return {"ok": False, "error": result.get("error", "Erreur query_selector_all")}


async def _browser_select_option(page_id: str, selector: str, value: str) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.select_option(page_id, selector, value)
    if result.get("success"):
        return {"ok": True, "message": f"Option '{value}' sélectionnée"}
    return {"ok": False, "error": result.get("error", "Erreur select")}


async def _browser_fill_form(page_id: str, fields: dict, submit_selector: str = None) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.fill_form(page_id, fields, submit_selector=submit_selector)
    if result.get("success"):
        return {"ok": True, "filled": result.get("filled", []), "submitted": result.get("submitted", False)}
    return {"ok": False, "error": result.get("error", "Erreur formulaire")}


async def _browser_download(page_id: str, url: str, filename: str = None) -> dict:
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.download_file(page_id, url, filename=filename)
    if result.get("success"):
        return {"ok": True, "filename": result.get("filename"), "path": result.get("path"), "size": result.get("size")}
    return {"ok": False, "error": result.get("error", "Erreur download")}


async def _browser_list_pages() -> dict:
    from backend.core.agents.tools.browser import browser_tool
    pages = browser_tool.list_pages()
    return {"ok": True, "pages": pages, "count": len(pages)}


async def _soul_read() -> dict:
    soul = DATA_DIR / "soul.md"
    if soul.exists():
        return {"ok": True, "content": soul.read_text(encoding="utf-8")}
    return {"ok": False, "error": "soul.md introuvable."}


async def _soul_write(content: str) -> dict:
    soul = DATA_DIR / "soul.md"
    soul.parent.mkdir(exist_ok=True)
    soul.write_text(content, encoding="utf-8")
    return {"ok": True, "message": "soul.md mis à jour. Prendra effet à la prochaine conversation."}


# ── Registre final ─────────────────────────────────────────────────────────────

WOLF_EXECUTORS: dict[str, Any] = {
    # Web fetch léger (PRIORITAIRE — fonctionne sans Playwright)
    "web_fetch":             _web_fetch,
    "web_crawl":             _web_crawl_lite,
    # Skills
    "skill_create":          _skill_create,
    "skill_update":          _skill_update,
    "skill_delete":          _skill_delete,
    "skill_list":            _skill_list,
    "personality_create":    _personality_create,
    "personality_update":    _personality_update,
    "personality_delete":    _personality_delete,
    "personality_set_active":_personality_set_active,
    "subagent_create":       _subagent_create,
    "subagent_update":       _subagent_update,
    "subagent_delete":       _subagent_delete,
    "subagent_list":         _subagent_list,
    "subagent_invoke":       _subagent_invoke,
    "kb_write":              _kb_write,
    "kb_read":               _kb_read,
    "kb_list":               _kb_list,
    "soul_read":             _soul_read,
    "soul_write":            _soul_write,
    "browser_navigate":      _browser_navigate,
    "browser_get_text":      _browser_get_text,
    "browser_click":         _browser_click,
    "browser_type":          _browser_type,
    "browser_screenshot":    _browser_screenshot,
    "browser_evaluate":      _browser_evaluate,
    "browser_close":         _browser_close,
    "browser_get_links":          _browser_get_links,
    "browser_get_page_info":      _browser_get_page_info,
    "browser_press_key":          _browser_press_key,
    "browser_crawl":              _browser_crawl,
    # Nouveaux outils web
    "web_search":                 _web_search,
    "browser_goto":               _browser_goto,
    "browser_get_html":           _browser_get_html,
    "browser_wait_for_selector":  _browser_wait_for_selector,
    "browser_scroll":             _browser_scroll,
    "browser_extract_table":      _browser_extract_table,
    "browser_query_selector_all": _browser_query_selector_all,
    "browser_select_option":      _browser_select_option,
    "browser_fill_form":          _browser_fill_form,
    "browser_download":           _browser_download,
    "browser_list_pages":         _browser_list_pages,
}

# Outils en lecture seule (autorisés même en mode restreint)
READ_ONLY_TOOLS = {
    "skill_list", "kb_read", "kb_list", "soul_read", "subagent_list", "subagent_invoke",
    "web_fetch", "web_crawl",
    "browser_navigate", "browser_get_text", "browser_screenshot", "browser_evaluate",
    "browser_click", "browser_type", "browser_close",
    "browser_get_links", "browser_get_page_info", "browser_press_key", "browser_crawl",
    "web_search", "browser_goto", "browser_get_html", "browser_wait_for_selector",
    "browser_scroll", "browser_extract_table", "browser_query_selector_all",
    "browser_select_option", "browser_fill_form", "browser_list_pages",
}
