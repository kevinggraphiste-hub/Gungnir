"""
wolf_tools.py — Outils que Wolf peut appeler lui-même via function calling.
Chaque outil a un schéma OpenAI-compatible et un exécuteur Python async.
"""
from pathlib import Path
from datetime import datetime, timezone
from typing import Any
import json, uuid

DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"

# ── Contexte d'exécution (défini par chat.py avant dispatch) ──────────────────
# Permet aux outils de connaître la conversation courante sans la passer en arg.
_current_conv_id: int | None = None
_current_user_id: int = 0

def set_conversation_context(conv_id: int | None) -> None:
    """Appelé par chat.py juste avant d'exécuter un outil, pour que les outils
    liés à une conversation (ex: conversation_tasks_*) sachent à quelle convo ils parlent."""
    global _current_conv_id
    _current_conv_id = conv_id

def get_conversation_context() -> int | None:
    return _current_conv_id

def set_user_context(user_id: int) -> None:
    """Appelé par chat.py pour que les outils soul/kb résolvent les chemins par user."""
    global _current_user_id
    _current_user_id = user_id

def get_user_context() -> int:
    return _current_user_id


def _soul_path(user_id: int = None) -> Path:
    """Chemin du soul.md per-user. Fallback global si user_id == 0."""
    uid = user_id or _current_user_id
    if uid and uid > 0:
        p = DATA_DIR / "soul" / str(uid) / "soul.md"
    else:
        p = DATA_DIR / "soul.md"  # fallback global
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _kb_dir(user_id: int = None) -> Path:
    """Répertoire KB per-user. Fallback global si user_id == 0."""
    uid = user_id or _current_user_id
    if uid and uid > 0:
        d = DATA_DIR / "kb" / str(uid)
    else:
        d = DATA_DIR / "kb"
    d.mkdir(parents=True, exist_ok=True)
    return d

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
            "description": "Met à jour l'identité permanente (soul.md) de l'agent. Change la personnalité de base pour TOUTES les conversations. Met aussi à jour le nom de l'agent dans la config si un nouveau nom est fourni.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Nouveau contenu complet de soul.md"},
                    "agent_name": {"type": "string", "description": "Nouveau nom de l'agent (optionnel — sera aussi extrait du contenu automatiquement)"}
                },
                "required": ["content"]
            }
        }
    },
    # ── Automata (tâches planifiées) ──────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "schedule_task",
            "description": "Crée une tâche planifiée qui sera exécutée automatiquement. Utilise ceci quand l'utilisateur demande d'automatiser, planifier, ou répéter une action (ex: 'vérifie mes backups tous les jours', 'rappelle-moi chaque lundi').",
            "parameters": {
                "type": "object",
                "properties": {
                    "name":        {"type": "string", "description": "Nom court de la tâche (ex: 'verif-backups')"},
                    "description": {"type": "string", "description": "Description courte pour l'utilisateur"},
                    "prompt":      {"type": "string", "description": "Prompt complet qui sera envoyé au LLM pour exécuter la tâche. Sois précis et détaillé."},
                    "task_type":   {"type": "string", "description": "Type: 'cron' (récurrent via expression cron), 'interval' (toutes les N secondes), 'once' (exécution unique)", "default": "cron"},
                    "cron_expression": {"type": "string", "description": "Expression cron 5 champs: minute heure jour mois jour_semaine. Ex: '0 9 * * 1-5' = 9h du lundi au vendredi"},
                    "interval_seconds": {"type": "integer", "description": "Intervalle en secondes (pour type=interval). Ex: 3600 = toutes les heures"},
                    "run_at":      {"type": "string", "description": "Date/heure ISO pour exécution unique (type=once). Ex: '2026-04-05T14:00:00'"},
                },
                "required": ["name", "description", "prompt"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "schedule_list",
            "description": "Liste les tâches planifiées existantes. Utilise ceci quand l'utilisateur demande de voir ses automatisations ou tâches programmées.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "schedule_delete",
            "description": "Supprime une tâche planifiée par son ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string", "description": "ID de la tâche à supprimer"}
                },
                "required": ["task_id"]
            }
        }
    },
    # ── Conversation tasks (todo-list interne façon Claude Code) ─────────────
    {
        "type": "function",
        "function": {
            "name": "conversation_tasks_list",
            "description": "Liste les tâches internes de la conversation courante (todo-list). Utilise ceci au début d'un gros projet pour voir l'état, ou avant d'ajouter de nouvelles tâches.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "conversation_tasks_set",
            "description": (
                "Remplace TOUTE la todo-list de la conversation courante en un seul appel. "
                "C'est l'outil principal à utiliser quand l'utilisateur demande un travail multi-étapes : "
                "tu planifies, tu envoies la liste complète, puis à chaque étape tu renvoies la liste mise à jour. "
                "Règles : une seule tâche en 'in_progress' à la fois ; marque immédiatement 'completed' dès qu'une tâche est finie ; "
                "garde 'content' à l'impératif ('Écrire la doc') et 'active_form' au participe ('Écriture de la doc')."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "description": "Liste complète des tâches dans l'ordre souhaité. Vide = efface la liste.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content":     {"type": "string", "description": "Forme impérative (ex: 'Écrire la doc')"},
                                "active_form": {"type": "string", "description": "Forme continue (ex: 'Écriture de la doc')"},
                                "status":      {"type": "string", "description": "pending | in_progress | completed", "default": "pending"}
                            },
                            "required": ["content"]
                        }
                    }
                },
                "required": ["tasks"]
            }
        }
    },
    # ── Filesystem & Shell (auto-modification) ─────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "file_read",
            "description": "Lit le contenu d'un fichier du projet Gungnir. Utilise ceci pour consulter le code source, la config, les données. Chemin relatif depuis la racine du projet.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin relatif (ex: 'backend/core/main.py', 'data/config.json')"},
                    "offset": {"type": "integer", "description": "Ligne de départ (0 = début)", "default": 0},
                    "limit": {"type": "integer", "description": "Nombre de lignes max à lire", "default": 200},
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "file_write",
            "description": "Écrit du contenu dans un fichier du projet Gungnir. ATTENTION: ceci modifie le code source. Utilise avec prudence. Les backups et le dossier backups/ sont protégés et ne peuvent pas être modifiés.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin relatif (ex: 'backend/plugins/code/routes.py')"},
                    "content": {"type": "string", "description": "Contenu complet du fichier"},
                },
                "required": ["path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "file_patch",
            "description": "Applique un remplacement ciblé dans un fichier (cherche old_text et le remplace par new_text). Plus sûr que file_write car ne touche que la partie ciblée.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin relatif du fichier"},
                    "old_text": {"type": "string", "description": "Texte exact à remplacer (doit être unique dans le fichier)"},
                    "new_text": {"type": "string", "description": "Nouveau texte de remplacement"},
                },
                "required": ["path", "old_text", "new_text"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "file_list",
            "description": "Liste les fichiers et dossiers dans un répertoire du projet Gungnir.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin relatif du dossier (ex: 'backend/plugins/', 'frontend/src/')", "default": "."},
                    "pattern": {"type": "string", "description": "Filtre glob optionnel (ex: '*.py', '*.tsx')", "default": "*"},
                    "recursive": {"type": "boolean", "description": "Lister récursivement", "default": False},
                },
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "bash_exec",
            "description": "Exécute une commande shell. ATTENTION: ceci peut modifier le système. Interdit de toucher au dossier backups/. Utilise pour: installer des packages, lancer des scripts, git, npm, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Commande bash à exécuter"},
                    "timeout": {"type": "integer", "description": "Timeout en secondes", "default": 30},
                    "cwd": {"type": "string", "description": "Répertoire de travail (relatif au projet)", "default": "."},
                },
                "required": ["command"]
            }
        }
    },
    # ── Doctor (auto-diagnostic) ─────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "doctor_check",
            "description": "Lance un diagnostic complet de Gungnir : plugins, services, dépendances, config, MCP, backup. Utilise ceci quand l'utilisateur demande un checkup, diagnostic, ou si quelque chose ne fonctionne pas.",
            "parameters": {
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "description": "Portée: 'full' (tout), 'plugins', 'services', 'dependencies', 'config', 'mcp', 'backup'", "default": "full"},
                },
            }
        }
    },
    # ── Channel management (setup wizard) ─────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "channel_manage",
            "description": (
                "Gère les canaux de communication (Telegram, Discord, Slack, WhatsApp, Email, Widget, API). "
                "Utilise cet outil quand l'utilisateur veut connecter, configurer, activer, désactiver ou supprimer un canal. "
                "Actions: 'list' (lister), 'catalog' (types disponibles), 'create' (créer), 'update' (modifier/ajouter token), "
                "'toggle' (activer/désactiver), 'delete' (supprimer), 'test' (tester), "
                "'oauth_url' (générer un lien OAuth pour que l'utilisateur autorise en 1 clic — Slack/Discord)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "catalog", "create", "update", "toggle", "delete", "test", "oauth_url"],
                               "description": "Action à effectuer"},
                    "channel_type": {"type": "string", "description": "Type: telegram, discord, slack, whatsapp, email, web_widget, api"},
                    "channel_id": {"type": "string", "description": "ID du canal (pour update/toggle/delete/test)"},
                    "name": {"type": "string", "description": "Nom du canal (pour create)"},
                    "config": {"type": "object", "description": "Configuration: {bot_token, webhook_secret, signing_secret, ...}"},
                    "enabled": {"type": "boolean", "description": "Activer/désactiver"},
                },
                "required": ["action"]
            }
        }
    },
    # ── Provider API key management ───────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "provider_manage",
            "description": (
                "Gère les providers LLM (clés API, activation, changement de modèle). "
                "Utilise cet outil quand l'utilisateur veut configurer, ajouter, supprimer une clé API, ou CHANGER de provider/modèle LLM en cours de conversation. "
                "Actions: 'list' (lister les providers et leur statut), 'save' (sauvegarder une clé API), 'delete' (supprimer un provider), "
                "'switch' (changer le provider/modèle actif — nécessite provider et optionnellement model)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "save", "delete", "switch"], "description": "Action à effectuer"},
                    "provider": {"type": "string", "description": "Nom du provider: openrouter, anthropic, openai, google, minimax, ollama"},
                    "api_key": {"type": "string", "description": "Clé API à sauvegarder"},
                    "base_url": {"type": "string", "description": "URL de base custom (optionnel)"},
                    "model": {"type": "string", "description": "Modèle à activer (pour action switch, ex: 'gpt-4.1', 'claude-sonnet-4-6')"},
                    "enabled": {"type": "boolean", "description": "Activer/désactiver", "default": True},
                },
                "required": ["action"]
            }
        }
    },
    # ── MCP server management ─────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "mcp_manage",
            "description": (
                "Gère les serveurs MCP (Model Context Protocol). "
                "Utilise cet outil quand l'utilisateur veut ajouter, lister ou supprimer un serveur MCP. "
                "Les serveurs MCP ajoutent des outils externes (n8n, GitHub, bases de données, etc.). "
                "Actions: 'list' (lister serveurs et outils), 'add' (ajouter un serveur), 'delete' (supprimer)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "delete"], "description": "Action à effectuer"},
                    "name": {"type": "string", "description": "Nom unique du serveur MCP"},
                    "command": {"type": "string", "description": "Commande: npx, node, python, etc."},
                    "args": {"type": "array", "items": {"type": "string"}, "description": "Arguments de la commande"},
                    "env": {"type": "object", "description": "Variables d'environnement {clé: valeur}"},
                    "enabled": {"type": "boolean", "description": "Activer au démarrage", "default": True},
                },
                "required": ["action"]
            }
        }
    },
    # ── Service connections (API directes) ────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "service_connect",
            "description": (
                "Connecte ou met à jour un service externe (n8n, GitHub, Notion, Supabase, etc.). "
                "Utilise cet outil quand l'utilisateur donne une URL, clé API, ou token pour un service. "
                "Le service est sauvegardé dans la config et disponible immédiatement pour service_call. "
                "Actions: 'connect' (ajouter/mettre à jour), 'disconnect' (désactiver), 'list' (lister), 'test' (tester la connexion)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["connect", "disconnect", "list", "test"], "description": "Action à effectuer"},
                    "name": {"type": "string", "description": "Nom du service (n8n, github, notion, supabase, slack, discord, etc.)"},
                    "base_url": {"type": "string", "description": "URL de base du service (ex: http://localhost:5678)"},
                    "api_key": {"type": "string", "description": "Clé API ou token d'authentification"},
                    "token": {"type": "string", "description": "Token OAuth/bot (alternatif à api_key)"},
                    "extra": {"type": "object", "description": "Paramètres supplémentaires {clé: valeur}"},
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "service_call",
            "description": (
                "Exécute un appel API REST sur un service déjà connecté via service_connect. "
                "Utilise cet outil pour interagir avec les services configurés : lister des workflows n8n, "
                "créer un issue GitHub, récupérer des données Notion, etc. "
                "Le service doit être connecté et activé au préalable."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "service": {"type": "string", "description": "Nom du service connecté (n8n, github, notion, etc.)"},
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"], "description": "Méthode HTTP"},
                    "path": {"type": "string", "description": "Chemin API (ex: /api/v1/workflows). Ajouté après la base_url du service."},
                    "body": {"type": "object", "description": "Corps de la requête (pour POST/PUT/PATCH)"},
                    "params": {"type": "object", "description": "Query parameters"},
                },
                "required": ["service", "method", "path"]
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
    # Par défaut : outils web + KB + communication inter-agents
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
        # Inter-agent communication: sub-agents can delegate to other sub-agents
        "subagent_invoke", "subagent_list",
    }
    return [s for s in WOLF_TOOL_SCHEMAS if s["function"]["name"] in web_tool_names]


