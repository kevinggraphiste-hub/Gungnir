/**
 * Gungnir Plugin — Analytics Dashboard
 * Full cost tracking, trends, budgets, heatmap, and exports.
 * Self-contained — only depends on recharts + CSS variables from core themes.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  AreaChart, Area, PieChart, Pie, Cell, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts'

// ── Types ────────────────────────────────────────────────────────────────────

interface Summary {
  total_cost: number
  total_tokens: number
  message_count: number
  avg_cost_per_message: number
}

interface ModelBreakdown {
  model: string
  total_cost: number
  total_tokens: number
  message_count: number
}

interface ProviderBreakdown {
  provider: string
  total_cost: number
  total_tokens: number
  message_count: number
}

interface TimeEntry {
  date?: string
  week?: string
  month?: string
  year?: string
  cost: number
  tokens: number
  messages: number
}

interface HeatmapEntry {
  date: string
  count: number
  cost: number
}

interface ConversationCost {
  conversation_id: number
  title: string
  total_cost: number
  total_tokens: number
  message_count: number
  last_message: string | null
}

interface BudgetSettings {
  monthly_limit: number | null
  weekly_limit: number | null
  alert_80: boolean
  alert_90: boolean
  alert_100: boolean
  block_on_limit: boolean
}

interface ProviderBudget {
  id: number
  provider: string
  monthly_limit: number | null
  weekly_limit: number | null
}

interface BudgetCheck {
  alerts: Array<{ level: number; scope: string; percent: number; cost: number; limit: number }>
  should_block: boolean
  block_reason: string
}

// ── API helper ───────────────────────────────────────────────────────────────

const API = '/api/plugins/analytics'

function getCurrentUserId(): number | null {
  try {
    const saved = localStorage.getItem('gungnir_current_user')
    if (saved) {
      const user = JSON.parse(saved)
      return user?.id ?? null
    }
  } catch {}
  return null
}

function withUser(path: string): string {
  const uid = getCurrentUserId()
  if (uid === null) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}user_id=${uid}`
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${withUser(path)}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  return res.json()
}

// ── Chart colors ─────────────────────────────────────────────────────────────

const COLORS = [
  '#dc2626', '#f97316', '#f59e0b', '#22c55e', '#3b82f6',
  '#8b5cf6', '#ec4899', '#14b8a6', '#6366f1', '#e11d48',
]

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(3)}`
  if (n >= 0.001) return `$${n.toFixed(4)}`
  return `$${n.toFixed(6)}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtDate(d: string): string {
  if (!d) return ''
  const parts = d.split('-')
  if (parts.length === 3) return `${parts[2]}/${parts[1]}`
  return d
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'trends' | 'models' | 'budget' | 'conversations'

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Vue globale' },
  { key: 'trends', label: 'Tendances' },
  { key: 'models', label: 'Modeles' },
  { key: 'budget', label: 'Budget' },
  { key: 'conversations', label: 'Conversations' },
]

// ── Custom Tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '8px 12px', fontSize: 12,
    }}>
      <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: p.color }}>
          {p.name}: {p.name.includes('cost') || p.name === 'Cost' ? fmtCost(p.value) : fmtTokens(p.value)}
        </div>
      ))}
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function AnalyticsPlugin() {
  const [tab, setTab] = useState<Tab>('overview')
  const [loading, setLoading] = useState(true)

  // Data
  const [summary, setSummary] = useState<Summary>({ total_cost: 0, total_tokens: 0, message_count: 0, avg_cost_per_message: 0 })
  const [byModel, setByModel] = useState<ModelBreakdown[]>([])
  const [byProvider, setByProvider] = useState<ProviderBreakdown[]>([])
  const [daily, setDaily] = useState<TimeEntry[]>([])
  const [weekly, setWeekly] = useState<TimeEntry[]>([])
  const [monthly, setMonthly] = useState<TimeEntry[]>([])
  const [heatmap, setHeatmap] = useState<HeatmapEntry[]>([])
  const [conversations, setConversations] = useState<ConversationCost[]>([])
  const [budget, setBudget] = useState<BudgetSettings>({ monthly_limit: null, weekly_limit: null, alert_80: true, alert_90: true, alert_100: true, block_on_limit: false })
  const [budgetCheck, setBudgetCheck] = useState<BudgetCheck>({ alerts: [], should_block: false, block_reason: '' })
  const [providerBudgets, setProviderBudgets] = useState<ProviderBudget[]>([])
  const [trendPeriod, setTrendPeriod] = useState<'day' | 'week' | 'month'>('day')

  // Budget edit state
  const [editBudget, setEditBudget] = useState(false)
  const [budgetForm, setBudgetForm] = useState({ monthly_limit: '', weekly_limit: '' })

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const arr = <T,>(v: T | unknown): T extends any[] ? T : never[] => (Array.isArray(v) ? v : []) as any

      const [s, m, p, d, w, mo, h, c, b, bc, pb] = await Promise.all([
        apiFetch<Summary>('/summary').catch(() => null),
        apiFetch<ModelBreakdown[]>('/by-model').catch(() => []),
        apiFetch<ProviderBreakdown[]>('/by-provider').catch(() => []),
        apiFetch<TimeEntry[]>('/by-day?days=30').catch(() => []),
        apiFetch<TimeEntry[]>('/by-week?weeks=12').catch(() => []),
        apiFetch<TimeEntry[]>('/by-month?months=12').catch(() => []),
        apiFetch<HeatmapEntry[]>('/heatmap?days=90').catch(() => []),
        apiFetch<ConversationCost[]>('/conversations?limit=50').catch(() => []),
        apiFetch<BudgetSettings>('/budget').catch(() => null),
        apiFetch<BudgetCheck>('/check-budget').catch(() => null),
        apiFetch<ProviderBudget[]>('/provider-budgets').catch(() => []),
      ])
      const defaultSummary = { total_cost: 0, total_tokens: 0, message_count: 0, avg_cost_per_message: 0 }
      const defaultBudget = { monthly_limit: null, weekly_limit: null, alert_80: true, alert_90: true, alert_100: true, block_on_limit: false }
      const defaultCheck = { alerts: [], should_block: false, block_reason: '' }

      setSummary({ ...defaultSummary, ...(s && typeof s === 'object' && !Array.isArray(s) ? s : {}) })
      setByModel(arr(m))
      setByProvider(arr(p))
      setDaily(arr(d))
      setWeekly(arr(w))
      setMonthly(arr(mo))
      setHeatmap(arr(h))
      setConversations(arr(c))
      setBudget({ ...defaultBudget, ...(b && typeof b === 'object' && !Array.isArray(b) ? b : {}) })
      setBudgetCheck({ ...defaultCheck, ...(bc && typeof bc === 'object' && !Array.isArray(bc) ? bc : {}), alerts: Array.isArray((bc as any)?.alerts) ? (bc as any).alerts : [] })
      setProviderBudgets(arr(pb))
    } catch (err) {
      console.error('Analytics load error:', err)
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const trendData = useMemo(() => {
    if (trendPeriod === 'week') return weekly.map(e => ({ label: e.week || '', ...e }))
    if (trendPeriod === 'month') return monthly.map(e => ({ label: e.month || '', ...e }))
    return daily.map(e => ({ label: fmtDate(e.date || ''), ...e }))
  }, [trendPeriod, daily, weekly, monthly])

  const [exportOpen, setExportOpen] = useState(false)

  const handleExport = async (format: 'csv' | 'json' | 'md' | 'html' | 'pdf' = 'csv') => {
    setExportOpen(false)
    // PDF: fetch the styled HTML, create a blob URL and open for browser Print → Save as PDF
    if (format === 'pdf') {
      const res = await fetch(`${API}${withUser('/export/html')}`)
      const htmlContent = await res.text()
      const blob = new Blob([htmlContent], { type: 'text/html' })
      const blobUrl = URL.createObjectURL(blob)
      const printWin = window.open(blobUrl, '_blank')
      if (printWin) {
        printWin.onload = () => {
          setTimeout(() => printWin.print(), 400)
        }
      }
      return
    }
    const endpoint = format === 'csv' ? '/export' : `/export/${format}`
    const res = await fetch(`${API}${withUser(endpoint)}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gungnir_analytics.${format}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const saveBudget = async () => {
    await apiFetch('/budget', {
      method: 'PUT',
      body: JSON.stringify({
        monthly_limit: budgetForm.monthly_limit ? parseFloat(budgetForm.monthly_limit) : null,
        weekly_limit: budgetForm.weekly_limit ? parseFloat(budgetForm.weekly_limit) : null,
        alert_80: budget.alert_80,
        alert_90: budget.alert_90,
        alert_100: budget.alert_100,
        block_on_limit: budget.block_on_limit,
      }),
    })
    setEditBudget(false)
    loadData()
  }

  // ── Styles ───────────────────────────────────────────────────────────────

  const card: React.CSSProperties = {
    background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 12, padding: 20,
  }

  const statCard: React.CSSProperties = {
    ...card, flex: 1, minWidth: 180,
  }

  const statValue: React.CSSProperties = {
    fontSize: 28, fontWeight: 700, color: 'var(--scarlet)',
    fontFamily: "'JetBrains Mono', monospace",
  }

  const statLabel: React.CSSProperties = {
    fontSize: 12, color: 'var(--text-muted)', marginTop: 4, textTransform: 'uppercase' as const,
    letterSpacing: 1,
  }

  const sectionTitle: React.CSSProperties = {
    fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16,
  }

  const btn: React.CSSProperties = {
    background: 'var(--scarlet)', color: '#fff', border: 'none', borderRadius: 8,
    padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  }

  const btnOutline: React.CSSProperties = {
    background: 'transparent', color: 'var(--text-secondary)',
    border: '1px solid var(--border)', borderRadius: 8,
    padding: '8px 16px', fontSize: 13, cursor: 'pointer',
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '16px 24px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'var(--bg-secondary)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>
            Analytics
          </span>
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 6,
            background: 'var(--scarlet)', color: '#fff', fontWeight: 600,
          }}>v2</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={loadData} style={btnOutline} title="Rafraichir">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 11-6.219-8.56" /><polyline points="21 3 21 9 15 9" />
            </svg>
          </button>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setExportOpen(!exportOpen)} style={btnOutline}>
              Exporter ▾
            </button>
            {exportOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setExportOpen(false)} />
                <div style={{
                  position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 50,
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 10, padding: 4, minWidth: 160, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                }}>
                  {([
                    { fmt: 'pdf' as const, label: '📄 PDF', desc: 'Rapport ScarletWolf' },
                    { fmt: 'html' as const, label: '🌐 HTML', desc: 'Rapport stylisé' },
                    { fmt: 'json' as const, label: '📦 JSON', desc: 'Données structurées' },
                    { fmt: 'md' as const, label: '📝 Markdown', desc: 'Documentation' },
                    { fmt: 'csv' as const, label: '📊 CSV', desc: 'Tableur' },
                  ]).map(({ fmt, label, desc }) => (
                    <button key={fmt} onClick={() => handleExport(fmt)} style={{
                      display: 'flex', flexDirection: 'column', width: '100%',
                      padding: '8px 12px', background: 'transparent', border: 'none',
                      borderRadius: 6, cursor: 'pointer', textAlign: 'left',
                    }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(220,38,38,0.08)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{desc}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: 0, borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)', padding: '0 24px',
      }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 20px', fontSize: 13, fontWeight: tab === t.key ? 600 : 400,
            color: tab === t.key ? 'var(--scarlet)' : 'var(--text-muted)',
            background: 'transparent', border: 'none', cursor: 'pointer',
            borderBottom: tab === t.key ? '2px solid var(--scarlet)' : '2px solid transparent',
            transition: 'all 0.15s',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 200 }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Chargement...</div>
          </div>
        ) : (
          <>
            {tab === 'overview' && <OverviewTab
              summary={summary} byProvider={byProvider} daily={daily}
              heatmap={heatmap} budgetCheck={budgetCheck}
              card={card} statCard={statCard} statValue={statValue}
              statLabel={statLabel} sectionTitle={sectionTitle}
            />}
            {tab === 'trends' && <TrendsTab
              trendData={trendData} trendPeriod={trendPeriod}
              setTrendPeriod={setTrendPeriod} card={card} sectionTitle={sectionTitle}
            />}
            {tab === 'models' && <ModelsTab
              byModel={byModel} byProvider={byProvider}
              card={card} sectionTitle={sectionTitle}
            />}
            {tab === 'budget' && <BudgetTab
              budget={budget} setBudget={setBudget} budgetCheck={budgetCheck}
              providerBudgets={providerBudgets}
              editBudget={editBudget} setEditBudget={setEditBudget}
              budgetForm={budgetForm} setBudgetForm={setBudgetForm}
              saveBudget={saveBudget} loadData={loadData}
              card={card} sectionTitle={sectionTitle} btn={btn} btnOutline={btnOutline}
            />}
            {tab === 'conversations' && <ConversationsTab
              conversations={conversations} card={card} sectionTitle={sectionTitle}
            />}
          </>
        )}
      </div>
    </div>
  )
}

// ── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ summary, byProvider, daily, heatmap, budgetCheck, card, statCard, statValue, statLabel, sectionTitle }: any) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Budget alerts */}
      {budgetCheck.alerts.length > 0 && (
        <div style={{
          ...card, background: budgetCheck.should_block ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
          borderColor: budgetCheck.should_block ? 'var(--accent-danger)' : 'var(--accent-warning)',
        }}>
          <div style={{ fontWeight: 600, color: budgetCheck.should_block ? 'var(--accent-danger)' : 'var(--accent-warning)', marginBottom: 8 }}>
            {budgetCheck.should_block ? 'Budget depasse !' : 'Alertes budget'}
          </div>
          {budgetCheck.alerts.map((a: any, i: number) => (
            <div key={i} style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {a.scope}: {fmtCost(a.cost)} / {fmtCost(a.limit)} ({a.percent}%)
            </div>
          ))}
        </div>
      )}

      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={statCard}>
          <div style={statValue}>{fmtCost(summary.total_cost)}</div>
          <div style={statLabel}>Cout total</div>
        </div>
        <div style={statCard}>
          <div style={statValue}>{fmtTokens(summary.total_tokens)}</div>
          <div style={statLabel}>Tokens total</div>
        </div>
        <div style={statCard}>
          <div style={statValue}>{summary.message_count}</div>
          <div style={statLabel}>Messages</div>
        </div>
        <div style={statCard}>
          <div style={statValue}>{fmtCost(summary.avg_cost_per_message)}</div>
          <div style={statLabel}>Moy / message</div>
        </div>
      </div>

      {/* Mini trend + provider pie */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <div style={card}>
          <div style={sectionTitle}>Cout journalier (30j)</div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={daily.map((d: TimeEntry) => ({ ...d, label: fmtDate(d.date || '') }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
              <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickFormatter={(v: number) => fmtCost(v)} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="cost" name="Cost" stroke="var(--scarlet)" fill="var(--scarlet)" fillOpacity={0.15} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div style={card}>
          <div style={sectionTitle}>Par fournisseur</div>
          {byProvider.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={byProvider} dataKey="total_cost" nameKey="provider" cx="50%" cy="50%" outerRadius={75} label={({ provider, percent }: any) => `${provider} ${(percent * 100).toFixed(0)}%`} labelLine={false} fontSize={11}>
                  {byProvider.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => fmtCost(v)} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', paddingTop: 60 }}>Pas de donnees</div>
          )}
        </div>
      </div>

      {/* Heatmap */}
      <div style={card}>
        <div style={sectionTitle}>Activite (90j)</div>
        <HeatmapGrid data={heatmap} />
      </div>
    </div>
  )
}

// ── Heatmap Grid ─────────────────────────────────────────────────────────────

function HeatmapGrid({ data }: { data: HeatmapEntry[] }) {
  if (!data.length) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Pas de donnees</div>

  const maxCount = Math.max(...data.map(d => d.count), 1)
  const dateMap = new Map(data.map(d => [d.date, d]))

  // Generate 90 days grid
  const days: string[] = []
  const now = new Date()
  for (let i = 89; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    days.push(d.toISOString().split('T')[0])
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
      {days.map((day, idx) => {
        const entry = dateMap.get(day)
        const intensity = entry ? entry.count / maxCount : 0
        return (
          <div key={`${day}-${idx}`} title={`${day}: ${entry?.count || 0} msgs, ${fmtCost(entry?.cost || 0)}`} style={{
            width: 12, height: 12, borderRadius: 2,
            background: intensity === 0
              ? 'var(--bg-tertiary)'
              : `rgba(220, 38, 38, ${0.2 + intensity * 0.8})`,
            transition: 'background 0.15s',
          }} />
        )
      })}
    </div>
  )
}

// ── Trends Tab ───────────────────────────────────────────────────────────────

function TrendsTab({ trendData, trendPeriod, setTrendPeriod, card, sectionTitle }: any) {
  const periods = [
    { key: 'day', label: 'Jour' },
    { key: 'week', label: 'Semaine' },
    { key: 'month', label: 'Mois' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {periods.map(p => (
          <button key={p.key} onClick={() => setTrendPeriod(p.key)} style={{
            padding: '6px 16px', fontSize: 12, fontWeight: trendPeriod === p.key ? 600 : 400,
            background: trendPeriod === p.key ? 'var(--scarlet)' : 'var(--bg-tertiary)',
            color: trendPeriod === p.key ? '#fff' : 'var(--text-secondary)',
            border: 'none', borderRadius: 6, cursor: 'pointer',
          }}>
            {p.label}
          </button>
        ))}
      </div>

      <div style={card}>
        <div style={sectionTitle}>Cout</div>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
            <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickFormatter={(v: number) => fmtCost(v)} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="cost" name="Cost" stroke="var(--scarlet)" fill="var(--scarlet)" fillOpacity={0.15} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div style={card}>
        <div style={sectionTitle}>Tokens</div>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
            <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickFormatter={(v: number) => fmtTokens(v)} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="tokens" name="Tokens" stroke="var(--ember)" fill="var(--ember)" fillOpacity={0.15} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div style={card}>
        <div style={sectionTitle}>Messages</div>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
            <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="messages" name="Messages" fill="var(--scarlet)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ── Models Tab ───────────────────────────────────────────────────────────────

function ModelsTab({ byModel, byProvider, card, sectionTitle }: any) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* By model pie */}
        <div style={card}>
          <div style={sectionTitle}>Repartition par modele</div>
          {byModel.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={byModel.slice(0, 10)} dataKey="total_cost" nameKey="model" cx="50%" cy="50%" outerRadius={90}
                  label={({ model, percent }: any) => `${model.split('/').pop()} ${(percent * 100).toFixed(0)}%`}
                  labelLine={false} fontSize={10}>
                  {byModel.slice(0, 10).map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => fmtCost(v)} />
              </PieChart>
            </ResponsiveContainer>
          ) : <NoData />}
        </div>

        {/* By provider pie */}
        <div style={card}>
          <div style={sectionTitle}>Repartition par fournisseur</div>
          {byProvider.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={byProvider} dataKey="total_cost" nameKey="provider" cx="50%" cy="50%" outerRadius={90}
                  label={({ provider, percent }: any) => `${provider} ${(percent * 100).toFixed(0)}%`}
                  labelLine={false} fontSize={11}>
                  {byProvider.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => fmtCost(v)} />
              </PieChart>
            </ResponsiveContainer>
          ) : <NoData />}
        </div>
      </div>

      {/* Model table */}
      <div style={card}>
        <div style={sectionTitle}>Details par modele</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Modele', 'Cout', 'Tokens', 'Messages', '% Total'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-muted)', fontWeight: 500, fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {byModel.map((m: ModelBreakdown, i: number) => {
                const totalCost = byModel.reduce((s: number, x: ModelBreakdown) => s + x.total_cost, 0)
                const pct = totalCost > 0 ? (m.total_cost / totalCost) * 100 : 0
                return (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '8px 12px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS[i % COLORS.length] }} />
                      {m.model}
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--scarlet)', fontFamily: "'JetBrains Mono', monospace" }}>{fmtCost(m.total_cost)}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{fmtTokens(m.total_tokens)}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{m.message_count}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, height: 4, background: 'var(--bg-tertiary)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: COLORS[i % COLORS.length], borderRadius: 2 }} />
                        </div>
                        <span style={{ color: 'var(--text-muted)', fontSize: 11, minWidth: 40 }}>{pct.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Budget Tab ───────────────────────────────────────────────────────────────

function BudgetTab({ budget, setBudget, budgetCheck, providerBudgets, editBudget, setEditBudget, budgetForm, setBudgetForm, saveBudget, loadData, card, sectionTitle, btn, btnOutline }: any) {
  const startEdit = () => {
    setBudgetForm({
      monthly_limit: budget.monthly_limit?.toString() || '',
      weekly_limit: budget.weekly_limit?.toString() || '',
    })
    setEditBudget(true)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Alerts */}
      {budgetCheck.alerts.length > 0 && (
        <div style={{
          ...card,
          background: budgetCheck.should_block ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
          borderColor: budgetCheck.should_block ? 'var(--accent-danger)' : 'var(--accent-warning)',
        }}>
          {budgetCheck.alerts.map((a: any, i: number) => (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '6px 0', color: a.level >= 100 ? 'var(--accent-danger)' : 'var(--accent-warning)',
              fontSize: 13,
            }}>
              <span>{a.scope}</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {fmtCost(a.cost)} / {fmtCost(a.limit)} ({a.percent}%)
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Global budget */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={sectionTitle}>Budget global</div>
          {!editBudget && <button onClick={startEdit} style={btnOutline}>Modifier</button>}
        </div>

        {editBudget ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <label style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Limite mensuelle ($)</div>
                <input type="number" step="0.01" value={budgetForm.monthly_limit}
                  onChange={e => setBudgetForm({ ...budgetForm, monthly_limit: e.target.value })}
                  placeholder="Pas de limite"
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 8, fontSize: 14,
                    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                    color: 'var(--text-primary)', outline: 'none',
                  }} />
              </label>
              <label style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Limite hebdo ($)</div>
                <input type="number" step="0.01" value={budgetForm.weekly_limit}
                  onChange={e => setBudgetForm({ ...budgetForm, weekly_limit: e.target.value })}
                  placeholder="Pas de limite"
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 8, fontSize: 14,
                    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                    color: 'var(--text-primary)', outline: 'none',
                  }} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              {[
                { key: 'alert_80', label: 'Alerte 80%' },
                { key: 'alert_90', label: 'Alerte 90%' },
                { key: 'alert_100', label: 'Alerte 100%' },
                { key: 'block_on_limit', label: 'Bloquer' },
              ].map(opt => (
                <label key={opt.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={budget[opt.key]}
                    onChange={e => setBudget({ ...budget, [opt.key]: e.target.checked })}
                    style={{ accentColor: 'var(--scarlet)' }} />
                  {opt.label}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={saveBudget} style={btn}>Enregistrer</button>
              <button onClick={() => setEditBudget(false)} style={btnOutline}>Annuler</button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 32 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Mensuel</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}>
                {budget.monthly_limit ? fmtCost(budget.monthly_limit) : 'Illimite'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Hebdo</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}>
                {budget.weekly_limit ? fmtCost(budget.weekly_limit) : 'Illimite'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Blocage</div>
              <div style={{ fontSize: 14, color: budget.block_on_limit ? 'var(--accent-danger)' : 'var(--accent-success)' }}>
                {budget.block_on_limit ? 'Actif' : 'Inactif'}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Provider budgets */}
      <div style={card}>
        <div style={sectionTitle}>Budgets par fournisseur</div>
        {providerBudgets.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {providerBudgets.map((pb: ProviderBudget) => (
              <div key={pb.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 14px', background: 'var(--bg-tertiary)', borderRadius: 8,
              }}>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{pb.provider}</span>
                <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'var(--text-secondary)' }}>
                  <span>Mensuel: {pb.monthly_limit ? fmtCost(pb.monthly_limit) : '-'}</span>
                  <span>Hebdo: {pb.weekly_limit ? fmtCost(pb.weekly_limit) : '-'}</span>
                  <button onClick={async () => {
                    await apiFetch(`/provider-budgets/${pb.provider}`, { method: 'DELETE' })
                    loadData()
                  }} style={{ background: 'none', border: 'none', color: 'var(--accent-danger)', cursor: 'pointer', fontSize: 12 }}>
                    Supprimer
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Aucun budget fournisseur configure</div>
        )}
      </div>
    </div>
  )
}

// ── Conversations Tab ────────────────────────────────────────────────────────

function ConversationsTab({ conversations, card, sectionTitle }: any) {
  return (
    <div style={card}>
      <div style={sectionTitle}>Cout par conversation</div>
      {conversations.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Conversation', 'Cout', 'Tokens', 'Messages', 'Dernier msg'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-muted)', fontWeight: 500, fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {conversations.map((c: ConversationCost) => (
                <tr key={c.conversation_id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: '8px 12px', color: 'var(--text-primary)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.title || `Conv #${c.conversation_id}`}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--scarlet)', fontFamily: "'JetBrains Mono', monospace" }}>{fmtCost(c.total_cost)}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{fmtTokens(c.total_tokens)}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{c.message_count}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 11 }}>
                    {c.last_message ? new Date(c.last_message).toLocaleDateString('fr-FR') : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <NoData />}
    </div>
  )
}

// ── Shared ────────────────────────────────────────────────────────────────────

function NoData() {
  return <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 40 }}>Pas de donnees</div>
}
