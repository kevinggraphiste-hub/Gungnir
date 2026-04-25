import { useState, useEffect, useRef } from 'react'
import {
  Shield, Plus, Trash2, Check, X, AlertTriangle, Star,
  Bot, Sparkles, Lock, Unlock, Settings as SettingsIcon,
  Code, Users, Cpu, Save, Search, FileText, GripVertical,
  ChevronDown, ChevronUp, Tag, Upload, MessageSquare, RefreshCw
} from 'lucide-react'
import { useStore } from '../stores/appStore'
import { api, apiFetch } from '../services/api'
import InfoButton from '../components/InfoButton'
import { PageHeader, TabBar } from '../components/ui'

// ── Emoji picker inline pour les skills ──────────────────────────────────────
const SKILL_EMOJIS = [
  '🔍', '📝', '🚀', '💡', '🎯', '⚡', '🛡️', '🔧', '📊', '🌐',
  '🤖', '💬', '📁', '🎨', '🧪', '📦', '🔗', '🧠', '📋', '✨',
  '🔥', '💾', '🗂️', '📌', '🏷️', '⚙️', '🎲', '📡', '🧩', '🔑',
]

function SkillIconPicker({ icon, onChange }: { icon: string; onChange: (emoji: string) => void }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  // Positionnement en `position: fixed` calé sur le bouton — nécessaire parce
  // que la carte parent a `overflow: hidden`, ce qui clipperait un popover en
  // position: absolute. Recalcule à chaque ouverture + sur scroll/resize.
  useEffect(() => {
    if (!open) return
    const updatePos = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      setPos({ top: r.bottom + 4, left: r.left })
    }
    updatePos()
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    window.addEventListener('scroll', updatePos, true)
    window.addEventListener('resize', updatePos)
    return () => {
      document.removeEventListener('mousedown', handler)
      window.removeEventListener('scroll', updatePos, true)
      window.removeEventListener('resize', updatePos)
    }
  }, [open])

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        ref={btnRef}
        onClick={() => setOpen(!open)}
        className="w-6 h-6 flex items-center justify-center rounded transition-colors hover:bg-[var(--bg-elevated)]"
        title="Choisir une icône"
        style={{ fontSize: icon ? 16 : 14 }}
      >
        {icon || <Code className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />}
      </button>
      {open && pos && (
        <div ref={popoverRef} className="p-2 rounded-lg shadow-lg grid grid-cols-6 gap-1"
          style={{
            position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', minWidth: 180,
          }}>
          {icon && (
            <button
              onClick={() => { onChange(''); setOpen(false) }}
              className="w-7 h-7 flex items-center justify-center rounded text-xs transition-colors hover:bg-[var(--bg-secondary)]"
              title="Retirer l'icône"
              style={{ color: 'var(--text-muted)' }}
            >
              <X className="w-3 h-3" />
            </button>
          )}
          {SKILL_EMOJIS.map(e => (
            <button
              key={e}
              onClick={() => { onChange(e); setOpen(false) }}
              className="w-7 h-7 flex items-center justify-center rounded text-base transition-colors hover:bg-[var(--bg-secondary)] hover:scale-125"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AgentSettings() {
  const { config, selectedProvider, setSelectedProvider, selectedModel, setSelectedModel, agentName } = useStore()
  const [activeTab, setActiveTab] = useState('mode')
  const [skills, setSkills] = useState<any[]>([])
  const [activeSkillName, setActiveSkillName] = useState<string | null>(null)
  const [subAgents, setSubAgents] = useState<any[]>([])
  const [personalities, setPersonalities] = useState<any[]>([])
  const [securityScan, setSecurityScan] = useState<any>(null)
  // null tant que le fetch initial /api/agent/mode n'a pas répondu — évite le
  // flash "Demande surligné → puis bascule sur le vrai mode" au retour sur la
  // page (avant : default `ask_permission` faisait briller la mauvaise carte
  // pendant ~200ms).
  const [currentMode, setCurrentMode] = useState<string | null>(null)
  const [pendingRequests, setPendingRequests] = useState<any[]>([])
  const [newSkill, setNewSkill] = useState({
    name: '', description: '', prompt: '', tools: [] as string[],
    category: 'general', tags: '', version: '1.0.0', author: 'gungnir',
    license: 'MIT', output_format: 'text', annotations: { readOnly: false, destructive: false, idempotent: false },
    examples: [{ prompt: '', expected: '' }],
  })
  const [showAdvancedSkill, setShowAdvancedSkill] = useState(false)
  const [newAgent, setNewAgent] = useState({ name: '', role: '', expertise: '', system_prompt: '', provider: 'openrouter', model: '', tools: [] as string[], description: '', tags: '', version: '1.0.0', max_iterations: 5, author: 'gungnir' })
  const [showAdvancedAgent, setShowAdvancedAgent] = useState(false)
  const [editingAgent, setEditingAgent] = useState<string | null>(null)
  const [editAgentForm, setEditAgentForm] = useState({ role: '', expertise: '', system_prompt: '', provider: 'openrouter', model: '' })
  const [editingSkill, setEditingSkill] = useState<string | null>(null)
  const [editSkillForm, setEditSkillForm] = useState({ description: '', prompt: '', category: '', tags: '', version: '', author: '', license: '', output_format: '' })
  const [editingPersonality, setEditingPersonality] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ description: '', system_prompt: '', traits_str: '' })
  const [newForm, setNewForm] = useState({ name: '', description: '', system_prompt: '' })
  const [showNewForm, setShowNewForm] = useState(false)
  const [newFormError, setNewFormError] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createSuccess, setCreateSuccess] = useState(false)

  // Security scan inline results
  const [codeScanResult, setCodeScanResult] = useState<any>(null)
  const [skillScanResult, setSkillScanResult] = useState<any>(null)
  const [importStatus, setImportStatus] = useState<{ type: string; success: boolean; message: string; score?: number; violations?: any[] } | null>(null)
  const skillFileRef = useRef<HTMLInputElement>(null)
  const agentFileRef = useRef<HTMLInputElement>(null)
  const personalityFileRef = useRef<HTMLInputElement>(null)

  // Drag-and-drop (shared for personalities and skills) — refs to avoid race conditions
  const dragRef = useRef<{ idx: number; context: 'personality' | 'skill' } | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null)
  const [dragContext, setDragContext] = useState<'personality' | 'skill' | null>(null)

  // Inter-agent conversations
  const [interAgentConvs, setInterAgentConvs] = useState<any[]>([])
  const [selectedConv, setSelectedConv] = useState<any>(null)
  const [interAgentLoading, setInterAgentLoading] = useState(false)

  const loadInterAgent = async () => {
    setInterAgentLoading(true)
    try {
      const res = await apiFetch('/api/inter-agent/conversations?limit=200')
      const data = await res.json()
      setInterAgentConvs(data.conversations || [])
    } finally {
      setInterAgentLoading(false)
    }
  }

  const loadConvDetail = async (id: string) => {
    const res = await apiFetch(`/api/inter-agent/conversations/${id}?tree=true`)
    const data = await res.json()
    if (!data.error) setSelectedConv(data)
  }

  const deleteConv = async (id: string) => {
    await apiFetch(`/api/inter-agent/conversations/${id}`, { method: 'DELETE' })
    if (selectedConv?.id === id) setSelectedConv(null)
    loadInterAgent()
  }

  const clearAllConvs = async () => {
    if (!confirm('Supprimer tout l\'historique inter-agents ?')) return
    await apiFetch('/api/inter-agent/conversations', { method: 'DELETE' })
    setSelectedConv(null)
    loadInterAgent()
  }

  useEffect(() => {
    if (activeTab === 'inter-agent') loadInterAgent()
  }, [activeTab])

  // Soul editor
  const [soulContent, setSoulContent] = useState('')
  const [soulLoaded, setSoulLoaded] = useState(false)
  const [isSavingSoul, setIsSavingSoul] = useState(false)
  const [soulSaveFlash, setSoulSaveFlash] = useState<'ok' | 'err' | null>(null)

  // Track previous agent name so we can find-replace in the soul when it changes
  const prevAgentName = useRef(agentName)
  useEffect(() => {
    const oldName = prevAgentName.current
    if (oldName && agentName && oldName !== agentName && soulLoaded && soulContent.includes(oldName)) {
      setSoulContent(prev => prev.replace(new RegExp(oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), agentName))
    }
    prevAgentName.current = agentName
  }, [agentName])

  // Provider/model fetching — config d'abord (immédiat) puis API (enrichissement)
  const [providerModelsMap, setProviderModelsMap] = useState<Record<string, string[]>>({})
  const [modelSearch, setModelSearch] = useState('')
  const [modelSavedFlash, setModelSavedFlash] = useState(false)

  // Favoris modèles (partagé avec Chat via localStorage)
  const [favoriteModels, setFavoriteModels] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('gungnir_favorite_models') || '[]')
      return Array.isArray(raw) ? raw.filter(x => typeof x === 'string' && x.includes('::')) : []
    } catch { return [] }
  })
  const toggleFavorite = (provider: string, model: string) => {
    const key = `${provider}::${model}`
    setFavoriteModels(prev => {
      const next = prev.includes(key) ? prev.filter(f => f !== key) : prev.length >= 5 ? prev : [...prev, key]
      localStorage.setItem('gungnir_favorite_models', JSON.stringify(next))
      return next
    })
  }

  useEffect(() => {
    if (!config?.providers) return

    // Init immédiate depuis config (liste curatée) — includes user-merged providers
    const initialMap: Record<string, string[]> = {}
    Object.entries(config.providers).forEach(([name, p]) => {
      const prov = p as any
      // Provider is usable if enabled OR has an API key (user or global)
      if ((prov.enabled || prov.has_api_key) && prov.models?.length > 0) initialMap[name] = prov.models
    })
    if (Object.keys(initialMap).length > 0) setProviderModelsMap(initialMap)

    // Enrichissement via l'API — fetch for all providers with a key
    const enabledNames = Object.entries(config.providers)
      .filter(([, p]) => (p as any).enabled || (p as any).has_api_key)
      .map(([name]) => name)

    Promise.all(
      enabledNames.map(async (name) => {
        try {
          const res = await apiFetch(`/api/models/${name}`)
          const data = await res.json()
          return { name, models: (data.models || []) as string[] }
        } catch {
          return { name, models: [] }
        }
      })
    ).then(results => {
      setProviderModelsMap(prev => {
        const next = { ...prev }
        results.forEach(({ name, models }) => { if (models.length > 0) next[name] = models })
        return next
      })
    })
  }, [config])

  const enabledProviders = Object.entries(providerModelsMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, models]) => ({
      name,
      models: Array.isArray(models) ? [...models].filter(m => typeof m === 'string').sort((a, b) => a.localeCompare(b)) : [],
      defaultModel: (config?.providers?.[name] as any)?.default_model as string | undefined,
    }))
    .filter(p => p.models.length > 0)

  // Liste plate de tous les modèles (provider:model) pour la config active
  const allModels = enabledProviders.flatMap(p =>
    p.models.map(m => ({ provider: p.name, model: m, label: `${p.name} / ${m.split('/').pop() || m}` }))
  ).filter(x => !modelSearch.trim() || x.label.toLowerCase().includes(modelSearch.toLowerCase()))

  const handleSaveModel = async () => {
    try {
      // On envoie uniquement default_model — le backend préserve api_key, enabled, models
      await api.saveProvider(selectedProvider, { enabled: true, default_model: selectedModel })
    } catch {}
    setModelSavedFlash(true)
    setTimeout(() => setModelSavedFlash(false), 2000)
  }

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    if (activeTab === 'personality' && !soulLoaded) {
      loadSoul()
    }
  }, [activeTab])

  const loadData = async () => {
    try {
      const [modeRes, skillsRes, agentsRes, persRes, secRes, activeSkillRes] = await Promise.all([
        apiFetch('/api/agent/mode').then(r => r.json()),
        apiFetch('/api/skills').then(r => r.json()),
        apiFetch('/api/sub-agents').then(r => r.json()),
        apiFetch('/api/personality').then(r => r.json()),
        apiFetch('/api/security/scan').then(r => r.json()),
        apiFetch('/api/skills/active').then(r => r.json()).catch(() => ({ active: null })),
      ])
      setCurrentMode(modeRes.mode)
      setSkills(skillsRes)
      setSubAgents(agentsRes)
      setPersonalities(persRes)
      setSecurityScan(secRes)
      setPendingRequests(modeRes.pending_requests || [])
      setActiveSkillName(activeSkillRes?.active || null)
    } catch (err) {
      console.error('Load error:', err)
    }
  }

  const toggleActiveSkill = async (skillName: string) => {
    try {
      if (activeSkillName === skillName) {
        await api.clearActiveSkill()
        setActiveSkillName(null)
      } else {
        const res = await api.setActiveSkill(skillName)
        if (res?.success) setActiveSkillName(res.active || skillName)
      }
    } catch (err) {
      console.error('Toggle active skill failed:', err)
    }
  }

  const loadSoul = async () => {
    try {
      const res = await api.getSoul() as any
      const content = res.content || ''
      setSoulContent(content)
      setSoulLoaded(true)
    } catch (err) {
      console.error('Failed to load soul:', err)
      // Show default placeholder so user can still edit
      setSoulContent(`# Identité de ${agentName}\n\nTu es **${agentName}**, un super-assistant IA.\nTu es intelligent, proactif, précis et loyal envers ton utilisateur.\nTu parles en français par défaut.\nTu es honnête : tu admets clairement quand tu ne sais pas quelque chose.`)
      setSoulLoaded(true)
    }
  }

  const saveSoul = async () => {
    setIsSavingSoul(true)
    setSoulSaveFlash(null)
    try {
      await api.saveSoul(soulContent)
      setSoulSaveFlash('ok')
    } catch {
      setSoulSaveFlash('err')
    } finally {
      setIsSavingSoul(false)
      setTimeout(() => setSoulSaveFlash(null), 3000)
    }
  }

  const SECURITY_THRESHOLD = 85

  // Extrait un bloc YAML front-matter en tête du texte (--- key: val --- body).
  // Format aligné sur celui supporté par le backend (`_parse_frontmatter`).
  // Renvoie {meta, body} — meta = {} si pas de front-matter.
  const parseFrontmatter = (text: string): { meta: Record<string, any>; body: string } => {
    const t = text.replace(/^﻿/, '') // strip BOM
    const stripped = t.trimStart()
    if (!stripped.startsWith('---')) return { meta: {}, body: t }
    const after = stripped.slice(3)
    const closeIdx = after.search(/\n---/)
    if (closeIdx === -1) return { meta: {}, body: t }
    const yamlBlock = after.slice(0, closeIdx)
    const body = after.slice(closeIdx + 4).replace(/^\n+/, '')
    const meta: Record<string, any> = {}
    for (const rawLine of yamlBlock.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      let value: any = line.slice(colonIdx + 1).trim()
      if (!key) continue
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map((x: string) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      } else if (/^(true|false)$/i.test(value)) {
        value = value.toLowerCase() === 'true'
      } else if (/^(null|none|)$/i.test(value)) {
        value = null
      } else {
        value = value.replace(/^["']|["']$/g, '')
      }
      meta[key] = value
    }
    return { meta, body }
  }

  // Cherche le premier `# Titre` du body si name pas dans le frontmatter
  const extractFirstHeading = (body: string): string | null => {
    const m = body.match(/^\s*#\s+(.+?)\s*$/m)
    return m ? m[1].trim() : null
  }

  // Parse a .md skill file → JSON. Priorité au YAML frontmatter (format
  // standard, aligné avec le backend). Fallback : format custom historique
  // `# Skill : nom` + `**catégorie :** xxx` + `## Prompt`. Fallback final :
  // tout le texte est le prompt.
  const parseSkillMarkdown = (text: string): Record<string, any> => {
    const { meta, body } = parseFrontmatter(text)
    if (Object.keys(meta).length > 0) {
      const data: Record<string, any> = { ...meta }
      if (!data.name) {
        const h = extractFirstHeading(body)
        if (h) data.name = h
      }
      if (body.trim()) data.prompt = body.trim()
      return data
    }
    // Fallback custom legacy
    const data: Record<string, any> = {}
    const nameMatch = text.match(/^#\s*(?:Skill|skill)\s*[:\-–]\s*(.+)/m)
    if (nameMatch) data.name = nameMatch[1].trim()
    const fieldMap: Record<string, string> = { 'catégorie': 'category', 'categorie': 'category', 'category': 'category', 'description': 'description', 'auteur': 'author', 'author': 'author', 'version': 'version', 'tags': 'tags' }
    for (const [frKey, jsonKey] of Object.entries(fieldMap)) {
      const re = new RegExp(`\\*\\*${frKey}\\s*[:：]\\s*\\*\\*\\s*(.+)`, 'im')
      const match = text.match(re)
      if (match) data[jsonKey] = jsonKey === 'tags' ? match[1].split(',').map((t: string) => t.trim()) : match[1].trim()
    }
    const promptMatch = text.match(/##\s*Prompt\s*\n+([\s\S]*?)(?=\n##\s|\n---|\s*$)/i)
    if (promptMatch) data.prompt = promptMatch[1].trim()
    if (!data.prompt && !data.name) {
      data.prompt = text.trim()
      data.name = 'imported_skill'
    }
    return data
  }

  const parseAgentMarkdown = (text: string): Record<string, any> => {
    const { meta, body } = parseFrontmatter(text)
    if (Object.keys(meta).length > 0) {
      const data: Record<string, any> = { ...meta }
      if (!data.name) {
        const h = extractFirstHeading(body)
        if (h) data.name = h
      }
      if (typeof data.name === 'string') {
        data.name = data.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
      }
      if (body.trim()) data.system_prompt = body.trim()
      return data
    }
    const data: Record<string, any> = {}
    const nameMatch = text.match(/^#\s*(?:Agent|Sub-?agent|Sous-?agent)\s*[:\-–]\s*(.+)/m)
    if (nameMatch) data.name = nameMatch[1].trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
    const fieldMap: Record<string, string> = { 'description': 'description', 'modèle': 'model', 'model': 'model', 'provider': 'provider', 'fournisseur': 'provider', 'température': 'temperature', 'temperature': 'temperature' }
    for (const [frKey, jsonKey] of Object.entries(fieldMap)) {
      const re = new RegExp(`\\*\\*${frKey}\\s*[:：]\\s*\\*\\*\\s*(.+)`, 'im')
      const match = text.match(re)
      if (match) {
        const val = match[1].trim()
        data[jsonKey] = jsonKey === 'temperature' ? parseFloat(val) : val
      }
    }
    const promptMatch = text.match(/##\s*(?:System\s*Prompt|Prompt|Instructions?)\s*\n+([\s\S]*?)(?=\n##\s|\n---|\s*$)/i)
    if (promptMatch) data.system_prompt = promptMatch[1].trim()
    if (!data.system_prompt && !data.name) {
      data.system_prompt = text.trim()
      data.name = 'imported_agent'
    }
    return data
  }

  const handleImportSkill = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const text = await file.text()
      const isText = file.name.endsWith('.md') || file.name.endsWith('.txt')
      const data = isText ? parseSkillMarkdown(text) : JSON.parse(text)
      setImportStatus({ type: 'skill', success: false, message: 'Analyse de sécurité en cours...' })
      const scanRes = await apiFetch('/api/security/scan/skill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: data.prompt || '', code: data.code || '' }),
      }).then(r => r.json())
      if ((scanRes.score ?? 100) >= SECURITY_THRESHOLD) {
        await apiFetch('/api/skills/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        await loadData()
        setImportStatus({ type: 'skill', success: true, message: `Skill importé avec succès (score: ${scanRes.score?.toFixed(0)}/100)`, score: scanRes.score })
      } else {
        setImportStatus({ type: 'skill', success: false, message: `Import rejeté — score ${scanRes.score?.toFixed(0)}/100 (minimum: ${SECURITY_THRESHOLD})`, score: scanRes.score, violations: scanRes.violations })
      }
    } catch (err: any) {
      setImportStatus({ type: 'skill', success: false, message: `Erreur: ${err.message || 'fichier invalide'}` })
    }
    setTimeout(() => setImportStatus(null), 12000)
  }

  const handleImportAgent = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const text = await file.text()
      const isText = file.name.endsWith('.md') || file.name.endsWith('.txt')
      const data = isText ? parseAgentMarkdown(text) : JSON.parse(text)
      setImportStatus({ type: 'agent', success: false, message: 'Analyse de sécurité en cours...' })
      const scanRes = await apiFetch('/api/security/scan/skill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: data.system_prompt || '', code: data.code || '' }),
      }).then(r => r.json())
      if ((scanRes.score ?? 100) >= SECURITY_THRESHOLD) {
        await apiFetch('/api/sub-agents/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        await loadData()
        setImportStatus({ type: 'agent', success: true, message: `Agent importé avec succès (score: ${scanRes.score?.toFixed(0)}/100)`, score: scanRes.score })
      } else {
        setImportStatus({ type: 'agent', success: false, message: `Import rejeté — score ${scanRes.score?.toFixed(0)}/100 (minimum: ${SECURITY_THRESHOLD})`, score: scanRes.score, violations: scanRes.violations })
      }
    } catch (err: any) {
      setImportStatus({ type: 'agent', success: false, message: `Erreur: ${err.message || 'fichier invalide'}` })
    }
    setTimeout(() => setImportStatus(null), 12000)
  }

  const parsePersonalityMarkdown = (text: string): Record<string, any> => {
    const { meta, body } = parseFrontmatter(text)
    if (Object.keys(meta).length > 0) {
      const data: Record<string, any> = { ...meta }
      if (!data.name) {
        const h = extractFirstHeading(body)
        if (h) data.name = h
      }
      if (typeof data.name === 'string') {
        data.name = data.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
      }
      if (body.trim()) data.system_prompt = body.trim()
      return data
    }
    const data: Record<string, any> = {}
    const nameMatch = text.match(/^#\s*(?:Personnalité|Personality|Personnalite)\s*[:\-–]\s*(.+)/m)
    if (nameMatch) data.name = nameMatch[1].trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
    const fieldMap: Record<string, string> = { 'description': 'description', 'auteur': 'author', 'author': 'author', 'version': 'version', 'tags': 'tags', 'traits': 'traits' }
    for (const [frKey, jsonKey] of Object.entries(fieldMap)) {
      const re = new RegExp(`\\*\\*${frKey}\\s*[:：]\\s*\\*\\*\\s*(.+)`, 'im')
      const match = text.match(re)
      if (match) data[jsonKey] = (jsonKey === 'tags' || jsonKey === 'traits') ? match[1].split(',').map((t: string) => t.trim()) : match[1].trim()
    }
    const promptMatch = text.match(/##\s*(?:System\s*Prompt|Prompt|Instructions?)\s*\n+([\s\S]*?)(?=\n##\s|\n---|\s*$)/i)
    if (promptMatch) data.system_prompt = promptMatch[1].trim()
    if (!data.system_prompt && !data.name) {
      data.system_prompt = text.trim()
      data.name = 'imported_personality'
    }
    return data
  }

  const handleImportPersonality = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const text = await file.text()
      const isText = file.name.endsWith('.md') || file.name.endsWith('.txt')
      const data = isText ? parsePersonalityMarkdown(text) : JSON.parse(text)
      setImportStatus({ type: 'personality', success: false, message: 'Analyse de sécurité en cours...' })
      const scanRes = await apiFetch('/api/security/scan/skill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: data.system_prompt || '', code: '' }),
      }).then(r => r.json())
      if ((scanRes.score ?? 100) >= SECURITY_THRESHOLD) {
        await apiFetch('/api/personality/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        await loadData()
        setImportStatus({ type: 'personality', success: true, message: `Personnalité importée avec succès (score: ${scanRes.score?.toFixed(0)}/100)`, score: scanRes.score })
      } else {
        setImportStatus({ type: 'personality', success: false, message: `Import rejeté — score ${scanRes.score?.toFixed(0)}/100 (minimum: ${SECURITY_THRESHOLD})`, score: scanRes.score, violations: scanRes.violations })
      }
    } catch (err: any) {
      setImportStatus({ type: 'personality', success: false, message: `Erreur: ${err.message || 'fichier invalide'}` })
    }
    setTimeout(() => setImportStatus(null), 12000)
  }

  const setMode = async (mode: string) => {
    await apiFetch(`/api/agent/mode/${mode}`, { method: 'POST' })
    setCurrentMode(mode)
  }

  const approveRequest = async (id: string) => {
    await apiFetch(`/api/agent/permission/${id}/approve`, { method: 'POST' })
    loadData()
  }

  const denyRequest = async (id: string) => {
    await apiFetch(`/api/agent/permission/${id}/deny`, { method: 'POST', body: JSON.stringify({ reason: 'denied' }) })
    loadData()
  }

  const createSkill = async () => {
    if (!newSkill.name || !newSkill.prompt) return
    const payload = {
      ...newSkill,
      tags: newSkill.tags ? newSkill.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      examples: newSkill.examples.filter(e => e.prompt.trim()),
    }
    const res = await apiFetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (data.success) {
      setNewSkill({
        name: '', description: '', prompt: '', tools: [],
        category: 'general', tags: '', version: '1.0.0', author: 'gungnir',
        license: 'MIT', output_format: 'text', annotations: { readOnly: false, destructive: false, idempotent: false },
        examples: [{ prompt: '', expected: '' }],
      })
      setShowAdvancedSkill(false)
      loadData()
    } else {
      alert(`Erreur: ${data.error}`)
    }
  }

  const deleteSkill = async (name: string) => {
    if (!confirm(`Supprimer ${name}?`)) return
    await apiFetch(`/api/skills/${name}`, { method: 'DELETE' })
    loadData()
  }

  const saveSkill = async (name: string) => {
    const payload = {
      ...editSkillForm,
      tags: editSkillForm.tags ? editSkillForm.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    }
    await apiFetch(`/api/skills/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setEditingSkill(null)
    loadData()
  }

  const createSubAgent = async () => {
    if (!newAgent.name || !newAgent.role) return
    const payload = {
      ...newAgent,
      tags: newAgent.tags ? newAgent.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    }
    const res = await apiFetch('/api/sub-agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (data.success) {
      setNewAgent({ name: '', role: '', expertise: '', system_prompt: '', provider: 'openrouter', model: '', tools: [], description: '', tags: '', version: '1.0.0', max_iterations: 5, author: 'gungnir' })
      setShowAdvancedAgent(false)
      loadData()
    }
  }

  const deleteSubAgent = async (name: string) => {
    if (!confirm(`Supprimer ${name}?`)) return
    await apiFetch(`/api/sub-agents/${name}`, { method: 'DELETE' })
    loadData()
  }

  const startEditAgent = (agent: any) => {
    setEditingAgent(agent.name)
    setEditAgentForm({
      role: agent.role || '',
      expertise: agent.expertise || '',
      system_prompt: agent.system_prompt || '',
      provider: agent.provider || 'openrouter',
      model: agent.model || '',
    })
  }

  const saveSubAgent = async (name: string) => {
    await apiFetch(`/api/sub-agents/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editAgentForm),
    })
    setEditingAgent(null)
    loadData()
  }

  const setPersonality = async (name: string) => {
    await api.setPersonality(name)
    loadData()
  }

  const tabs = [
    { key: 'mode', label: 'Mode', icon: <SettingsIcon className="w-3.5 h-3.5" /> },
    { key: 'model', label: 'Modèle', icon: <Cpu className="w-3.5 h-3.5" /> },
    { key: 'skills', label: 'Skills', icon: <Sparkles className="w-3.5 h-3.5" /> },
    { key: 'subagents', label: 'Sous-agents', icon: <Users className="w-3.5 h-3.5" /> },
    { key: 'personality', label: 'Personnalité', icon: <Bot className="w-3.5 h-3.5" /> },
    { key: 'inter-agent', label: 'Conversations inter-agents', icon: <MessageSquare className="w-3.5 h-3.5" /> },
    {
      key: 'security',
      label: 'Sécurité',
      icon: <Shield className="w-3.5 h-3.5" />,
      badge: securityScan ? (
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: securityScan.score >= 80 ? 'var(--accent-success)' : 'var(--accent-danger)',
        }} />
      ) : undefined,
    },
  ]

  return (
    <div className="max-w-6xl mx-auto p-6 h-full overflow-y-auto">
      <PageHeader
        icon={<Bot size={18} />}
        title="Configuration Agent"
        subtitle="Mode d'autonomie, modèles, skills, sous-agents, personnalité et sécurité"
        version="1.0.1"
      />

      <div style={{ marginBottom: 20 }}>
        <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />
      </div>

      <div className="rounded-xl border p-6" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>
        {activeTab === 'mode' && (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-4">
              <button
                onClick={() => setMode('autonomous')}
                className="p-4 rounded-lg border-2 transition-colors"
                style={currentMode === 'autonomous'
                  ? { borderColor: 'var(--accent-danger)', background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)' }
                  : { borderColor: 'var(--border)' }
                }
              >
                <Unlock className="w-8 h-8 mb-2" style={{ color: currentMode === 'autonomous' ? 'var(--accent-danger)' : 'var(--text-muted)' }} />
                <div style={{ color: 'var(--text-primary)' }} className="font-medium">Autonome</div>
                <div style={{ color: 'var(--text-muted)' }} className="text-sm">Tout seul</div>
              </button>

              <button
                onClick={() => setMode('ask_permission')}
                className="p-4 rounded-lg border-2 transition-colors"
                style={currentMode === 'ask_permission'
                  ? { borderColor: 'var(--accent-tertiary)', background: 'color-mix(in srgb, var(--accent-tertiary) 10%, transparent)' }
                  : { borderColor: 'var(--border)' }
                }
              >
                <SettingsIcon className="w-8 h-8 mb-2" style={{ color: currentMode === 'ask_permission' ? 'var(--accent-tertiary)' : 'var(--text-muted)' }} />
                <div style={{ color: 'var(--text-primary)' }} className="font-medium">Demande</div>
                <div style={{ color: 'var(--text-muted)' }} className="text-sm">Demande oralement, réponds « oui »</div>
              </button>

              <button
                onClick={() => setMode('restrained')}
                className="p-4 rounded-lg border-2 transition-colors"
                style={currentMode === 'restrained'
                  ? { borderColor: 'var(--accent-success)', background: 'color-mix(in srgb, var(--accent-success) 10%, transparent)' }
                  : { borderColor: 'var(--border)' }
                }
              >
                <Lock className="w-8 h-8 mb-2" style={{ color: currentMode === 'restrained' ? 'var(--accent-success)' : 'var(--text-muted)' }} />
                <div style={{ color: 'var(--text-primary)' }} className="font-medium">Restreint</div>
                <div style={{ color: 'var(--text-muted)' }} className="text-sm">Carte d'autorisation à valider</div>
              </button>
            </div>

            {pendingRequests.length > 0 && (
              <div className="mt-6">
                <h3 className="font-medium mb-4" style={{ color: 'var(--text-primary)' }}>Demandes en attente</h3>
                <div className="space-y-2">
                  {pendingRequests.map(req => (
                    <div key={req.id} className="flex items-center justify-between bg-[var(--bg-primary)] p-4 rounded-lg">
                      <div>
                        <div style={{ color: 'var(--text-primary)' }}>{req.action}</div>
                        <div style={{ color: 'var(--text-muted)' }} className="text-sm">{JSON.stringify(req.details)}</div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => approveRequest(req.id)}
                          className="p-2 rounded-lg"
                          style={{ background: 'var(--accent-success)', color: 'var(--text-primary)' }}
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => denyRequest(req.id)}
                          className="p-2 rounded-lg"
                          style={{ background: 'var(--accent-primary)', color: 'var(--text-primary)' }}
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'model' && (
          <div className="space-y-5">
            <div>
              <h3 className="font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Modèle actif</h3>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Partagé avec le chat — sélectionnez parmi tous les modèles disponibles selon vos providers configurés.
              </p>
            </div>

            {enabledProviders.length === 0 ? (
              <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border)] p-8 text-center">
                <Cpu className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Aucun provider disponible</p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Activez un provider dans <strong style={{ color: 'var(--text-secondary)' }}>Paramètres &rarr; Providers</strong></p>
              </div>
            ) : (
              <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border)] p-5 flex flex-col" style={{ maxHeight: '480px' }}>
                {/* Search */}
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] mb-4 flex-shrink-0">
                  <Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <input
                    type="text"
                    value={modelSearch}
                    onChange={e => setModelSearch(e.target.value)}
                    placeholder="Rechercher un modèle ou provider…"
                    className="flex-1 bg-transparent text-sm outline-none"
                    style={{ color: 'var(--text-primary)' }}
                    autoFocus
                  />
                  {modelSearch && (
                    <button onClick={() => setModelSearch('')} className="transition-colors" style={{ color: 'var(--text-muted)' }}>
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {/* Grouped by provider — with favorites at top */}
                <div className="overflow-y-auto flex-1 space-y-4 pr-1">
                  {/* Favoris */}
                  {favoriteModels.length > 0 && !modelSearch.trim() && (
                    <div className="pb-3 mb-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <div className="text-xs font-semibold uppercase tracking-widest mb-2 px-1 flex items-center gap-1.5" style={{ color: 'var(--accent-tertiary)' }}>
                        <Star className="w-3 h-3" /> Favoris
                      </div>
                      <div className="space-y-1">
                        {favoriteModels.map(fav => {
                          if (typeof fav !== 'string' || !fav.includes('::')) return null
                          const [prov, mod] = fav.split('::')
                          if (!prov || !mod) return null
                          const isSelected = selectedModel === mod && selectedProvider === prov
                          return (
                            <button key={fav}
                              onClick={() => { setSelectedProvider(prov); setSelectedModel(mod) }}
                              className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg border transition-all text-left"
                              style={isSelected
                                ? { borderColor: 'color-mix(in srgb, var(--accent-primary) 50%, transparent)', background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)', color: 'var(--text-primary)' }
                                : { borderColor: 'var(--border)', color: 'var(--text-secondary)' }
                              }>
                              <div className="flex items-center gap-3 min-w-0">
                                <Star className="w-3.5 h-3.5 flex-shrink-0 fill-current" style={{ color: 'var(--accent-tertiary)' }}
                                  onClick={e => { e.stopPropagation(); toggleFavorite(prov, mod) }} />
                                <span className="text-sm truncate">{mod.split('/').pop() || mod}</span>
                                <span className="text-[10px] capitalize" style={{ color: 'var(--text-muted)' }}>{prov}</span>
                              </div>
                              {isSelected && <Check className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {enabledProviders.map(p => {
                    const filtered = p.models.filter(m =>
                      !modelSearch.trim() || `${p.name} ${m}`.toLowerCase().includes(modelSearch.toLowerCase())
                    )
                    if (filtered.length === 0) return null
                    return (
                      <div key={p.name}>
                        <div className="text-xs font-semibold uppercase tracking-widest mb-2 px-1 capitalize" style={{ color: 'var(--text-muted)' }}>{p.name}</div>
                        <div className="space-y-1">
                          {filtered.map(m => {
                            const isSelected = selectedModel === m && selectedProvider === p.name
                            const isDefault = m === p.defaultModel
                            const isFav = favoriteModels.includes(`${p.name}::${m}`)
                            return (
                              <button
                                key={`${p.name}/${m}`}
                                onClick={() => { setSelectedProvider(p.name); setSelectedModel(m) }}
                                className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg border transition-all text-left group"
                                style={isSelected
                                  ? { borderColor: 'color-mix(in srgb, var(--accent-primary) 50%, transparent)', background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)', color: 'var(--text-primary)' }
                                  : { borderColor: 'var(--border)', color: 'var(--text-secondary)' }
                                }
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <Star className={`w-3.5 h-3.5 flex-shrink-0 cursor-pointer transition-all ${isFav ? 'fill-current' : ''}`}
                                    style={{ color: isFav ? 'var(--accent-tertiary)' : 'var(--border)' }}
                                    onClick={e => { e.stopPropagation(); toggleFavorite(p.name, m) }} />
                                  <span className="text-sm truncate">{m.split('/').pop()}</span>
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                  {isDefault && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>défaut</span>}
                                  {isSelected && <Check className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} />}
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                  {allModels.length === 0 && modelSearch && (
                    <p className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>Aucun modèle trouvé pour "{modelSearch}"</p>
                  )}
                </div>
              </div>
            )}

            {/* Configuration active + save */}
            {selectedProvider && selectedModel && (
              <div className="flex items-center justify-between p-4 rounded-xl border"
                style={{ background: 'color-mix(in srgb, var(--accent-primary) 4%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' }}>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg" style={{ background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' }}>
                    <Cpu className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-widest mb-0.5" style={{ color: 'var(--text-muted)' }}>Configuration active</div>
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      <span className="capitalize" style={{ color: 'var(--text-secondary)' }}>{selectedProvider}</span>
                      <span className="mx-1.5" style={{ color: 'var(--text-muted)' }}>/</span>
                      <span>{selectedModel.split('/').pop()}</span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleSaveModel}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all border"
                  style={modelSavedFlash
                    ? { background: 'color-mix(in srgb, var(--accent-success) 20%, transparent)', color: 'var(--accent-success)', borderColor: 'color-mix(in srgb, var(--accent-success) 30%, transparent)' }
                    : { background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary))', color: 'var(--text-primary)', borderColor: 'transparent' }
                  }
                >
                  {modelSavedFlash ? <><Check className="w-4 h-4" /> Sauvegardé</> : <><Save className="w-4 h-4" /> Définir par défaut</>}
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'skills' && (
          <div className="space-y-5">
            {/* Intro */}
            <div className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              <span>Skills (compétences)</span>
              <InfoButton>
                <strong>Un skill</strong> est une compétence spécialisée que tu peux activer pour orienter l'agent sur une tâche précise — par exemple un skill <em>code_reviewer</em>, <em>writer</em>, <em>debugger</em>…
                <br /><br />
                Chaque skill contient un prompt système spécifique, une liste d'outils recommandés, et des exemples. Quand tu l'actives, l'agent prend le ton et les comportements définis dans le skill pour cette conversation.
                <br /><br />
                Gungnir fournit plusieurs templates par défaut (tu peux les modifier ou les supprimer — ce que tu supprimes reste supprimé pour toi). Tu peux aussi créer les tiens de zéro ou les importer depuis un fichier JSON/MD.
              </InfoButton>
            </div>
            {/* New skill form */}
            <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border)] p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                  <Plus className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} /> Nouveau Skill
                </h3>
                <button onClick={() => skillFileRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:opacity-80"
                  style={{ borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }}>
                  <Upload className="w-3.5 h-3.5" /> Importer
                </button>
                <input ref={skillFileRef} type="file" accept=".json,.md,.txt" className="hidden" onChange={handleImportSkill} />
              </div>
              {importStatus?.type === 'skill' && (
                <div className="mb-4 p-3 rounded-lg border text-sm" style={{
                  borderColor: importStatus.success ? 'var(--accent-success)' : 'var(--accent-danger)',
                  background: importStatus.success ? 'color-mix(in srgb, var(--accent-success) 8%, transparent)' : 'color-mix(in srgb, var(--accent-danger) 8%, transparent)',
                  color: 'var(--text-primary)',
                }}>
                  <div className="flex items-center gap-2 font-medium">
                    <Shield className="w-4 h-4" style={{ color: importStatus.success ? 'var(--accent-success)' : 'var(--accent-danger)' }} />
                    {importStatus.message}
                  </div>
                  {importStatus.violations && importStatus.violations.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {importStatus.violations.map((v: any, i: number) => (
                        <div key={i} className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase" style={{
                            background: v.severity === 'critical' ? 'var(--accent-danger)' : v.severity === 'high' ? 'var(--accent-secondary)' : 'var(--accent-tertiary)',
                            color: '#fff',
                          }}>{v.severity}</span>
                          {v.description}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Champs essentiels */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input type="text" placeholder="Nom (snake_case)" value={newSkill.name}
                  onChange={e => setNewSkill({ ...newSkill, name: e.target.value })}
                  className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                  style={{ color: 'var(--text-primary)', '--tw-ring-color': 'color-mix(in srgb, var(--accent-primary) 50%, transparent)' } as React.CSSProperties} />
                <input type="text" placeholder="Description" value={newSkill.description}
                  onChange={e => setNewSkill({ ...newSkill, description: e.target.value })}
                  className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                  style={{ color: 'var(--text-primary)', '--tw-ring-color': 'color-mix(in srgb, var(--accent-primary) 50%, transparent)' } as React.CSSProperties} />
                <select value={newSkill.category} onChange={e => setNewSkill({ ...newSkill, category: e.target.value })}
                  className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ color: 'var(--text-primary)' }}>
                  <option value="general">Général</option>
                  <option value="development">Développement</option>
                  <option value="research">Recherche</option>
                  <option value="writing">Rédaction</option>
                  <option value="design">Design</option>
                  <option value="data">Data / Analyse</option>
                  <option value="security">Sécurité</option>
                  <option value="devops">DevOps</option>
                </select>
                <select value={newSkill.output_format} onChange={e => setNewSkill({ ...newSkill, output_format: e.target.value })}
                  className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ color: 'var(--text-primary)' }}>
                  <option value="text">Sortie : Texte</option>
                  <option value="markdown">Sortie : Markdown</option>
                  <option value="json">Sortie : JSON</option>
                  <option value="structured">Sortie : Structuré</option>
                </select>
              </div>

              <textarea placeholder="Prompt du skill…" value={newSkill.prompt}
                onChange={e => setNewSkill({ ...newSkill, prompt: e.target.value })} rows={4}
                className="w-full mt-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 resize-none"
                style={{ color: 'var(--text-primary)', '--tw-ring-color': 'color-mix(in srgb, var(--accent-primary) 50%, transparent)' } as React.CSSProperties} />

              <input type="text" placeholder="Tags (séparés par virgule : seo, analyse, code…)" value={newSkill.tags}
                onChange={e => setNewSkill({ ...newSkill, tags: e.target.value })}
                className="w-full mt-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                style={{ color: 'var(--text-primary)', '--tw-ring-color': 'color-mix(in srgb, var(--accent-primary) 50%, transparent)' } as React.CSSProperties} />

              {/* Section avancée (repliable) */}
              <button onClick={() => setShowAdvancedSkill(!showAdvancedSkill)}
                className="flex items-center gap-2 mt-3 text-xs transition-colors"
                style={{ color: 'var(--text-muted)' }}>
                {showAdvancedSkill ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                Paramètres avancés (version, auteur, licence, annotations, exemples)
              </button>

              {showAdvancedSkill && (
                <div className="mt-3 space-y-3 p-3 rounded-lg border border-[var(--border)]" style={{ background: 'color-mix(in srgb, var(--bg-secondary) 50%, transparent)' }}>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="text-[10px] uppercase tracking-widest mb-1 block" style={{ color: 'var(--text-muted)' }}>Version</label>
                      <input type="text" value={newSkill.version} onChange={e => setNewSkill({ ...newSkill, version: e.target.value })}
                        className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                        style={{ color: 'var(--text-primary)' }} />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-widest mb-1 block" style={{ color: 'var(--text-muted)' }}>Auteur</label>
                      <input type="text" value={newSkill.author} onChange={e => setNewSkill({ ...newSkill, author: e.target.value })}
                        className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                        style={{ color: 'var(--text-primary)' }} />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-widest mb-1 block" style={{ color: 'var(--text-muted)' }}>Licence</label>
                      <select value={newSkill.license} onChange={e => setNewSkill({ ...newSkill, license: e.target.value })}
                        className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                        style={{ color: 'var(--text-primary)' }}>
                        <option value="MIT">MIT</option>
                        <option value="Apache-2.0">Apache 2.0</option>
                        <option value="GPL-3.0">GPL 3.0</option>
                        <option value="proprietary">Propriétaire</option>
                        <option value="none">Aucune</option>
                      </select>
                    </div>
                  </div>

                  {/* Annotations */}
                  <div>
                    <label className="text-[10px] uppercase tracking-widest mb-2 block" style={{ color: 'var(--text-muted)' }}>Annotations</label>
                    <div className="flex flex-wrap gap-3">
                      {[
                        { key: 'readOnly', label: 'Lecture seule', desc: 'Ne modifie rien' },
                        { key: 'destructive', label: 'Destructif', desc: 'Peut supprimer des données' },
                        { key: 'idempotent', label: 'Idempotent', desc: 'Peut être relancé sans effet' },
                      ].map(ann => (
                        <label key={ann.key} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer text-xs transition-all"
                          style={{
                            background: (newSkill.annotations as any)[ann.key] ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'var(--bg-secondary)',
                            border: `1px solid ${(newSkill.annotations as any)[ann.key] ? 'color-mix(in srgb, var(--accent-primary) 30%, transparent)' : 'var(--border)'}`,
                            color: (newSkill.annotations as any)[ann.key] ? 'var(--accent-primary)' : 'var(--text-secondary)',
                          }}>
                          <input type="checkbox" checked={(newSkill.annotations as any)[ann.key]}
                            onChange={e => setNewSkill({ ...newSkill, annotations: { ...newSkill.annotations, [ann.key]: e.target.checked } })}
                            className="sr-only" />
                          <span>{ann.label}</span>
                          <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>— {ann.desc}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Exemples */}
                  <div>
                    <label className="text-[10px] uppercase tracking-widest mb-2 block" style={{ color: 'var(--text-muted)' }}>Exemples d'utilisation</label>
                    {newSkill.examples.map((ex, i) => (
                      <div key={i} className="grid grid-cols-2 gap-2 mb-2">
                        <input type="text" placeholder="Question exemple" value={ex.prompt}
                          onChange={e => {
                            const exs = [...newSkill.examples]; exs[i] = { ...exs[i], prompt: e.target.value }
                            setNewSkill({ ...newSkill, examples: exs })
                          }}
                          className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs focus:outline-none"
                          style={{ color: 'var(--text-primary)' }} />
                        <div className="flex gap-1">
                          <input type="text" placeholder="Réponse attendue" value={ex.expected}
                            onChange={e => {
                              const exs = [...newSkill.examples]; exs[i] = { ...exs[i], expected: e.target.value }
                              setNewSkill({ ...newSkill, examples: exs })
                            }}
                            className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs focus:outline-none"
                            style={{ color: 'var(--text-primary)' }} />
                          {newSkill.examples.length > 1 && (
                            <button onClick={() => setNewSkill({ ...newSkill, examples: newSkill.examples.filter((_, j) => j !== i) })}
                              className="p-1.5 rounded-lg hover:bg-[var(--bg-secondary)]" style={{ color: 'var(--text-muted)' }}>
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    <button onClick={() => setNewSkill({ ...newSkill, examples: [...newSkill.examples, { prompt: '', expected: '' }] })}
                      className="text-[10px] flex items-center gap-1 mt-1 transition-colors" style={{ color: 'var(--accent-primary)' }}>
                      <Plus className="w-3 h-3" /> Ajouter un exemple
                    </button>
                  </div>
                </div>
              )}

              <div className="flex justify-end mt-3">
                <button onClick={createSkill} disabled={!newSkill.name || !newSkill.prompt}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary))', color: 'var(--text-primary)' }}>
                  <Plus className="w-4 h-4" /> Créer le skill
                </button>
              </div>
            </div>

            {/* Skills list */}
            <div className="space-y-2">
              <h3 className="font-semibold text-sm mb-3" style={{ color: 'var(--text-primary)' }}>Skills existants</h3>
              {skills.map((skill: any, idx: number) => {
                const isEditing = editingSkill === skill.name
                return (
                  <div key={skill.name}
                    draggable
                    onDragStart={(e) => {
                      dragRef.current = { idx, context: 'skill' }
                      setDraggedIdx(idx); setDragContext('skill')
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (dragRef.current?.context === 'skill') setDragOverIdx(idx)
                    }}
                    onDragEnd={() => {
                      dragRef.current = null
                      setDraggedIdx(null); setDragOverIdx(null); setDragContext(null)
                    }}
                    onDrop={async () => {
                      const drag = dragRef.current
                      if (!drag || drag.context !== 'skill' || drag.idx === idx) return
                      const reordered = [...skills]
                      const [moved] = reordered.splice(drag.idx, 1)
                      reordered.splice(idx, 0, moved)
                      setSkills(reordered)
                      dragRef.current = null
                      setDraggedIdx(null); setDragOverIdx(null); setDragContext(null)
                      await api.reorderSkills(reordered.map((s: any) => s.name))
                    }}
                    className="rounded-xl border overflow-hidden transition-all"
                    style={{
                      borderColor: activeSkillName === skill.name ? 'var(--accent-primary)'
                        : dragContext === 'skill' && dragOverIdx === idx && draggedIdx !== idx ? 'var(--accent-primary)'
                        : 'var(--border)',
                      background: activeSkillName === skill.name
                        ? 'color-mix(in srgb, var(--accent-primary) 6%, var(--bg-primary))'
                        : 'var(--bg-primary)',
                      ...(dragContext === 'skill' && dragOverIdx === idx && draggedIdx !== idx ? { boxShadow: '0 0 0 1px var(--accent-primary)' } : {}),
                      ...(dragContext === 'skill' && draggedIdx === idx ? { opacity: 0.5 } : {}),
                      ...(activeSkillName === skill.name ? { boxShadow: '0 0 0 1px var(--accent-primary)' } : {}),
                    }}
                  >
                    <div className="flex items-center gap-3 p-4">
                      <div className="cursor-grab active:cursor-grabbing p-1 -ml-1 flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                        <GripVertical className="w-4 h-4" />
                      </div>
                      <button
                        onClick={async () => {
                          const res = await api.toggleSkillFavorite(skill.name)
                          if (res.success) {
                            setSkills(prev => prev.map((s: any) => s.name === skill.name ? { ...s, is_favorite: res.is_favorite } : s))
                          }
                        }}
                        className="p-1 flex-shrink-0 transition-colors"
                        title={skill.is_favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                      >
                        <Star className={`w-4 h-4 ${skill.is_favorite ? 'fill-current' : ''}`} style={{ color: skill.is_favorite ? 'var(--accent-tertiary)' : 'var(--border)' }} />
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <SkillIconPicker
                            icon={skill.icon || ''}
                            onChange={async (emoji: string) => {
                              setSkills(prev => prev.map((s: any) => s.name === skill.name ? { ...s, icon: emoji } : s))
                              await apiFetch(`/api/skills/${encodeURIComponent(skill.name)}/icon`, {
                                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ icon: emoji }),
                              })
                            }}
                          />
                          <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{skill.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] border border-[var(--border)] capitalize" style={{ color: 'var(--text-muted)' }}>{skill.category}</span>
                          {skill.version && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded border" style={{ color: 'var(--accent-tertiary)', borderColor: 'color-mix(in srgb, var(--accent-tertiary) 30%, transparent)' }}>v{skill.version}</span>
                          )}
                          {skill.annotations?.readOnly && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'var(--accent-success)', background: 'color-mix(in srgb, var(--accent-success) 12%, transparent)' }}>lecture seule</span>
                          )}
                          {activeSkillName === skill.name && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-bold flex items-center gap-1"
                              style={{ color: '#fff', background: 'var(--accent-primary)' }}>
                              <Check className="w-3 h-3" /> Actif
                            </span>
                          )}
                        </div>
                        <p className="text-xs mt-1 ml-6" style={{ color: 'var(--text-muted)' }}>{skill.description}</p>
                        {/* Tags */}
                        {skill.tags && skill.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5 ml-6">
                            {skill.tags.map((tag: string) => (
                              <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ color: 'var(--accent-primary-light)', background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' }}>#{tag}</span>
                            ))}
                          </div>
                        )}
                        {/* Tools */}
                        {skill.tools && skill.tools.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5 ml-6">
                            {skill.tools.map((tool: string) => (
                              <span key={tool} className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ color: 'var(--text-secondary)', background: 'color-mix(in srgb, var(--border) 40%, transparent)' }}>{tool}</span>
                            ))}
                          </div>
                        )}
                        {/* Author + license */}
                        {(skill.author || skill.license) && (
                          <div className="flex items-center gap-3 mt-1.5 ml-6">
                            {skill.author && <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>par {skill.author}</span>}
                            {skill.license && <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>• {skill.license}</span>}
                            {skill.compatibility && skill.compatibility.length > 0 && (
                              <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>• {skill.compatibility.join(', ')}</span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => toggleActiveSkill(skill.name)}
                          className="px-2.5 py-1 rounded-lg text-xs font-medium border transition-all"
                          style={activeSkillName === skill.name
                            ? { background: 'var(--accent-primary)', color: '#fff', borderColor: 'var(--accent-primary)' }
                            : { background: 'var(--bg-secondary)', color: 'var(--text-secondary)', borderColor: 'var(--border)' }
                          }
                          title={activeSkillName === skill.name ? 'Désactiver ce skill' : 'Utiliser ce skill dans le chat'}
                        >
                          {activeSkillName === skill.name ? 'Désactiver' : 'Utiliser'}
                        </button>
                        <button
                          onClick={() => {
                            if (isEditing) { setEditingSkill(null) }
                            else { setEditingSkill(skill.name); setEditSkillForm({ description: skill.description, prompt: skill.prompt || '', category: skill.category, tags: (skill.tags || []).join(', '), version: skill.version || '1.0.0', author: skill.author || 'gungnir', license: skill.license || 'MIT', output_format: skill.output_format || 'text' }) }
                          }}
                          className="p-1.5 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors"
                          style={{ color: "var(--text-muted)" }}
                          title="Éditer"
                        >
                          <SettingsIcon className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => deleteSkill(skill.name)}
                          className="p-1.5 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors"
                          style={{ color: "var(--text-muted)" }}
                          title="Supprimer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    {isEditing && (
                      <div className="border-t border-[var(--border)] p-4 space-y-3">
                        <input type="text" placeholder="Description" value={editSkillForm.description}
                          onChange={e => setEditSkillForm({ ...editSkillForm, description: e.target.value })}
                          className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2" style={{ color: "var(--text-primary)", "--tw-ring-color": "color-mix(in srgb, var(--accent-primary) 50%, transparent)" } as React.CSSProperties} />

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          <select value={editSkillForm.category} onChange={e => setEditSkillForm({ ...editSkillForm, category: e.target.value })}
                            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-xs focus:outline-none" style={{ color: 'var(--text-primary)' }}>
                            {['general','development','research','writing','design','data','security','devops'].map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                          <select value={editSkillForm.output_format} onChange={e => setEditSkillForm({ ...editSkillForm, output_format: e.target.value })}
                            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-xs focus:outline-none" style={{ color: 'var(--text-primary)' }}>
                            <option value="text">Texte</option><option value="markdown">Markdown</option><option value="json">JSON</option><option value="structured">Structuré</option>
                          </select>
                          <input type="text" placeholder="Version" value={editSkillForm.version}
                            onChange={e => setEditSkillForm({ ...editSkillForm, version: e.target.value })}
                            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-xs focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                          <select value={editSkillForm.license} onChange={e => setEditSkillForm({ ...editSkillForm, license: e.target.value })}
                            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-xs focus:outline-none" style={{ color: 'var(--text-primary)' }}>
                            <option value="MIT">MIT</option><option value="Apache-2.0">Apache 2.0</option><option value="GPL-3.0">GPL 3.0</option><option value="proprietary">Propriétaire</option><option value="none">Aucune</option>
                          </select>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <input type="text" placeholder="Auteur" value={editSkillForm.author}
                            onChange={e => setEditSkillForm({ ...editSkillForm, author: e.target.value })}
                            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                          <input type="text" placeholder="Tags (séparés par virgule)" value={editSkillForm.tags}
                            onChange={e => setEditSkillForm({ ...editSkillForm, tags: e.target.value })}
                            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                        </div>

                        <div>
                          <label className="text-xs uppercase tracking-widest mb-1.5 block" style={{ color: 'var(--text-muted)' }}>Prompt système</label>
                          <textarea value={editSkillForm.prompt}
                            onChange={e => setEditSkillForm({ ...editSkillForm, prompt: e.target.value })} rows={6}
                            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 resize-none" style={{ color: "var(--text-primary)", "--tw-ring-color": "color-mix(in srgb, var(--accent-primary) 50%, transparent)" } as React.CSSProperties} />
                        </div>
                        {/* Examples */}
                        {skill.examples && skill.examples.length > 0 && (
                          <div>
                            <label className="text-xs uppercase tracking-widest mb-1.5 block" style={{ color: 'var(--text-muted)' }}>Exemples d'utilisation</label>
                            <div className="space-y-1.5">
                              {skill.examples.map((ex: any, i: number) => (
                                <div key={i} className="rounded-lg p-2.5 text-xs" style={{ background: 'color-mix(in srgb, var(--bg-secondary) 60%, transparent)', border: '1px solid var(--border)' }}>
                                  <div className="flex gap-2"><span style={{ color: 'var(--accent-primary)' }}>Q:</span> <span style={{ color: 'var(--text-secondary)' }}>{ex.prompt}</span></div>
                                  <div className="flex gap-2 mt-1"><span style={{ color: 'var(--accent-success)' }}>R:</span> <span style={{ color: 'var(--text-muted)' }}>{ex.expected}</span></div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => setEditingSkill(null)}
                            className="px-3 py-1.5 rounded-lg text-sm border border-[var(--border)] transition-colors" style={{ color: "var(--text-secondary)" }}>
                            Annuler
                          </button>
                          <button onClick={() => saveSkill(skill.name)}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm"
                            style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary))', color: 'var(--text-primary)' }}>
                            <Save className="w-3.5 h-3.5" /> Sauvegarder
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              {skills.length === 0 && (
                <div className="text-center py-10 px-6 rounded-xl border border-dashed" style={{ borderColor: 'var(--border)', background: 'var(--bg-primary)' }}>
                  <Sparkles className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
                  <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Aucun skill configuré</p>
                  <p className="text-xs max-w-sm mx-auto mb-4" style={{ color: 'var(--text-muted)' }}>
                    Les skills sont des compétences spécialisées que tu actives pour orienter l'agent sur une tâche précise (code review, rédaction, debug…). Crée le tien via le formulaire ci-dessus ou importe un fichier JSON / Markdown.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'subagents' && (
          <div className="space-y-5">
            {/* Intro */}
            <div className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              <span>Sous-agents</span>
              <InfoButton>
                <strong>Un sous-agent</strong> est un agent spécialisé que l'agent principal peut invoquer pour déléguer une tâche précise — par exemple un sous-agent <em>agent_seo_expert</em>, <em>agent_analyste_vulnerabilites</em>, <em>agent_expert_comptable</em>…
                <br /><br />
                Contrairement aux skills (qui sont des modes temporaires), les sous-agents sont des <em>entités</em> avec leur propre identité, leur propre prompt, leurs propres outils, et même leur propre provider/modèle. L'agent principal peut leur envoyer une tâche et récupérer le résultat.
                <br /><br />
                Tu peux voir le détail des échanges inter-agents dans l'onglet <em>Conversations inter-agents</em>.
              </InfoButton>
            </div>

            {/* ── Formulaire création ── */}
            <div className="rounded-xl border p-5 space-y-3" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg" style={{ background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' }}><Users className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} /></div>
                  <h4 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Nouveau sous-agent</h4>
                </div>
                <button onClick={() => agentFileRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:opacity-80"
                  style={{ borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }}>
                  <Upload className="w-3.5 h-3.5" /> Importer
                </button>
                <input ref={agentFileRef} type="file" accept=".json,.md,.txt" className="hidden" onChange={handleImportAgent} />
              </div>
              {importStatus?.type === 'agent' && (
                <div className="p-3 rounded-lg border text-sm" style={{
                  borderColor: importStatus.success ? 'var(--accent-success)' : 'var(--accent-danger)',
                  background: importStatus.success ? 'color-mix(in srgb, var(--accent-success) 8%, transparent)' : 'color-mix(in srgb, var(--accent-danger) 8%, transparent)',
                  color: 'var(--text-primary)',
                }}>
                  <div className="flex items-center gap-2 font-medium">
                    <Shield className="w-4 h-4" style={{ color: importStatus.success ? 'var(--accent-success)' : 'var(--accent-danger)' }} />
                    {importStatus.message}
                  </div>
                  {importStatus.violations && importStatus.violations.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {importStatus.violations.map((v: any, i: number) => (
                        <div key={i} className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase" style={{
                            background: v.severity === 'critical' ? 'var(--accent-danger)' : v.severity === 'high' ? 'var(--accent-secondary)' : 'var(--accent-tertiary)',
                            color: '#fff',
                          }}>{v.severity}</span>
                          {v.description}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Champs essentiels */}
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="Nom (ex: seo_expert)" value={newAgent.name}
                  onChange={e => setNewAgent({ ...newAgent, name: e.target.value })}
                  className="col-span-1 rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                <input placeholder="Rôle (ex: Expert SEO)" value={newAgent.role}
                  onChange={e => setNewAgent({ ...newAgent, role: e.target.value })}
                  className="col-span-1 rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                <input placeholder="Description courte" value={newAgent.description}
                  onChange={e => setNewAgent({ ...newAgent, description: e.target.value })}
                  className="col-span-2 rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                <input placeholder="Expertise (ex: référencement, mots-clés)" value={newAgent.expertise}
                  onChange={e => setNewAgent({ ...newAgent, expertise: e.target.value })}
                  className="col-span-2 rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                <textarea placeholder="System prompt (optionnel — généré automatiquement si vide)" value={newAgent.system_prompt}
                  onChange={e => setNewAgent({ ...newAgent, system_prompt: e.target.value })} rows={3}
                  className="col-span-2 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none font-mono"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                <input type="text" placeholder="Tags (séparés par virgule)" value={newAgent.tags}
                  onChange={e => setNewAgent({ ...newAgent, tags: e.target.value })}
                  className="col-span-2 rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              </div>

              {/* Sélecteur modèle */}
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Modèle du sous-agent</p>
                <select
                  value={newAgent.model ? `${newAgent.provider}||${newAgent.model}` : ''}
                  onChange={e => {
                    if (!e.target.value) {
                      setNewAgent({ ...newAgent, model: '' })
                    } else {
                      const [prov, ...rest] = e.target.value.split('||')
                      setNewAgent({ ...newAgent, provider: prov, model: rest.join('||') })
                    }
                  }}
                  className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                  <option value="">— Modèle par défaut du provider principal —</option>
                  {enabledProviders.map(prov => (
                    <optgroup key={prov.name} label={prov.name.toUpperCase()}>
                      {prov.models.map(m => (
                        <option key={`${prov.name}||${m}`} value={`${prov.name}||${m}`}>
                          {m.split('/').pop()} {m === prov.defaultModel ? '★' : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {newAgent.model && (
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{newAgent.provider} / {newAgent.model}</p>
                )}
              </div>

              {/* Section avancée */}
              <button onClick={() => setShowAdvancedAgent(!showAdvancedAgent)}
                className="flex items-center gap-2 text-xs transition-colors"
                style={{ color: 'var(--text-muted)' }}>
                {showAdvancedAgent ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                Paramètres avancés (version, auteur, itérations max)
              </button>

              {showAdvancedAgent && (
                <div className="p-3 rounded-lg border border-[var(--border)] grid grid-cols-3 gap-3" style={{ background: 'color-mix(in srgb, var(--bg-secondary) 50%, transparent)' }}>
                  <div>
                    <label className="text-[10px] uppercase tracking-widest mb-1 block" style={{ color: 'var(--text-muted)' }}>Version</label>
                    <input type="text" value={newAgent.version} onChange={e => setNewAgent({ ...newAgent, version: e.target.value })}
                      className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                      style={{ color: 'var(--text-primary)' }} />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-widest mb-1 block" style={{ color: 'var(--text-muted)' }}>Auteur</label>
                    <input type="text" value={newAgent.author} onChange={e => setNewAgent({ ...newAgent, author: e.target.value })}
                      className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                      style={{ color: 'var(--text-primary)' }} />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-widest mb-1 block" style={{ color: 'var(--text-muted)' }}>Itérations max</label>
                    <input type="number" min={1} max={50} value={newAgent.max_iterations}
                      onChange={e => setNewAgent({ ...newAgent, max_iterations: parseInt(e.target.value) || 5 })}
                      className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                      style={{ color: 'var(--text-primary)' }} />
                  </div>
                </div>
              )}

              <button onClick={createSubAgent} disabled={!newAgent.name || !newAgent.role}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary))', color: 'var(--text-primary)' }}>
                <Plus className="w-3.5 h-3.5" /> Créer le sous-agent
              </button>
            </div>

            {/* ── Liste des sous-agents ── */}
            <div className="space-y-3">
              {subAgents.length === 0 && (
                <div className="text-center py-10 px-6 rounded-xl border border-dashed" style={{ borderColor: 'var(--border)', background: 'var(--bg-primary)' }}>
                  <Users className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
                  <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Aucun sous-agent configuré</p>
                  <p className="text-xs max-w-sm mx-auto" style={{ color: 'var(--text-muted)' }}>
                    Un sous-agent est une entité spécialisée avec sa propre identité et son propre provider/modèle. {agentName} peut en créer automatiquement en discutant avec toi, ou tu peux en définir via le formulaire ci-dessus.
                  </p>
                </div>
              )}

              {subAgents.map((agent: any) => {
                const isEditing = editingAgent === agent.name
                return (
                  <div key={agent.name} className="rounded-xl border overflow-hidden transition-all"
                    style={{ background: 'var(--bg-primary)', borderColor: isEditing ? 'color-mix(in srgb, var(--accent-primary) 30%, transparent)' : 'var(--border-subtle)' }}>

                    {/* Header carte */}
                    <div className="flex items-center justify-between px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent-primary) 15%, transparent), color-mix(in srgb, var(--accent-secondary) 8%, transparent))' }}>
                          <Bot className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{agent.name}</span>
                            {agent.version && <span className="text-[10px] px-1.5 py-0.5 rounded border" style={{ color: 'var(--accent-tertiary)', borderColor: 'color-mix(in srgb, var(--accent-tertiary) 30%, transparent)' }}>v{agent.version}</span>}
                          </div>
                          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{agent.role}</div>
                          {agent.description && <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{agent.description}</div>}
                          {agent.tags && agent.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {agent.tags.map((tag: string) => (
                                <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ color: 'var(--accent-primary-light)', background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' }}>#{tag}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {/* Badge modèle */}
                        <span className="px-2 py-0.5 rounded text-[10px] font-medium" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                          {agent.model ? agent.model.split('/').pop() : 'modèle défaut'}
                        </span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-medium" style={{ background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent)', color: 'var(--accent-primary)' }}>
                          {agent.provider || 'openrouter'}
                        </span>
                        <button onClick={() => isEditing ? setEditingAgent(null) : startEditAgent(agent)}
                          className="p-1.5 rounded-lg transition-colors text-xs"
                          style={isEditing ? { color: 'var(--accent-primary)', background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' } : { color: 'var(--text-muted)' }}>
                          <SettingsIcon className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteSubAgent(agent.name)}
                          className="p-1.5 rounded-lg transition-colors"
                          style={{ color: 'var(--text-muted)' }}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Expertise preview (collapsed) */}
                    {!isEditing && agent.expertise && (
                      <div className="px-4 pb-3">
                        <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{agent.expertise}</p>
                      </div>
                    )}

                    {/* Formulaire édition inline */}
                    {isEditing && (
                      <div className="px-4 pb-4 space-y-3 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-[10px] uppercase tracking-widest block mb-1" style={{ color: 'var(--text-muted)' }}>Rôle</label>
                            <input value={editAgentForm.role} onChange={e => setEditAgentForm({ ...editAgentForm, role: e.target.value })}
                              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                          </div>
                          <div>
                            <label className="text-[10px] uppercase tracking-widest block mb-1" style={{ color: 'var(--text-muted)' }}>Expertise</label>
                            <input value={editAgentForm.expertise} onChange={e => setEditAgentForm({ ...editAgentForm, expertise: e.target.value })}
                              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                          </div>
                        </div>

                        <div>
                          <label className="text-[10px] uppercase tracking-widest block mb-1" style={{ color: 'var(--text-muted)' }}>System Prompt</label>
                          <textarea value={editAgentForm.system_prompt} onChange={e => setEditAgentForm({ ...editAgentForm, system_prompt: e.target.value })} rows={5}
                            className="w-full rounded-lg px-3 py-2 text-sm font-mono focus:outline-none resize-y"
                            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-[10px] uppercase tracking-widest block" style={{ color: 'var(--text-muted)' }}>Modèle du sous-agent</label>
                          <select
                            value={editAgentForm.model ? `${editAgentForm.provider}||${editAgentForm.model}` : ''}
                            onChange={e => {
                              if (!e.target.value) {
                                setEditAgentForm({ ...editAgentForm, model: '' })
                              } else {
                                const [prov, ...rest] = e.target.value.split('||')
                                setEditAgentForm({ ...editAgentForm, provider: prov, model: rest.join('||') })
                              }
                            }}
                            className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                          >
                            <option value="">— Modèle par défaut du provider principal —</option>
                            {enabledProviders.map(prov => (
                              <optgroup key={prov.name} label={prov.name.toUpperCase()}>
                                {prov.models.map(m => (
                                  <option key={`${prov.name}||${m}`} value={`${prov.name}||${m}`}>
                                    {m.split('/').pop()} {m === prov.defaultModel ? '★' : ''}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                          {editAgentForm.model && (
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{editAgentForm.provider} / {editAgentForm.model}</p>
                          )}
                        </div>

                        <div className="flex items-center gap-2 pt-1">
                          <button onClick={() => saveSubAgent(agent.name)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm"
                            style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary))', color: 'var(--text-primary)' }}>
                            <Save className="w-3.5 h-3.5" /> Sauvegarder
                          </button>
                          <button onClick={() => setEditingAgent(null)}
                            className="px-3 py-1.5 rounded-lg text-sm transition-colors"
                            style={{ color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}>
                            Annuler
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {activeTab === 'personality' && (
          <div className="space-y-5">

            {/* ─── Soul editor ─── */}
            <div className="bg-[var(--bg-primary)] rounded-xl border p-5 space-y-3" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2 mb-1">
                <div className="p-1.5 rounded-lg" style={{ background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' }}>
                  <FileText className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                </div>
                <div className="flex-1">
                  <h4 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Âme de {agentName}</h4>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Identité permanente injectée avant chaque conversation — indépendante des personnalités.</p>
                </div>
              </div>

              {soulLoaded ? (
                <textarea
                  value={soulContent}
                  onChange={e => setSoulContent(e.target.value)}
                  rows={10}
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2.5 text-xs font-mono focus:outline-none focus:ring-2 resize-y" style={{ color: "var(--text-primary)", "--tw-ring-color": "color-mix(in srgb, var(--accent-primary) 40%, transparent)" } as React.CSSProperties}
                  placeholder={`# Identité de ${agentName}\nTu es ${agentName}, un super-assistant IA...`}
                  spellCheck={false}
                />
              ) : (
                <div className="h-32 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] flex items-center justify-center">
                  <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Chargement…</span>
                </div>
              )}

              <div className="flex items-center justify-between">
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Fichier : <code style={{ color: 'var(--text-muted)' }}>data/soul/&lt;ton_id&gt;/soul.md</code> <span className="opacity-60">(per-user)</span>
                </div>
                <button
                  onClick={saveSoul}
                  disabled={isSavingSoul || !soulLoaded}
                  className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-50 border"
                  style={soulSaveFlash === 'ok'
                    ? { background: 'color-mix(in srgb, var(--accent-success) 20%, transparent)', color: 'var(--accent-success)', borderColor: 'color-mix(in srgb, var(--accent-success) 30%, transparent)' }
                    : soulSaveFlash === 'err'
                      ? { background: 'color-mix(in srgb, var(--accent-danger) 20%, transparent)', color: 'var(--accent-danger)', borderColor: 'color-mix(in srgb, var(--accent-danger) 30%, transparent)' }
                      : { background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary))', color: 'var(--text-primary)', borderColor: 'transparent' }
                  }
                >
                  {soulSaveFlash === 'ok' ? (
                    <><Check className="w-4 h-4" /> Sauvegardé</>
                  ) : soulSaveFlash === 'err' ? (
                    <><X className="w-4 h-4" /> Erreur</>
                  ) : isSavingSoul ? (
                    <><Save className="w-4 h-4 animate-pulse" /> Sauvegarde…</>
                  ) : (
                    <><Save className="w-4 h-4" /> Sauvegarder</>
                  )}
                </button>
              </div>
            </div>

            {/* ─── Header personnalités ─── */}
            <div className="flex items-center justify-between pt-2">
              <div>
                <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>Personnalités</h3>
                <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  La personnalité active est injectée après l'âme dans chaque message.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => personalityFileRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors hover:opacity-80"
                  style={{ borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }}>
                  <Upload className="w-3.5 h-3.5" /> Importer
                </button>
                <input ref={personalityFileRef} type="file" accept=".json,.md,.txt" className="hidden" onChange={handleImportPersonality} />
                <button
                  onClick={() => { setShowNewForm(!showNewForm); setNewFormError('') }}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary))', color: 'var(--text-primary)' }}
                >
                  {showNewForm ? <><X className="w-4 h-4" /> Fermer</> : <><Plus className="w-4 h-4" /> Nouvelle</>}
                </button>
              </div>
            </div>

            {importStatus?.type === 'personality' && (
              <div className="p-3 rounded-lg border text-sm" style={{
                borderColor: importStatus.success ? 'var(--accent-success)' : 'var(--accent-danger)',
                background: importStatus.success ? 'color-mix(in srgb, var(--accent-success) 8%, transparent)' : 'color-mix(in srgb, var(--accent-danger) 8%, transparent)',
                color: importStatus.success ? 'var(--accent-success)' : 'var(--accent-danger)',
              }}>
                {importStatus.message}
              </div>
            )}

            {/* New personality form */}
            {showNewForm && (
              <div className="bg-[var(--bg-primary)] rounded-xl border p-5 space-y-3" style={{ borderColor: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' }}>
                <h4 className="font-medium text-sm flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Plus className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} /> Créer une personnalité
                </h4>
                <div>
                  <input
                    type="text"
                    placeholder="Nom (ex: pirate, scientifique...)"
                    value={newForm.name}
                    onChange={e => { setNewForm({ ...newForm, name: e.target.value }); setNewFormError('') }}
                    className={`w-full bg-[var(--bg-secondary)] border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
                      newFormError && !newForm.name ? '' : 'border-[var(--border)]'
                    }`}
                    style={{ color: "var(--text-primary)", "--tw-ring-color": "color-mix(in srgb, var(--accent-primary) 50%, transparent)", ...(newFormError && !newForm.name ? { borderColor: "color-mix(in srgb, var(--accent-danger) 60%, transparent)" } : {}) } as React.CSSProperties}
                  />
                </div>
                <input
                  type="text"
                  placeholder="Description courte (optionnel)"
                  value={newForm.description}
                  onChange={e => setNewForm({ ...newForm, description: e.target.value })}
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2" style={{ color: "var(--text-primary)", "--tw-ring-color": "color-mix(in srgb, var(--accent-primary) 50%, transparent)" } as React.CSSProperties}
                />
                <div>
                  <label className="text-xs uppercase tracking-widest mb-1.5 block" style={{ color: 'var(--text-muted)' }}>Prompt système *</label>
                  <textarea
                    placeholder={`Ex : Tu es ${agentName}, un assistant IA avec le caractère d'un pirate des mers. Tu utilises argot marin, tu es direct et intrépide…`}
                    value={newForm.system_prompt}
                    onChange={e => { setNewForm({ ...newForm, system_prompt: e.target.value }); setNewFormError('') }}
                    rows={5}
                    className={`w-full bg-[var(--bg-secondary)] border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 resize-none ${
                      newFormError && !newForm.system_prompt ? '' : 'border-[var(--border)]'
                    }`}
                    style={{ color: 'var(--text-primary)', '--tw-ring-color': 'color-mix(in srgb, var(--accent-primary) 50%, transparent)', ...(newFormError && !newForm.system_prompt ? { borderColor: 'color-mix(in srgb, var(--accent-danger) 60%, transparent)' } : {}) } as React.CSSProperties}
                  />
                </div>

                {newFormError && (
                  <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--accent-danger)' }}>
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    {newFormError}
                  </div>
                )}

                {createSuccess && (
                  <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--accent-success)' }}>
                    <Check className="w-4 h-4 flex-shrink-0" />
                    Personnalité créée avec succès !
                  </div>
                )}

                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setShowNewForm(false); setNewForm({ name: '', description: '', system_prompt: '' }); setNewFormError(''); setCreateSuccess(false) }}
                    className="px-3 py-1.5 rounded-lg text-sm border border-[var(--border)] transition-colors"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Annuler
                  </button>
                  <button
                    disabled={isCreating}
                    onClick={async () => {
                      setNewFormError('')
                      setCreateSuccess(false)
                      if (!newForm.name.trim()) {
                        setNewFormError('Le nom est obligatoire.')
                        return
                      }
                      if (!newForm.system_prompt.trim()) {
                        setNewFormError('Le prompt système est obligatoire.')
                        return
                      }
                      setIsCreating(true)
                      try {
                        await api.createPersonality({
                          name: newForm.name.trim(),
                          description: newForm.description.trim(),
                          system_prompt: newForm.system_prompt.trim(),
                        })
                        setCreateSuccess(true)
                        setNewForm({ name: '', description: '', system_prompt: '' })
                        loadData()
                        setTimeout(() => { setShowNewForm(false); setCreateSuccess(false) }, 1200)
                      } catch (err: any) {
                        setNewFormError(err?.message || 'Erreur lors de la création.')
                      } finally {
                        setIsCreating(false)
                      }
                    }}
                    className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm disabled:opacity-60 transition-all"
                    style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary))', color: 'var(--text-primary)' }}
                  >
                    {isCreating ? (
                      <><Save className="w-4 h-4 animate-pulse" /> Création…</>
                    ) : (
                      <><Check className="w-4 h-4" /> Créer</>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* Personalities list */}
            <div className="space-y-1">
              {personalities.map((p: any, idx: number) => {
                const isActive = p.active
                const isEditing = editingPersonality === p.name
                const isDragSource = dragContext === 'personality' && draggedIdx === idx
                const isDragTarget = dragContext === 'personality' && dragOverIdx === idx && draggedIdx !== null && draggedIdx !== idx
                const dropAbove = isDragTarget && draggedIdx !== null && idx < draggedIdx
                const dropBelow = isDragTarget && draggedIdx !== null && idx > draggedIdx
                return (
                  <div key={p.name} className="relative">
                    {/* Drop indicator line — above */}
                    {dropAbove && (
                      <div className="absolute -top-1 left-4 right-4 flex items-center gap-2 z-10 pointer-events-none">
                        <div className="w-2.5 h-2.5 rounded-full border-2 flex-shrink-0" style={{ borderColor: 'var(--accent-primary)', background: 'var(--bg-primary)' }} />
                        <div className="flex-1 h-0.5 rounded-full" style={{ background: 'var(--accent-primary)' }} />
                      </div>
                    )}
                    <div
                      draggable
                      onDragStart={(e) => {
                        dragRef.current = { idx, context: 'personality' }
                        setDraggedIdx(idx); setDragContext('personality')
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (dragRef.current?.context === 'personality') setDragOverIdx(idx)
                      }}
                      onDragEnd={() => {
                        dragRef.current = null
                        setDraggedIdx(null); setDragOverIdx(null); setDragContext(null)
                      }}
                      onDrop={async () => {
                        const drag = dragRef.current
                        if (!drag || drag.context !== 'personality' || drag.idx === idx) return
                        const reordered = [...personalities]
                        const [moved] = reordered.splice(drag.idx, 1)
                        reordered.splice(idx, 0, moved)
                        setPersonalities(reordered)
                        dragRef.current = null
                        setDraggedIdx(null); setDragOverIdx(null); setDragContext(null)
                        await api.reorderPersonalities(reordered.map((pp: any) => pp.name))
                      }}
                      className="rounded-xl border transition-all"
                      style={{
                        ...(isActive
                          ? { borderColor: 'color-mix(in srgb, var(--accent-primary) 40%, transparent)', background: 'color-mix(in srgb, var(--accent-primary) 5%, transparent)' }
                          : { borderColor: 'var(--border)', background: 'var(--bg-primary)' }),
                        ...(isDragTarget ? { borderColor: 'var(--accent-primary)', boxShadow: '0 0 0 1px var(--accent-primary)' } : {}),
                        ...(isDragSource ? { opacity: 0.4, transform: 'scale(0.98)' } : {}),
                      }}
                  >
                    {/* Card header */}
                    <div className="flex items-center gap-3 p-4">
                      <div className="cursor-grab active:cursor-grabbing p-1 -ml-1" style={{ color: 'var(--text-muted)' }}>
                        <GripVertical className="w-4 h-4" />
                      </div>
                      <button
                        onClick={() => { setPersonality(p.name); setSelectedProvider(selectedProvider); }}
                        className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all"
                        style={isActive
                          ? { background: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' }
                          : { background: 'var(--bg-secondary)' }
                        }
                      >
                        <Bot className="w-5 h-5" style={{ color: isActive ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium capitalize" style={{ color: 'var(--text-primary)' }}>{p.name}</span>
                          {isActive && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide" style={{ background: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)', color: 'var(--accent-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' }}>
                              active
                            </span>
                          )}
                        </div>
                        <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{p.description}</p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => {
                            if (isEditing) {
                              setEditingPersonality(null)
                            } else {
                              setEditingPersonality(p.name)
                              setEditForm({ description: p.description, system_prompt: p.system_prompt || '', traits_str: (p.traits || []).join(', ') })
                            }
                          }}
                          className="p-1.5 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors"
                          style={{ color: "var(--text-muted)" }}
                          title="Éditer"
                        >
                          <SettingsIcon className="w-4 h-4" />
                        </button>
                        {personalities.length > 1 && (
                          <button
                            onClick={async () => {
                              if (!confirm(`Supprimer "${p.name}" ?`)) return
                              await api.deletePersonality(p.name)
                              loadData()
                            }}
                            className="p-1.5 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors"
                            style={{ color: "var(--text-muted)" }}
                            title="Supprimer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Edit form */}
                    {isEditing && (
                      <div className="border-t border-[var(--border)] p-4 space-y-3">
                        <input
                          type="text"
                          placeholder="Description"
                          value={editForm.description}
                          onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                          className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2" style={{ color: "var(--text-primary)", "--tw-ring-color": "color-mix(in srgb, var(--accent-primary) 50%, transparent)" } as React.CSSProperties}
                        />
                        <div>
                          <label className="text-xs uppercase tracking-widest mb-1.5 block" style={{ color: 'var(--text-muted)' }}>Prompt système</label>
                          <textarea
                            value={editForm.system_prompt}
                            onChange={e => setEditForm({ ...editForm, system_prompt: e.target.value })}
                            rows={6}
                            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 resize-none font-mono" style={{ color: "var(--text-primary)", "--tw-ring-color": "color-mix(in srgb, var(--accent-primary) 50%, transparent)" } as React.CSSProperties}
                          />
                        </div>
                        <input
                          type="text"
                          placeholder="Traits (séparés par virgules)"
                          value={editForm.traits_str}
                          onChange={e => setEditForm({ ...editForm, traits_str: e.target.value })}
                          className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2" style={{ color: "var(--text-primary)", "--tw-ring-color": "color-mix(in srgb, var(--accent-primary) 50%, transparent)" } as React.CSSProperties}
                        />
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => setEditingPersonality(null)}
                            className="px-3 py-1.5 rounded-lg text-sm border border-[var(--border)] transition-colors" style={{ color: "var(--text-secondary)" }}
                          >
                            Annuler
                          </button>
                          <button
                            onClick={async () => {
                              await api.updatePersonality(p.name, {
                                description: editForm.description,
                                system_prompt: editForm.system_prompt,
                                traits: editForm.traits_str.split(',').map((t: string) => t.trim()).filter(Boolean),
                              })
                              setEditingPersonality(null)
                              loadData()
                            }}
                            className="px-3 py-1.5 rounded-lg text-sm"
                            style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary))', color: 'var(--text-primary)' }}
                          >
                            Sauvegarder
                          </button>
                        </div>
                      </div>
                    )}
                    </div>
                    {/* Drop indicator line — below */}
                    {dropBelow && (
                      <div className="absolute -bottom-1 left-4 right-4 flex items-center gap-2 z-10 pointer-events-none">
                        <div className="w-2.5 h-2.5 rounded-full border-2 flex-shrink-0" style={{ borderColor: 'var(--accent-primary)', background: 'var(--bg-primary)' }} />
                        <div className="flex-1 h-0.5 rounded-full" style={{ background: 'var(--accent-primary)' }} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Tip */}
            <div className="flex items-start gap-3 p-3 rounded-lg bg-[var(--bg-primary)] border border-[var(--border)]">
              <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-primary)' }} />
              <div className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                <strong style={{ color: 'var(--text-secondary)' }}>Dans le chat</strong>, utilise <code className="bg-[var(--bg-secondary)] px-1 rounded" style={{ color: 'var(--accent-primary)' }}>/perso [nom]</code> pour changer de personnalité instantanément (ex: <code className="bg-[var(--bg-secondary)] px-1 rounded" style={{ color: 'var(--accent-primary)' }}>/perso friendly</code>), ou décris naturellement le comportement souhaité.
              </div>
            </div>
          </div>
        )}

        {activeTab === 'inter-agent' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Conversations inter-agents</h2>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Historique des échanges entre l'agent principal et ses sous-agents, et entre sous-agents.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={loadInterAgent}
                  className="px-3 py-2 rounded-lg border flex items-center gap-2 text-sm"
                  style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                  title="Rafraîchir"
                >
                  <RefreshCw className={`w-4 h-4 ${interAgentLoading ? 'animate-spin' : ''}`} />
                  Rafraîchir
                </button>
                <button
                  onClick={clearAllConvs}
                  className="px-3 py-2 rounded-lg border flex items-center gap-2 text-sm"
                  style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)', color: 'var(--accent-danger)' }}
                  title="Tout supprimer"
                >
                  <Trash2 className="w-4 h-4" />
                  Tout supprimer
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* List */}
              <div className="lg:col-span-1 space-y-2 max-h-[70vh] overflow-y-auto pr-2">
                {interAgentConvs.length === 0 && (
                  <div className="text-sm p-4 rounded-lg border" style={{ color: 'var(--text-muted)', borderColor: 'var(--border)', background: 'var(--bg-primary)' }}>
                    Aucune conversation enregistrée. Lance une tâche qui délègue à un sous-agent pour voir apparaître l'historique ici.
                  </div>
                )}
                {interAgentConvs.map((c: any) => (
                  <div
                    key={c.id}
                    onClick={() => loadConvDetail(c.id)}
                    className="p-3 rounded-lg border cursor-pointer transition-colors"
                    style={{
                      background: selectedConv?.id === c.id ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' : 'var(--bg-primary)',
                      borderColor: selectedConv?.id === c.id ? 'var(--accent-primary)' : 'var(--border)',
                    }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-xs font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                        {c.caller} → <span style={{ color: 'var(--accent-primary)' }}>{c.callee}</span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteConv(c.id) }}
                        className="p-1 rounded hover:bg-red-500/10"
                        title="Supprimer"
                      >
                        <Trash2 className="w-3 h-3" style={{ color: 'var(--accent-danger)' }} />
                      </button>
                    </div>
                    <div className="text-sm line-clamp-2" style={{ color: 'var(--text-primary)' }}>{c.task}</div>
                    <div className="flex items-center gap-2 mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {c.model && <span className="px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)' }}>{c.model}</span>}
                      {c.depth > 0 && <span>profondeur {c.depth}</span>}
                      {c.has_error && <span style={{ color: 'var(--accent-danger)' }}>erreur</span>}
                      <span className="ml-auto">{c.started_at?.slice(0, 19).replace('T', ' ')}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Detail */}
              <div className="lg:col-span-2 rounded-lg border p-4 max-h-[70vh] overflow-y-auto" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}>
                {!selectedConv && (
                  <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    Sélectionne une conversation pour voir les messages échangés.
                  </div>
                )}
                {selectedConv && (
                  <div className="space-y-4">
                    <div>
                      <div className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{selectedConv.id}</div>
                      <div className="font-bold" style={{ color: 'var(--text-primary)' }}>
                        {selectedConv.caller} → {selectedConv.callee}
                      </div>
                      <div className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{selectedConv.task}</div>
                      <div className="flex gap-3 mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        <span>{selectedConv.provider}/{selectedConv.model}</span>
                        <span>in: {selectedConv.tokens_input} / out: {selectedConv.tokens_output}</span>
                      </div>
                      {selectedConv.error && (
                        <div className="mt-2 p-2 rounded text-xs" style={{ background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)', color: 'var(--accent-danger)' }}>
                          {selectedConv.error}
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Messages</div>
                      {(selectedConv.messages || []).map((m: any, i: number) => (
                        <div key={i} className="p-2 rounded text-sm" style={{
                          background: m.role === 'system' ? 'color-mix(in srgb, var(--accent-tertiary) 8%, transparent)'
                                    : m.role === 'user' ? 'color-mix(in srgb, var(--accent-primary) 8%, transparent)'
                                    : m.role === 'assistant' ? 'var(--bg-secondary)'
                                    : 'color-mix(in srgb, var(--accent-success) 8%, transparent)'
                        }}>
                          <div className="text-[10px] uppercase font-bold mb-1" style={{ color: 'var(--text-muted)' }}>{m.role}{m.tool_call_id ? ` · ${m.tool_call_id}` : ''}</div>
                          <div className="whitespace-pre-wrap break-words" style={{ color: 'var(--text-primary)' }}>{m.content}</div>
                          {m.tool_calls && (
                            <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {m.tool_calls.length} tool_call(s)
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {selectedConv.tool_events?.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Tool events ({selectedConv.tool_events.length})</div>
                        {selectedConv.tool_events.map((t: any, i: number) => (
                          <div key={i} className="p-2 rounded text-xs border" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                            <div className="font-mono font-bold" style={{ color: 'var(--accent-primary)' }}>{t.tool}</div>
                            <details>
                              <summary className="cursor-pointer" style={{ color: 'var(--text-muted)' }}>args / result</summary>
                              <pre className="mt-1 overflow-x-auto" style={{ color: 'var(--text-secondary)' }}>{JSON.stringify(t.args, null, 2)}</pre>
                              <pre className="overflow-x-auto" style={{ color: 'var(--text-secondary)' }}>{JSON.stringify(t.result, null, 2).slice(0, 3000)}</pre>
                            </details>
                          </div>
                        ))}
                      </div>
                    )}

                    {selectedConv.children?.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                          Sous-conversations ({selectedConv.children.length})
                        </div>
                        {selectedConv.children.map((child: any) => child && (
                          <div
                            key={child.id}
                            onClick={() => loadConvDetail(child.id)}
                            className="p-2 rounded border cursor-pointer text-sm"
                            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
                          >
                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              {child.caller} → <span style={{ color: 'var(--accent-primary)' }}>{child.callee}</span>
                            </div>
                            <div className="line-clamp-1" style={{ color: 'var(--text-primary)' }}>{child.task}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'security' && (
          <div className="space-y-6">
            <div className="flex items-center gap-4 p-4 bg-[var(--bg-primary)] rounded-lg">
              <Shield className="w-12 h-12" style={{ color: securityScan?.score >= 80 ? 'var(--accent-success)' : 'var(--accent-danger)' }} />
              <div>
                <div className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Score: {securityScan?.score || 0}/100</div>
                <div style={{ color: 'var(--text-muted)' }}>
                  {securityScan?.score >= 80 ? 'Système sécurisé' : 'Attention requise'}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-[var(--bg-primary)] p-4 rounded-lg">
                <h3 className="font-medium mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Code className="w-4 h-4" />
                  Scanner de code
                </h3>
                <textarea
                  id="codeToScan"
                  placeholder="Collez le code à analyser..."
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 h-32 focus:outline-none focus:ring-2" style={{ color: "var(--text-primary)", "--tw-ring-color": "color-mix(in srgb, var(--accent-primary) 50%, transparent)" } as React.CSSProperties}
                />
                <button
                  onClick={async () => {
                    const code = (document.getElementById('codeToScan') as HTMLTextAreaElement)?.value
                    setCodeScanResult(null)
                    const res = await apiFetch('/api/security/scan/code', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ code }),
                    })
                    setCodeScanResult(await res.json())
                  }}
                  className="mt-2 w-full py-2 rounded-lg font-medium text-sm"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary))', color: 'var(--text-primary)' }}
                >
                  Analyser
                </button>
                {codeScanResult && (
                  <div className="mt-3 p-3 rounded-lg border" style={{
                    borderColor: codeScanResult.score >= SECURITY_THRESHOLD ? 'var(--accent-success)' : 'var(--accent-danger)',
                    background: codeScanResult.score >= SECURITY_THRESHOLD ? 'color-mix(in srgb, var(--accent-success) 8%, transparent)' : 'color-mix(in srgb, var(--accent-danger) 8%, transparent)',
                  }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Shield className="w-4 h-4" style={{ color: codeScanResult.score >= SECURITY_THRESHOLD ? 'var(--accent-success)' : 'var(--accent-danger)' }} />
                      <span className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>Score: {codeScanResult.score?.toFixed(0)}/100</span>
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{
                        background: codeScanResult.score >= SECURITY_THRESHOLD ? 'var(--accent-success)' : 'var(--accent-danger)',
                        color: '#fff',
                      }}>{codeScanResult.score >= SECURITY_THRESHOLD ? 'SAFE' : 'UNSAFE'}</span>
                    </div>
                    {codeScanResult.violations?.length > 0 && (
                      <div className="space-y-1 mt-2">
                        {codeScanResult.violations.map((v: any, i: number) => (
                          <div key={i} className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase" style={{
                              background: v.severity === 'critical' ? 'var(--accent-danger)' : v.severity === 'high' ? 'var(--accent-secondary)' : 'var(--accent-tertiary)',
                              color: '#fff',
                            }}>{v.severity}</span>
                            {v.description}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="bg-[var(--bg-primary)] p-4 rounded-lg">
                <h3 className="font-medium mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Sparkles className="w-4 h-4" />
                  Scanner de skill
                </h3>
                <textarea
                  id="skillToScan"
                  placeholder="Collez le prompt du skill..."
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 h-32 focus:outline-none focus:ring-2" style={{ color: "var(--text-primary)", "--tw-ring-color": "color-mix(in srgb, var(--accent-primary) 50%, transparent)" } as React.CSSProperties}
                />
                <button
                  onClick={async () => {
                    const prompt = (document.getElementById('skillToScan') as HTMLTextAreaElement)?.value
                    setSkillScanResult(null)
                    const res = await apiFetch('/api/security/scan/skill', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ prompt }),
                    })
                    setSkillScanResult(await res.json())
                  }}
                  className="mt-2 w-full py-2 rounded-lg font-medium text-sm"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary))', color: 'var(--text-primary)' }}
                >
                  Analyser
                </button>
                {skillScanResult && (
                  <div className="mt-3 p-3 rounded-lg border" style={{
                    borderColor: (skillScanResult.score ?? 100) >= SECURITY_THRESHOLD ? 'var(--accent-success)' : 'var(--accent-danger)',
                    background: (skillScanResult.score ?? 100) >= SECURITY_THRESHOLD ? 'color-mix(in srgb, var(--accent-success) 8%, transparent)' : 'color-mix(in srgb, var(--accent-danger) 8%, transparent)',
                  }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Shield className="w-4 h-4" style={{ color: (skillScanResult.score ?? 100) >= SECURITY_THRESHOLD ? 'var(--accent-success)' : 'var(--accent-danger)' }} />
                      <span className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>Score: {(skillScanResult.score ?? 100).toFixed(0)}/100</span>
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{
                        background: (skillScanResult.score ?? 100) >= SECURITY_THRESHOLD ? 'var(--accent-success)' : 'var(--accent-danger)',
                        color: '#fff',
                      }}>{(skillScanResult.score ?? 100) >= SECURITY_THRESHOLD ? 'SAFE' : 'UNSAFE'}</span>
                    </div>
                    {skillScanResult.violations?.length > 0 && (
                      <div className="space-y-1 mt-2">
                        {skillScanResult.violations.map((v: any, i: number) => (
                          <div key={i} className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase" style={{
                              background: v.severity === 'critical' ? 'var(--accent-danger)' : v.severity === 'high' ? 'var(--accent-secondary)' : 'var(--accent-tertiary)',
                              color: '#fff',
                            }}>{v.severity}</span>
                            {v.description}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {securityScan?.violations && securityScan.violations.length > 0 && (
              <div className="bg-[var(--bg-primary)] p-4 rounded-lg">
                <h3 className="font-medium mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <AlertTriangle className="w-4 h-4" style={{ color: 'var(--accent-tertiary)' }} />
                  Violations détectées
                </h3>
                <div className="space-y-2">
                  {securityScan.violations.map((v: any, i: number) => (
                    <div key={i} className="p-2 rounded border"
                      style={v.severity === 'critical'
                        ? { borderColor: 'var(--accent-danger)', background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)' }
                        : v.severity === 'high'
                          ? { borderColor: 'var(--accent-secondary)', background: 'color-mix(in srgb, var(--accent-secondary) 10%, transparent)' }
                          : { borderColor: 'var(--accent-tertiary)', background: 'color-mix(in srgb, var(--accent-tertiary) 10%, transparent)' }
                      }>
                      <div className="flex items-center gap-2">
                        <span className="text-xs px-2 py-0.5 rounded"
                          style={{ background: v.severity === 'critical' ? 'var(--accent-primary)' : v.severity === 'high' ? 'var(--accent-secondary)' : 'var(--accent-tertiary)', color: 'var(--text-primary)' }}
                        >{v.severity}</span>
                        <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{v.description}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