# Track active invocations to prevent infinite loops (A → B → A)
_active_invocations: set[str] = set()
_MAX_DELEGATION_DEPTH = 3  # Max chain: agent → sub1 → sub2 → sub3

async def _subagent_invoke(name: str, task: str) -> dict:
    from backend.core.agents.skills import subagent_library
    from backend.core.config.settings import Settings
    from backend.core.providers import get_provider
    from backend.core.providers.base import ChatMessage as CM
    from backend.core.agents.inter_agent_log import ConversationRecorder

    # Anti-loop: prevent recursive invocation
    if name in _active_invocations:
        return {"ok": False, "error": f"Boucle détectée : le sous-agent '{name}' est déjà en cours d'exécution. Évite les appels circulaires."}
    if len(_active_invocations) >= _MAX_DELEGATION_DEPTH:
        return {"ok": False, "error": f"Profondeur max de délégation atteinte ({_MAX_DELEGATION_DEPTH}). Résous la tâche toi-même."}

    agent = subagent_library.get_agent(name)
    if not agent:
        return {"ok": False, "error": f"Sous-agent '{name}' introuvable."}
    settings = Settings.load()
    provider_name = agent.provider or "openrouter"
    provider_meta = settings.providers.get(provider_name)

    # STRICT per-user: resolve the caller's own key via the wolf user context.
    # chat.py sets this before invoking a tool, so the sub-agent runs on the
    # caller's credits instead of falling back to a global fallback.
    _uid_sa = get_user_context() or 0
    _user_api_key = None
    _user_base_url = None
    if _uid_sa > 0:
        try:
            from backend.core.db.engine import async_session as _sa_sm
            from backend.core.api.auth_helpers import (
                get_user_settings as _sa_gus,
                get_user_provider_key as _sa_gpk,
            )
            async with _sa_sm() as _sa_s:
                _uset = await _sa_gus(_uid_sa, _sa_s)
                _decoded = _sa_gpk(_uset, provider_name)
                if _decoded and _decoded.get("api_key"):
                    _user_api_key = _decoded["api_key"]
                    _user_base_url = _decoded.get("base_url")
        except Exception as _e:
            print(f"[Wolf] Sub-agent key lookup failed for uid={_uid_sa}: {_e}")

    if not _user_api_key:
        return {"ok": False, "error": f"Provider '{provider_name}' non configuré pour cet utilisateur."}

    model = agent.model or (provider_meta.default_model if provider_meta else None)
    llm = get_provider(provider_name, _user_api_key, _user_base_url or (provider_meta.base_url if provider_meta else None))

    # Start recording this inter-agent conversation (context-aware: parent_id is set
    # automatically if we're inside another sub-agent invocation).
    _recorder = ConversationRecorder(callee=name, task=task, provider=agent.provider, model=model)
    _recorder.__enter__()

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
- **subagent_list** : Lister les autres sous-agents disponibles
- **subagent_invoke** : Déléguer une tâche à un autre sous-agent. Params: name (nom du sous-agent), task (la tâche à effectuer)
- **kb_write** / **kb_read** / **kb_list** : Base de connaissances partagée (tous les agents y ont accès)

