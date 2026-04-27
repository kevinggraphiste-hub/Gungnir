/**
 * Forge — humanisation des outils.
 *
 * Les wolf_tools ont des noms techniques (`valkyrie_create_card`, `web_fetch`,
 * `kb_write`…) imbuvables pour un débutant. On dérive ici un titre humain
 * + une catégorie + un résumé court à partir de la description backend,
 * sans toucher aux ~130 schemas en place.
 *
 * Stratégie :
 * - Titre humain = première phrase de la description (avant `. ` ou max 70c)
 * - Catégorie  = préfixe du name (avant le premier `_`) mappé en label FR
 * - Résumé     = la suite après la première phrase, tronquée
 */
import {
  Globe, Brain, ListTodo, Hammer, Bot, Code, MessageSquare,
  RadioTower, Sparkles, Webhook, BarChart3, FileText, Layers,
  Zap, Settings2, BookOpen, Search, Wand,
} from 'lucide-react'

export interface ToolLabel {
  /** Titre court en français (1ère phrase). */
  title: string
  /** Catégorie pour grouper visuellement. */
  category: string
  /** Suite de la description (après la 1ère phrase), facultatif. */
  summary: string
  /** Icône lucide associée à la catégorie. */
  icon: any
  /** Couleur scarlet-friendly de la catégorie. */
  color: string
}

interface CategoryDef {
  label: string
  icon: any
  color: string
}

// Mapping préfixe `<préfixe>_xxx` → catégorie. Ordre d'évaluation :
// si plusieurs préfixes matchent, le plus long gagne.
const PREFIX_CATEGORIES: Record<string, CategoryDef> = {
  valkyrie:      { label: 'Valkyrie (tâches)',   icon: ListTodo,      color: '#dc2626' },
  forge:         { label: 'Forge (workflows)',   icon: Hammer,        color: '#dc2626' },
  llm:           { label: 'IA / LLM',             icon: Wand,          color: '#8b5cf6' },
  ai:            { label: 'IA / LLM',             icon: Wand,          color: '#8b5cf6' },
  consciousness: { label: 'Conscience',          icon: Brain,         color: '#8b5cf6' },
  conscience:    { label: 'Conscience',          icon: Brain,         color: '#8b5cf6' },
  kb:            { label: 'Mémoire (KB)',        icon: BookOpen,      color: '#0ea5e9' },
  soul:          { label: 'Identité (soul)',     icon: Sparkles,      color: '#a855f7' },
  web:           { label: 'Web',                 icon: Globe,         color: '#22c55e' },
  hunt:          { label: 'HuntR (recherche)',   icon: Search,        color: '#22c55e' },
  huntr:         { label: 'HuntR (recherche)',   icon: Search,        color: '#22c55e' },
  browser:       { label: 'Navigateur',          icon: Globe,         color: '#22c55e' },
  channels:      { label: 'Canaux externes',     icon: RadioTower,    color: '#f97316' },
  telegram:      { label: 'Canaux externes',     icon: RadioTower,    color: '#f97316' },
  discord:       { label: 'Canaux externes',     icon: RadioTower,    color: '#f97316' },
  slack:         { label: 'Canaux externes',     icon: RadioTower,    color: '#f97316' },
  webhook:       { label: 'Webhooks',            icon: Webhook,       color: '#f97316' },
  webhooks:      { label: 'Webhooks',            icon: Webhook,       color: '#f97316' },
  mcp:           { label: 'Intégrations (MCP)',  icon: Zap,           color: '#f59e0b' },
  github:        { label: 'Intégrations',        icon: Zap,           color: '#f59e0b' },
  gmail:         { label: 'Intégrations',        icon: Zap,           color: '#f59e0b' },
  notion:        { label: 'Intégrations',        icon: Zap,           color: '#f59e0b' },
  drive:         { label: 'Intégrations',        icon: Zap,           color: '#f59e0b' },
  agent:         { label: 'Sous-agents',         icon: Bot,           color: '#a855f7' },
  subagent:      { label: 'Sous-agents',         icon: Bot,           color: '#a855f7' },
  personality:   { label: 'Personnalités',       icon: MessageSquare, color: '#a855f7' },
  skill:         { label: 'Skills',              icon: Sparkles,      color: '#a855f7' },
  skills:        { label: 'Skills',              icon: Sparkles,      color: '#a855f7' },
  analytics:     { label: 'Analytics',           icon: BarChart3,     color: '#0ea5e9' },
  voice:         { label: 'Voix',                icon: RadioTower,    color: '#ec4899' },
  code:          { label: 'Code (SpearCode)',    icon: Code,          color: '#10b981' },
  spear:         { label: 'Code (SpearCode)',    icon: Code,          color: '#10b981' },
  scheduler:     { label: 'Automata',            icon: Zap,           color: '#f59e0b' },
  automata:      { label: 'Automata',            icon: Zap,           color: '#f59e0b' },
  task:          { label: 'Automata',            icon: Zap,           color: '#f59e0b' },
  reminder:      { label: 'Automata',            icon: Zap,           color: '#f59e0b' },
  // Fallbacks pour les outils sans préfixe clair
  bash:          { label: 'Système',             icon: Settings2,     color: '#737373' },
  shell:         { label: 'Système',             icon: Settings2,     color: '#737373' },
  git:           { label: 'Système',             icon: Settings2,     color: '#737373' },
  fs:            { label: 'Fichiers',            icon: FileText,      color: '#737373' },
  file:          { label: 'Fichiers',            icon: FileText,      color: '#737373' },
}

