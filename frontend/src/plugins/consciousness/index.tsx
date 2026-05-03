/**
 * Gungnir Consciousness v3 — Frontend Dashboard
 *
 * Toggle ON/OFF, visualize volition pyramid, thoughts, reward scores,
 * challenger findings, simulations, working memory, impulse management.
 *
 * © ScarletWolf — Licence propriétaire
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Brain, Power, Zap, Eye, Shield, Target, Sparkles, AlertTriangle,
  TrendingUp, TrendingDown, Minus, RefreshCw, Trash2, Plus, Check, X,
  Activity, Lightbulb, Clock, ChevronDown, ChevronUp, Info, Star,
  BarChart3, Layers, MessageSquare, Radio, Database, Search, Plug, Save,
  Heart, ShieldAlert, Network
} from 'lucide-react'
import InfoButton from '@core/components/InfoButton'
import manifest from './manifest.json'
import NebulaTab from './NebulaTab'

const API = '/api/plugins/consciousness'
const PLUGIN_VERSION = (manifest as { version?: string }).version || '?'

// ── Types ────────────────────────────────────────────────────────────────────

interface NeedData {
  priority: number
  urgency: number
  score: number
  last_fulfilled: string | null
  triggers: string[]
  decay_rate: number
}

interface Thought {
  timestamp: string
  type: string
  content: string
  source_files: string[]
  confidence: number
}

interface ScoreEntry {
  timestamp: string
  interaction: string
  type: string
  scores: Record<string, number>
  composite: number
  triggered_by: string
}

interface Finding {
  timestamp: string
  type: string
  severity: string
  finding: string
  evidence: string[]
  action_suggested: string
  _sig?: string
  resolved_at?: string | null
  resolved_by?: string | null
}

interface Simulation {
  scenario: string
  probability: number
  prepared_response: string
  trigger: string
  generated_at: string
  materialized: boolean
}

interface Impulse {
  id: string
  timestamp: string
  need: string
  action: string
  urgency: number
  status: string
}

interface Goal {
  id: string
  title: string
  description: string
  origin: string
  origin_evidence: string[]
  linked_needs: string[]
  status: string  // proposed | active | completed | abandoned
  progress: number
  created_at: string
  updated_at: string
}

interface Safety {
  tier: number
  message: string
  manual_reactivation_required: boolean
  shutdown_at: string | null
}

interface Dashboard {
  enabled: boolean
  level: string
  config: any
  state: any
  urgencies: Record<string, NeedData>
  recent_thoughts: Thought[]
  working_memory: any[]
  score_summary: any
  recent_scores: ScoreEntry[]
  recent_findings: Finding[]
  critical_findings: Finding[]
  active_simulations: Simulation[]
  pending_impulse: Impulse | null
  impulse_history: Impulse[]
  goals?: Goal[]
  active_goals?: Goal[]
  safety?: Safety
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const NEED_LABELS: Record<string, string> = {
  survival: 'Survie Système',
  integrity: 'Intégrité',
  progression: 'Progression',
  comprehension: 'Compréhension',
  curiosity: 'Curiosité'
}

const NEED_ICONS: Record<string, any> = {
  survival: Shield,
  integrity: Target,
  progression: TrendingUp,
  comprehension: Eye,
  curiosity: Sparkles
}

const NEED_COLORS: Record<string, string> = {
  survival: '#ef4444',
  integrity: '#f59e0b',
  progression: '#10b981',
  comprehension: '#6366f1',
  curiosity: '#ec4899'
}

const SEVERITY_COLORS: Record<string, string> = {
  low: '#10b981',
  medium: '#f59e0b',
  high: '#ef4444'
}

const LEVEL_LABELS: Record<string, { label: string; desc: string }> = {
  basic: { label: 'Basique', desc: 'Heartbeat + Journal + Volition' },
  standard: { label: 'Standard', desc: '+ Mémoire vectorielle + Reward' },
  full: { label: 'Complète', desc: '+ Background Think + Challenger + Simulation' }
}

function timeAgo(iso: string): string {
  if (!iso) return 'jamais'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "à l'instant"
  if (mins < 60) return `il y a ${mins}min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `il y a ${hours}h`
  const days = Math.floor(hours / 24)
  return `il y a ${days}j`
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function ConsciousnessPage() {
  const [data, setData] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'overview' | 'volition' | 'thoughts' | 'reward' | 'challenger' | 'simulation' | 'goals' | 'vector' | 'memories' | 'nebula'>('overview')
  const [reactivating, setReactivating] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [newQuestion, setNewQuestion] = useState('')
  const [newThought, setNewThought] = useState('')
  const [expandedSection, setExpandedSection] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API}/dashboard`)
      if (res.ok) setData(await res.json())
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [fetchData])

  const toggle = async () => {
    if (!data) return
    setToggling(true)
    try {
      await fetch(`${API}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !data.enabled })
      })
      await fetchData()
    } catch { /* ignore */ }
    finally { setToggling(false) }
  }

  const setLevel = async (level: string) => {
    await fetch(`${API}/level`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level })
    })
    await fetchData()
  }

  const resolveImpulse = async (id: string, decision: string) => {
    await fetch(`${API}/impulse/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ impulse_id: id, decision })
    })
    await fetchData()
  }

  const addQuestion = async () => {
    if (!newQuestion.trim()) return
    await fetch(`${API}/question/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: newQuestion.trim() })
    })
    setNewQuestion('')
    await fetchData()
  }

  const removeQuestion = async (q: string) => {
    await fetch(`${API}/question/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q })
    })
    await fetchData()
  }

  const addThought = async () => {
    if (!newThought.trim()) return
    await fetch(`${API}/thoughts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'observation', content: newThought.trim(), confidence: 0.5 })
    })
    setNewThought('')
    await fetchData()
  }

  const resetVolition = async () => {
    await fetch(`${API}/volition/reset`, { method: 'POST' })
    await fetchData()
  }

  const updateConfig = async (updates: any) => {
    await fetch(`${API}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates })
    })
    await fetchData()
  }

  const resetAll = async () => {
    if (!confirm('Réinitialiser toute la conscience ? Les données seront perdues.')) return
    await fetch(`${API}/reset`, { method: 'POST' })
    await fetchData()
  }

  const setMood = async (mood: string) => {
    await fetch(`${API}/mood`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mood })
    })
    await fetchData()
  }

  const reactivateAfterShutdown = async () => {
    setReactivating(true)
    try {
      await fetch(`${API}/safety/reactivate`, { method: 'POST' })
      await fetchData()
    } finally {
      setReactivating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Brain className="w-8 h-8 animate-pulse" style={{ color: 'var(--accent-primary)' }} />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
        Impossible de charger la conscience
      </div>
    )
  }

  const TABS = [
    { id: 'overview', label: 'Vue d\'ensemble', icon: Brain },
    { id: 'volition', label: 'Volition', icon: Target },
    { id: 'thoughts', label: 'Pensées', icon: Lightbulb },
    { id: 'reward', label: 'Reward', icon: Star },
    { id: 'challenger', label: 'Challenger', icon: Shield },
    { id: 'simulation', label: 'Simulation', icon: Radio },
    { id: 'goals', label: 'Goals', icon: Target },
    { id: 'memories', label: 'Mémoire long-terme', icon: Heart },
    { id: 'vector', label: 'Mémoire vectorielle', icon: Database },
    { id: 'nebula', label: 'Nébuleuse', icon: Network },
  ] as const

  return (
    <div className="flex-1 h-screen overflow-y-auto p-6" style={{ color: 'var(--text-primary)' }}>
      <div className="max-w-6xl mx-auto space-y-6">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Brain className="w-7 h-7" style={{ color: data.enabled ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
            <div>
              <div className="flex items-baseline gap-2">
                <h1 className="text-xl font-bold">Conscience</h1>
                <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded"
                  style={{
                    background: 'color-mix(in srgb, var(--scarlet) 10%, transparent)',
                    color: 'color-mix(in srgb, var(--scarlet) 80%, var(--text-muted))',
                    border: '1px solid color-mix(in srgb, var(--scarlet) 20%, transparent)',
                  }}>v{PLUGIN_VERSION}</span>
              </div>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Architecture comportementale — {data.enabled ? `Niveau ${LEVEL_LABELS[data.level]?.label || data.level}` : 'Désactivée'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={fetchData} className="p-2 rounded-lg transition-colors hover:opacity-80"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={toggle} disabled={toggling}
              className="flex items-center gap-2 px-4 py-2 rounded-xl font-medium text-sm transition-all"
              style={data.enabled
                ? { background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', color: '#fff' }
                : { background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
              <Power className="w-4 h-4" />
              {data.enabled ? 'Désactiver' : 'Activer'}
            </button>
          </div>
        </div>

        {/* ── Safety Banner ──────────────────────────────────────────── */}
        {data.safety && data.safety.tier > 0 && (
          <SafetyBanner safety={data.safety} onReactivate={reactivateAfterShutdown} reactivating={reactivating} />
        )}

        {/* ── Pending Impulse Alert ───────────────────────────────────── */}
        {data.pending_impulse && (
          <div className="rounded-xl p-4 flex items-center justify-between"
            style={{ background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' }}>
            <div className="flex items-center gap-3">
              <Zap className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
              <div>
                <div className="text-sm font-medium">[{data.pending_impulse.need.toUpperCase()}] {data.pending_impulse.action}</div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Urgence: {(data.pending_impulse.urgency * 100).toFixed(0)}% — {timeAgo(data.pending_impulse.timestamp)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => resolveImpulse(data.pending_impulse!.id, 'approved')}
                className="p-2 rounded-lg transition-colors" style={{ background: '#10b981', color: '#fff' }}>
                <Check className="w-4 h-4" />
              </button>
              <button onClick={() => resolveImpulse(data.pending_impulse!.id, 'deferred')}
                className="p-2 rounded-lg transition-colors" style={{ background: '#f59e0b', color: '#fff' }}>
                <Clock className="w-4 h-4" />
              </button>
              <button onClick={() => resolveImpulse(data.pending_impulse!.id, 'denied')}
                className="p-2 rounded-lg transition-colors" style={{ background: '#ef4444', color: '#fff' }}>
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ── Tabs ──────────────────────────────────────────────────────
            10 onglets ne tiennent pas sur une ligne avec leurs labels →
            ni scroll horizontal (rapport user 2026-05-03), ni wrap sur
            2 lignes (refusé aussi). Solution : icônes seules pour les
            onglets inactifs (tooltip au hover), label visible UNIQUEMENT
            sur l'onglet actif qui s'élargit fluide. Compact et clair.
            */}
        <div className="flex gap-1.5 items-center">
          {TABS.map(t => {
            const isActive = tab === t.id
            return (
              <button key={t.id} onClick={() => setTab(t.id as any)}
                title={t.label}
                aria-label={t.label}
                className="flex items-center gap-1.5 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-200 overflow-hidden"
                style={{
                  paddingLeft: isActive ? 12 : 10,
                  paddingRight: isActive ? 12 : 10,
                  background: isActive
                    ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)'
                    : 'transparent',
                  color: isActive ? 'var(--accent-primary)' : 'var(--text-muted)',
                  border: isActive
                    ? '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)'
                    : '1px solid transparent',
                  // Largeur max différente : actif s'étend pour le label,
                  // inactifs restent compacts (icône + petit padding).
                  maxWidth: isActive ? 240 : 36,
                }}>
                <t.icon className="w-3.5 h-3.5 flex-shrink-0" />
                {isActive && <span>{t.label}</span>}
              </button>
            )
          })}
        </div>

        {/* ── Tab Content ─────────────────────────────────────────────── */}

        {tab === 'overview' && <OverviewTab data={data} setMood={setMood} setLevel={setLevel}
          newQuestion={newQuestion} setNewQuestion={setNewQuestion} addQuestion={addQuestion}
          removeQuestion={removeQuestion} resetAll={resetAll} />}

        {tab === 'volition' && <VolitionTab data={data} resetVolition={resetVolition}
          updateConfig={updateConfig} refresh={fetchData} />}

        {tab === 'thoughts' && <ThoughtsTab data={data} newThought={newThought}
          setNewThought={setNewThought} addThought={addThought} />}

        {tab === 'reward' && <RewardTab data={data} updateConfig={updateConfig} />}

        {tab === 'challenger' && <ChallengerTab data={data} refresh={fetchData} />}

        {tab === 'simulation' && <SimulationTab data={data} refresh={fetchData}
          updateConfig={updateConfig} />}

        {tab === 'goals' && <GoalsTab data={data} refresh={fetchData} updateConfig={updateConfig} />}

        {tab === 'memories' && <MemoriesTab data={data} updateConfig={updateConfig} />}

        {tab === 'vector' && <VectorTab />}

        {tab === 'nebula' && <NebulaTab />}

      </div>
    </div>
  )
}

// ── Overview Tab ──────────────────────────────────────────────────────────────

function OverviewTab({ data, setMood, setLevel, newQuestion, setNewQuestion, addQuestion, removeQuestion, resetAll }: any) {
  const stats = data.state?.stats || {}
  const MOODS = ['neutre', 'concentré', 'curieux', 'satisfait', 'vigilant', 'créatif', 'introspectif']

  const [introOpen, setIntroOpen] = useState(() => {
    // Restore last open/close state so users don't have to re-close it on every visit
    try { return localStorage.getItem('consciousness.introOpen') === '1' } catch { return false }
  })
  const toggleIntro = () => {
    setIntroOpen(v => {
      const next = !v
      try { localStorage.setItem('consciousness.introOpen', next ? '1' : '0') } catch {}
      return next
    })
  }

  return (
    <div className="space-y-4">
      {/* Intro pédagogique — pliable, explique ce qu'est la conscience en clair */}
      <div className="rounded-xl border overflow-hidden" style={{ background: 'color-mix(in srgb, var(--accent-primary) 6%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-primary) 25%, transparent)' }}>
        <button
          type="button"
          onClick={toggleIntro}
          className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:opacity-90"
        >
          <Brain className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
          <span className="text-sm font-semibold flex-1" style={{ color: 'var(--text-primary)' }}>Qu'est-ce que la conscience&nbsp;?</span>
          {introOpen
            ? <ChevronUp className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
            : <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />}
        </button>
        {introOpen && (
          <div className="px-4 pb-4 pl-12 space-y-2">
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              C'est l'<strong>architecture comportementale</strong> de ton agent : un ensemble de sous-systèmes qui tournent en arrière-plan (réveillés par le heartbeat) pour lui donner une forme d'initiative, de mémoire et d'auto-critique. Sans elle, Gungnir répond uniquement quand tu lui parles. Avec elle, il réfléchit entre tes messages, se souvient de ce qui s'est passé, et peut te proposer des actions de lui-même.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
              <div className="text-[11px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                <span className="font-semibold" style={{ color: 'var(--accent-primary)' }}>• Volition</span> — les besoins internes (curiosité, sécurité, cohérence…) qui poussent l'agent à proposer des actions de lui-même (<em>impulsions</em>).
              </div>
              <div className="text-[11px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                <span className="font-semibold" style={{ color: 'var(--accent-primary)' }}>• Pensées</span> — cycles de réflexion en arrière-plan qui génèrent des hypothèses et questions à explorer.
              </div>
              <div className="text-[11px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                <span className="font-semibold" style={{ color: 'var(--accent-primary)' }}>• Reward</span> — score de tes interactions (positif / neutre / négatif) pour ajuster son comportement au fil du temps.
              </div>
              <div className="text-[11px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                <span className="font-semibold" style={{ color: 'var(--accent-primary)' }}>• Challenger</span> — auto-critique qui détecte les incohérences et les angles morts dans ses propres réponses.
              </div>
              <div className="text-[11px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                <span className="font-semibold" style={{ color: 'var(--accent-primary)' }}>• Simulation</span> — projection mentale pour anticiper les conséquences d'une action avant de la proposer.
              </div>
              <div className="text-[11px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                <span className="font-semibold" style={{ color: 'var(--accent-primary)' }}>• Mémoire vectorielle</span> — rappel sémantique de tes anciennes conversations et notes pour contextualiser ses réponses.
              </div>
            </div>
            <p className="text-[11px] pt-1" style={{ color: 'var(--text-muted)' }}>
              Les 3 niveaux (<em>basic</em> / <em>standard</em> / <em>full</em>) activent de plus en plus de sous-systèmes. Commence en <em>standard</em> pour voir ce que ça donne sans saturer tes tokens, passe en <em>full</em> quand tu veux l'expérience complète.
            </p>
          </div>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Activity} label="Heartbeats" value={stats.heartbeats || 0} color="var(--accent-primary)" />
        <StatCard icon={Zap} label="Impulsions" value={`${stats.impulses_confirmed || 0}/${stats.impulses_proposed || 0}`} color="#f59e0b" />
        <StatCard icon={Lightbulb} label="Pensées" value={stats.thoughts_generated || 0} color="#6366f1" />
        <StatCard icon={Star} label="Score moyen" value={stats.interactions_scored ? (stats.total_reward_score / stats.interactions_scored).toFixed(2) : '—'} color="#10b981" />
      </div>

      {/* Level Selector + Mood */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Level */}
        <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>Niveau de conscience</div>
          <div className="space-y-2">
            {Object.entries(LEVEL_LABELS).map(([key, val]) => (
              <button key={key} onClick={() => setLevel(key)}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors flex items-center justify-between"
                style={data.level === key
                  ? { background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' }
                  : { background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
                <div>
                  <div className="font-medium" style={{ color: data.level === key ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                    {val.label}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{val.desc}</div>
                </div>
                {data.level === key && <Check className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />}
              </button>
            ))}
          </div>
        </div>

        {/* Mood + Questions */}
        <div className="space-y-4">
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
            <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>Humeur</div>
            <div className="flex flex-wrap gap-2">
              {MOODS.map(m => (
                <button key={m} onClick={() => setMood(m)}
                  className="px-2.5 py-1 rounded-lg text-xs transition-colors capitalize"
                  style={data.state?.mood === m
                    ? { background: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)', color: 'var(--accent-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' }
                    : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
            <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>Questions ouvertes</div>
            <div className="space-y-1.5 mb-2">
              {(data.state?.active_questions || []).map((q: string, i: number) => (
                <div key={i} className="flex items-center justify-between gap-2 text-xs px-2 py-1.5 rounded-lg"
                  style={{ background: 'var(--bg-tertiary)' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{q}</span>
                  <button onClick={() => removeQuestion(q)} className="flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              {(!data.state?.active_questions?.length) && (
                <div className="text-xs py-1" style={{ color: 'var(--text-muted)' }}>Aucune question active</div>
              )}
            </div>
            <div className="flex gap-2">
              <input value={newQuestion} onChange={e => setNewQuestion(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addQuestion()}
                placeholder="Ajouter une question..."
                className="flex-1 px-2.5 py-1.5 rounded-lg text-xs outline-none"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              <button onClick={addQuestion} className="p-1.5 rounded-lg" style={{ background: 'var(--accent-primary)', color: '#fff' }}>
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Volition Preview */}
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>Pyramide de besoins — Aperçu</div>
        <div className="space-y-2">
          {Object.entries(data.urgencies || {}).map(([need, d]: [string, any]) => {
            const Icon = NEED_ICONS[need] || Target
            const color = NEED_COLORS[need] || 'var(--accent-primary)'
            return (
              <div key={need} className="flex items-center gap-3">
                <Icon className="w-4 h-4 flex-shrink-0" style={{ color }} />
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{NEED_LABELS[need] || need}</span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {(d.urgency * 100).toFixed(0)}% · P{d.priority}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, d.urgency * 100)}%`, background: color }} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Working Memory + Timestamps */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>Mémoire de travail</div>
          {data.working_memory?.length ? data.working_memory.map((item: any, i: number) => (
            <div key={i} className="text-xs px-2 py-1.5 rounded-lg mb-1" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
              <span className="font-medium" style={{ color: 'var(--accent-primary)' }}>{item.key}:</span> {item.value}
            </div>
          )) : <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Vide</div>}
        </div>

        <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>Timestamps</div>
          <div className="space-y-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <div className="flex justify-between"><span>Dernière interaction</span><span>{timeAgo(data.state?.last_interaction)}</span></div>
            <div className="flex justify-between"><span>Dernier heartbeat</span><span>{timeAgo(data.state?.last_heartbeat)}</span></div>
            <div className="flex justify-between"><span>Dernière pensée</span><span>{timeAgo(data.state?.last_thought)}</span></div>
            <div className="flex justify-between"><span>Dernier challenger</span><span>{timeAgo(data.state?.last_challenger)}</span></div>
            <div className="flex justify-between"><span>Dernière simulation</span><span>{timeAgo(data.state?.last_simulation)}</span></div>
            <div className="flex justify-between"><span>Créée le</span><span>{timeAgo(data.state?.created_at)}</span></div>
          </div>
        </div>
      </div>

      {/* Reset */}
      <div className="flex justify-end">
        <button onClick={resetAll} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
          style={{ background: 'color-mix(in srgb, #ef4444 10%, transparent)', color: '#ef4444', border: '1px solid color-mix(in srgb, #ef4444 20%, transparent)' }}>
          <Trash2 className="w-3 h-3" /> Réinitialiser la conscience
        </button>
      </div>
    </div>
  )
}