## COLLABORATION INTER-AGENTS
- Tu peux **déléguer** une sous-tâche à un autre sous-agent si sa spécialité correspond mieux
- Tu peux **lire/écrire dans la KB** pour partager des résultats avec les autres agents
- Commence par `subagent_list` si tu as besoin de savoir qui est disponible
- Ne délègue que si c'est pertinent — si tu peux faire le travail toi-même, fais-le

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
    _recorder.record_messages(messages)

    _active_invocations.add(name)
    _tok_in_total = 0
    _tok_out_total = 0
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
            _tok_in_total += getattr(resp, "tokens_input", 0) or 0
            _tok_out_total += getattr(resp, "tokens_output", 0) or 0

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
                    _msg_a = CM(role="assistant", content="Je récupère les informations...")
                    _msg_u = CM(role="user", content=f"[SYSTÈME — CONTENU GATEWAY]\n\n{force_result['enriched_content']}\n\n---\nRéponds avec ce contenu.")
                    messages.append(_msg_a); messages.append(_msg_u)
                    _recorder.record_messages([_msg_a, _msg_u])
                    continue

            if not resp.tool_calls:
                _recorder.record_message("assistant", resp.content or "")
                _recorder.set_result(resp.content or "", _tok_in_total, _tok_out_total)
                return {"ok": True, "agent": name, "model": model, "result": resp.content, "conversation_id": _recorder.conv.id}

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
                _recorder.record_tool_event(tool_name, args, tool_result)

            if _is_text or not _native_mode:
                _msg_a = CM(role="assistant", content=resp.content or "Exécution...")
                parts = [f"**{r['tool']}** → {json.dumps(r['result'], ensure_ascii=False)[:6000]}" for r in all_results]
                _msg_u = CM(role="user", content="Résultats :\n\n" + "\n\n".join(parts) + "\n\nRéponds.")
                messages.append(_msg_a); messages.append(_msg_u)
                _recorder.record_messages([_msg_a, _msg_u])
            else:
                _msg_a = CM(role="assistant", content=resp.content or "", tool_calls=resp.tool_calls)
                messages.append(_msg_a)
                _recorder.record_messages([_msg_a])
                for r in all_results:
                    _msg_t = CM(role="tool", content=json.dumps(r["result"], ensure_ascii=False)[:3000], tool_call_id=r["call_id"])
                    messages.append(_msg_t)
                    _recorder.record_messages([_msg_t])
            _recorder.flush()

        resp = await llm.chat(messages, model)
        _tok_in_total += getattr(resp, "tokens_input", 0) or 0
        _tok_out_total += getattr(resp, "tokens_output", 0) or 0
        _recorder.record_message("assistant", resp.content or "")
        _recorder.set_result(resp.content or "", _tok_in_total, _tok_out_total)
        return {"ok": True, "agent": name, "model": model, "result": resp.content, "conversation_id": _recorder.conv.id}
    except Exception as ex:
        _recorder.conv.error = str(ex)
        return {"ok": False, "error": str(ex), "conversation_id": _recorder.conv.id}
    finally:
        _active_invocations.discard(name)
        try:
            _recorder.__exit__(None, None, None)
        except Exception:
            pass


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
    """Retourne un chemin sécurisé dans le répertoire KB per-user (pas de traversal)."""
    subdir_clean = Path(subdir).name  # empêche ../../../etc
    filename_clean = Path(filename).name
    base = _kb_dir()
    path = base / subdir_clean / filename_clean
    # S'assurer que le chemin résolu reste dans le répertoire KB de l'user
    if not str(path.resolve()).startswith(str(base.resolve())):
        raise ValueError("Chemin non autorisé.")
    return path


async def _kb_write(filename: str, content: str, subdir: str = "knowledge") -> dict:
    if not filename.endswith(".md"):
        filename = filename + ".md"
    path = _safe_path(subdir, filename)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return {"ok": True, "path": str(path), "message": f"Fichier '{filename}' sauvegardé dans la KB."}


async def _kb_read(filename: str, subdir: str = "knowledge") -> dict:
    if not filename.endswith(".md"):
        filename = filename + ".md"
    path = _safe_path(subdir, filename)
    if not path.exists():
        return {"ok": False, "error": f"Fichier '{filename}' introuvable dans la KB."}
    return {"ok": True, "content": path.read_text(encoding="utf-8")}


async def _kb_list(subdir: str = "knowledge") -> dict:
    subdir_clean = Path(subdir).name
    base = _kb_dir()
    directory = base / subdir_clean
    if not directory.exists():
        return {"files": []}
    files = [f.name for f in directory.iterdir() if f.is_file()]
    return {"files": files, "directory": str(directory)}


def _validate_browser_url(url: str) -> bool:
    """Only allow http/https URLs for browser navigation."""
    url_lower = url.lower().strip()
    allowed_schemes = ("http://", "https://")
    return url_lower.startswith(allowed_schemes)


async def _browser_navigate(url: str) -> dict:
    if not _validate_browser_url(url):
        return {"ok": False, "error": "URL scheme not allowed (only http/https)"}
    if _is_private_url(url):
        return {"ok": False, "error": "URL points to private/internal network (blocked for security)"}
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
    if _is_private_url(url):
        return {"ok": False, "error": "URL points to private/internal network (blocked for security)"}
    from backend.core.agents.tools.browser import browser_tool
    result = await browser_tool.crawl(url, max_pages=min(max_pages, 50), same_domain=same_domain)
    if result.get("success"):
        return {
            "ok": True,
            "pages_crawled": result.get("pages_crawled", 0),
            "results": result.get("results", []),
        }
    return {"ok": False, "error": result.get("error", "Erreur crawl")}


def _is_private_url(url: str) -> bool:
    """Block SSRF attempts to private/internal networks."""
    from urllib.parse import urlparse
    import ipaddress
    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    # Block obvious private hostnames
    if hostname in ("localhost", "127.0.0.1", "0.0.0.0", "::1"):
        return True
    if hostname.startswith("169.254."):  # AWS metadata
        return True
    if hostname.startswith("10.") or hostname.startswith("192.168."):
        return True
    if hostname.startswith("172."):
        try:
            second_octet = int(hostname.split(".")[1])
            if 16 <= second_octet <= 31:
                return True
        except (ValueError, IndexError):
            pass
    # Try resolving to check for DNS rebinding
    try:
        addr = ipaddress.ip_address(hostname)
        return addr.is_private or addr.is_loopback or addr.is_link_local
    except ValueError:
        # It's a hostname — resolve it to check the actual IP
        import socket
        try:
            resolved_ip = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
            for family, _, _, _, sockaddr in resolved_ip:
                ip_str = sockaddr[0]
                try:
                    addr = ipaddress.ip_address(ip_str)
                    if addr.is_private or addr.is_loopback or addr.is_link_local:
                        return True
                except ValueError:
                    continue
        except socket.gaierror:
            pass  # DNS resolution failed — allow (will fail at fetch anyway)
    return False


async def _web_fetch(url: str, extract: str = "text") -> dict:
    """Fetch léger — HTTP GET + extraction de contenu (pas besoin de Playwright)."""
    if _is_private_url(url):
        return {"ok": False, "error": "URL points to private/internal network (blocked for security)"}
    from backend.core.agents.tools.web_fetch import web_fetch
    return await web_fetch(url, extract=extract)


