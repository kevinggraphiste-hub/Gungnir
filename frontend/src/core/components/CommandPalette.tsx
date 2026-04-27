/**
 * Gungnir — Command Palette (Ctrl+K)
 *
 * A universal search modal that lets the user jump anywhere in the app
 * without memorizing where things are. Inspired by VSCode, Linear, Notion.
 *
 * Opened with Ctrl+K or Cmd+K from anywhere. Typing fuzzy-filters the
 * indexed entries in real-time. ↑↓ to navigate, Enter to fire, Esc to
 * dismiss.
 *
 * Indexed entries (built lazily the first time the palette opens so it
 * doesn't slow down initial page load):
 * - Core pages: Chat, Agent, Settings + every Settings tab deep-linked
 * - Loaded plugins: Consciousness, Scheduler, Channels, Integrations,
 *   Analytics, Browser, Voice, Code, Model Guide
 * - The caller's own skills, personalities, sub-agents (fetched from
 *   /api/skills, /api/personality, /api/sub-agents)
 * - Quick actions: new chat, backup now, restart heartbeat, etc.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import {
  Search as SearchIcon, MessageSquare, Settings as SettingsIcon, Bot,
  Brain, Clock, RadioTower, Plug, BarChart3, Globe, Mic, Code, BookOpen,
  Sparkles, Users, Target, ArrowRight, Plus, HardDrive, HeartPulse, Key,
  Zap, FileText, Workflow,
} from 'lucide-react'
import { api, apiFetch } from '../services/api'

type EntryKind = 'page' | 'tab' | 'skill' | 'personality' | 'subagent' | 'action'

interface Entry {
  id: string
  kind: EntryKind
  label: string
  sublabel?: string
  icon: any
  run: () => void
  // Lowercased haystack used by the fuzzy matcher.
  haystack: string
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // ── Base entries (pages, tabs, plugins, quick actions) ───────────────
  const buildStaticEntries = useCallback((): Entry[] => {
    const go = (path: string) => () => { navigate(path); onClose() }
    return [
      // Core pages
      { id: 'p:chat', kind: 'page', label: 'Chat', sublabel: 'Conversation avec l\'agent', icon: MessageSquare, run: go('/'), haystack: 'chat conversation agent' },
      { id: 'p:agent', kind: 'page', label: 'Configuration Agent', sublabel: 'Mode, skills, sous-agents, sécurité', icon: Bot, run: go('/agent'), haystack: 'agent configuration mode skills personality sous-agents security' },
      { id: 'p:settings', kind: 'page', label: 'Paramètres', sublabel: 'Général, providers, voice, services, heartbeat…', icon: SettingsIcon, run: go('/settings'), haystack: 'settings paramètres general' },

      // Settings tabs deep-linked
      { id: 't:settings:providers', kind: 'tab', label: 'Paramètres → Providers', sublabel: 'Configurer tes clés API (OpenRouter, Anthropic…)', icon: Key, run: go('/settings?tab=providers'), haystack: 'providers openrouter anthropic openai google mistral clé api key' },
      { id: 't:settings:voice', kind: 'tab', label: 'Paramètres → Voice', sublabel: 'ElevenLabs, OpenAI Realtime…', icon: Mic, run: go('/settings?tab=voice'), haystack: 'voice voix elevenlabs openai realtime' },
      { id: 't:settings:services', kind: 'tab', label: 'Paramètres → Services', sublabel: 'Supabase, Qdrant, S3, GitHub…', icon: Plug, run: go('/settings?tab=services'), haystack: 'services supabase qdrant s3 github notion n8n' },
      { id: 't:settings:heartbeat', kind: 'tab', label: 'Paramètres → Heartbeat', sublabel: 'Intervalle, mode jour/nuit, démarrage', icon: HeartPulse, run: go('/settings?tab=heartbeat'), haystack: 'heartbeat pouls intervalle cron pulse' },
      { id: 't:settings:backup', kind: 'tab', label: 'Paramètres → Backup', sublabel: 'Créer, restaurer, supprimer tes sauvegardes', icon: HardDrive, run: go('/settings?tab=backup'), haystack: 'backup sauvegarde restore restauration zip' },
      { id: 't:settings:doctor', kind: 'tab', label: 'Paramètres → Doctor', sublabel: 'Diagnostic complet du système', icon: FileText, run: go('/settings?tab=doctor'), haystack: 'doctor diagnostic health check' },

      // Plugins (best-effort — always listed; no-op if the plugin isn't mounted)
      { id: 'p:consciousness', kind: 'page', label: 'Conscience', sublabel: 'Volition, pensées, reward, challenger…', icon: Brain, run: go('/plugins/consciousness'), haystack: 'conscience consciousness volition pensées thoughts reward challenger simulation vector memory mémoire' },
      { id: 'p:scheduler', kind: 'page', label: 'Automata', sublabel: 'Tâches planifiées (crons, intervalles)', icon: Clock, run: go('/plugins/scheduler'), haystack: 'automata scheduler cron intervalle planifié tâche task' },
      { id: 'p:channels', kind: 'page', label: 'Channels', sublabel: 'Telegram, Discord, Slack, widget…', icon: RadioTower, run: go('/plugins/channels'), haystack: 'channels canaux telegram discord slack whatsapp email widget' },
      { id: 'p:webhooks', kind: 'page', label: 'Intégrations', sublabel: 'MCP, GitHub, Notion, n8n…', icon: Plug, run: go('/plugins/webhooks'), haystack: 'intégrations integrations webhooks mcp github notion n8n linear supabase' },
      { id: 'p:analytics', kind: 'page', label: 'Analytics', sublabel: 'Coûts, tendances, modèles, budget', icon: BarChart3, run: go('/plugins/analytics'), haystack: 'analytics stats coûts budget tendances modèles' },
      { id: 'p:browser', kind: 'page', label: 'Browser', sublabel: 'Recherche web, actu, académique', icon: Globe, run: go('/plugins/browser'), haystack: 'browser recherche search web actu académique' },
      { id: 'p:voice', kind: 'page', label: 'Voice', sublabel: 'Chat vocal temps réel', icon: Mic, run: go('/plugins/voice'), haystack: 'voice vocal voix chat audio' },
      { id: 'p:code', kind: 'page', label: 'Code (SpearCode)', sublabel: 'IDE intégré avec assistance IA', icon: Code, run: go('/plugins/code'), haystack: 'code spearcode ide éditeur workspace' },
      { id: 'p:model_guide', kind: 'page', label: 'Model Guide', sublabel: 'Catalogue des modèles disponibles', icon: BookOpen, run: go('/plugins/model_guide'), haystack: 'modèles models catalogue guide openrouter anthropic' },
      { id: 'p:forge', kind: 'page', label: 'Forge', sublabel: 'Workflows YAML — orchestrateur visuel', icon: Workflow, run: go('/plugins/forge'), haystack: 'forge workflow workflows orchestrateur dag yaml automation n8n' },

      // Quick actions
      { id: 'a:newchat', kind: 'action', label: 'Nouvelle conversation', sublabel: 'Créer un nouveau chat', icon: Plus, run: () => { window.dispatchEvent(new CustomEvent('gungnir:new-chat')); onClose() }, haystack: 'nouvelle conversation new chat créer' },
      { id: 'a:backup', kind: 'action', label: 'Créer un backup maintenant', sublabel: 'Snapshot de tes données per-user', icon: HardDrive, run: async () => { try { await apiFetch('/api/backup/now', { method: 'POST' }) } catch {} onClose() }, haystack: 'backup sauvegarde créer snapshot zip' },
      { id: 'a:skip-onboarding', kind: 'action', label: 'Passer l\'onboarding', sublabel: 'Marquer l\'onboarding comme terminé', icon: Zap, run: async () => { try { await apiFetch('/api/onboarding/skip', { method: 'POST' }) } catch {} onClose() }, haystack: 'onboarding skip passer bienvenue' },
    ]
  }, [navigate, onClose])

  // ── Per-user entries (skills / personalities / sub-agents) ───────────
  const [userEntries, setUserEntries] = useState<Entry[]>([])

  const loadUserEntries = useCallback(async () => {
    try {
      const [skills, personalities, subAgents] = await Promise.all([
        api.getSkills().catch(() => []),
        api.getPersonalities().catch(() => []),
        apiFetch('/api/sub-agents').then((r) => r.ok ? r.json() : []).catch(() => []),
      ])
      const go = (path: string) => () => { navigate(path); onClose() }
      const entries: Entry[] = []
      for (const s of (Array.isArray(skills) ? skills : [])) {
        entries.push({
          id: `s:${s.name}`,
          kind: 'skill',
          label: s.name,
          sublabel: `Skill — ${s.description || s.category || ''}`.slice(0, 80),
          icon: Sparkles,
          run: go('/agent?tab=skills'),
          haystack: `skill ${s.name} ${s.description || ''} ${s.category || ''}`.toLowerCase(),
        })
      }
      const pList = Array.isArray(personalities) ? personalities : (personalities?.personalities || [])
      for (const p of pList) {
        entries.push({
          id: `per:${p.name}`,
          kind: 'personality',
          label: p.name,
          sublabel: `Personnalité — ${p.description || ''}`.slice(0, 80),
          icon: Target,
          run: go('/agent?tab=personality'),
          haystack: `personnalité personality ${p.name} ${p.description || ''}`.toLowerCase(),
        })
      }
      const aList = Array.isArray(subAgents) ? subAgents : (subAgents?.agents || subAgents?.sub_agents || [])
      for (const a of aList) {
        entries.push({
          id: `sa:${a.name}`,
          kind: 'subagent',
          label: a.name,
          sublabel: `Sous-agent — ${a.role || a.description || ''}`.slice(0, 80),
          icon: Users,
          run: go('/agent?tab=subagents'),
          haystack: `sous-agent subagent ${a.name} ${a.role || ''} ${a.description || ''}`.toLowerCase(),
        })
      }
      setUserEntries(entries)
    } catch { /* ignore */ }
  }, [navigate, onClose])

  // Build the full entry list the first time the palette opens and every time
  // the user navigates (cheap — a few dozen strings).
  useEffect(() => {
    if (!open) return
    setEntries([...buildStaticEntries(), ...userEntries])
    loadUserEntries()
    setQuery('')
    setSelectedIdx(0)
    // Focus the input next tick so the caret lands in the box
    setTimeout(() => inputRef.current?.focus(), 0)
    // We depend on open+userEntries length so new entries appear without
    // re-fetching. Avoid putting userEntries in the dep array to prevent
    // an infinite loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Refresh entries when user entries finish loading
  useEffect(() => {
    if (!open) return
    setEntries([...buildStaticEntries(), ...userEntries])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEntries.length])

  // ── Fuzzy filter ────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries.slice(0, 40)
    const tokens = q.split(/\s+/).filter(Boolean)
    return entries
      .map((e) => {
        let score = 0
        for (const tok of tokens) {
          if (e.haystack.includes(tok)) score += 10
          if (e.label.toLowerCase().includes(tok)) score += 5
          if (e.label.toLowerCase().startsWith(tok)) score += 3
        }
        return { e, score }
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map(({ e }) => e)
  }, [entries, query])

  useEffect(() => { setSelectedIdx(0) }, [query])

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`) as HTMLElement | null
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  // ── Keyboard handling ───────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = filtered[selectedIdx]
      if (hit) hit.run()
    }
  }

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh] px-4"
      style={{ background: 'color-mix(in srgb, #000 60%, transparent)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <SearchIcon className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Que cherches-tu ? (page, skill, action…)"
            className="flex-1 bg-transparent outline-none text-sm"
            style={{ color: 'var(--text-primary)' }}
          />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>Esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
              Aucun résultat pour « {query} »
            </div>
          )}
          {filtered.map((e, idx) => {
            const Icon = e.icon
            const isSelected = idx === selectedIdx
            return (
              <button
                key={e.id}
                data-idx={idx}
                onClick={() => e.run()}
                onMouseEnter={() => setSelectedIdx(idx)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
                style={{
                  background: isSelected ? 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' : 'transparent',
                  borderLeft: `3px solid ${isSelected ? 'var(--accent-primary)' : 'transparent'}`,
                }}
              >
                <Icon className="w-4 h-4 flex-shrink-0" style={{ color: isSelected ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{e.label}</div>
                  {e.sublabel && (
                    <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{e.sublabel}</div>
                  )}
                </div>
                <span className="text-[9px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-muted)' }}>{e.kind}</span>
                {isSelected && <ArrowRight className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />}
              </button>
            )
          })}
        </div>
        <div className="flex items-center justify-between px-4 py-2 border-t text-[10px]" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
          <div className="flex items-center gap-3">
            <span><kbd className="px-1 rounded" style={{ background: 'var(--bg-primary)' }}>↑↓</kbd> naviguer</span>
            <span><kbd className="px-1 rounded" style={{ background: 'var(--bg-primary)' }}>Entrée</kbd> valider</span>
            <span><kbd className="px-1 rounded" style={{ background: 'var(--bg-primary)' }}>Esc</kbd> fermer</span>
          </div>
          <div>{filtered.length} résultat{filtered.length > 1 ? 's' : ''}</div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