const DEFAULT_CATEGORY: CategoryDef = {
  label: 'Outils de base', icon: Layers, color: '#737373',
}

function findCategory(toolName: string): CategoryDef {
  const lower = toolName.toLowerCase()
  // Prend le plus long préfixe qui matche.
  let best: CategoryDef | null = null
  let bestLen = 0
  for (const prefix of Object.keys(PREFIX_CATEGORIES)) {
    if ((lower === prefix || lower.startsWith(prefix + '_')) && prefix.length > bestLen) {
      best = PREFIX_CATEGORIES[prefix]
      bestLen = prefix.length
    }
  }
  return best || DEFAULT_CATEGORY
}

/** Découpe la description en {1ère phrase, suite}. */
function splitFirstSentence(desc: string): [string, string] {
  if (!desc) return ['', '']
  const trimmed = desc.trim()
  // On cherche `. ` ou `.\n` (pas dans une URL, etc — heuristique simple).
  const m = trimmed.match(/^([^.]{5,160}\.)\s+(.+)$/s)
  if (m) return [m[1].trim(), m[2].trim()]
  if (trimmed.length <= 80) return [trimmed, '']
  // Pas de phrase claire : tronque.
  return [trimmed.slice(0, 80).trim() + '…', trimmed.slice(80).trim()]
}

/** Retire le `.` final d'un titre — superflu pour un label de carte. */
function trimDot(s: string): string {
  return s.endsWith('.') ? s.slice(0, -1) : s
}

export function humanizeTool(tool: { name: string; description: string }): ToolLabel {
  const cat = findCategory(tool.name)
  const [first, rest] = splitFirstSentence(tool.description || '')
  const title = trimDot(first) || tool.name
  return {
    title,
    summary: rest,
    category: cat.label,
    icon: cat.icon,
    color: cat.color,
  }
}

/** Groupe une liste d'outils par catégorie (label) — ordre stable alphabétique. */
export function groupByCategory<T extends { name: string; description: string }>(
  tools: T[],
): Array<{ category: string; icon: any; color: string; tools: T[] }> {
  const map = new Map<string, { icon: any; color: string; tools: T[] }>()
  for (const t of tools) {
    const lbl = humanizeTool(t)
    const slot = map.get(lbl.category)
    if (slot) slot.tools.push(t)
    else map.set(lbl.category, { icon: lbl.icon, color: lbl.color, tools: [t] })
  }
  // Ordre : catégories définies d'abord (suivant l'ordre d'apparition),
  // puis "Outils de base" en dernier.
  const ordered: Array<{ category: string; icon: any; color: string; tools: T[] }> = []
  for (const [category, v] of map.entries()) {
    ordered.push({ category, ...v })
  }
  ordered.sort((a, b) => {
    if (a.category === DEFAULT_CATEGORY.label) return 1
    if (b.category === DEFAULT_CATEGORY.label) return -1
    return a.category.localeCompare(b.category)
  })
  // Dans chaque catégorie, tri par titre humain.
  for (const g of ordered) {
    g.tools.sort((a, b) => humanizeTool(a).title.localeCompare(humanizeTool(b).title))
  }
  return ordered
}