async def _web_crawl_lite(url: str, max_pages: int = 10, same_domain: bool = True) -> dict:
    """Crawl léger — suit les liens via HTTP (pas besoin de Playwright)."""
    if _is_private_url(url):
        return {"ok": False, "error": "URL points to private/internal network (blocked for security)"}
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
    if not _validate_browser_url(url):
        return {"ok": False, "error": "URL scheme not allowed (only http/https)"}
    if _is_private_url(url):
        return {"ok": False, "error": "URL interne bloquee (securite SSRF)"}
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
    _validate_browser_url(url)
    if _is_private_url(url):
        return {"ok": False, "error": "URL interne bloquee (securite SSRF)"}
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
    soul = _soul_path()
    if soul.exists():
        return {"ok": True, "content": soul.read_text(encoding="utf-8")}
    # Fallback: copy from global soul.md if it exists (first-time per-user)
    global_soul = DATA_DIR / "soul.md"
    if global_soul.exists():
        content = global_soul.read_text(encoding="utf-8")
        soul.parent.mkdir(parents=True, exist_ok=True)
        soul.write_text(content, encoding="utf-8")
        return {"ok": True, "content": content}
    return {"ok": False, "error": "soul.md introuvable."}


async def _soul_write(content: str, agent_name: str = None) -> dict:
    soul = _soul_path()
    soul.parent.mkdir(parents=True, exist_ok=True)
    soul.write_text(content, encoding="utf-8")

    # If agent_name is provided (or extractable), update the app settings
    _name = agent_name
    if not _name:
        # Try to extract name from first line pattern: "# Ame de XXX" or "Tu es **XXX**"
        import re
        m = re.search(r'#\s*(?:Ame|Âme|Soul)\s+de\s+(\w+)', content)
        if not m:
            m = re.search(r'Tu es \*\*(\w+)\*\*', content)
        if m:
            _name = m.group(1)

    if _name:
        try:
            from backend.core.config.settings import Settings
            settings = Settings.load()
            if settings.app.agent_name != _name:
                settings.app.agent_name = _name
                settings.save()
                return {"ok": True, "message": f"soul.md mis à jour et nom changé en '{_name}'. Prendra effet immédiatement."}
        except Exception:
            pass

    return {"ok": True, "message": "soul.md mis à jour. Prendra effet à la prochaine conversation."}


# ── Automata executors ────────────────────────────────────────────────────────
#
# Must stay in sync with backend/plugins/scheduler/routes.py and
# backend/plugins/scheduler/__init__.py — tasks live per-user at
# data/automata/{uid}/tasks.json so the UI and the background daemon
# (which scans that exact path glob) can see what the LLM creates.

def _user_automata_file() -> Path:
    """Per-user automata file. Uses the LLM's current user context."""
    uid = get_user_context() or 0
    p = DATA_DIR / "automata" / str(uid) / "tasks.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p

def _load_automata() -> dict:
    f = _user_automata_file()
    if f.exists():
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"tasks": [], "history": []}

def _save_automata(data: dict):
    f = _user_automata_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str), encoding="utf-8")

async def _schedule_task(
    name: str, description: str, prompt: str,
    task_type: str = "cron", cron_expression: str = None,
    interval_seconds: int = None, run_at: str = None
) -> dict:
    data = _load_automata()
    # Full UUID — the scheduler UI, the toggle endpoint, and the daemon
    # all match on the full id. Short ids would never line up.
    task_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    task = {
        "id": task_id,
        "name": name,
        "description": description,
        "prompt": prompt,
        "task_type": task_type,
        "cron_expression": cron_expression,
        "interval_seconds": interval_seconds,
        "run_at": run_at,
        "enabled": True,
        "created_at": now,
        "updated_at": now,
        "last_run": None,
        "run_count": 0,
        "last_status": None,
    }

    data.setdefault("tasks", []).append(task)
    data.setdefault("history", [])
    _save_automata(data)

    schedule_desc = cron_expression or (f"toutes les {interval_seconds}s" if interval_seconds else run_at or "non défini")
    return {
        "ok": True,
        "task_id": task_id,
        "message": f"Tâche '{name}' créée avec succès. Planning: {schedule_desc}. Visible dans le dashboard Automata.",
    }

async def _schedule_list() -> dict:
    data = _load_automata()
    tasks = data.get("tasks", [])
    if not tasks:
        return {"ok": True, "message": "Aucune tâche planifiée.", "tasks": []}
    summary = []
    for t in tasks:
        summary.append({
            "id": t["id"],
            "name": t["name"],
            "description": t.get("description", ""),
            "type": t.get("task_type"),
            "enabled": t.get("enabled", False),
            "schedule": t.get("cron_expression") or (f"{t.get('interval_seconds')}s" if t.get("interval_seconds") else t.get("run_at", "—")),
            "run_count": t.get("run_count", 0),
            "last_run": t.get("last_run"),
        })
    return {"ok": True, "tasks": summary, "total": len(summary)}

async def _schedule_delete(task_id: str) -> dict:
    data = _load_automata()
    tasks = data.get("tasks", [])
    removed_name = None
    for t in tasks:
        if t["id"] == task_id:
            removed_name = t["name"]
            break
    if removed_name is None:
        return {"ok": False, "error": f"Tâche '{task_id}' introuvable."}
    data["tasks"] = [t for t in tasks if t["id"] != task_id]
    _save_automata(data)
    return {"ok": True, "message": f"Tâche '{removed_name}' ({task_id}) supprimée."}


# ── Conversation tasks executors (todo-list façon Claude Code) ───────────────

_CONV_TASK_VALID_STATUSES = {"pending", "in_progress", "completed"}


async def _conversation_tasks_list() -> dict:
    conv_id = get_conversation_context()
    if conv_id is None:
        return {"ok": False, "error": "Pas de conversation courante — cet outil ne fonctionne que depuis un chat actif."}
    from backend.core.db.engine import async_session
    from backend.core.db.models import ConversationTask
    from sqlalchemy import select
    async with async_session() as session:
        result = await session.execute(
            select(ConversationTask)
            .where(ConversationTask.conversation_id == conv_id)
            .order_by(ConversationTask.position, ConversationTask.id)
        )
        tasks = result.scalars().all()
        return {
            "ok": True,
            "conversation_id": conv_id,
            "total": len(tasks),
            "tasks": [
                {
                    "id": t.id,
                    "content": t.content,
                    "active_form": t.active_form,
                    "status": t.status,
                    "position": t.position,
                    "created_by": t.created_by,
                }
                for t in tasks
            ],
        }


async def _conversation_tasks_set(tasks: list | None = None) -> dict:
    """Remplace l'intégralité de la todo-list de la conversation courante."""
    conv_id = get_conversation_context()
    if conv_id is None:
        return {"ok": False, "error": "Pas de conversation courante — cet outil ne fonctionne que depuis un chat actif."}
    if not isinstance(tasks, list):
        return {"ok": False, "error": "Le paramètre 'tasks' doit être une liste."}

    from backend.core.db.engine import async_session
    from backend.core.db.models import ConversationTask
    from sqlalchemy import delete as sql_delete

    async with async_session() as session:
        # Wipe
        await session.execute(
            sql_delete(ConversationTask).where(ConversationTask.conversation_id == conv_id)
        )
        # Insert
        inserted = []
        in_progress_count = 0
        for i, t in enumerate(tasks):
            if not isinstance(t, dict):
                continue
            content = (t.get("content") or "").strip()
            if not content:
                continue
            status = t.get("status", "pending")
            if status not in _CONV_TASK_VALID_STATUSES:
                status = "pending"
            if status == "in_progress":
                in_progress_count += 1
            row = ConversationTask(
                conversation_id=conv_id,
                content=content,
                active_form=(t.get("active_form") or "").strip() or None,
                status=status,
                position=i,
                created_by="agent",
            )
            session.add(row)
            inserted.append({"content": content, "status": status})
        await session.commit()

    warning = None
    if in_progress_count > 1:
        warning = f"Attention : {in_progress_count} tâches sont 'in_progress' alors qu'il devrait n'y en avoir qu'une seule."
    return {
        "ok": True,
        "conversation_id": conv_id,
        "total": len(inserted),
        "warning": warning,
        "message": f"Todo-list mise à jour ({len(inserted)} tâches).",
    }


# ── Filesystem & Shell executors ──────────────────────────────────────────────

# PROTECTED PATHS — l'agent ne peut JAMAIS y écrire/supprimer
PROTECTED_PATHS = {"backups", "data/backups", ".git"}
PROTECTED_PREFIXES = ("backups/", "data/backups/", ".git/")

