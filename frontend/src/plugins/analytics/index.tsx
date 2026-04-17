/**
 * Gungnir Plugin — Analytics Dashboard
 * Full cost tracking, trends, budgets, heatmap, and exports.
 * Aligné sur le design system Conscience (SectionCard, TabBar, StatCard...).
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  AreaChart, Area, PieChart, Pie, Cell, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import {
  BarChart3, RefreshCw, Download, DollarSign, Hash, MessageSquare,
  TrendingUp, AlertTriangle, Calendar, PieChart as PieIcon, Activity,
  Layers, Wallet, MessagesSquare, Edit3, Trash2, Save, X,
} from 'lucide-react'
import {
  PageHeader, TabBar, SectionCard, SectionTitle, StatCard,
  PrimaryButton, SecondaryButton, FormInput, Badge,
} from '@core/components/ui'

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

const TABS = [
  { key: 'overview' as const, label: 'Vue globale', icon: <Activity size={14} /> },
  { key: 'trends' as const, label: 'Tendances', icon: <TrendingUp size={14} /> },
  { key: 'models' as const, label: 'Modèles', icon: <Layers size={14} /> },
  { key: 'budget' as const, label: 'Budget', icon: <Wallet size={14} /> },
  { key: 'conversations' as const, label: 'Conversations', icon: <MessagesSquare size={14} /> },
]

// ── Custom Tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--bg-elevated, var(--bg-secondary))', border: '1px solid var(--border)',
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

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <PageHeader
          icon={<BarChart3 size={18} />}
          title="Analytics"
          version="1.0.1"
          subtitle="Suivi des coûts, tokens et usage par modèle"
          actions={
            <>
              <SecondaryButton
                size="sm"
                icon={<RefreshCw size={14} />}
                onClick={loadData}
                title="Rafraîchir"
              >
                Rafraîchir
              </SecondaryButton>
              <div style={{ position: 'relative' }}>
                <PrimaryButton size="sm" icon={<Download size={14} />} onClick={() => setExportOpen(!exportOpen)}>
                  Exporter
                </PrimaryButton>
                {exportOpen && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setExportOpen(false)} />
                    <div style={{
                      position: 'absolute', right: 0, top: '100%', marginTop: 6, zIndex: 50,
                      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                      borderRadius: 12, padding: 6, minWidth: 180, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                    }}>
                      {([
                        { fmt: 'pdf' as const, label: 'PDF', desc: 'Rapport ScarletWolf' },
                        { fmt: 'html' as const, label: 'HTML', desc: 'Rapport stylisé' },
                        { fmt: 'json' as const, label: 'JSON', desc: 'Données structurées' },
                        { fmt: 'md' as const, label: 'Markdown', desc: 'Documentation' },
                        { fmt: 'csv' as const, label: 'CSV', desc: 'Tableur' },
                      ]).map(({ fmt, label, desc }) => (
                        <button key={fmt} onClick={() => handleExport(fmt)} style={{
                          display: 'flex', flexDirection: 'column', width: '100%',
                          padding: '8px 12px', background: 'transparent', border: 'none',
                          borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                        }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--scarlet) 10%, transparent)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{desc}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          }
        />
      </div>

      <div style={{ padding: '0 24px 12px' }}>
        <TabBar tabs={TABS} active={tab} onChange={setTab} />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 24px' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 200 }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Chargement...</div>
          </div>
        ) : (
          <>
            {tab === 'overview' && <OverviewTab
              summary={summary} byProvider={byProvider} daily={daily}
              heatmap={heatmap} budgetCheck={budgetCheck}
            />}
            {tab === 'trends' && <TrendsTab
              trendData={trendData} trendPeriod={trendPeriod} setTrendPeriod={setTrendPeriod}
            />}
            {tab === 'models' && <ModelsTab byModel={byModel} byProvider={byProvider} />}
            {tab === 'budget' && <BudgetTab
              budget={budget} setBudget={setBudget} budgetCheck={budgetCheck}
              providerBudgets={providerBudgets}
              editBudget={editBudget} setEditBudget={setEditBudget}
              budgetForm={budgetForm} setBudgetForm={setBudgetForm}
              saveBudget={saveBudget} loadData={loadData}
            />}
            {tab === 'conversations' && <ConversationsTab conversations={conversations} />}
          </>
        )}
      </div>
    </div>
  )
}

// ── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ summary, byProvider, daily, heatmap, budgetCheck }: any) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {budgetCheck.alerts.length > 0 && (
        <SectionCard accent={budgetCheck.should_block ? '#ef4444' : '#f59e0b'}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
            fontWeight: 700, color: budgetCheck.should_block ? '#ef4444' : '#f59e0b',
          }}>
            <AlertTriangle size={16} />
            {budgetCheck.should_block ? 'Budget dépassé !' : 'Alertes budget'}
          </div>
          {budgetCheck.alerts.map((a: any, i: number) => (
            <div key={i} style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {a.scope}: {fmtCost(a.cost)} / {fmtCost(a.limit)} ({a.percent}%)
            </div>
          ))}
        </SectionCard>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <StatCard label="Coût total" value={fmtCost(summary.total_cost)} icon={<DollarSign size={14} />} />
        <StatCard label="Tokens total" value={fmtTokens(summary.total_tokens)} icon={<Hash size={14} />} accent="#f97316" />
        <StatCard label="Messages" value={summary.message_count} icon={<MessageSquare size={14} />} accent="#22c55e" />
        <StatCard label="Moy / message" value={fmtCost(summary.avg_cost_per_message)} icon={<TrendingUp size={14} />} accent="#3b82f6" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <SectionCard>
          <SectionTitle icon={<Calendar size={12} />}>Coût journalier (30j)</SectionTitle>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={daily.map((d: TimeEntry) => ({ ...d, label: fmtDate(d.date || '') }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
              <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickFormatter={(v: number) => fmtCost(v)} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="cost" name="Cost" stroke="var(--scarlet)" fill="var(--scarlet)" fillOpacity={0.15} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard>
          <SectionTitle icon={<PieIcon size={12} />}>Par fournisseur</SectionTitle>
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
            <NoData />
          )}
        </SectionCard>
      </div>

      <SectionCard>
        <SectionTitle icon={<Activity size={12} />}>Activité (90j)</SectionTitle>
        <HeatmapGrid data={heatmap} />
      </SectionCard>
    </div>
  )
}

// ── Heatmap Grid ─────────────────────────────────────────────────────────────

function HeatmapGrid({ data }: { data: HeatmapEntry[] }) {
  if (!data.length) return <NoData />

  const maxCount = Math.max(...data.map(d => d.count), 1)
  const dateMap = new Map(data.map(d => [d.date, d]))

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
            width: 12, height: 12, borderRadius: 3,
            background: intensity === 0
              ? 'var(--bg-tertiary)'
              : `color-mix(in srgb, var(--scarlet) ${20 + intensity * 80}%, transparent)`,
            transition: 'background 0.15s',
          }} />
        )
      })}
    </div>
  )
}

// ── Trends Tab ───────────────────────────────────────────────────────────────

function TrendsTab({ trendData, trendPeriod, setTrendPeriod }: any) {
  const PERIODS = [
    { key: 'day' as const, label: 'Jour' },
    { key: 'week' as const, label: 'Semaine' },
    { key: 'month' as const, label: 'Mois' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <TabBar tabs={PERIODS} active={trendPeriod} onChange={setTrendPeriod} size="sm" />

      <SectionCard>
        <SectionTitle icon={<DollarSign size={12} />}>Coût</SectionTitle>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
            <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickFormatter={(v: number) => fmtCost(v)} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="cost" name="Cost" stroke="var(--scarlet)" fill="var(--scarlet)" fillOpacity={0.15} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </SectionCard>

      <SectionCard>
        <SectionTitle icon={<Hash size={12} />}>Tokens</SectionTitle>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
            <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickFormatter={(v: number) => fmtTokens(v)} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="tokens" name="Tokens" stroke="#f97316" fill="#f97316" fillOpacity={0.15} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </SectionCard>

      <SectionCard>
        <SectionTitle icon={<MessageSquare size={12} />}>Messages</SectionTitle>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
            <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="messages" name="Messages" fill="var(--scarlet)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </SectionCard>
    </div>
  )
}

// ── Models Tab ───────────────────────────────────────────────────────────────

function ModelsTab({ byModel, byProvider }: any) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <SectionCard>
          <SectionTitle icon={<Layers size={12} />}>Répartition par modèle</SectionTitle>
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
        </SectionCard>

        <SectionCard>
          <SectionTitle icon={<PieIcon size={12} />}>Répartition par fournisseur</SectionTitle>
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
        </SectionCard>
      </div>

      <SectionCard>
        <SectionTitle icon={<Layers size={12} />}>Détails par modèle</SectionTitle>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Modèle', 'Coût', 'Tokens', 'Messages', '% Total'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {byModel.map((m: ModelBreakdown, i: number) => {
                const totalCost = byModel.reduce((s: number, x: ModelBreakdown) => s + x.total_cost, 0)
                const pct = totalCost > 0 ? (m.total_cost / totalCost) * 100 : 0
                return (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '8px 12px', color: 'var(--text-primary)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS[i % COLORS.length] }} />
                        {m.model}
                      </div>
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--scarlet)', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{fmtCost(m.total_cost)}</td>
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
      </SectionCard>
    </div>
  )
}

// ── Budget Tab ───────────────────────────────────────────────────────────────

function BudgetTab({ budget, setBudget, budgetCheck, providerBudgets, editBudget, setEditBudget, budgetForm, setBudgetForm, saveBudget, loadData }: any) {
  const startEdit = () => {
    setBudgetForm({
      monthly_limit: budget.monthly_limit?.toString() || '',
      weekly_limit: budget.weekly_limit?.toString() || '',
    })
    setEditBudget(true)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {budgetCheck.alerts.length > 0 && (
        <SectionCard accent={budgetCheck.should_block ? '#ef4444' : '#f59e0b'}>
          <SectionTitle
            icon={<AlertTriangle size={12} />}
            color={budgetCheck.should_block ? '#ef4444' : '#f59e0b'}
          >
            {budgetCheck.should_block ? 'Budget dépassé' : 'Alertes budget'}
          </SectionTitle>
          {budgetCheck.alerts.map((a: any, i: number) => (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '6px 0', color: a.level >= 100 ? '#ef4444' : '#f59e0b',
              fontSize: 13,
            }}>
              <span>{a.scope}</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {fmtCost(a.cost)} / {fmtCost(a.limit)} ({a.percent}%)
              </span>
            </div>
          ))}
        </SectionCard>
      )}

      <SectionCard>
        <SectionTitle
          icon={<Wallet size={12} />}
          right={!editBudget ? (
            <SecondaryButton size="sm" icon={<Edit3 size={12} />} onClick={startEdit}>Modifier</SecondaryButton>
          ) : undefined}
        >
          Budget global
        </SectionTitle>

        {editBudget ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <FormInput
                label="Limite mensuelle ($)"
                type="number"
                step="0.01"
                value={budgetForm.monthly_limit}
                onChange={e => setBudgetForm({ ...budgetForm, monthly_limit: e.target.value })}
                placeholder="Pas de limite"
              />
              <FormInput
                label="Limite hebdo ($)"
                type="number"
                step="0.01"
                value={budgetForm.weekly_limit}
                onChange={e => setBudgetForm({ ...budgetForm, weekly_limit: e.target.value })}
                placeholder="Pas de limite"
              />
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {[
                { key: 'alert_80', label: 'Alerte 80%' },
                { key: 'alert_90', label: 'Alerte 90%' },
                { key: 'alert_100', label: 'Alerte 100%' },
                { key: 'block_on_limit', label: 'Bloquer au dépassement' },
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
              <PrimaryButton size="sm" icon={<Save size={14} />} onClick={saveBudget}>Enregistrer</PrimaryButton>
              <SecondaryButton size="sm" icon={<X size={14} />} onClick={() => setEditBudget(false)}>Annuler</SecondaryButton>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Mensuel</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>
                {budget.monthly_limit ? fmtCost(budget.monthly_limit) : 'Illimité'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Hebdo</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>
                {budget.weekly_limit ? fmtCost(budget.weekly_limit) : 'Illimité'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Blocage</div>
              <div style={{ marginTop: 4 }}>
                <Badge color={budget.block_on_limit ? '#ef4444' : '#22c55e'}>
                  {budget.block_on_limit ? 'Actif' : 'Inactif'}
                </Badge>
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard>
        <SectionTitle icon={<Layers size={12} />}>Budgets par fournisseur</SectionTitle>
        {providerBudgets.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {providerBudgets.map((pb: ProviderBudget) => (
              <div key={pb.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 14px', background: 'var(--bg-tertiary)', borderRadius: 10,
                border: '1px solid var(--border-subtle)',
              }}>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{pb.provider}</span>
                <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'var(--text-secondary)', alignItems: 'center' }}>
                  <span>Mensuel: {pb.monthly_limit ? fmtCost(pb.monthly_limit) : '—'}</span>
                  <span>Hebdo: {pb.weekly_limit ? fmtCost(pb.weekly_limit) : '—'}</span>
                  <SecondaryButton size="sm" danger icon={<Trash2 size={12} />} onClick={async () => {
                    await apiFetch(`/provider-budgets/${pb.provider}`, { method: 'DELETE' })
                    loadData()
                  }}>
                    Supprimer
                  </SecondaryButton>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Aucun budget fournisseur configuré</div>
        )}
      </SectionCard>
    </div>
  )
}

// ── Conversations Tab ────────────────────────────────────────────────────────

function ConversationsTab({ conversations }: any) {
  return (
    <SectionCard>
      <SectionTitle icon={<MessagesSquare size={12} />}>Coût par conversation</SectionTitle>
      {conversations.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Conversation', 'Coût', 'Tokens', 'Messages', 'Dernier msg'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {conversations.map((c: ConversationCost) => (
                <tr key={c.conversation_id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: '8px 12px', color: 'var(--text-primary)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.title || `Conv #${c.conversation_id}`}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--scarlet)', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{fmtCost(c.total_cost)}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{fmtTokens(c.total_tokens)}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{c.message_count}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 11 }}>
                    {c.last_message ? new Date(c.last_message).toLocaleDateString('fr-FR') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <NoData />}
    </SectionCard>
  )
}

// ── Shared ────────────────────────────────────────────────────────────────────

function NoData() {
  return <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 40 }}>Pas de données</div>
}