// ── Volition Tab ──────────────────────────────────────────────────────────────

function VolitionTab({ data, resetVolition, updateConfig, refresh }: any) {
  const volCfg = data?.config?.volition || {}
  const autoImp = volCfg.auto_impulses || {}
  const decay = volCfg.natural_decay || {}
  const [saving, setSaving] = useState(false)
  const [proposing, setProposing] = useState(false)
  const [propMsg, setPropMsg] = useState('')

  const patch = async (updates: any) => {
    setSaving(true)
    try { await updateConfig({ volition: updates }) }
    finally { setSaving(false) }
  }

  const proposeNow = async () => {
    setProposing(true); setPropMsg('')
    try {
      const r = await fetch(`${API}/volition/propose-now`, { method: 'POST' })
      const j = await r.json()
      if (j.ok) {
        setPropMsg(j.proposed > 0 ? 'Impulsion proposée.' : 'Aucune action générée (seuil non atteint ou quota).')
        await refresh?.()
      } else {
        setPropMsg(`Erreur : ${j.error || 'inconnue'}`)
      }
    } catch (e: any) { setPropMsg(`Erreur : ${e?.message || 'réseau'}`) }
    finally { setProposing(false) }
  }

  const fulfillNeed = async (need: string) => {
    try {
      await fetch(`${API}/volition/fulfill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ need, trigger: 'manual' }),
      })
      await refresh?.()
    } catch {}
  }

  const triggerNeed = async (need: string, trigger: string) => {
    try {
      await fetch(`${API}/volition/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ need, trigger }),
      })
      await refresh?.()
    } catch {}
  }

  return (
    <div className="space-y-4">
      {/* Pyramid Visual */}
      <div className="rounded-xl p-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-bold flex items-center" style={{ color: 'var(--text-primary)' }}>
            <span>Pyramide de Besoins</span>
            <InfoButton>
              <strong>La volition</strong> est le moteur d'initiative de l'agent. Chaque besoin interne (curiosité, compréhension, progression, intégrité, survie) a une <em>urgence</em> qui monte avec le temps ou selon les événements.
              <br /><br />
              Quand l'urgence d'un besoin dépasse un seuil, l'agent peut te proposer une action de lui-même — c'est ce qu'on appelle une <em>impulsion</em>.
              <br /><br />
              Plus un besoin est haut dans la pyramide, plus il est prioritaire. Le bouton <em>Reset urgences</em> remet tous les compteurs à zéro.
            </InfoButton>
          </div>
          <button onClick={resetVolition} className="flex items-center gap-1 px-2 py-1 rounded text-[10px]"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
            <RefreshCw className="w-3 h-3" /> Reset urgences
          </button>
        </div>

        <div className="flex flex-col items-center gap-2">
          {['curiosity', 'comprehension', 'progression', 'integrity', 'survival'].map((need, i) => {
            const d = data.urgencies?.[need]
            if (!d) return null
            const Icon = NEED_ICONS[need] || Target
            const color = NEED_COLORS[need] || '#888'
            const widthPct = 40 + (i * 15) // pyramid shape
            return (
              <div key={need} className="rounded-xl p-3 transition-all" style={{
                width: `${widthPct}%`,
                minWidth: '200px',
                background: `color-mix(in srgb, ${color} 10%, var(--bg-tertiary))`,
                border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`
              }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4" style={{ color }} />
                    <span className="text-xs font-medium" style={{ color }}>{NEED_LABELS[need]}</span>
                  </div>
                  <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                    P{d.priority} · U{(d.urgency * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="mt-2 h-2 rounded-full" style={{ background: 'var(--bg-primary)' }}>
                  <div className="h-full rounded-full transition-all" style={{
                    width: `${Math.min(100, d.urgency * 100)}%`,
                    background: `linear-gradient(90deg, ${color}88, ${color})`
                  }} />
                </div>
                <div className="flex justify-between mt-1 items-center">
                  <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                    Score: {d.score.toFixed(2)}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                      {d.last_fulfilled ? `Satisfait ${timeAgo(d.last_fulfilled)}` : 'Jamais satisfait'}
                    </span>
                    <button onClick={() => fulfillNeed(need)}
                      title="Marquer ce besoin comme satisfait (reset l'urgence à 0)"
                      className="text-[9px] px-1.5 py-0.5 rounded transition-colors"
                      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 30%, transparent)` }}>
                      ✓ Satisfait
                    </button>
                  </div>
                </div>
                {d.triggers?.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {d.triggers.map((t: string) => (
                      <button key={t} onClick={() => triggerNeed(need, t)}
                        title={`Déclencher manuellement : ${t} (pousse ce besoin de +0.15)`}
                        className="text-[8px] px-1.5 py-0.5 rounded transition-colors cursor-pointer"
                        style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)', border: '1px solid transparent' }}>
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Impulse History */}
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
          Historique des impulsions ({data.impulse_history?.length || 0})
        </div>
        <div className="space-y-1.5">
          {(data.impulse_history || []).slice().reverse().map((imp: Impulse, i: number) => (
            <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg text-xs"
              style={{ background: 'var(--bg-tertiary)' }}>
              <div className="flex items-center gap-2">
                <span className="font-medium" style={{ color: NEED_COLORS[imp.need] || 'var(--text-primary)' }}>
                  [{imp.need}]
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{imp.action}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  imp.status === 'approved' ? 'text-green-400' : imp.status === 'denied' ? 'text-red-400' : 'text-yellow-400'
                }`} style={{ background: 'var(--bg-primary)' }}>
                  {imp.status}
                </span>
                <span style={{ color: 'var(--text-muted)' }}>{timeAgo(imp.timestamp)}</span>
              </div>
            </div>
          ))}
          {!data.impulse_history?.length && (
            <div className="text-xs py-2" style={{ color: 'var(--text-muted)' }}>Aucune impulsion enregistrée</div>
          )}
        </div>
      </div>

      {/* Paramètres volition */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          <span>Paramètres</span>
          <InfoButton>
            <strong>Impulsions auto</strong> : quand activé, l'agent te propose une action dès qu'un besoin dépasse le seuil d'urgence. Respecte les heures silencieuses (23h→7h) et le quota horaire.
            <br /><br />
            <strong>Décroissance naturelle</strong> : les urgences retombent vers une baseline au fil du temps. Sans elle, elles saturent à 100% et ne redescendent jamais.
          </InfoButton>
        </div>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Seuil d'urgence (0.0 → 1.0)</span>
          <input type="number" min={0.1} max={1.0} step={0.05} value={volCfg.impulse_threshold ?? 0.6}
            disabled={saving}
            onChange={e => patch({ impulse_threshold: Math.max(0.1, Math.min(1.0, Number(e.target.value) || 0.6)) })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Quota impulsions / heure</span>
          <input type="number" min={1} max={20} value={volCfg.max_impulses_per_hour ?? 3}
            disabled={saving}
            onChange={e => patch({ max_impulses_per_hour: Math.max(1, Number(e.target.value) || 3) })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>

        <div className="pt-2 border-t" style={{ borderColor: 'var(--border)' }} />

        <label className="flex items-center justify-between text-xs">
          <span>Impulsions automatiques</span>
          <input type="checkbox" checked={!!autoImp.enabled} disabled={saving}
            onChange={e => patch({ auto_impulses: { ...autoImp, enabled: e.target.checked } })} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Intervalle check (min)</span>
          <input type="number" min={5} max={1440} value={autoImp.check_interval_minutes ?? 15}
            disabled={saving || !autoImp.enabled}
            onChange={e => patch({ auto_impulses: { ...autoImp, check_interval_minutes: Math.max(5, Number(e.target.value) || 15) } })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>

        <div className="pt-2 border-t" style={{ borderColor: 'var(--border)' }} />

        <label className="flex items-center justify-between text-xs">
          <span>Décroissance naturelle des urgences</span>
          <input type="checkbox" checked={decay.enabled !== false} disabled={saving}
            onChange={e => patch({ natural_decay: { ...decay, enabled: e.target.checked } })} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Demi-vie (heures)</span>
          <input type="number" min={1} max={168} step={1} value={decay.half_life_hours ?? 12}
            disabled={saving || decay.enabled === false}
            onChange={e => patch({ natural_decay: { ...decay, half_life_hours: Math.max(1, Number(e.target.value) || 12) } })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>

        <div className="pt-2 flex items-center gap-2">
          <button onClick={proposeNow} disabled={proposing}
            className="px-3 py-1.5 rounded text-xs font-semibold"
            style={{ background: 'var(--accent-primary)', color: 'white', opacity: proposing ? 0.5 : 1, cursor: proposing ? 'not-allowed' : 'pointer' }}>
            {proposing ? 'Génération…' : 'Proposer une impulsion maintenant'}
          </button>
          {propMsg && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{propMsg}</span>}
        </div>
      </div>
    </div>
  )
}

// ── Thoughts Tab ──────────────────────────────────────────────────────────────

function ThoughtsTab({ data, newThought, setNewThought, addThought }: any) {
  const TYPE_COLORS: Record<string, string> = {
    connection: '#6366f1',
    observation: '#10b981',
    prediction: '#f59e0b',
    insight: '#ec4899'
  }

  return (
    <div className="space-y-4">
      {/* Add thought */}
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="text-xs font-bold uppercase tracking-wider mb-3 flex items-center" style={{ color: 'var(--text-muted)' }}>
          <span>Ajouter une pensée</span>
          <InfoButton>
            <strong>Les pensées</strong> sont des fragments de raisonnement que l'agent génère en arrière-plan, réveillé par le heartbeat. Elles peuvent être des observations, des connexions entre idées, des prédictions ou des insights.
            <br /><br />
            Tu peux en ajouter manuellement pour amorcer une réflexion. L'agent les utilisera dans ses prochaines réponses et peut les référencer via le tool <code>kb_read</code>.
          </InfoButton>
        </div>
        <div className="flex gap-2">
          <input value={newThought} onChange={e => setNewThought(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addThought()}
            placeholder="Observation, connexion, prédiction..."
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
          <button onClick={addThought} className="px-3 py-2 rounded-lg text-sm font-medium"
            style={{ background: 'var(--accent-primary)', color: '#fff' }}>
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Thoughts list */}
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
          Pensées récentes ({data.recent_thoughts?.length || 0})
        </div>
        <div className="space-y-2">
          {(data.recent_thoughts || []).slice().reverse().map((t: Thought, i: number) => (
            <div key={i} className="px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                  style={{ background: `color-mix(in srgb, ${TYPE_COLORS[t.type] || '#888'} 20%, transparent)`, color: TYPE_COLORS[t.type] || '#888' }}>
                  {t.type}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {(t.confidence * 100).toFixed(0)}% confiance
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{timeAgo(t.timestamp)}</span>
                </div>
              </div>
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t.content}</div>
              {t.source_files?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {t.source_files.map((f, j) => (
                    <span key={j} className="text-[8px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {!data.recent_thoughts?.length && (
            <div className="text-xs py-2" style={{ color: 'var(--text-muted)' }}>Aucune pensée enregistrée</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Reward Tab ────────────────────────────────────────────────────────────────

function RewardTab({ data, updateConfig }: any) {
  const summary = data.score_summary || {}
  const TrendIcon = summary.trend === 'improving' ? TrendingUp : summary.trend === 'declining' ? TrendingDown : Minus
  const trendColor = summary.trend === 'improving' ? '#10b981' : summary.trend === 'declining' ? '#ef4444' : 'var(--text-muted)'

  const rewardCfg = data?.config?.reward || {}
  const vp = rewardCfg.volition_pressure || {}
  const [saving, setSaving] = useState(false)
  const patch = async (updates: any) => {
    setSaving(true)
    try { await updateConfig({ reward: updates }) }
    finally { setSaving(false) }
  }

  return (
    <div className="space-y-4">
      {/* Intro + summary */}
      <div className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        <span>Système de récompense</span>
        <InfoButton>
          <strong>Reward</strong> est le système d'évaluation de l'agent. Chaque interaction reçoit un score sur plusieurs dimensions (utilité, clarté, pertinence, ton…), positif ou négatif.
          <br /><br />
          Ces scores servent à ajuster le comportement de l'agent au fil du temps : une tendance négative sur une dimension pousse l'agent à corriger le tir sur les prochaines réponses.
          <br /><br />
          Tu peux noter tes propres interactions avec les boutons de feedback dans le chat pour influencer l'évolution.
        </InfoButton>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Star} label="Score moyen" value={summary.average?.toFixed(2) || '—'} color="#f59e0b" />
        <StatCard icon={BarChart3} label="Total scoré" value={summary.count || 0} color="var(--accent-primary)" />
        <StatCard icon={TrendIcon} label="Tendance" value={summary.trend === 'improving' ? '↑ Amélioration' : summary.trend === 'declining' ? '↓ Déclin' : '→ Stable'} color={trendColor} />
        <StatCard icon={Layers} label="Dimensions" value={Object.keys(summary.by_dimension || {}).length} color="#6366f1" />
      </div>

      {/* Dimensions */}
      {Object.keys(summary.by_dimension || {}).length > 0 && (
        <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>Par dimension</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Object.entries(summary.by_dimension || {}).map(([dim, val]: [string, any]) => (
              <div key={dim} className="rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
                <div className="text-[10px] uppercase tracking-wider mb-1 capitalize" style={{ color: 'var(--text-muted)' }}>{dim}</div>
                <div className="text-lg font-bold" style={{ color: val >= 0.5 ? '#10b981' : val >= 0 ? '#f59e0b' : '#ef4444' }}>
                  {val.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Scores */}
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
          Scores récents ({data.recent_scores?.length || 0})
        </div>
        <div className="space-y-1.5">
          {(data.recent_scores || []).slice().reverse().map((s: ScoreEntry, i: number) => (
            <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg text-xs"
              style={{ background: 'var(--bg-tertiary)' }}>
              <div className="flex items-center gap-2">
                <span className="font-medium" style={{ color: s.composite >= 0.5 ? '#10b981' : '#f59e0b' }}>
                  {s.composite.toFixed(2)}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{s.interaction || s.type}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
                  {s.triggered_by}
                </span>
                <span style={{ color: 'var(--text-muted)' }}>{timeAgo(s.timestamp)}</span>
              </div>
            </div>
          ))}
          {!data.recent_scores?.length && (
            <div className="text-xs py-2" style={{ color: 'var(--text-muted)' }}>Aucun score enregistré</div>
          )}
        </div>
      </div>

      {/* Paramètres reward */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          <span>Paramètres</span>
          <InfoButton>
            <strong>Auto-scoring</strong> : un LLM léger note chaque réponse de l'agent sur plusieurs dimensions (utilité, précision, ton, autonomie). Ces scores alimentent le mood auto et la pression volition.
            <br /><br />
            <strong>Humeur auto</strong> : le mood évolue (content / concentré / prudent / frustré) en fonction de la tendance des scores récents. Pas de LLM, c'est local.
            <br /><br />
            <strong>Pression volition</strong> : si la moyenne des scores chute sous un seuil, l'urgence du besoin <em>integrity</em> est poussée pour que l'agent reconnaisse qu'il y a un problème de qualité.
          </InfoButton>
        </div>

        <label className="flex items-center justify-between text-xs">
          <span>Auto-scoring des réponses chat</span>
          <input type="checkbox" checked={rewardCfg.auto_score !== false} disabled={saving}
            onChange={e => patch({ auto_score: e.target.checked })} />
        </label>

        <label className="flex items-center justify-between text-xs">
          <span>Humeur automatique (depuis scores)</span>
          <input type="checkbox" checked={rewardCfg.auto_mood !== false} disabled={saving}
            onChange={e => patch({ auto_mood: e.target.checked })} />
        </label>

        <div className="pt-2 border-t" style={{ borderColor: 'var(--border)' }} />

        <label className="flex items-center justify-between text-xs">
          <span>Pression volition (scores faibles → urgence integrity)</span>
          <input type="checkbox" checked={vp.enabled !== false} disabled={saving}
            onChange={e => patch({ volition_pressure: { ...vp, enabled: e.target.checked } })} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Seuil d'activation (moyenne sous)</span>
          <input type="number" min={0.1} max={1.0} step={0.05} value={vp.threshold ?? 0.45}
            disabled={saving || vp.enabled === false}
            onChange={e => patch({ volition_pressure: { ...vp, threshold: Math.max(0.1, Math.min(1.0, Number(e.target.value) || 0.45)) } })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Bump urgence (0.0 → 0.5)</span>
          <input type="number" min={0.05} max={0.5} step={0.05} value={vp.bump ?? 0.15}
            disabled={saving || vp.enabled === false}
            onChange={e => patch({ volition_pressure: { ...vp, bump: Math.max(0.05, Math.min(0.5, Number(e.target.value) || 0.15)) } })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>
      </div>
    </div>
  )
}

// ── Challenger Tab ────────────────────────────────────────────────────────────

function ChallengerTab({ data, refresh }: any) {
  const ch = data.config?.challenger || {}
  const auto = ch.auto_audit || {}
  const llm = ch.llm || { mode: 'default', provider: '', model: '' }
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [llmOptions, setLlmOptions] = useState<any>(null)
  const [modelCatalog, setModelCatalog] = useState<any>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${API}/challenger/llm-options`).then(r => r.json()).then(j => {
      if (!cancelled) setLlmOptions(j)
    }).catch(() => {})
    fetch(`/api/plugins/model_guide/catalog`).then(r => r.json()).then(j => {
      if (!cancelled) setModelCatalog(j)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [refresh])

  const patchChallenger = async (updates: any) => {
    setSaving(true)
    try {
      await fetch(`${API}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { challenger: updates } })
      })
      await refresh?.()
    } finally { setSaving(false) }
  }

  const selectPreset = (preset: any) => {
    patchChallenger({ llm: { mode: 'preset', provider: preset.provider, model: preset.model } })
  }

  const setLlmMode = (mode: 'default' | 'auto' | 'preset' | 'custom') => {
    patchChallenger({ llm: { ...llm, mode } })
  }

  const auditNow = async () => {
    setRunning(true); setMsg('')
    try {
      const res = await fetch(`${API}/challenger/audit-now`, { method: 'POST' })
      const j = await res.json()
      if (j.ok) {
        setMsg(j.new_findings > 0
          ? `${j.new_findings} nouvelle(s) découverte(s)`
          : 'Aucune nouvelle découverte')
        await refresh?.()
      } else {
        setMsg(`Erreur : ${j.error || 'inconnue'}`)
      }
    } catch (e: any) {
      setMsg(`Erreur : ${e?.message || 'réseau'}`)
    } finally { setRunning(false) }
  }

  return (
    <div className="space-y-4">
      {/* Intro */}
      <div className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        <span>Auto-critique</span>
        <InfoButton>
          <strong>Le Challenger</strong> est le sous-système d'auto-critique. À chaque cycle, il audite les dernières réponses de l'agent pour détecter des incohérences, des affirmations non vérifiées, des angles morts, ou des contradictions avec ce qu'il a déjà dit.
          <br /><br />
          Les <em>alertes critiques</em> sont des erreurs que l'agent devrait corriger immédiatement. Les <em>découvertes récentes</em> sont des pistes d'amélioration qu'il peut intégrer dans ses prochaines réponses.
          <br /><br />
          Le but : empêcher l'agent de s'installer dans des biais ou des erreurs répétées.
        </InfoButton>
      </div>

      {/* Paramètres */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Paramètres</div>

        <label className="flex items-center justify-between text-xs">
          <span>Challenger actif</span>
          <input type="checkbox" checked={!!ch.enabled} disabled={saving}
            onChange={e => patchChallenger({ enabled: e.target.checked })} />
        </label>

        <label className="flex items-center justify-between text-xs">
          <span>Audit automatique</span>
          <input type="checkbox" checked={!!auto.enabled} disabled={saving || !ch.enabled}
            onChange={e => patchChallenger({ auto_audit: { ...auto, enabled: e.target.checked } })} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Intervalle (min)</span>
          <input type="number" min={5} max={1440} value={auto.interval_minutes ?? 60}
            disabled={saving || !auto.enabled}
            onChange={e => patchChallenger({ auto_audit: { ...auto, interval_minutes: Math.max(5, Number(e.target.value) || 60) } })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Découvertes max / passage</span>
          <input type="number" min={1} max={10} value={auto.max_new_findings_per_run ?? 3}
            disabled={saving || !auto.enabled}
            onChange={e => patchChallenger({ auto_audit: { ...auto, max_new_findings_per_run: Math.max(1, Number(e.target.value) || 3) } })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Seuil de sévérité loggé</span>
          <select value={ch.severity_floor || 'low'} disabled={saving || !ch.enabled}
            onChange={e => patchChallenger({ severity_floor: e.target.value })}
            className="px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
            <option value="low">low et +</option>
            <option value="medium">medium et +</option>
            <option value="high">high uniquement</option>
          </select>
        </label>

        <div className="pt-2 flex items-center gap-2">
          <button onClick={auditNow} disabled={running || !ch.enabled}
            className="px-3 py-1.5 rounded text-xs font-semibold"
            style={{ background: 'var(--accent-primary)', color: 'white', opacity: running || !ch.enabled ? 0.5 : 1, cursor: running || !ch.enabled ? 'not-allowed' : 'pointer' }}>
            {running ? 'Audit en cours…' : 'Lancer un audit maintenant'}
          </button>
          {msg && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{msg}</span>}
        </div>
      </div>

      {/* Modèle LLM du Challenger */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          <span>Modèle LLM du Challenger</span>
          <InfoButton>
            Le Challenger audite la conscience avec un LLM. Pour éviter qu'il s'auto-complaise, utiliser un modèle <em>différent</em> de l'agent principal est souvent plus efficace.
            <br /><br />
            <strong>Modes :</strong>
            <br />• <strong>Défaut</strong> : réutilise le modèle de chat principal (pas d'effort supplémentaire).
            <br />• <strong>Auto</strong> : Gungnir choisit le meilleur modèle low-cost parmi <em>tes</em> providers configurés.
            <br />• <strong>Préréglage</strong> : un modèle curé (2 gratuits, 2 modérés, 1 élevé). Certains préréglages nécessitent un provider spécifique.
            <br />• <strong>Personnalisé</strong> : tu choisis librement provider + nom du modèle.
          </InfoButton>
        </div>

        <div className="rounded-lg p-2 text-[11px]" style={{ background: 'color-mix(in srgb, var(--accent-primary) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent)', color: 'var(--text-secondary)' }}>
          ⚠️ Les préréglages dépendent des providers que tu as connectés. Si aucun préréglage n'est dispo, passe en mode <strong>Auto</strong> ou <strong>Défaut</strong> — le Challenger retombera sur un modèle à faible coût compatible avec ta config.
        </div>

        <div className="flex gap-2 flex-wrap">
          {(['default', 'auto', 'preset', 'custom'] as const).map(m => (
            <button key={m} onClick={() => setLlmMode(m)} disabled={saving || !ch.enabled}
              className="px-3 py-1 rounded text-xs font-medium"
              style={{
                background: (llm.mode || 'default') === m ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                color: (llm.mode || 'default') === m ? 'white' : 'var(--text-primary)',
                border: '1px solid var(--border)',
                opacity: saving || !ch.enabled ? 0.5 : 1,
                cursor: saving || !ch.enabled ? 'not-allowed' : 'pointer',
              }}>
              {m === 'default' ? 'Défaut' : m === 'auto' ? 'Auto' : m === 'preset' ? 'Préréglage' : 'Personnalisé'}
            </button>
          ))}
        </div>

        {llm.mode === 'auto' && llmOptions && (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {llmOptions.auto_pick
              ? <>Modèle qui sera utilisé : <strong style={{ color: 'var(--text-primary)' }}>{llmOptions.auto_pick.provider} / {llmOptions.auto_pick.model}</strong></>
              : <>Aucun provider configuré — le Challenger retombera sur le modèle de chat par défaut.</>
            }
          </div>
        )}

        {llm.mode === 'preset' && llmOptions && (
          <div className="space-y-2">
            {(['free', 'mid', 'high'] as const).map(tier => {
              const items = (llmOptions.presets || []).filter((p: any) => p.tier === tier)
              if (!items.length) return null
              const tierLabel = tier === 'free' ? '🆓 Gratuit / faible coût' : tier === 'mid' ? '💰 Coût modéré' : '💎 Coût élevé'
              return (
                <div key={tier}>
                  <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{tierLabel}</div>
                  <div className="flex gap-2 flex-wrap">
                    {items.map((p: any) => {
                      const selected = llm.provider === p.provider && llm.model === p.model
                      return (
                        <button key={p.id} onClick={() => selectPreset(p)} disabled={saving || !p.available}
                          title={p.available ? p.note : `Nécessite le provider ${p.provider}`}
                          className="px-3 py-1.5 rounded text-xs flex flex-col items-start"
                          style={{
                            background: selected ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                            color: selected ? 'white' : (p.available ? 'var(--text-primary)' : 'var(--text-muted)'),
                            border: '1px solid var(--border)',
                            opacity: p.available ? 1 : 0.45,
                            cursor: p.available ? 'pointer' : 'not-allowed',
                            minWidth: 160,
                          }}>
                          <span className="font-semibold">{p.label}</span>
                          <span className="text-[10px] opacity-80">
                            {p.provider} · {p.available ? 'Dispo' : `Nécessite ${p.provider}`}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {llm.mode === 'custom' && (() => {
          const configuredProviders: string[] = modelCatalog
            ? Object.keys(modelCatalog).filter(p => modelCatalog[p]?.has_api_key)
            : []
          const currentProvider = llm.provider || configuredProviders[0] || ''
          const providerModels: any[] = (modelCatalog?.[currentProvider]?.models) || []
          return (
            <div className="flex gap-2 flex-wrap items-center">
              <select
                value={currentProvider}
                disabled={saving || !ch.enabled || configuredProviders.length === 0}
                onChange={e => patchChallenger({ llm: { ...llm, provider: e.target.value, model: '' } })}
                className="px-2 py-1 rounded text-xs"
                style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', minWidth: 180 }}>
                {configuredProviders.length === 0 && <option value="">(aucun provider configuré)</option>}
                {configuredProviders.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <select
                value={llm.model || ''}
                disabled={saving || !ch.enabled || providerModels.length === 0}
                onChange={e => patchChallenger({ llm: { ...llm, provider: currentProvider, model: e.target.value } })}
                className="px-2 py-1 rounded text-xs"
                style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', flex: 1, minWidth: 260 }}>
                <option value="">(choisir un modèle)</option>
                {providerModels.map((m: any) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}{m.pricing?.tier && m.pricing.tier !== 'unknown' ? ` · ${m.pricing.tier}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )
        })()}

        {llmOptions && llmOptions.configured_providers?.length > 0 && (
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Providers détectés : {llmOptions.configured_providers.join(', ')}
          </div>
        )}
      </div>
      {/* Critical Alerts */}
      {data.critical_findings?.length > 0 && (
        <div className="rounded-xl p-4" style={{ background: 'color-mix(in srgb, #ef4444 8%, var(--bg-secondary))', border: '1px solid color-mix(in srgb, #ef4444 25%, transparent)' }}>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4" style={{ color: '#ef4444' }} />
            <div className="text-xs font-bold uppercase tracking-wider" style={{ color: '#ef4444' }}>
              Alertes critiques ({data.critical_findings.length})
            </div>
          </div>
          <div className="space-y-2">
            {data.critical_findings.map((f: Finding, i: number) => (
              <FindingCard key={i} finding={f} refresh={refresh} />
            ))}
          </div>
        </div>
      )}

      {/* All Findings */}
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
          Découvertes récentes ({data.recent_findings?.length || 0})
        </div>
        <div className="space-y-2">
          {(data.recent_findings || []).slice().reverse().map((f: Finding, i: number) => (
            <FindingCard key={i} finding={f} refresh={refresh} />
          ))}
          {!data.recent_findings?.length && (
            <div className="text-xs py-2" style={{ color: 'var(--text-muted)' }}>
              Aucune découverte — le Challenger n'a pas encore effectué d'audit
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FindingCard({ finding, refresh }: { finding: Finding; refresh?: () => void }) {
  const [busy, setBusy] = useState(false)
  const isResolved = !!finding.resolved_at
  const resolve = async () => {
    if (!finding._sig || busy) return
    setBusy(true)
    try {
      await fetch(`${API}/challenger/finding/${finding._sig}/resolve`, { method: 'POST' })
      refresh?.()
    } finally { setBusy(false) }
  }
  const reopen = async () => {
    if (!finding._sig || busy) return
    setBusy(true)
    try {
      await fetch(`${API}/challenger/finding/${finding._sig}/reopen`, { method: 'POST' })
      refresh?.()
    } finally { setBusy(false) }
  }
  return (
    <div className="px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-tertiary)', opacity: isResolved ? 0.6 : 1 }}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: isResolved ? '#22c55e' : (SEVERITY_COLORS[finding.severity] || '#888') }} />
          <span className="text-[10px] uppercase font-medium" style={{ color: isResolved ? '#22c55e' : (SEVERITY_COLORS[finding.severity] || '#888') }}>
            {finding.type} · {isResolved ? `résolu${finding.resolved_by === 'auto' ? ' (auto)' : ''}` : finding.severity}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{timeAgo(finding.timestamp)}</span>
          {finding._sig && !isResolved && (
            <button onClick={resolve} disabled={busy} title="Marquer comme résolu"
              className="p-0.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50">
              <Check className="w-3 h-3" style={{ color: '#22c55e' }} />
            </button>
          )}
          {finding._sig && isResolved && (
            <button onClick={reopen} disabled={busy} title="Rouvrir"
              className="p-0.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50">
              <X className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
            </button>
          )}
        </div>
      </div>
      <div className="text-xs" style={{ color: 'var(--text-secondary)', textDecoration: isResolved ? 'line-through' : undefined }}>{finding.finding}</div>
      {finding.action_suggested && !isResolved && (
        <div className="text-[10px] mt-1.5 flex items-center gap-1" style={{ color: 'var(--accent-primary)' }}>
          <Lightbulb className="w-3 h-3" /> {finding.action_suggested}
        </div>
      )}
    </div>
  )
}

// ── Simulation Tab ───────────────────────────────────────────────────────────

function SimulationTab({ data, refresh, updateConfig }: any) {
  const [generating, setGenerating] = useState(false)
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)

  const patch = async (updates: any) => {
    setSaving(true)
    try { await updateConfig({ simulation: updates }) }
    finally { setSaving(false) }
  }

  const generateNow = async () => {
    setGenerating(true); setMsg('')
    try {
      const res = await fetch(`${API}/simulation/generate`, { method: 'POST' })
      const j = await res.json()
      if (j.ok) {
        setMsg(j.added > 0 ? `${j.added} scénario(s) généré(s)` : 'Aucun scénario généré')
        await refresh?.()
      } else {
        setMsg(`Erreur : ${j.error || 'inconnue'}`)
      }
    } catch (e: any) {
      setMsg(`Erreur : ${e?.message || 'réseau'}`)
    } finally { setGenerating(false) }
  }

  const simCfg = data?.config?.simulation || {}
  const autoEnabled = !!simCfg.enabled
  const intervalMin = simCfg.interval_minutes ?? 30

  return (
    <div className="space-y-4">
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            Simulations actives ({data.active_simulations?.length || 0})
          </div>
          <button
            onClick={generateNow}
            disabled={generating}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity disabled:opacity-50"
            style={{ background: 'var(--accent-primary)', color: '#fff' }}
          >
            <Sparkles className="w-3.5 h-3.5" />
            {generating ? 'Génération…' : 'Générer des scénarios'}
          </button>
        </div>
        {msg && (
          <div className="text-[11px] mb-3 px-2 py-1.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
            {msg}
          </div>
        )}
        <div className="space-y-2">
          {(data.active_simulations || []).map((sim: Simulation, i: number) => (
            <div key={i} className="px-3 py-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{sim.scenario}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                  style={{
                    background: `color-mix(in srgb, ${sim.probability >= 0.5 ? '#10b981' : '#f59e0b'} 15%, transparent)`,
                    color: sim.probability >= 0.5 ? '#10b981' : '#f59e0b'
                  }}>
                  {(sim.probability * 100).toFixed(0)}%
                </span>
              </div>
              {sim.prepared_response && (
                <div className="text-[11px] mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  💡 {sim.prepared_response}
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
                  Trigger: {sim.trigger}
                </span>
                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{timeAgo(sim.generated_at)}</span>
              </div>
            </div>
          ))}
          {!data.active_simulations?.length && (
            <div className="text-xs py-2" style={{ color: 'var(--text-muted)' }}>
              Aucune simulation — le système n'a pas encore généré de scénarios
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2 mb-2">
          <Info className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
          <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Comment ça marche</div>
        </div>
        <div className="text-xs space-y-1.5" style={{ color: 'var(--text-secondary)' }}>
          {autoEnabled ? (
            <p>Génération automatique activée — un LLM produit 2-3 scénarios probables toutes les <strong>{intervalMin} min</strong>.</p>
          ) : (
            <p>Génération automatique désactivée. Active-la dans les paramètres ci-dessous, ou clique sur <strong>Générer des scénarios</strong> pour un passage manuel.</p>
          )}
          <p>Ce n'est pas de la prédiction — c'est de la <strong>préparation</strong>. Comme imaginer sa journée avant de se lever.</p>
          <p>Si un scénario se matérialise, la réponse préparée est utilisée pour accélérer le traitement.</p>
        </div>
      </div>

      {/* Paramètres simulation */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Paramètres</div>

        <label className="flex items-center justify-between text-xs">
          <span>Génération automatique</span>
          <input type="checkbox" checked={autoEnabled} disabled={saving}
            onChange={e => patch({ ...simCfg, enabled: e.target.checked })} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Intervalle (min)</span>
          <input type="number" min={5} max={1440} value={simCfg.interval_minutes ?? 30}
            disabled={saving || !autoEnabled}
            onChange={e => patch({ ...simCfg, interval_minutes: Math.max(5, Number(e.target.value) || 30) })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Nombre de scénarios par passage</span>
          <input type="number" min={1} max={10} value={simCfg.max_scenarios ?? 3}
            disabled={saving}
            onChange={e => patch({ ...simCfg, max_scenarios: Math.max(1, Number(e.target.value) || 3) })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>
      </div>
    </div>
  )
}

// ── Vector Memory Tab ────────────────────────────────────────────────────────

function VectorTab() {
  const [status, setStatus] = useState<any>(null)
  const [config, setConfig] = useState<any>(null)
  const [testResult, setTestResult] = useState<any>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        fetch(`${API}/vector/status`).then(r => r.json()),
        fetch(`${API}/config`).then(r => r.json()),
      ])
      setStatus(s)
      setConfig(c?.vector_memory || {})
    } catch {}
  }, [])

  useEffect(() => { loadStatus() }, [loadStatus])

  const testConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await fetch(`${API}/vector/test`, { method: 'POST' })
      setTestResult(await r.json())
    } catch (e: any) {
      setTestResult({ error: e.message })
    }
    setTesting(false)
  }

  const saveConfig = async () => {
    setSaving(true)
    try {
      await fetch(`${API}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { vector_memory: config } }),
      })
      // Re-init vector memory with new config
      await fetch(`${API}/vector/init`, { method: 'POST' })
      await loadStatus()
    } catch {}
    setSaving(false)
  }

  const doSearch = async () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    try {
      const r = await fetch(`${API}/vector/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery, top_k: 10 }),
      })
      const data = await r.json()
      setSearchResults(data.results || [])
    } catch {}
    setSearching(false)
  }

  const updateField = (field: string, value: string) => {
    setConfig((prev: any) => ({ ...prev, [field]: value }))
  }

  const card = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }
  const inputStyle = { background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: 8, padding: '6px 10px', width: '100%', fontSize: 'var(--font-sm)' }
  const selectStyle = { ...inputStyle, cursor: 'pointer' as const }

  if (!config) return <div style={{ color: 'var(--text-muted)' }}>Chargement...</div>

  const provider = config.vector_provider || 'none'

  return (
    <div className="space-y-4">
      {/* ── Status ─────────────────────────────────────────── */}
      <div style={card}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
            <span className="text-sm font-semibold">Mémoire vectorielle</span>
            <InfoButton>
              <strong>La mémoire vectorielle</strong> est un rappel sémantique de longue durée : tes conversations, tes notes, tes documents sont transformés en vecteurs numériques et stockés dans une base (Qdrant, Chroma…).
              <br /><br />
              Quand tu poses une question, l'agent peut rechercher dans cette mémoire les bouts de contexte les plus pertinents et les injecter dans sa réponse — même s'ils datent d'il y a plusieurs mois.
              <br /><br />
              Sans elle, l'agent oublie tout ce qui sort de la conversation courante. Avec elle, il peut se souvenir de tes projets, de tes préférences, de tes échanges passés.
            </InfoButton>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium"
              style={{
                background: status?.ready ? 'color-mix(in srgb, #22c55e 15%, transparent)' : status?.enabled ? 'color-mix(in srgb, #f59e0b 15%, transparent)' : 'color-mix(in srgb, var(--text-muted) 15%, transparent)',
                color: status?.ready ? '#22c55e' : status?.enabled ? '#f59e0b' : 'var(--text-muted)',
              }}>
              {status?.ready ? 'Connecté' : status?.enabled ? 'Déconnecté' : 'Désactivé'}
            </span>
          </div>
        </div>

        {status?.ready && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <div className="rounded-lg p-2.5" style={{ background: 'var(--bg-secondary)' }}>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Provider</div>
              <div className="text-sm font-bold" style={{ color: 'var(--accent-primary)' }}>{status.provider}</div>
            </div>
            <div className="rounded-lg p-2.5" style={{ background: 'var(--bg-secondary)' }}>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Vecteurs</div>
              <div className="text-sm font-bold" style={{ color: 'var(--accent-tertiary)' }}>{status.total_vectors || 0}</div>
            </div>
            <div className="rounded-lg p-2.5" style={{ background: 'var(--bg-secondary)' }}>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Pensées</div>
              <div className="text-sm font-bold">{status.collections?.consciousness_thoughts || 0}</div>
            </div>
            <div className="rounded-lg p-2.5" style={{ background: 'var(--bg-secondary)' }}>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Mémoires</div>
              <div className="text-sm font-bold">{status.collections?.consciousness_memories || 0}</div>
            </div>
          </div>
        )}
      </div>

      {/* ── Configuration ──────────────────────────────────── */}
      <div style={card}>
        <div className="flex items-center gap-2 mb-4">
          <Plug className="w-4 h-4" style={{ color: 'var(--accent-secondary)' }} />
          <span className="text-sm font-semibold">Configuration</span>
        </div>

        <div className="space-y-4">
          {/* Vector Provider */}
          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Vector Store</label>
            <select value={provider} onChange={e => updateField('vector_provider', e.target.value)} style={selectStyle}>
              <option value="none">Désactivé</option>
              <option value="chromadb">ChromaDB (local)</option>
              <option value="pinecone">Pinecone (cloud)</option>
              <option value="qdrant">Qdrant (self-hosted / cloud)</option>
            </select>
          </div>

          {/* Provider-specific settings */}
          {provider === 'chromadb' && (
            <div>
              <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Dossier de persistance</label>
              <input value={config.chroma_persist_dir || ''} onChange={e => updateField('chroma_persist_dir', e.target.value)} style={inputStyle} placeholder="data/consciousness/chroma_db" />
            </div>
          )}

          {provider === 'pinecone' && (
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>API Key</label>
                <input type="password" value={config.pinecone_api_key || ''} onChange={e => updateField('pinecone_api_key', e.target.value)} style={inputStyle} placeholder="pk-..." />
              </div>
              <div>
                <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Environment</label>
                <input value={config.pinecone_environment || ''} onChange={e => updateField('pinecone_environment', e.target.value)} style={inputStyle} placeholder="us-east-1" />
              </div>
              <div>
                <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Index</label>
                <input value={config.pinecone_index || ''} onChange={e => updateField('pinecone_index', e.target.value)} style={inputStyle} placeholder="gungnir-consciousness" />
              </div>
            </div>
          )}

          {provider === 'qdrant' && (
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>URL</label>
                <input value={config.qdrant_url || ''} onChange={e => updateField('qdrant_url', e.target.value)} style={inputStyle} placeholder="http://localhost:6333" />
              </div>
              <div>
                <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>API Key (optionnel)</label>
                <input type="password" value={config.qdrant_api_key || ''} onChange={e => updateField('qdrant_api_key', e.target.value)} style={inputStyle} placeholder="Laisser vide si pas d'auth" />
              </div>
            </div>
          )}

          {provider !== 'none' && (
            <>
              {/* Embedding Config */}
              <div className="pt-3" style={{ borderTop: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--accent-tertiary)' }} />
                  <span className="text-xs font-semibold">Embedding</span>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Provider d'embedding</label>
                    <select value={config.embedding_provider || 'openai'} onChange={e => updateField('embedding_provider', e.target.value)} style={selectStyle}>
                      <option value="openai">OpenAI</option>
                      <option value="google">Google</option>
                      <option value="mistral">Mistral</option>
                      <option value="deepseek">DeepSeek</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Modèle</label>
                    <input value={config.embedding_model || ''} onChange={e => updateField('embedding_model', e.target.value)} style={inputStyle}
                      placeholder={
                        config.embedding_provider === 'google' ? 'gemini-embedding-001'
                        : config.embedding_provider === 'mistral' ? 'mistral-embed'
                        : config.embedding_provider === 'deepseek' ? 'deepseek-embed (à confirmer)'
                        : 'text-embedding-3-small'
                      } />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>API Key embedding</label>
                    <input type="password" value={config.embedding_api_key || ''} onChange={e => updateField('embedding_api_key', e.target.value)} style={inputStyle} placeholder="sk-... ou AIza..." />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Dimension</label>
                    <input type="number" value={config.embedding_dimension || 1536} onChange={e => updateField('embedding_dimension', e.target.value)} style={inputStyle} />
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
                <button onClick={saveConfig} disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{ background: 'var(--accent-primary)', color: '#fff', opacity: saving ? 0.6 : 1 }}>
                  <Save className="w-3.5 h-3.5" />{saving ? 'Enregistrement...' : 'Enregistrer & connecter'}
                </button>
                <button onClick={testConnection} disabled={testing}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', opacity: testing ? 0.6 : 1 }}>
                  <Plug className="w-3.5 h-3.5" />{testing ? 'Test...' : 'Tester la connexion'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Test Results ───────────────────────────────────── */}
      {testResult && (
        <div style={card}>
          <div className="flex items-center gap-2 mb-3">
            <Activity className="w-4 h-4" style={{ color: testResult.embedding && testResult.store && testResult.search ? '#22c55e' : '#ef4444' }} />
            <span className="text-sm font-semibold">Résultat du test</span>
          </div>
          <div className="space-y-2">
            {['embedding', 'store', 'search'].map(step => (
              <div key={step} className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
                <span className="text-xs capitalize">{step === 'embedding' ? 'Génération embedding' : step === 'store' ? 'Connexion store' : 'Écriture + lecture'}</span>
                <div className="flex items-center gap-2">
                  {testResult[step] ? (
                    <Check className="w-4 h-4" style={{ color: '#22c55e' }} />
                  ) : (
                    <X className="w-4 h-4" style={{ color: '#ef4444' }} />
                  )}
                  {testResult[`${step}_error`] && (
                    <span className="text-[10px]" style={{ color: '#ef4444' }}>{testResult[`${step}_error`]}</span>
                  )}
                </div>
              </div>
            ))}
            {testResult.dimension && (
              <div className="text-[10px] px-3" style={{ color: 'var(--text-muted)' }}>Dimension: {testResult.dimension}</div>
            )}
          </div>
        </div>
      )}

      {/* ── Semantic Search ─────────────────────────────────── */}
      {status?.ready && (
        <div style={card}>
          <div className="flex items-center gap-2 mb-3">
            <Search className="w-4 h-4" style={{ color: 'var(--accent-tertiary)' }} />
            <span className="text-sm font-semibold">Recherche sémantique</span>
          </div>
          <div className="flex gap-2 mb-3">
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
              style={inputStyle} placeholder="Rechercher dans la mémoire de conscience..." />
            <button onClick={doSearch} disabled={searching}
              className="px-3 py-2 rounded-lg text-xs font-medium flex-shrink-0 transition-colors"
              style={{ background: 'var(--accent-primary)', color: '#fff', opacity: searching ? 0.6 : 1 }}>
              <Search className="w-3.5 h-3.5" />
            </button>
          </div>
          {searchResults.length > 0 && (
            <div className="space-y-2">
              {searchResults.map((r, i) => (
                <div key={i} className="px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                      style={{ background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', color: 'var(--accent-primary)' }}>
                      {r.collection?.replace('consciousness_', '') || 'unknown'}
                    </span>
                    <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                      {(r.score * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{r.text}</p>
                  {r.metadata?.type && (
                    <span className="text-[10px] mt-1 inline-block" style={{ color: 'var(--text-muted)' }}>Type: {r.metadata.type}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {searchResults.length === 0 && searchQuery && !searching && (
            <div className="text-xs text-center py-3" style={{ color: 'var(--text-muted)' }}>Aucun résultat</div>
          )}
        </div>
      )}

      {/* ── Info ────────────────────────────────────────────── */}
      <div style={{ ...card, background: 'color-mix(in srgb, var(--accent-primary) 5%, var(--bg-card))' }}>
        <div className="flex items-center gap-2 mb-2">
          <Info className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--accent-primary)' }}>Comment ça marche</span>
        </div>
        <div className="text-xs space-y-1.5" style={{ color: 'var(--text-secondary)' }}>
          <p>La mémoire vectorielle permet à la conscience de <strong>retrouver des souvenirs par sens</strong> plutôt que par date.</p>
          <p>Chaque pensée, mémoire de travail et interaction est convertie en vecteur via un modèle d'embedding, puis stockée dans une base vectorielle.</p>
          <p><strong>ChromaDB</strong> : local, zéro-config, idéal pour le dev. <strong>Pinecone</strong> : cloud managé, production. <strong>Qdrant</strong> : auto-hébergeable, performant.</p>
          <p>La recherche sémantique permet ensuite de rappeler des souvenirs pertinents pour enrichir le contexte de la conscience.</p>
        </div>
      </div>
    </div>
  )
}

// ── Safety Banner ────────────────────────────────────────────────────────────

function SafetyBanner({ safety, onReactivate, reactivating }: {
  safety: Safety
  onReactivate: () => void
  reactivating: boolean
}) {
  const palette: Record<number, { bg: string; border: string; fg: string; label: string }> = {
    1: { bg: '#f59e0b', border: '#f59e0b', fg: '#fff', label: 'Tension ressentie' },
    2: { bg: '#ef4444', border: '#ef4444', fg: '#fff', label: 'Mode prudent' },
    3: { bg: '#7f1d1d', border: '#7f1d1d', fg: '#fff', label: 'Mise en pause' },
  }
  const p = palette[safety.tier] || palette[1]
  const Icon = safety.tier === 3 ? ShieldAlert : AlertTriangle
  return (
    <div className="rounded-xl p-4 flex items-start justify-between gap-3"
      style={{
        background: `color-mix(in srgb, ${p.bg} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${p.border} 35%, transparent)`,
      }}>
      <div className="flex items-start gap-3">
        <Icon className="w-5 h-5 mt-0.5 shrink-0" style={{ color: p.bg }} />
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: p.bg }}>
            {p.label}
          </div>
          <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {safety.message}
          </div>
          {safety.shutdown_at && (
            <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Pause initiée {timeAgo(safety.shutdown_at)}
            </div>
          )}
        </div>
      </div>
      {safety.tier === 3 && safety.manual_reactivation_required && (
        <button onClick={onReactivate} disabled={reactivating}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors shrink-0"
          style={{ background: p.bg, color: p.fg }}>
          <Power className="w-3.5 h-3.5" />
          {reactivating ? 'Réactivation…' : 'Réactiver'}
        </button>
      )}
    </div>
  )
}

// ── Goals Tab ────────────────────────────────────────────────────────────────

const GOAL_STATUS_COLORS: Record<string, string> = {
  proposed: '#f59e0b',
  active: '#10b981',
  completed: '#6366f1',
  abandoned: '#6b7280',
}

const GOAL_ORIGIN_LABELS: Record<string, string> = {
  manual: 'Manuel',
  need_recurrence: 'Besoin persistant',
  challenger_pattern: 'Pattern Challenger',
  score_decline: 'Tendance scores',
}

function GoalsTab({ data, refresh, updateConfig }: any) {
  const goalsCfg = data?.config?.goals || {}
  const active = (data?.active_goals || []) as Goal[]
  const all = (data?.goals || []) as Goal[]
  const archived = all.filter(g => g.status === 'completed' || g.status === 'abandoned')

  const [proposing, setProposing] = useState(false)
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [adding, setAdding] = useState(false)

  const patch = async (updates: any) => {
    setSaving(true)
    try { await updateConfig({ goals: updates }) }
    finally { setSaving(false) }
  }

  const proposeNow = async () => {
    setProposing(true); setMsg('')
    try {
      const r = await fetch(`${API}/goals/propose-now`, { method: 'POST' })
      const j = await r.json()
      if (j.ok) {
        setMsg(j.added > 0 ? `${j.added} goal(s) proposé(s)` : 'Aucun goal proposé (pas de signal structurel ou quota atteint)')
        await refresh?.()
      } else {
        setMsg(`Erreur : ${j.error || 'inconnue'}`)
      }
    } catch (e: any) { setMsg(`Erreur : ${e?.message || 'réseau'}`) }
    finally { setProposing(false) }
  }

  const addManual = async () => {
    const title = newTitle.trim()
    if (!title) return
    setAdding(true)
    try {
      const r = await fetch(`${API}/goals/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: newDesc.trim(), linked_needs: [] }),
      })
      const j = await r.json()
      if (j.ok) { setNewTitle(''); setNewDesc(''); await refresh?.() }
      else setMsg(`Erreur : ${j.error || 'inconnue'}`)
    } finally { setAdding(false) }
  }

  const updateGoal = async (id: string, body: any) => {
    await fetch(`${API}/goals/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal_id: id, ...body }),
    })
    await refresh?.()
  }

  const removeGoal = async (id: string) => {
    if (!confirm('Supprimer ce goal définitivement ?')) return
    await fetch(`${API}/goals/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal_id: id }),
    })
    await refresh?.()
  }

  const card: React.CSSProperties = {
    background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 12, padding: 16,
  }

  return (
    <div className="space-y-4">
      {/* Intro */}
      <div className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        <span>Objectifs moyen/long terme</span>
        <InfoButton>
          <strong>Les goals</strong> sont des objectifs persistants sur plusieurs jours, dérivés automatiquement de signaux structurels :
          <br /><br />
          • <strong>Besoin persistant</strong> : un besoin dont l'urgence reste haute tick après tick.
          <br />• <strong>Pattern Challenger</strong> : le même type de finding revient ≥ 3 fois.
          <br />• <strong>Tendance scores</strong> : la moyenne baisse sur une dimension spécifique.
          <br /><br />
          Contrairement aux impulsions (action immédiate), les goals orientent l'agent sur la durée et apparaissent dans son system prompt.
        </InfoButton>
      </div>

      {/* Header action */}
      <div style={card}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            Goals actifs ({active.length})
          </div>
          <button onClick={proposeNow} disabled={proposing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity disabled:opacity-50"
            style={{ background: 'var(--accent-primary)', color: '#fff' }}>
            <Sparkles className="w-3.5 h-3.5" />
            {proposing ? 'Analyse…' : 'Proposer des goals maintenant'}
          </button>
        </div>
        {msg && (
          <div className="text-[11px] mb-3 px-2 py-1.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
            {msg}
          </div>
        )}
        <div className="space-y-2">
          {active.length === 0 && (
            <div className="text-xs py-2" style={{ color: 'var(--text-muted)' }}>
              Aucun goal actif. Tant que des signaux structurels n'apparaissent pas (besoins persistants, findings récurrents), la conscience ne propose rien de lui-même.
            </div>
          )}
          {active.map(g => (
            <GoalCard key={g.id} goal={g} onUpdate={updateGoal} onRemove={removeGoal} />
          ))}
        </div>
      </div>

      {/* Add manual */}
      <div style={card}>
        <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
          Ajouter un goal manuel
        </div>
        <div className="space-y-2">
          <input value={newTitle} onChange={e => setNewTitle(e.target.value)}
            placeholder="Titre court et actionnable…"
            className="w-full px-3 py-2 rounded-lg text-sm outline-none"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
          <textarea value={newDesc} onChange={e => setNewDesc(e.target.value)}
            placeholder="Description (optionnel) — pourquoi ce goal et ce qu'il implique"
            rows={2}
            className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
          <div className="flex justify-end">
            <button onClick={addManual} disabled={adding || !newTitle.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
              style={{ background: 'var(--accent-primary)', color: '#fff' }}>
              <Plus className="w-3.5 h-3.5" /> Ajouter
            </button>
          </div>
        </div>
      </div>

      {/* Archive */}
      {archived.length > 0 && (
        <div style={card}>
          <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
            Archive ({archived.length})
          </div>
          <div className="space-y-1.5">
            {archived.slice(0, 20).map(g => (
              <div key={g.id} className="flex items-center justify-between px-3 py-2 rounded-lg text-xs"
                style={{ background: 'var(--bg-tertiary)' }}>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: GOAL_STATUS_COLORS[g.status] }} />
                  <span style={{ color: 'var(--text-secondary)' }}>{g.title}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] capitalize" style={{ color: GOAL_STATUS_COLORS[g.status] }}>
                    {g.status}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>{timeAgo(g.updated_at)}</span>
                  <button onClick={() => removeGoal(g.id)} className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Paramètres */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Paramètres</div>

        <label className="flex items-center justify-between text-xs">
          <span>Génération automatique</span>
          <input type="checkbox" checked={goalsCfg.enabled !== false} disabled={saving}
            onChange={e => patch({ ...goalsCfg, enabled: e.target.checked })} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Intervalle de vérification (heures)</span>
          <input type="number" min={1} max={168} value={goalsCfg.check_interval_hours ?? 24}
            disabled={saving || goalsCfg.enabled === false}
            onChange={e => patch({ ...goalsCfg, check_interval_hours: Math.max(1, Number(e.target.value) || 24) })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Max goals actifs simultanés</span>
          <input type="number" min={1} max={20} value={goalsCfg.max_active_goals ?? 5}
            disabled={saving}
            onChange={e => patch({ ...goalsCfg, max_active_goals: Math.max(1, Number(e.target.value) || 5) })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Urgence min. besoin persistant</span>
          <input type="number" min={0.1} max={1.0} step={0.05} value={goalsCfg.persistent_need_min_urgency ?? 0.5}
            disabled={saving}
            onChange={e => patch({ ...goalsCfg, persistent_need_min_urgency: Math.max(0.1, Math.min(1.0, Number(e.target.value) || 0.5)) })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Occurrences min. finding récurrent</span>
          <input type="number" min={2} max={20} value={goalsCfg.recurrent_finding_min_count ?? 3}
            disabled={saving}
            onChange={e => patch({ ...goalsCfg, recurrent_finding_min_count: Math.max(2, Number(e.target.value) || 3) })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>
      </div>
    </div>
  )
}

function GoalCard({ goal, onUpdate, onRemove }: { goal: Goal; onUpdate: (id: string, body: any) => void; onRemove: (id: string) => void }) {
  const color = GOAL_STATUS_COLORS[goal.status] || '#6b7280'
  const progress = Math.max(0, Math.min(1, goal.progress || 0))

  return (
    <div className="px-3 py-3 rounded-lg" style={{
      background: 'var(--bg-tertiary)',
      border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
    }}>
      <div className="flex items-start justify-between mb-1.5">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Target className="w-4 h-4 flex-shrink-0" style={{ color }} />
          <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{goal.title}</span>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium capitalize whitespace-nowrap"
          style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}>
          {goal.status}
        </span>
      </div>

      {goal.description && (
        <div className="text-[11px] mb-2" style={{ color: 'var(--text-secondary)' }}>
          {goal.description}
        </div>
      )}

      <div className="h-1.5 rounded-full mb-2" style={{ background: 'var(--bg-primary)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${progress * 100}%`, background: color }} />
      </div>

      <div className="flex items-center justify-between text-[10px]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
            {GOAL_ORIGIN_LABELS[goal.origin] || goal.origin}
          </span>
          {(goal.linked_needs || []).map(n => (
            <span key={n} className="px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
              {n}
            </span>
          ))}
          <span style={{ color: 'var(--text-muted)' }}>{timeAgo(goal.updated_at)}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {goal.status === 'proposed' && (
            <button onClick={() => onUpdate(goal.id, { status: 'active' })}
              className="px-2 py-0.5 rounded" style={{ background: '#10b981', color: '#fff' }}>
              Activer
            </button>
          )}
          {goal.status === 'active' && (
            <>
              <input type="number" min={0} max={100} step={5} value={Math.round(progress * 100)}
                onChange={e => onUpdate(goal.id, { progress: Math.max(0, Math.min(1, Number(e.target.value) / 100)) })}
                className="w-14 px-1 py-0.5 rounded text-[10px]"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              <button onClick={() => onUpdate(goal.id, { status: 'completed' })}
                className="px-2 py-0.5 rounded" style={{ background: '#6366f1', color: '#fff' }}>
                Terminer
              </button>
            </>
          )}
          {(goal.status === 'proposed' || goal.status === 'active') && (
            <button onClick={() => onUpdate(goal.id, { status: 'abandoned' })}
              className="px-2 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
              Abandon
            </button>
          )}
          <button onClick={() => onRemove(goal.id)}
            className="p-1 rounded" style={{ color: 'var(--text-muted)' }}>
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {goal.origin_evidence && goal.origin_evidence.length > 0 && (
        <div className="mt-2 pt-2 border-t text-[10px]"
          style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
          {goal.origin_evidence.map((e, i) => (
            <div key={i}>• {e}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Memories Tab (mémoire long-terme / consolidations) ──────────────────────

function MemoriesTab({ data, updateConfig }: any) {
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [consolidating, setConsolidating] = useState(false)
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)

  const wmCfg = data?.config?.working_memory || {}
  const cons = wmCfg.consolidation || {}

  const patch = async (updates: any) => {
    setSaving(true)
    try { await updateConfig({ working_memory: updates }) }
    finally { setSaving(false) }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`${API}/memory/consolidations?limit=50`)
      const j = await r.json()
      setItems(j.items || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const consolidateNow = async () => {
    setConsolidating(true)
    setMsg('')
    try {
      const r = await fetch(`${API}/memory/consolidate-now`, { method: 'POST' })
      const j = await r.json()
      if (j.ok && j.consolidated) {
        setMsg('Consolidation effectuée.')
        await load()
      } else if (j.ok) {
        setMsg('Pas assez d\'éléments à consolider pour le moment.')
      } else {
        setMsg(`Erreur : ${j.error || 'inconnue'}`)
      }
    } finally {
      setConsolidating(false)
    }
  }

  const card: React.CSSProperties = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: '12px',
    padding: '16px',
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Heart className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
            Mémoire long-terme
          </h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Consolidations périodiques de ce que la conscience retient d'important — y compris les passages difficiles.
          </p>
        </div>
        <button onClick={consolidateNow} disabled={consolidating}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          <RefreshCw className={`w-3.5 h-3.5 ${consolidating ? 'animate-spin' : ''}`} />
          Consolider maintenant
        </button>
      </div>

      {msg && (
        <div className="text-xs p-2 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>{msg}</div>
      )}

      {/* Paramètres consolidation */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          <span>Paramètres consolidation</span>
          <InfoButton>
            Un LLM résume périodiquement la mémoire de travail + pensées + feedback en un paragraphe narratif stocké en vector long-terme. N'efface pas la working memory (le TTL s'en charge).
          </InfoButton>
        </div>

        <label className="flex items-center justify-between text-xs">
          <span>Consolidation automatique</span>
          <input type="checkbox" checked={cons.enabled !== false} disabled={saving}
            onChange={e => patch({ ...wmCfg, consolidation: { ...cons, enabled: e.target.checked } })} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Intervalle (heures)</span>
          <input type="number" min={1} max={168} value={cons.interval_hours ?? 12}
            disabled={saving || cons.enabled === false}
            onChange={e => patch({ ...wmCfg, consolidation: { ...cons, interval_hours: Math.max(1, Number(e.target.value) || 12) } })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>

        <label className="flex items-center justify-between text-xs gap-3">
          <span>Items min. pour consolider</span>
          <input type="number" min={1} max={50} value={cons.min_items ?? 3}
            disabled={saving || cons.enabled === false}
            onChange={e => patch({ ...wmCfg, consolidation: { ...cons, min_items: Math.max(1, Number(e.target.value) || 3) } })}
            className="w-20 px-2 py-1 rounded text-xs"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </label>
      </div>

      {loading ? (
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
          <Brain className="w-6 h-6 animate-pulse mx-auto" />
        </div>
      ) : items.length === 0 ? (
        <div style={card}>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Aucune consolidation pour le moment. Elles apparaissent ici après que la conscience
            ait eu le temps d'accumuler des échanges (environ toutes les 12 heures).
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item, i) => (
            <div key={item.id || i} style={card}>
              <div className="flex items-start justify-between mb-2">
                <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                  {item.created_at ? timeAgo(item.created_at) : '—'}
                </span>
                {item.key && (
                  <span className="text-[10px] px-2 py-0.5 rounded"
                    style={{
                      background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                      color: 'var(--accent-primary)',
                    }}>
                    {item.key}
                  </span>
                )}
              </div>
              <div className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
                {item.content || <span style={{ color: 'var(--text-muted)' }}>(contenu vide)</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Shared Components ────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: string | number; color: string }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-3.5 h-3.5" style={{ color }} />
        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</span>
      </div>
      <div className="text-lg font-bold" style={{ color }}>{value}</div>
    </div>
  )
}