# CORE INTEGRITY — fichiers essentiels au fonctionnement de Gungnir (écriture bloquée)
CORE_INTEGRITY_FILES = {
    "backend/core/main.py",
    "backend/core/api/router.py",
    "backend/core/api/users.py",
    "backend/core/db/engine.py",
    "backend/core/db/models.py",
    "backend/core/agents/security.py",
    "backend/core/config/settings.py",
}
CORE_INTEGRITY_PREFIXES = (".git/", "backups/", "data/backups/", ".claude/")

def _is_protected_path(path: str) -> bool:
    """Check if a path touches protected directories (backups, .git)."""
    normalized = path.replace("\\", "/").strip("/")
    if normalized in PROTECTED_PATHS:
        return True
    for prefix in PROTECTED_PREFIXES:
        if normalized.startswith(prefix):
            return True
    return False


def _is_core_integrity_file(path: str) -> bool:
    """Check if path is a core Gungnir file protected from agent writes."""
    normalized = path.replace("\\", "/").strip("/")
    if normalized in CORE_INTEGRITY_FILES:
        return True
    for prefix in CORE_INTEGRITY_PREFIXES:
        if normalized.startswith(prefix):
            return True
    return False

def _resolve_project_path(rel_path: str) -> Path:
    """Resolve a relative path to absolute, ensuring it stays within the project."""
    project_root = Path(__file__).parent.parent.parent.parent
    resolved = (project_root / rel_path).resolve()
    if not str(resolved).startswith(str(project_root.resolve())):
        raise ValueError(f"Chemin hors du projet interdit: {rel_path}")
    return resolved


