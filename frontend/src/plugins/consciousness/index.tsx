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
  BarChart3, Layers, MessageSquare, Radio, Database, Search, Plug, Save
} from 'lucide-react'

const API = '/api/plugins/consciousness'

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
  const [tab, setTab] = useState<'overview' | 'volition' | 'thoughts' | 'reward' | 'challenger' | 'simulation' | 'vector'>('overview')
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
    { id: 'vector', label: 'Mémoire vectorielle', icon: Database },
  ] as const

  return (
    <div className="flex-1 h-screen overflow-y-auto p-6" style={{ color: 'var(--text-primary)' }}>
      <div className="max-w-6xl mx-auto space-y-6">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Brain className="w-7 h-7" style={{ color: data.enabled ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
            <div>
              <h1 className="text-xl font-bold">Conscience v3</h1>
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

        {/* ── Tabs ────────────────────────────────────────────────────── */}
        <div className="flex gap-1 overflow-x-auto pb-1">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id as any)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors"
              style={tab === t.id
                ? { background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', color: 'var(--accent-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' }
                : { color: 'var(--text-muted)', border: '1px solid transparent' }}>
              <t.icon className="w-3.5 h-3.5" />{t.label}
            </button>
          ))}
        </div>

        {/* ── Tab Content ─────────────────────────────────────────────── */}

        {tab === 'overview' && <OverviewTab data={data} setMood={setMood} setLevel={setLevel}
          newQuestion={newQuestion} setNewQuestion={setNewQuestion} addQuestion={addQuestion}
          removeQuestion={removeQuestion} resetAll={resetAll} />}

        {tab === 'volition' && <VolitionTab data={data} resetVolition={resetVolition} />}

        {tab === 'thoughts' && <ThoughtsTab data={data} newThought={newThought}
          setNewThought={setNewThought} addThought={addThought} />}

        {tab === 'reward' && <RewardTab data={data} />}

        {tab === 'challenger' && <ChallengerTab data={data} />}

        {tab === 'simulation' && <SimulationTab data={data} />}

        {tab === 'vector' && <VectorTab />}

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

function VolitionTab({ data, resetVolition }: any) {
  return (
    <div className="space-y-4">
      {/* Pyramid Visual */}
      <div className="rounded-xl p-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Pyramide de Besoins</div>
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
                <div className="flex justify-between mt-1">
                  <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                    Score: {d.score.toFixed(2)}
                  </span>
                  <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                    {d.last_fulfilled ? `Satisfait ${timeAgo(d.last_fulfilled)}` : 'Jamais satisfait'}
                  </span>
                </div>
                {d.triggers?.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {d.triggers.map((t: string) => (
                      <span key={t} className="text-[8px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
                        {t}
                      </span>
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
        <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>Ajouter une pensée</div>
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

function RewardTab({ data }: any) {
  const summary = data.score_summary || {}
  const TrendIcon = summary.trend === 'improving' ? TrendingUp : summary.trend === 'declining' ? TrendingDown : Minus
  const trendColor = summary.trend === 'improving' ? '#10b981' : summary.trend === 'declining' ? '#ef4444' : 'var(--text-muted)'

  return (
    <div className="space-y-4">
      {/* Summary */}
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
    </div>
  )
}

// ── Challenger Tab ────────────────────────────────────────────────────────────

function ChallengerTab({ data }: any) {
  return (
    <div className="space-y-4">
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
              <FindingCard key={i} finding={f} />
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
            <FindingCard key={i} finding={f} />
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

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <div className="px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: SEVERITY_COLORS[finding.severity] || '#888' }} />
          <span className="text-[10px] uppercase font-medium" style={{ color: SEVERITY_COLORS[finding.severity] || '#888' }}>
            {finding.type} · {finding.severity}
          </span>
        </div>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{timeAgo(finding.timestamp)}</span>
      </div>
      <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{finding.finding}</div>
      {finding.action_suggested && (
        <div className="text-[10px] mt-1.5 flex items-center gap-1" style={{ color: 'var(--accent-primary)' }}>
          <Lightbulb className="w-3 h-3" /> {finding.action_suggested}
        </div>
      )}
    </div>
  )
}

// ── Simulation Tab ───────────────────────────────────────────────────────────

function SimulationTab({ data }: any) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
          Simulations actives ({data.active_simulations?.length || 0})
        </div>
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
          <p>À chaque heartbeat, la conscience génère 2-3 scénarios probables pour les prochaines heures.</p>
          <p>Ce n'est pas de la prédiction — c'est de la <strong>préparation</strong>. Comme imaginer sa journée avant de se lever.</p>
          <p>Si un scénario se matérialise, la réponse préparée est utilisée pour accélérer le traitement.</p>
        </div>
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
  const inputStyle = { background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: 8, padding: '6px 10px', width: '100%', fontSize: 12 }
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
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Modèle</label>
                    <input value={config.embedding_model || ''} onChange={e => updateField('embedding_model', e.target.value)} style={inputStyle}
                      placeholder={config.embedding_provider === 'google' ? 'gemini-embedding-001' : 'text-embedding-3-small'} />
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
