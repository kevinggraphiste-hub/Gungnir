"""
Forge — templates de workflows pré-construits.

Petite bibliothèque de starters inspirés des cas d'usage les plus
courants (digest quotidien, triage, suivi, veille, traduction, chat
LLM en boucle). L'user clique sur un template, on crée un workflow
copié dans son espace, qu'il peut ensuite éditer.

Pas de marketplace dynamique en MVP — c'est statique en code. Si la
demande monte, on bascule vers une DB de templates avec partage
communautaire.
"""
from __future__ import annotations

from typing import Any


TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "daily_news_digest",
        "name": "Digest news quotidien",
        "category": "Veille",
        "description": "Fetch 3 sources d'actualité, résume avec un LLM, sauvegarde le digest dans la KB.",
        "tags": ["veille", "llm", "kb"],
        "trigger_hint": "Idéal avec un cron à 8h du matin.",
        "yaml": """\
name: Digest news quotidien
description: Fetch 3 sources puis résumé LLM dans la KB.

inputs:
  sources:
    type: array
    default:
      - https://news.ycombinator.com
      - https://www.lemonde.fr/rss/une.xml
      - https://www.reddit.com/r/MachineLearning/.json

steps:
  - id: fetch_hn
    tool: web_fetch
    args: { url: "{{ inputs.sources.0 }}", max_chars: 3000 }
  - id: fetch_lemonde
    tool: web_fetch
    args: { url: "{{ inputs.sources.1 }}", max_chars: 3000 }
  - id: fetch_reddit
    tool: web_fetch
    args: { url: "{{ inputs.sources.2 }}", max_chars: 3000 }
  - id: summarize
    tool: llm_call
    args:
      system: "Tu produis un digest quotidien concis (8 puces max) en français."
      prompt: "Voici 3 sources :\\n\\n[HN]\\n{{ steps.fetch_hn.text }}\\n\\n[LeMonde]\\n{{ steps.fetch_lemonde.text }}\\n\\n[Reddit ML]\\n{{ steps.fetch_reddit.text }}\\n\\nFais-moi un digest."
      max_tokens: 800
  - id: save
    tool: kb_write
    args:
      path: "digests/news.md"
      content: "{{ steps.summarize.text }}"
""",
    },
    {
        "id": "triage_github_issue",
        "name": "Triage automatique d'une GitHub issue",
        "category": "Dev",
        "description": "Webhook GitHub → classifie en bug/feature/question via LLM → crée carte Valkyrie + notif Slack.",
        "tags": ["webhook", "llm", "valkyrie"],
        "trigger_hint": "Configure un webhook GitHub vers ce workflow.",
        "yaml": """\
name: Triage GitHub issue
description: Webhook → classification LLM → carte Valkyrie + Slack.

steps:
  - id: classify
    tool: llm_classify
    args:
      text: "{{ body.issue.title }}\\n\\n{{ body.issue.body }}"
      categories: [bug, feature, question, doc]
      instruction: "Quel type d'issue est-ce ?"
  - id: create_card
    tool: valkyrie_create_card
    args:
      project_id: 1
      title: "[{{ steps.classify.category }}] {{ body.issue.title }}"
      description: "{{ body.issue.body }}"
      tags: ["{{ steps.classify.category }}", "github"]
""",
    },
    {
        "id": "valkyrie_daily_overdue",
        "name": "Rappel quotidien des tâches en retard",
        "category": "Productivité",
        "description": "Cron 9h → liste les cartes Valkyrie overdue → résume → écrit dans la KB du jour.",
        "tags": ["cron", "valkyrie", "llm", "kb"],
        "trigger_hint": "Configure un cron `0 9 * * *`.",
        "yaml": """\
name: Rappel tâches en retard
description: Liste cartes overdue + résumé LLM dans la KB.

steps:
  - id: get_reminders
    tool: valkyrie_get_reminders
    args: {}
  - id: summarize
    tool: llm_call
    args:
      system: "Tu produis un rappel motivant en 5 lignes max, ton bienveillant."
      prompt: "Cartes en retard :\\n{{ steps.get_reminders.overdue }}\\n\\nCartes du jour :\\n{{ steps.get_reminders.today }}\\n\\nDonne-moi un rappel matinal."
      max_tokens: 400
  - id: save
    tool: kb_write
    args:
      path: "daily/reminders.md"
      content: "{{ steps.summarize.text }}"
""",
    },
    {
        "id": "rss_to_kb",
        "name": "Veille RSS → KB",
        "category": "Veille",
        "description": "Fetch un flux RSS, extrait les titres + liens en JSON, sauvegarde dans la KB.",
        "tags": ["rss", "llm", "kb"],
        "trigger_hint": "Cron horaire ou bouton manuel.",
        "yaml": """\
name: Veille RSS → KB
description: Fetch RSS + extraction LLM + écriture KB.

inputs:
  feed_url:
    type: string
    default: https://hnrss.org/frontpage

steps:
  - id: fetch
    tool: web_fetch
    args: { url: "{{ inputs.feed_url }}", max_chars: 8000 }
  - id: extract
    tool: llm_extract
    args:
      text: "{{ steps.fetch.text }}"
      instruction: "Extrait les 10 derniers items au format [{title, link, summary}]"
      schema_hint: '[{"title":"...","link":"https://...","summary":"..."}]'
  - id: save
    tool: kb_write
    args:
      path: "veille/rss.json"
      content: "{{ steps.extract.raw }}"
""",
    },
    {
        "id": "translate_doc",
        "name": "Traducteur de fichier",
        "category": "Texte",
        "description": "Lit un fichier de la KB, le traduit via LLM, écrit la version traduite à côté.",
        "tags": ["llm", "kb"],
        "trigger_hint": "Run manuel avec `inputs.path` et `inputs.target_lang`.",
        "yaml": """\
name: Traducteur fichier KB
description: Lit un fichier, traduit, écrit la version traduite.

inputs:
  path:
    type: string
    default: notes/exemple.md
  target_lang:
    type: string
    default: anglais

steps:
  - id: read
    tool: kb_read
    args: { path: "{{ inputs.path }}" }
  - id: translate
    tool: llm_call
    args:
      system: "Tu traduis fidèlement, sans commenter. Garde le format markdown."
      prompt: "Traduis ce texte en {{ inputs.target_lang }} :\\n\\n{{ steps.read.content }}"
      max_tokens: 4000
  - id: save
    tool: kb_write
    args:
      path: "{{ inputs.path }}.{{ inputs.target_lang }}.md"
      content: "{{ steps.translate.text }}"
""",
    },
    {
        "id": "agent_chain",
        "name": "Chaîne d'agents (researcher → writer)",
        "category": "IA",
        "description": "Délègue à 2 sous-agents en cascade : recherche puis rédaction.",
        "tags": ["subagent", "llm"],
        "trigger_hint": "Run manuel avec `inputs.topic`.",
        "yaml": """\
name: Researcher → Writer
description: Recherche par un sous-agent puis rédaction par un autre.

inputs:
  topic:
    type: string
    default: "L'impact de Mistral AI sur l'écosystème français"

steps:
  - id: research
    tool: subagent_invoke
    args:
      name: agent_researcher
      task: "Trouve 5 faits récents et sourcés sur : {{ inputs.topic }}"
  - id: write
    tool: subagent_invoke
    args:
      name: agent_copywriter
      task: "Rédige un article de 400 mots à partir de ces faits :\\n{{ steps.research.response }}"
  - id: save
    tool: kb_write
    args:
      path: "articles/{{ inputs.topic }}.md"
      content: "{{ steps.write.response }}"
""",
    },
    {
        "id": "webhook_to_telegram",
        "name": "Webhook → Telegram",
        "category": "Notifications",
        "description": "Reçoit un POST, formate via LLM, envoie sur un canal Telegram configuré.",
        "tags": ["webhook", "telegram", "llm"],
        "trigger_hint": "Active un trigger webhook + connecte un channel Telegram.",
        "yaml": """\
name: Webhook → Telegram
description: Webhook + LLM + envoi Telegram.

steps:
  - id: format
    tool: llm_call
    args:
      system: "Tu formates un message Telegram concis (3 lignes max), avec emojis discrets."
      prompt: "Message reçu :\\n{{ body }}"
      max_tokens: 200
  - id: send
    tool: channels_send_telegram
    args:
      message: "{{ steps.format.text }}"
""",
    },
]


def list_templates() -> list[dict]:
    """Retourne la liste des templates (sans le YAML pour la liste légère)."""
    return [{k: v for k, v in t.items() if k != "yaml"} for t in TEMPLATES]


def get_template(template_id: str) -> dict | None:
    for t in TEMPLATES:
        if t["id"] == template_id:
            return t
    return None