async def _file_read(path: str, offset: int = 0, limit: int = 200) -> dict:
    try:
        full = _resolve_project_path(path)
        if not full.exists():
            return {"ok": False, "error": f"Fichier introuvable: {path}"}
        if full.is_dir():
            return {"ok": False, "error": f"C'est un dossier, utilise file_list: {path}"}
        text = full.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        selected = lines[offset:offset + limit]
        return {
            "ok": True,
            "path": path,
            "total_lines": len(lines),
            "offset": offset,
            "content": "\n".join(f"{offset + i + 1}: {l}" for i, l in enumerate(selected)),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _file_write(path: str, content: str) -> dict:
    if _is_protected_path(path):
        return {"ok": False, "error": f"INTERDIT: le chemin '{path}' est protégé (backups/système). Impossible de modifier."}
    if _is_core_integrity_file(path):
        return {"ok": False, "error": f"INTERDIT: '{path}' est un fichier système critique de Gungnir. Modification bloquée pour préserver l'intégrité."}
    try:
        full = _resolve_project_path(path)
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")
        lines = content.count("\n") + 1
        return {"ok": True, "path": path, "lines_written": lines, "message": f"Fichier '{path}' écrit ({lines} lignes)."}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _file_patch(path: str, old_text: str, new_text: str) -> dict:
    if _is_protected_path(path):
        return {"ok": False, "error": f"INTERDIT: le chemin '{path}' est protégé."}
    if _is_core_integrity_file(path):
        return {"ok": False, "error": f"INTERDIT: '{path}' est un fichier système critique de Gungnir."}
    try:
        full = _resolve_project_path(path)
        if not full.exists():
            return {"ok": False, "error": f"Fichier introuvable: {path}"}
        content = full.read_text(encoding="utf-8")
        count = content.count(old_text)
        if count == 0:
            return {"ok": False, "error": "Texte à remplacer introuvable dans le fichier."}
        if count > 1:
            return {"ok": False, "error": f"Texte trouvé {count} fois — doit être unique. Fournis plus de contexte."}
        new_content = content.replace(old_text, new_text, 1)
        full.write_text(new_content, encoding="utf-8")
        return {"ok": True, "path": path, "message": f"Patch appliqué dans '{path}'."}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _file_list(path: str = ".", pattern: str = "*", recursive: bool = False) -> dict:
    try:
        full = _resolve_project_path(path)
        if not full.exists():
            return {"ok": False, "error": f"Dossier introuvable: {path}"}
        if not full.is_dir():
            return {"ok": False, "error": f"Ce n'est pas un dossier: {path}"}

        entries = []
        glob_func = full.rglob if recursive else full.glob
        for p in sorted(glob_func(pattern))[:100]:  # Max 100 entries
            rel = p.relative_to(full)
            entries.append({
                "name": str(rel),
                "type": "dir" if p.is_dir() else "file",
                "size": p.stat().st_size if p.is_file() else None,
            })
        return {"ok": True, "path": path, "entries": entries, "count": len(entries)}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _bash_exec(command: str, timeout: int = 30, cwd: str = ".") -> dict:
    import asyncio as _asyncio

    # Block dangerous commands
    cmd_lower = command.lower().strip()
    import re as _re

    # 1. Destructive system commands (wide patterns)
    destructive_patterns = [
        r"rm\s+(-[a-z]*\s+)*(/|~|\$home)", r"del\s+/[sfq]",
        r"format\s+[a-z]:", r"mkfs", r"dd\s+if=",
        r"find\s+/\s+.*-delete", r"shred\s+", r"wipefs",
        r">\s*/dev/sd[a-z]", r"remove-item\s+.*-recurse.*-force.*/",
    ]
    for pat in destructive_patterns:
        if _re.search(pat, cmd_lower):
            return {"ok": False, "error": f"Commande bloquée: pattern destructif détecté"}

    # 2. Block any command that targets backups or .git
    protected_dirs = ["backups", ".git", ".claude"]
    for d in protected_dirs:
        if d in cmd_lower and any(w in cmd_lower for w in ["rm", "del", "move", "mv", "rename", "remove", "rmdir"]):
            return {"ok": False, "error": f"INTERDIT: impossible de modifier '{d}' via shell."}

    # 3. Block modification of core integrity files via shell
    for core_file in CORE_INTEGRITY_FILES:
        fname = core_file.split("/")[-1]
        if fname in cmd_lower and any(w in cmd_lower for w in ["rm", "del", "> ", "move", "mv", "rename", "remove"]):
            return {"ok": False, "error": f"INTERDIT: '{core_file}' est protégé. Modification via shell bloquée."}

    try:
        project_root = Path(__file__).parent.parent.parent.parent
        work_dir = (project_root / cwd).resolve()

        proc = await _asyncio.create_subprocess_exec(
            "cmd", "/c", command,
            stdout=_asyncio.subprocess.PIPE,
            stderr=_asyncio.subprocess.PIPE,
            cwd=str(work_dir),
        )
        try:
            stdout, stderr = await _asyncio.wait_for(proc.communicate(), timeout=timeout)
        except _asyncio.TimeoutError:
            proc.kill()
            return {"ok": False, "error": f"Timeout après {timeout}s", "command": command}

        out = stdout.decode("utf-8", errors="replace")[:5000]
        err = stderr.decode("utf-8", errors="replace")[:2000]

        return {
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "stdout": out,
            "stderr": err if err else None,
            "command": command,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


# ── Channel management ───────────────────────────────────────────────────────

async def _channel_manage(action: str, channel_type: str = None, channel_id: str = None,
                          name: str = None, config: dict = None, enabled: bool = None) -> dict:
    """Manage communication channels via internal API."""
    import httpx
    base = "http://127.0.0.1:8000/api/plugins/channels"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            if action == "catalog":
                r = await client.get(f"{base}/catalog")
                data = r.json()
                # Include setup_guide + required fields so agent can guide the user
                return {"ok": True, "types": list(data.get("channels", {}).keys()),
                        "details": {k: {"name": v["display_name"], "complexity": v.get("complexity", ""),
                                        "description": v["description"][:150],
                                        "required_fields": [f["key"] for f in v.get("fields", []) if f.get("required")],
                                        "all_fields": [f["key"] for f in v.get("fields", [])],
                                        "setup_guide": v.get("setup_guide", "")}
                                    for k, v in data.get("channels", {}).items()}}

            elif action == "list":
                r = await client.get(f"{base}/list")
                channels = r.json().get("channels", [])
                return {"ok": True, "count": len(channels),
                        "channels": [{"id": c["id"], "type": c.get("type"), "name": c.get("name"),
                                      "enabled": c.get("enabled", False)} for c in channels]}

            elif action == "create":
                if not channel_type or not name:
                    return {"ok": False, "error": "channel_type et name requis pour create"}
                import uuid as _uuid
                payload = {"id": str(_uuid.uuid4())[:8], "type": channel_type, "name": name,
                           "config": config or {}, "enabled": enabled if enabled is not None else False}
                r = await client.post(f"{base}/create", json=payload)
                result = r.json()
                if result.get("ok"):
                    ch = result.get("channel", {})
                    return {"ok": True, "channel_id": ch.get("id"), "type": channel_type, "name": name,
                            "message": f"Canal '{name}' créé. Configure le token/clé puis active-le."}
                return {"ok": False, "error": result.get("detail", "Erreur création")}

            elif action == "update":
                if not channel_id:
                    return {"ok": False, "error": "channel_id requis pour update"}
                payload = {}
                if name: payload["name"] = name
                if enabled is not None: payload["enabled"] = enabled
                if config: payload["config"] = config
                r = await client.put(f"{base}/{channel_id}", json=payload)
                result = r.json()
                webhook_info = result.get("webhook")
                msg = "Canal mis à jour."
                if webhook_info and webhook_info.get("ok"):
                    msg += f" Webhook enregistré: {webhook_info.get('webhook_url', '')}"
                elif webhook_info and not webhook_info.get("ok"):
                    msg += f" Webhook erreur: {webhook_info.get('error', '')}"
                return {"ok": result.get("ok", True), "message": msg, "webhook": webhook_info}

            elif action == "toggle":
                if not channel_id:
                    return {"ok": False, "error": "channel_id requis pour toggle"}
                r = await client.post(f"{base}/{channel_id}/toggle")
                result = r.json()
                return {"ok": True, "enabled": result.get("enabled"),
                        "webhook": result.get("webhook"),
                        "message": f"Canal {'activé' if result.get('enabled') else 'désactivé'}"}

            elif action == "delete":
                if not channel_id:
                    return {"ok": False, "error": "channel_id requis pour delete"}
                r = await client.delete(f"{base}/{channel_id}")
                return {"ok": True, "message": "Canal supprimé"}

            elif action == "test":
                if not channel_id:
                    return {"ok": False, "error": "channel_id requis pour test"}
                r = await client.post(f"{base}/{channel_id}/test")
                return r.json()

            elif action == "oauth_url":
                if not channel_id or not channel_type:
                    return {"ok": False, "error": "channel_id et channel_type requis pour oauth_url"}
                if channel_type not in ("slack", "discord"):
                    return {"ok": False, "error": f"OAuth non supporté pour {channel_type}. Seuls Slack et Discord supportent OAuth."}
                r = await client.get(f"{base}/oauth/{channel_type}/start/{channel_id}")
                if r.status_code == 200:
                    data = r.json()
                    return {"ok": True, "oauth_url": data.get("oauth_url", ""),
                            "message": f"Lien OAuth généré. Envoie ce lien à l'utilisateur pour qu'il autorise l'app. "
                                       f"Une fois qu'il clique et autorise, le canal sera automatiquement configuré et activé."}
                return {"ok": False, "error": r.text[:300]}

            else:
                return {"ok": False, "error": f"Action inconnue: {action}. Actions: list, catalog, create, update, toggle, delete, test, oauth_url"}

    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


# ── Provider API key management ──────────────────────────────────────────────

async def _provider_manage(action: str, provider: str = None, api_key: str = None,
                           base_url: str = None, model: str = None, enabled: bool = True) -> dict:
    """Manage LLM provider API keys and switch active model."""
    import httpx
    base = "http://127.0.0.1:8000/api/config"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            if action == "list":
                r = await client.get(f"{base}")
                data = r.json()
                providers = data.get("providers", {})
                return {"ok": True, "providers": {
                    name: {"enabled": p["enabled"], "has_key": p["has_api_key"],
                           "default_model": p.get("default_model", ""),
                           "models": p.get("models", [])}
                    for name, p in providers.items()
                }}

            elif action == "save":
                if not provider or not api_key:
                    return {"ok": False, "error": "provider et api_key requis pour save"}
                payload = {"api_key": api_key, "enabled": enabled}
                if base_url:
                    payload["base_url"] = base_url
                r = await client.post(f"{base}/user/providers/{provider}",
                                      json=payload, headers={"Content-Type": "application/json"})
                if r.status_code == 200:
                    return {"ok": True, "message": f"Clé API {provider} sauvegardée et activée."}
                return {"ok": False, "error": r.text[:200]}

            elif action == "delete":
                if not provider:
                    return {"ok": False, "error": "provider requis pour delete"}
                r = await client.delete(f"{base}/user/providers/{provider}")
                return {"ok": True, "message": f"Provider {provider} supprimé."}

            elif action == "switch":
                if not provider:
                    return {"ok": False, "error": "provider requis pour switch"}
                # Verify the provider is configured
                r = await client.get(f"{base}")
                data = r.json()
                prov_info = data.get("providers", {}).get(provider)
                if not prov_info:
                    return {"ok": False, "error": f"Provider '{provider}' introuvable."}
                if not prov_info.get("has_api_key") and not prov_info.get("enabled"):
                    return {"ok": False, "error": f"Provider '{provider}' n'a pas de clé API configurée."}
                # Resolve model
                target_model = model or prov_info.get("default_model", "")
                if not target_model and prov_info.get("models"):
                    target_model = prov_info["models"][0]
                # Save to user app settings
                payload = {"active_provider": provider, "active_model": target_model}
                r = await client.post(f"{base}/user/app", json=payload,
                                      headers={"Content-Type": "application/json"})
                if r.status_code == 200:
                    return {"ok": True, "switched": True,
                            "provider": provider, "model": target_model,
                            "message": f"Modèle changé : {provider} / {target_model}. Le prochain message utilisera ce modèle."}
                return {"ok": False, "error": r.text[:200]}

            else:
                return {"ok": False, "error": f"Action inconnue: {action}. Actions: list, save, delete, switch"}

    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


# ── MCP server management ────────────────────────────────────────────────────

async def _mcp_manage(action: str, name: str = None, command: str = None,
                      args: list = None, env: dict = None, enabled: bool = True) -> dict:
    """Manage MCP servers."""
    import httpx
    base = "http://127.0.0.1:8000/api/mcp/servers"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            if action == "list":
                r = await client.get(base)
                data = r.json()
                servers = data.get("servers", [])
                status = data.get("status", [])
                return {"ok": True, "count": len(servers),
                        "servers": [{"name": s.get("name"), "command": s.get("command"),
                                     "enabled": s.get("enabled", False)} for s in servers],
                        "status": status}

            elif action == "add":
                if not name or not command:
                    return {"ok": False, "error": "name et command requis pour add"}
                payload = {"name": name, "command": command,
                           "args": args or [], "env": env or {}, "enabled": enabled}
                r = await client.post(base, json=payload, headers={"Content-Type": "application/json"})
                result = r.json()
                if result.get("ok"):
                    tools = result.get("tools_discovered", 0)
                    return {"ok": True, "message": f"Serveur MCP '{name}' ajouté. {tools} outils découverts."}
                return {"ok": False, "error": result.get("error", r.text[:200])}

            elif action == "delete":
                if not name:
                    return {"ok": False, "error": "name requis pour delete"}
                r = await client.delete(f"{base}/{name}")
                return {"ok": True, "message": f"Serveur MCP '{name}' supprimé."}

            else:
                return {"ok": False, "error": f"Action inconnue: {action}. Actions: list, add, delete"}

    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


# ── Service connections (API directes) ────────────────────────────────────────

# Auth header patterns per service type
_SERVICE_AUTH_HEADERS = {
    "n8n":       lambda key: {"X-N8N-API-KEY": key},
    "github":    lambda key: {"Authorization": f"token {key}"},
    "gitlab":    lambda key: {"PRIVATE-TOKEN": key},
    "notion":    lambda key: {"Authorization": f"Bearer {key}", "Notion-Version": "2022-06-28"},
    "supabase":  lambda key: {"apikey": key, "Authorization": f"Bearer {key}"},
    "linear":    lambda key: {"Authorization": key},
    "slack":     lambda key: {"Authorization": f"Bearer {key}"},
    "discord":   lambda key: {"Authorization": f"Bot {key}"},
}

# Test endpoints per service type (GET these to verify connection)
_SERVICE_TEST_ENDPOINTS = {
    "n8n":       "/api/v1/workflows?limit=1",
    "github":    "/user",
    "gitlab":    "/api/v4/user",
    "notion":    "/v1/users/me",
    "supabase":  "/rest/v1/",
    "linear":    "/api/graphql",
    "slack":     "/api/auth.test",
}


async def _user_service_entry(service_name: str) -> tuple[dict, int]:
    """Load the current wolf-user's entry for a given service. Returns
    (entry_dict, user_id). entry_dict is empty if nothing is set."""
    from backend.core.db.engine import async_session as _svc_sm
    from backend.core.api.auth_helpers import get_user_settings as _svc_gus, get_user_service_key as _svc_gsk

    uid = get_user_context() or 0
    if uid <= 0:
        return {}, 0
    try:
        async with _svc_sm() as _s:
            us = await _svc_gus(uid, _s)
            decoded = _svc_gsk(us, service_name) or {}
            return decoded, uid
    except Exception as _e:
        print(f"[Wolf] service entry lookup failed uid={uid} name={service_name}: {_e}")
        return {}, uid


async def _persist_user_service_entry(user_id: int, service_name: str, update: dict) -> None:
    """Merge `update` into the user's service_keys[service_name] and persist.
    Secrets in `update` must already be plaintext — they are re-encrypted here."""
    from backend.core.db.engine import async_session as _svc_sm
    from backend.core.api.auth_helpers import get_user_settings as _svc_gus
    from backend.core.config.settings import encrypt_value as _enc
    from sqlalchemy.orm.attributes import flag_modified as _fm

    async with _svc_sm() as _s:
        us = await _svc_gus(user_id, _s)
        svc_keys = dict(us.service_keys or {})
        entry = dict(svc_keys.get(service_name) or {})
        for k, v in update.items():
            if k in ("api_key", "token") and isinstance(v, str) and v and not v.startswith(("FERNET:", "enc:")):
                entry[k] = _enc(v)
            else:
                entry[k] = v
        svc_keys[service_name] = entry
        us.service_keys = svc_keys
        _fm(us, "service_keys")
        await _s.commit()


async def _service_connect(action: str, name: str = None, base_url: str = None,
                           api_key: str = None, token: str = None, extra: dict = None) -> dict:
    """Connect, disconnect, list, or test the CURRENT user's external services.

    Reads/writes the caller's UserSettings.service_keys — the legacy global
    settings.services store is only consulted for catalog metadata (labels,
    default base_url) and never for secrets.
    """
    from backend.core.config.settings import Settings

    try:
        settings = Settings.load()
        uid = get_user_context() or 0
        if uid <= 0:
            return {"ok": False, "error": "Authentification requise pour utiliser les services."}

        if action == "list":
            entry_map, _ = await _user_service_entry("__all__")  # placeholder, we need the whole dict
            # Fetch the raw dict directly so we can iterate over every service the user owns
            from backend.core.db.engine import async_session as _sm_list
            from backend.core.api.auth_helpers import get_user_settings as _gus_list
            async with _sm_list() as _s:
                us = await _gus_list(uid, _s)
                user_entries = us.service_keys or {}

            result = []
            for sname in {**(settings.services or {}), **user_entries}.keys():
                user_entry = user_entries.get(sname) or {}
                meta = settings.services.get(sname)
                base = user_entry.get("base_url") or (meta.base_url if meta else "")
                has_auth = bool(user_entry.get("api_key") or user_entry.get("token"))
                result.append({
                    "name": sname,
                    "enabled": bool(user_entry.get("enabled")),
                    "base_url": base or "",
                    "has_auth": has_auth,
                })
            return {"ok": True, "services": result, "count": len(result)}

        if not name:
            return {"ok": False, "error": "Le nom du service est requis."}

        if action == "connect":
            if not base_url and not api_key and not token:
                return {"ok": False, "error": "Au moins base_url ou api_key/token est requis."}

            update: dict = {"enabled": True}
            if base_url:
                update["base_url"] = base_url.rstrip("/")
            if api_key:
                update["api_key"] = api_key.strip()
            if token:
                update["token"] = token.strip()
            if extra:
                entry, _ = await _user_service_entry(name)
                merged_extra = dict(entry.get("extra") or {})
                merged_extra.update(extra)
                update["extra"] = merged_extra

            await _persist_user_service_entry(uid, name, update)
            return {
                "ok": True,
                "message": f"Service '{name}' connecté et activé pour cet utilisateur.",
                "service": name,
                "base_url": update.get("base_url"),
            }

        elif action == "disconnect":
            entry, _ = await _user_service_entry(name)
            if not entry:
                return {"ok": False, "error": f"Service '{name}' introuvable pour cet utilisateur."}
            await _persist_user_service_entry(uid, name, {"enabled": False})
            return {"ok": True, "message": f"Service '{name}' désactivé."}

        elif action == "test":
            entry, _ = await _user_service_entry(name)
            if not entry or not entry.get("enabled"):
                return {"ok": False, "error": f"Service '{name}' non connecté ou désactivé."}
            meta = settings.services.get(name)
            url_base = entry.get("base_url") or (meta.base_url if meta else None)
            if not url_base:
                return {"ok": False, "error": f"Service '{name}' n'a pas de base_url configurée."}

            key = entry.get("api_key") or entry.get("token") or ""
            auth_fn = _SERVICE_AUTH_HEADERS.get(name, lambda k: {"Authorization": f"Bearer {k}"})
            headers = auth_fn(key) if key else {}
            test_path = _SERVICE_TEST_ENDPOINTS.get(name, "/")
            url = f"{url_base}{test_path}"

            import httpx
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.get(url, headers=headers)
                if r.status_code < 400:
                    return {"ok": True, "message": f"Connexion à '{name}' réussie.",
                            "status": r.status_code, "url": url_base}
                else:
                    return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}

        else:
            return {"ok": False, "error": f"Action inconnue: {action}. Actions: connect, disconnect, list, test"}

    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


# Blocked URL patterns for service_call
_BLOCKED_URL_PATTERNS = [
    "169.254.169.254",  # Cloud metadata
    "metadata.google",
    "/etc/", "/proc/", "/sys/",
]

async def _service_call(service: str, method: str, path: str,
                        body: dict = None, params: dict = None) -> dict:
    """Execute a REST API call on a connected service using the CURRENT user's credentials."""
    from backend.core.config.settings import Settings
    import httpx

    try:
        settings = Settings.load()
        entry, uid = await _user_service_entry(service)
        if uid <= 0:
            return {"ok": False, "error": "Authentification requise pour appeler un service."}
        if not entry:
            return {"ok": False, "error": f"Service '{service}' non configuré pour cet utilisateur. Utilise service_connect pour l'ajouter."}
        if not entry.get("enabled"):
            return {"ok": False, "error": f"Service '{service}' désactivé pour cet utilisateur. Utilise service_connect(action='connect') d'abord."}

        meta = settings.services.get(service)
        base = entry.get("base_url") or (meta.base_url if meta else None)
        if not base:
            return {"ok": False, "error": f"Service '{service}' n'a pas de base_url. Utilise service_connect pour la configurer."}

        # Security: block metadata/internal URLs
        full_url = f"{base}{path}"
        for blocked in _BLOCKED_URL_PATTERNS:
            if blocked in full_url.lower():
                return {"ok": False, "error": f"URL bloquée pour raison de sécurité."}

        # Build auth headers from the user's own credentials
        key = entry.get("api_key") or entry.get("token") or ""
        auth_fn = _SERVICE_AUTH_HEADERS.get(service, lambda k: {"Authorization": f"Bearer {k}"})
        headers = auth_fn(key) if key else {}
        headers["Content-Type"] = "application/json"

        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.request(
                method=method.upper(),
                url=full_url,
                headers=headers,
                json=body if body and method.upper() in ("POST", "PUT", "PATCH") else None,
                params=params,
            )

            # Parse response
            try:
                data = r.json()
            except Exception:
                data = r.text[:2000]

            if r.status_code < 400:
                # Truncate large responses
                import json as _json
                text = _json.dumps(data, ensure_ascii=False) if isinstance(data, (dict, list)) else str(data)
                if len(text) > 4000:
                    text = text[:4000] + "\n... (tronqué)"
                return {"ok": True, "status": r.status_code, "data": data if len(str(data)) < 4000 else text}
            else:
                return {"ok": False, "status": r.status_code, "error": str(data)[:500]}

    except httpx.TimeoutException:
        return {"ok": False, "error": f"Timeout sur {service} ({method} {path})"}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


# ── Doctor (auto-diagnostic) ─────────────────────────────────────────────────

async def _doctor_check(scope: str = "full") -> dict:
    results = {"ok": True, "checks": [], "warnings": [], "errors": []}
    project_root = Path(__file__).parent.parent.parent.parent

    def add_check(name: str, status: str, detail: str = ""):
        entry = {"name": name, "status": status, "detail": detail}
        results["checks"].append(entry)
        if status == "warning":
            results["warnings"].append(f"{name}: {detail}")
        elif status == "error":
            results["errors"].append(f"{name}: {detail}")
            results["ok"] = False

    # ── Config
    if scope in ("full", "config"):
        try:
            from backend.core.config.settings import Settings
            settings = Settings.load()
            add_check("Config chargée", "ok", "config.json trouvé")

            # Per-user: resolve the caller's provider keys from the wolf context,
            # not the now-empty global config.
            _uid_doc = get_user_context() or 0
            _user_providers: list[str] = []
            if _uid_doc > 0:
                try:
                    from backend.core.db.engine import async_session as _doc_sm
                    from backend.core.api.auth_helpers import (
                        get_user_settings as _doc_gus,
                        get_user_provider_key as _doc_gpk,
                    )
                    async with _doc_sm() as _doc_s:
                        _uset_doc = await _doc_gus(_uid_doc, _doc_s)
                        for pname in (_uset_doc.provider_keys or {}).keys():
                            decoded = _doc_gpk(_uset_doc, pname)
                            if decoded and decoded.get("api_key"):
                                _user_providers.append(pname)
                except Exception as _de:
                    print(f"[Wolf] Doctor user provider lookup failed: {_de}")

            if _user_providers:
                add_check("Providers LLM", "ok", f"{len(_user_providers)} actifs: {', '.join(_user_providers)}")
            else:
                add_check("Providers LLM", "warning", "Aucun provider LLM configuré pour cet utilisateur")

            enabled_services = [n for n, s in settings.services.items() if s.enabled]
            add_check("Services", "ok" if enabled_services else "info", f"{len(enabled_services)} services activés")
        except Exception as e:
            add_check("Config", "error", str(e)[:200])

    # ── Plugins
    if scope in ("full", "plugins"):
        plugins_dir = project_root / "backend" / "plugins"
        if plugins_dir.exists():
            for pdir in sorted(plugins_dir.iterdir()):
                manifest = pdir / "manifest.json"
                routes = pdir / "routes.py"
                if manifest.exists():
                    try:
                        import json as _json
                        m = _json.loads(manifest.read_text())
                        has_routes = routes.exists()
                        # Check frontend: source (dev) OR built dist/ (prod/Docker)
                        has_frontend_src = (project_root / "frontend" / "src" / "plugins" / pdir.name / "index.tsx").exists()
                        has_frontend_dist = (project_root / "frontend" / "dist" / "index.html").exists()
                        has_frontend = has_frontend_src or has_frontend_dist
                        status = "ok" if has_routes and has_frontend else "warning"
                        detail = f"v{m.get('version', '?')}"
                        if not has_routes: detail += " [routes.py manquant]"
                        if not has_frontend: detail += " [frontend manquant]"
                        add_check(f"Plugin: {m.get('display_name', pdir.name)}", status, detail)
                    except Exception as e:
                        add_check(f"Plugin: {pdir.name}", "error", str(e)[:100])

    # ── Dependencies
    if scope in ("full", "dependencies"):
        import shutil as _shutil
        for pkg in ["fastapi", "uvicorn", "httpx", "pydantic", "websockets"]:
            try:
                __import__(pkg)
                add_check(f"Python: {pkg}", "ok")
            except ImportError:
                add_check(f"Python: {pkg}", "error", "Non installé")
        if _shutil.which("npx"):
            add_check("Node.js: npx", "ok")
        else:
            add_check("Node.js: npx", "warning", "npx non trouvé — MCP servers ne pourront pas démarrer")

    # ── MCP (scoped to the current user)
    if scope in ("full", "mcp"):
        try:
            from backend.core.agents.mcp_client import mcp_manager
            _uid = get_user_context() or 0
            status_list = mcp_manager.get_user_server_status(_uid)
            if status_list:
                total_tools = sum(s.get("tools", 0) for s in status_list)
                add_check("MCP Servers", "ok", f"{len(status_list)} serveurs, {total_tools} outils")
            else:
                add_check("MCP Servers", "info", "Aucun serveur MCP actif")
        except Exception as e:
            add_check("MCP", "error", str(e)[:200])

    # ── Backup
    if scope in ("full", "backup"):
        backups_dir = project_root / "data" / "backups"
        if backups_dir.exists():
            backup_files = list(backups_dir.rglob("*.zip"))
            add_check("Backup système", "ok", f"{len(backup_files)} backups trouvés")
            if backup_files:
                latest = max(backup_files, key=lambda f: f.stat().st_mtime)
                from datetime import datetime as _dt
                age_hours = (_dt.now().timestamp() - latest.stat().st_mtime) / 3600
                if age_hours > 48:
                    add_check("Dernier backup", "warning", f"Il y a {age_hours:.0f}h — pensez à faire un backup")
                else:
                    add_check("Dernier backup", "ok", f"Il y a {age_hours:.1f}h: {latest.name}")
        else:
            add_check("Backup système", "warning", "Aucun backup trouvé")

    # ── Database
    if scope in ("full", "config"):
        from backend.core.db.engine import DATABASE_URL
        if DATABASE_URL and "postgresql" in DATABASE_URL:
            # PostgreSQL — test actual connectivity
            try:
                from backend.core.db.engine import async_session
                async with async_session() as session:
                    result = await session.execute(__import__('sqlalchemy').text("SELECT 1"))
                    result.scalar()
                add_check("Base de données", "ok", "PostgreSQL connecté")
            except Exception as e:
                add_check("Base de données", "error", f"PostgreSQL inaccessible: {str(e)[:100]}")
        else:
            # SQLite fallback
            db_path = project_root / "data" / "gungnir.db"
            if db_path.exists():
                size_mb = db_path.stat().st_size / (1024 * 1024)
                add_check("Base de données", "ok", f"gungnir.db — {size_mb:.1f} Mo")
            else:
                add_check("Base de données", "warning", "gungnir.db introuvable")

    # Summary
    total = len(results["checks"])
    ok_count = sum(1 for c in results["checks"] if c["status"] == "ok")
    results["summary"] = f"{ok_count}/{total} checks OK, {len(results['warnings'])} avertissements, {len(results['errors'])} erreurs"
    return results


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
    # Automata
    "schedule_task":              _schedule_task,
    "schedule_list":              _schedule_list,
    "schedule_delete":            _schedule_delete,
    # Conversation tasks (todo-list)
    "conversation_tasks_list":    _conversation_tasks_list,
    "conversation_tasks_set":     _conversation_tasks_set,
    # Filesystem & Shell (auto-modification)
    "file_read":                  _file_read,
    "file_write":                 _file_write,
    "file_patch":                 _file_patch,
    "file_list":                  _file_list,
    "bash_exec":                  _bash_exec,
    # Doctor
    "doctor_check":               _doctor_check,
    # Setup wizard tools
    "channel_manage":             _channel_manage,
    "provider_manage":            _provider_manage,
    "mcp_manage":                 _mcp_manage,
    # Service connections (API directes)
    "service_connect":            _service_connect,
    "service_call":               _service_call,
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
    # Lecture seule filesystem + doctor + setup
    "file_read", "file_list", "doctor_check",
    # Lecture todo-list
    "conversation_tasks_list",
    "channel_manage", "provider_manage", "mcp_manage",
    # service_connect est read-only pour list/test, service_call est lecture
    "service_connect", "service_call",
}
