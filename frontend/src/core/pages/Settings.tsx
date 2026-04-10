import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../stores/appStore'
import { api } from '../services/api'
import {
  Settings as SettingsIcon, Globe, Palette, Key, Mic, RefreshCw,
  HeartPulse, HardDrive, Download, Upload, Trash2, CheckCircle, AlertCircle, Type, User,
  Server, Database, Cloud, MessageSquare, GitBranch, Zap, Search as SearchIcon, Loader2, Plus,
  Stethoscope, Pipette
} from 'lucide-react'

const LANG_FLAG: Record<string, string> = {
  fr: 'fr', en: 'gb', es: 'es', pt: 'pt', it: 'it', de: 'de', nl: 'nl', ca: 'es-ct', be: 'be', br: 'fr',
  sv: 'se', no: 'no', da: 'dk', fi: 'fi', is: 'is',
  pl: 'pl', ru: 'ru', uk: 'ua', cs: 'cz', sk: 'sk', hu: 'hu', ro: 'ro', bg: 'bg', hr: 'hr', sr: 'rs', sl: 'si', et: 'ee', lv: 'lv', lt: 'lt',
  el: 'gr', tr: 'tr',
  ar: 'sa', he: 'il', fa: 'ir',
  zh: 'cn', 'zh-TW': 'tw', ja: 'jp', ko: 'kr', hi: 'in', bn: 'bd', th: 'th', vi: 'vn', id: 'id', ms: 'my', tl: 'ph',
  sw: 'ke', am: 'et',
}

const LANG_GROUPS = [
  { label: 'Europe occidentale', langs: [
    { value: 'fr', name: 'Français' }, { value: 'en', name: 'English' }, { value: 'es', name: 'Español' },
    { value: 'pt', name: 'Português' }, { value: 'it', name: 'Italiano' }, { value: 'de', name: 'Deutsch' },
    { value: 'nl', name: 'Nederlands' }, { value: 'ca', name: 'Català' }, { value: 'be', name: 'Vlaams' }, { value: 'br', name: 'Brezhoneg' },
  ]},
  { label: 'Europe nordique', langs: [
    { value: 'sv', name: 'Svenska' }, { value: 'no', name: 'Norsk' }, { value: 'da', name: 'Dansk' },
    { value: 'fi', name: 'Suomi' }, { value: 'is', name: 'Íslenska' },
  ]},
  { label: 'Europe orientale', langs: [
    { value: 'pl', name: 'Polski' }, { value: 'ru', name: 'Русский' }, { value: 'uk', name: 'Українська' },
    { value: 'cs', name: 'Čeština' }, { value: 'sk', name: 'Slovenčina' }, { value: 'hu', name: 'Magyar' },
    { value: 'ro', name: 'Română' }, { value: 'bg', name: 'Български' }, { value: 'hr', name: 'Hrvatski' },
    { value: 'sr', name: 'Srpski' }, { value: 'sl', name: 'Slovenščina' }, { value: 'et', name: 'Eesti' },
    { value: 'lv', name: 'Latviešu' }, { value: 'lt', name: 'Lietuvių' },
  ]},
  { label: 'Europe du Sud-Est', langs: [
    { value: 'el', name: 'Ελληνικά' }, { value: 'tr', name: 'Türkçe' },
  ]},
  { label: 'Moyen-Orient', langs: [
    { value: 'ar', name: 'العربية' }, { value: 'he', name: 'עברית' }, { value: 'fa', name: 'فارسی' },
  ]},
  { label: 'Asie', langs: [
    { value: 'zh', name: '中文 (简体)' }, { value: 'zh-TW', name: '中文 (繁體)' }, { value: 'ja', name: '日本語' },
    { value: 'ko', name: '한국어' }, { value: 'hi', name: 'हिन्दी' }, { value: 'bn', name: 'বাংলা' },
    { value: 'th', name: 'ไทย' }, { value: 'vi', name: 'Tiếng Việt' }, { value: 'id', name: 'Bahasa Indonesia' },
    { value: 'ms', name: 'Bahasa Melayu' }, { value: 'tl', name: 'Filipino' },
  ]},
  { label: 'Afrique', langs: [
    { value: 'sw', name: 'Kiswahili' }, { value: 'am', name: 'አማርኛ' },
  ]},
]

const ALL_LANGS = LANG_GROUPS.flatMap(g => g.langs)

const FlagImg = ({ code, size = 20 }: { code: string; size?: number }) => (
  <img
    src={`https://flagcdn.com/w40/${LANG_FLAG[code] || code}.png`}
    alt=""
    width={size}
    height={Math.round(size * 0.75)}
    style={{ borderRadius: 2, objectFit: 'cover', flexShrink: 0 }}
  />
)

const DEFAULT_HB_CONFIG = {
  enabled: true,
  paused: false,
  check_interval_seconds: 30,
  ws_ping_interval_seconds: 25,
  offset_seconds: 0,
  max_concurrent_tasks: 5,
  on_startup: true,
  // Mode Jour/Nuit
  day_night_enabled: false,
  day_start_hour: 7,
  night_start_hour: 22,
  night_config: {
    check_interval_seconds: 300,
    ws_ping_interval_seconds: 60,
    max_concurrent_tasks: 2,
  },
}

export default function Settings() {
  const { t, i18n } = useTranslation()
  const { config, setConfig, agentName, setAgentName } = useStore()
  const [activeTab, setActiveTab] = useState('general')
  const [isSaving, setIsSaving] = useState(false)
  const [langDropdownOpen, setLangDropdownOpen] = useState(false)
  const langDropdownRef = useRef<HTMLDivElement>(null)
  const [providerConfigs, setProviderConfigs] = useState<Record<string, { api_key?: string; enabled: boolean; default_model?: string }>>({})

  // Heartbeat
  const [hbConfig, setHbConfig] = useState<any>(DEFAULT_HB_CONFIG)
  const [hbStatus, setHbStatus] = useState<any>({ running: false, tasks: [] })
  const [hbLoading, setHbLoading] = useState(false)
  const [hbDirty, setHbDirty] = useState(false)
  const [hbSaving, setHbSaving] = useState(false)
  const [hbSaveMsg, setHbSaveMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [hbNightActive, setHbNightActive] = useState(false)
  const [hbEditMode, setHbEditMode] = useState<'day' | 'night'>('day')

  // Voice providers
  const [voiceConfigs, setVoiceConfigs] = useState<Record<string, any>>({})
  const [voiceSaving, setVoiceSaving] = useState<string | null>(null)
  const [voiceTestResult, setVoiceTestResult] = useState<Record<string, { ok: boolean; message?: string; error?: string }>>({})
  const [voiceTesting, setVoiceTesting] = useState<string | null>(null)

  // Custom voice providers
  const [customProviders, setCustomProviders] = useState<any[]>([])
  const [customPresets, setCustomPresets] = useState<Record<string, any>>({})
  const [editingCustom, setEditingCustom] = useState<any | null>(null)
  const [customSaving, setCustomSaving] = useState(false)

  // Services
  const [services, setServices] = useState<Record<string, any>>({})
  const [serviceCategories, setServiceCategories] = useState<Record<string, string[]>>({})
  const [serviceLabels, setServiceLabels] = useState<Record<string, string>>({})
  const [editingService, setEditingService] = useState<string | null>(null)
  const [serviceForm, setServiceForm] = useState<Record<string, any>>({})
  const [serviceTesting, setServiceTesting] = useState<string | null>(null)
  const [serviceTestResult, setServiceTestResult] = useState<Record<string, { ok: boolean; message?: string; error?: string }>>({})
  const [serviceSaving, setServiceSaving] = useState(false)

  // Doctor
  const [doctorResult, setDoctorResult] = useState<any>(null)
  const [doctorLoading, setDoctorLoading] = useState(false)

  // Custom theme
  const [customThemeColors, setCustomThemeColors] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem('gungnir_custom_theme')
      return saved ? JSON.parse(saved) : {
        '--bg-primary': '#080808',
        '--bg-secondary': '#111111',
        '--bg-tertiary': '#1a1a1a',
        '--accent-primary': '#dc2626',
        '--accent-secondary': '#f97316',
        '--text-primary': '#f5f5f5',
        '--text-secondary': '#a3a3a3',
        '--text-muted': '#666666',
        '--border': '#2a2a2a',
      }
    } catch { return {} }
  })

  // Backup
  const [backupConfig, setBackupConfig] = useState<any>(null)
  const [backupHistory, setBackupHistory] = useState<any[]>([])
  const [backupLoading, setBackupLoading] = useState(false)
  const [backupMsg, setBackupMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  // Theme & Font size
  const [currentTheme, setCurrentTheme] = useState(() => localStorage.getItem('gungnir_theme') || 'dark-scarlet')
  const [currentFontSize, setCurrentFontSize] = useState(() => localStorage.getItem('gungnir_fontsize') || 'md')

  const applyTheme = (theme: string) => {
    // Nettoyer les CSS variables custom inline (sinon elles écrasent le nouveau thème)
    const customVars = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--accent-primary', '--accent-secondary', '--text-primary', '--text-secondary', '--text-muted', '--border']
    customVars.forEach(v => document.documentElement.style.removeProperty(v))
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('gungnir_theme', theme)
    setCurrentTheme(theme)
  }

  const applyFontSize = (size: string) => {
    document.documentElement.setAttribute('data-fontsize', size)
    localStorage.setItem('gungnir_fontsize', size)
    setCurrentFontSize(size)
  }

  // Apply saved theme/font on mount
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (langDropdownRef.current && !langDropdownRef.current.contains(e.target as Node)) setLangDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    const savedTheme = localStorage.getItem('gungnir_theme')
    if (savedTheme) {
      document.documentElement.setAttribute('data-theme', savedTheme)
      // Restaurer les couleurs custom si thème personnalisé
      if (savedTheme === 'custom') {
        try {
          const colors = JSON.parse(localStorage.getItem('gungnir_custom_theme') || '{}')
          for (const [key, value] of Object.entries(colors)) {
            document.documentElement.style.setProperty(key, value as string)
          }
        } catch { /* ignore */ }
      }
    }
    const savedSize = localStorage.getItem('gungnir_fontsize')
    if (savedSize) document.documentElement.setAttribute('data-fontsize', savedSize)
  }, [])

  useEffect(() => {
    if (config?.providers) {
      const configs: Record<string, { api_key?: string; enabled: boolean; default_model?: string }> = {}
      Object.entries(config.providers).forEach(([name, p]: [string, any]) => {
        configs[name] = { enabled: p?.enabled || false, api_key: '', default_model: p?.default_model || '' }
      })
      setProviderConfigs(configs)
    }
  }, [config])

  const handleSaveProvider = async (provider: string) => {
    const cfg = providerConfigs[provider]; if (!cfg) return
    setIsSaving(true)
    try { await api.saveProvider(provider, cfg); const newConfig = await api.getConfig(); setConfig(newConfig) }
    catch (err) { console.error('Save provider error:', err) }
    setIsSaving(false)
  }

  const handleLanguageChange = async (lang: string) => {
    i18n.changeLanguage(lang)
    await api.saveAppConfig({ language: lang })
    const newConfig = await api.getConfig(); setConfig(newConfig)
  }

  // -- Heartbeat ---------------------------------------------------------------
  const loadHeartbeat = async () => {
    setHbLoading(true)
    try {
      const res = await fetch('/api/heartbeat')
      if (res.ok) {
        const data = await res.json()
        setHbStatus(data)
        if (data.config) {
          // Merge avec les défauts pour garantir la présence de night_config etc.
          setHbConfig({ ...DEFAULT_HB_CONFIG, ...data.config, night_config: { ...DEFAULT_HB_CONFIG.night_config, ...(data.config.night_config || {}) } })
          setHbDirty(false)
        }
      } else {
        console.warn('Heartbeat fetch status:', res.status)
      }
      // Charge aussi l'état effectif (jour/nuit actuel)
      try {
        const eff = await fetch('/api/heartbeat/effective')
        if (eff.ok) {
          const d = await eff.json()
          setHbNightActive(!!d.night_active)
        }
      } catch {}
    } catch (err) {
      console.warn('Heartbeat fetch error:', err)
    }
    setHbLoading(false)
  }

  // -- Voice Providers ----------------------------------------------------------
  const VOICE_PROVIDERS = [
    { id: 'elevenlabs', label: 'ElevenLabs', desc: 'ConvAI — voix ultra-réalistes, agent dédié', color: '#fbbf24', fields: ['api_key', 'voice_id', 'agent_id'] },
    { id: 'openai', label: 'OpenAI Realtime', desc: 'GPT-4o natif — voix + raisonnement', color: '#22c55e', fields: ['api_key'], note: 'Utilise la clé du provider OpenAI si non renseignée ici' },
    { id: 'google', label: 'Gemini Live', desc: 'Gemini Multimodal Live — conversation native', color: '#3b82f6', fields: ['api_key'], note: 'Utilise la clé du provider Google si non renseignée ici' },
    { id: 'grok', label: 'Grok Realtime', desc: 'xAI Grok — protocole OpenAI-compatible', color: '#a855f7', fields: ['api_key'], note: 'Nécessite une clé API xAI' },
  ]

  const loadCustomProviders = async () => {
    try {
      const resp = await fetch('/api/plugins/voice/custom-providers')
      if (resp.ok) {
        const data = await resp.json()
        setCustomProviders(data.providers || [])
        setCustomPresets(data.presets || {})
      }
    } catch (err) { console.warn('Custom providers load error:', err) }
  }

  const handleNewCustomProvider = (presetKey: string = 'generic') => {
    const preset = customPresets[presetKey] || {}
    setEditingCustom({
      id: '',
      display_name: '',
      icon: '🔊',
      description: '',
      enabled: true,
      ws_url: preset.ws_url || 'wss://',
      auth_method: preset.auth_method || 'header',
      auth_header_name: preset.auth_header_name || 'Authorization',
      auth_header_prefix: preset.auth_header_prefix || 'Bearer ',
      auth_query_param: preset.auth_query_param || 'key',
      api_key: '',
      sample_rate_in: preset.sample_rate_in || 16000,
      sample_rate_out: preset.sample_rate_out || 16000,
      audio_format: 'pcm16',
      send_audio_wrapper: preset.send_audio_wrapper || '{"type":"audio","data":"{audio}"}',
      recv_audio_path: preset.recv_audio_path || 'audio.data',
      recv_transcript_path: preset.recv_transcript_path || '',
      recv_transcript_role_path: '',
      setup_message: preset.setup_message || '',
      ping_type: '',
      pong_response: '',
      protocol_type: presetKey,
      doc_url: '',
    })
  }

  const handleEditCustomProvider = (cp: any) => {
    setEditingCustom({ ...cp, api_key: '' })
  }

  const handleSaveCustomProvider = async () => {
    if (!editingCustom) return
    if (!editingCustom.id) {
      // Generate ID from display name
      editingCustom.id = editingCustom.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `custom-${Date.now()}`
    }
    setCustomSaving(true)
    try {
      const resp = await fetch('/api/plugins/voice/custom-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingCustom),
      })
      if (resp.ok) {
        setEditingCustom(null)
        await loadCustomProviders()
        await loadVoiceConfigs()
      } else {
        const err = await resp.json().catch(() => ({}))
        console.error('Save custom provider error:', err)
      }
    } catch (err) { console.error('Save custom error:', err) }
    setCustomSaving(false)
  }

  const handleDeleteCustomProvider = async (id: string) => {
    if (!confirm(`Supprimer le provider "${id}" ?`)) return
    try {
      await fetch(`/api/plugins/voice/custom-providers/${id}`, { method: 'DELETE' })
      await loadCustomProviders()
      await loadVoiceConfigs()
    } catch {}
  }

  const loadVoiceConfigs = async () => {
    try {
      const resp = await fetch('/api/plugins/voice/providers')
      if (resp.ok) {
        const data = await resp.json()
        const configs: Record<string, any> = {}
        for (const p of (data.providers || [])) {
          configs[p.name] = {
            enabled: p.enabled || false,
            api_key: '',
            voice_id: p.voice_id || '',
            agent_id: '',
            has_voice_key: p.has_voice_key,
            has_llm_key: p.has_llm_key,
            has_agent: p.has_agent,
            language: p.language || 'fr',
          }
        }
        setVoiceConfigs(configs)
      }
    } catch (err) { console.warn('Voice config load error:', err) }
  }

  const handleSaveVoice = async (providerId: string) => {
    setVoiceSaving(providerId)
    try {
      const cfg = voiceConfigs[providerId]
      await api.saveVoiceConfig(providerId, {
        enabled: cfg.enabled,
        provider: providerId,
        api_key: cfg.api_key || undefined,
        voice_id: cfg.voice_id || undefined,
        agent_id: cfg.agent_id || undefined,
        language: cfg.language || 'fr',
      })
      await loadVoiceConfigs()
    } catch (err) { console.error('Save voice error:', err) }
    setVoiceSaving(null)
  }

  const handleTestVoice = async (providerId: string) => {
    setVoiceTesting(providerId)
    try {
      const resp = await fetch('/api/plugins/voice/provider/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      })
      const result = await resp.json()
      setVoiceTestResult(prev => ({ ...prev, [providerId]: result }))
    } catch (err: any) {
      setVoiceTestResult(prev => ({ ...prev, [providerId]: { ok: false, error: err.message } }))
    }
    setVoiceTesting(null)
  }

  // -- Services ----------------------------------------------------------------
  const loadServices = async () => {
    try {
      const data = await api.getServices()
      setServices(data.services || {})
      setServiceCategories(data.categories || {})
      setServiceLabels(data.labels || {})
    } catch (err) { console.warn('Services fetch error:', err) }
  }

  const handleEditService = (name: string) => {
    const svc = services[name]
    setServiceForm({
      enabled: svc?.enabled || false,
      api_key: '',
      base_url: svc?.base_url || '',
      project_id: svc?.project_id || '',
      region: svc?.region || '',
      bucket: svc?.bucket || '',
      database: svc?.database || '',
      token: '',
      webhook_url: svc?.webhook_url || '',
      namespace: svc?.namespace || '',
    })
    setEditingService(name)
  }

  const handleSaveService = async () => {
    if (!editingService) return
    setServiceSaving(true)
    try {
      // Only send non-empty fields
      const payload: Record<string, any> = { enabled: serviceForm.enabled }
      for (const [k, v] of Object.entries(serviceForm)) {
        if (k !== 'enabled' && v) payload[k] = v
      }
      await api.saveService(editingService, payload)
      await loadServices()
      setEditingService(null)
    } catch (err) { console.error('Save service error:', err) }
    setServiceSaving(false)
  }

  const handleTestService = async (name: string) => {
    setServiceTesting(name)
    try {
      const result = await api.testService(name)
      setServiceTestResult(prev => ({ ...prev, [name]: result }))
    } catch (err: any) {
      setServiceTestResult(prev => ({ ...prev, [name]: { ok: false, error: err.message } }))
    }
    setServiceTesting(null)
  }

  // Doctor
  const runDoctor = async () => {
    setDoctorLoading(true)
    setDoctorResult(null)
    try {
      const res = await fetch('/api/doctor')
      const data = await res.json()
      setDoctorResult(data)
    } catch (err: any) {
      setDoctorResult({ error: err.message })
    }
    setDoctorLoading(false)
  }

  // Custom theme
  const applyCustomTheme = (colors: Record<string, string>) => {
    document.documentElement.setAttribute('data-theme', 'custom')
    // Apply each CSS variable
    for (const [key, value] of Object.entries(colors)) {
      document.documentElement.style.setProperty(key, value)
    }
    localStorage.setItem('gungnir_theme', 'custom')
    localStorage.setItem('gungnir_custom_theme', JSON.stringify(colors))
    setCurrentTheme('custom')
  }

  const updateCustomColor = (key: string, value: string) => {
    const newColors = { ...customThemeColors, [key]: value }
    setCustomThemeColors(newColors)
    if (currentTheme === 'custom') {
      document.documentElement.style.setProperty(key, value)
      localStorage.setItem('gungnir_custom_theme', JSON.stringify(newColors))
    }
  }

  useEffect(() => {
    if (activeTab === 'voice') { loadVoiceConfigs(); loadCustomProviders() }
    if (activeTab === 'heartbeat') loadHeartbeat()
    if (activeTab === 'backup') loadBackup()
    if (activeTab === 'services') loadServices()
    if (activeTab === 'doctor') runDoctor()
  }, [activeTab])

  // Met à jour le draft local (top-level ou nested night_config.X)
  const updateHbConfig = (key: string, val: any) => {
    setHbDirty(true)
    setHbSaveMsg(null)
    if (key.startsWith('night.')) {
      const subKey = key.slice(6)
      setHbConfig((prev: any) => ({
        ...prev,
        night_config: { ...(prev.night_config || {}), [subKey]: val },
      }))
    } else {
      setHbConfig((prev: any) => ({ ...prev, [key]: val }))
    }
  }

  // Sauvegarde complète du draft vers le backend
  const saveHbConfig = async () => {
    setHbSaving(true)
    setHbSaveMsg(null)
    try {
      const res = await fetch('/api/heartbeat/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hbConfig),
      })
      if (res.ok) {
        const data = await res.json()
        setHbDirty(false)
        setHbNightActive(!!data.night_active)
        setHbSaveMsg({ type: 'ok', text: 'Configuration sauvegardée' })
        setTimeout(() => setHbSaveMsg(null), 2500)
      } else {
        setHbSaveMsg({ type: 'err', text: `Erreur ${res.status}` })
      }
    } catch (err: any) {
      setHbSaveMsg({ type: 'err', text: err?.message || 'Erreur réseau' })
    }
    setHbSaving(false)
  }

  const hbAction = async (action: string) => {
    try {
      await fetch(`/api/heartbeat/${action}`, { method: 'POST' })
      setTimeout(loadHeartbeat, 500)
    } catch (err) { console.warn('HB action error:', err) }
  }

  // -- Backup ------------------------------------------------------------------
  const loadBackup = async () => {
    try {
      const res = await fetch('/api/backup/config')
      if (res.ok) { const data = await res.json(); setBackupConfig(data) }
    } catch {}
    try {
      const res = await fetch('/api/backup/history')
      if (res.ok) { const data = await res.json(); setBackupHistory(data.backups || []) }
    } catch {}
  }

  const saveBackupConfig = async (newCfg: any) => {
    setBackupConfig(newCfg)
    try {
      await fetch('/api/backup/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCfg),
      })
    } catch {}
  }

  const triggerBackup = async () => {
    setBackupLoading(true); setBackupMsg(null)
    try {
      const res = await fetch('/api/backup/now', { method: 'POST' })
      const data = await res.json()
      if (data.ok) { setBackupMsg({ type: 'ok', text: `Backup réussi : ${data.filename || 'OK'}` }); await loadBackup() }
      else setBackupMsg({ type: 'err', text: data.error || 'Erreur backup' })
    } catch (err: any) { setBackupMsg({ type: 'err', text: err.message }) }
    setBackupLoading(false)
  }

  const restoreBackup = async (filename: string) => {
    if (!confirm(`Restaurer le backup "${filename}" ? Les données actuelles seront écrasées.`)) return
    setBackupLoading(true); setBackupMsg(null)
    try {
      const res = await fetch('/api/backup/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      })
      const data = await res.json()
      if (data.ok) setBackupMsg({ type: 'ok', text: 'Restauration réussie. Redémarrez le serveur.' })
      else setBackupMsg({ type: 'err', text: data.error || 'Erreur restauration' })
    } catch (err: any) { setBackupMsg({ type: 'err', text: err.message }) }
    setBackupLoading(false)
  }

  const deleteBackup = async (filename: string) => {
    if (!confirm(`Supprimer le backup "${filename}" ?`)) return
    try {
      await fetch(`/api/backup/${encodeURIComponent(filename)}`, { method: 'DELETE' })
      await loadBackup()
    } catch {}
  }

  const handleCheckUpdate = async () => {
    try {
      const info = await api.checkUpdate()
      alert(info.update_available ? `Mise à jour disponible: ${info.latest_version}` : 'Vous êtes à jour')
    } catch (err) { console.error('Check update error:', err) }
  }

  const tabs = [
    { id: 'general', label: t('settings.general'), icon: SettingsIcon },
    { id: 'providers', label: t('settings.providers'), icon: Key },
    { id: 'voice', label: t('settings.voice'), icon: Mic },
    { id: 'services', label: t('settings.services'), icon: Server },
    { id: 'heartbeat', label: t('settings.heartbeat'), icon: HeartPulse },
    { id: 'backup', label: t('settings.backup'), icon: HardDrive },
    { id: 'doctor', label: t('settings.doctor'), icon: Stethoscope },
  ]

  return (
    <div className="max-w-4xl mx-auto p-6 h-full overflow-y-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-3 rounded-xl" style={{ background: 'linear-gradient(to bottom right, color-mix(in srgb, var(--accent-primary) 15%, transparent), color-mix(in srgb, var(--accent-secondary) 10%, transparent))' }}>
          <SettingsIcon className="w-6 h-6" style={{ color: 'var(--accent-primary)' }} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.title')}</h1>
          <p style={{ color: 'var(--text-muted)' }}>{t('settings.subtitle')}</p>
        </div>
      </div>

      <div className="flex gap-6">
        <aside className="w-48 flex-shrink-0">
          <nav className="space-y-2">
            {tabs.map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors"
                style={{
                  background: activeTab === tab.id ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'transparent',
                  color: activeTab === tab.id ? 'var(--accent-primary)' : 'var(--text-muted)',
                  border: activeTab === tab.id ? '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' : '1px solid transparent'
                }}>
                <tab.icon className="w-4 h-4" />{tab.label}
              </button>
            ))}
          </nav>
        </aside>

        <div className="flex-1 rounded-xl border p-6" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>
          {/* -- General --------------------------------------------------- */}
          {activeTab === 'general' && (
            <div className="space-y-6">
              {/* Agent Name */}
              <div>
                <label className="flex items-center gap-3 text-[var(--text-secondary)] mb-3"><User className="w-4 h-4" />{t('settings.agentName')}</label>
                <input type="text" value={agentName}
                  onChange={e => setAgentName(e.target.value)}
                  placeholder="Gungnir"
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-3 focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                <p className="text-[var(--text-muted)] text-xs mt-1">{t('settings.agentNameDesc')}</p>
              </div>

              <div>
                <label className="flex items-center gap-3 text-[var(--text-secondary)] mb-3"><Globe className="w-4 h-4" />{t('settings.language')}</label>
                <div className="relative" ref={langDropdownRef}>
                  <button type="button" onClick={() => setLangDropdownOpen(!langDropdownOpen)}
                    className="w-full flex items-center gap-3 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-3 text-left"
                    style={{ color: 'var(--text-primary)' }}>
                    <FlagImg code={i18n.language} />
                    <span className="flex-1">{(ALL_LANGS.find(l => l.value === i18n.language) || ALL_LANGS[0]).name}</span>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" style={{ opacity: 0.5, transform: langDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                      <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />
                    </svg>
                  </button>
                  {langDropdownOpen && (
                    <div className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] shadow-xl"
                      style={{ scrollbarWidth: 'thin' }}>
                      {LANG_GROUPS.map(group => (
                        <div key={group.label}>
                          <div className="px-3 py-1.5 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide sticky top-0 bg-[var(--bg-secondary)]">
                            {group.label}
                          </div>
                          {group.langs.map(lang => (
                            <button key={lang.value} type="button"
                              onClick={() => { handleLanguageChange(lang.value); setLangDropdownOpen(false) }}
                              className={`w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors ${lang.value === i18n.language ? 'bg-[var(--bg-hover)]' : ''}`}
                              style={{ color: 'var(--text-primary)' }}>
                              <FlagImg code={lang.value} />
                              <span>{lang.name}</span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div>
                <label className="flex items-center gap-3 text-[var(--text-secondary)] mb-3"><Palette className="w-4 h-4" />{t('settings.theme')}</label>
                {/* 4 preset themes in 2x2 grid */}
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { id: 'dark-scarlet', label: 'Dark Scarlet', color: '#CC1B1B', desc: t('settings.themeDarkScarlet') },
                    { id: 'dark-bronze', label: 'Dark Bronze', color: '#9B8260', desc: t('settings.themeDarkBronze') },
                    { id: 'daltonien', label: 'Accessible', color: '#2563EB', desc: t('settings.themeAccessible') },
                    { id: 'light', label: t('settings.light'), color: '#CC1B1B', desc: t('settings.themeLight') },
                  ].map(theme => (
                    <button key={theme.id} onClick={() => applyTheme(theme.id)}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-all text-left ${
                        currentTheme === theme.id
                          ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10'
                          : 'border-[var(--border)] bg-[var(--bg-primary)] hover:border-[var(--text-muted)]'
                      }`}>
                      <div className="w-5 h-5 rounded-full flex-shrink-0 border-2"
                        style={{
                          background: theme.color,
                          borderColor: currentTheme === theme.id ? theme.color : 'transparent',
                          boxShadow: currentTheme === theme.id ? `0 0 8px ${theme.color}40` : 'none'
                        }} />
                      <div>
                        <div className={`text-sm font-semibold ${currentTheme === theme.id ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                          {theme.label}
                        </div>
                        <div className="text-[11px] text-[var(--text-muted)]">{theme.desc}</div>
                      </div>
                    </button>
                  ))}
                </div>
                {/* Custom theme — full width below the 2x2 grid */}
                <button onClick={() => applyCustomTheme(customThemeColors)}
                  className={`mt-3 w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-all text-left ${
                    currentTheme === 'custom'
                      ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10'
                      : 'border-[var(--border)] bg-[var(--bg-primary)] hover:border-[var(--text-muted)]'
                  }`}>
                  <div className="w-5 h-5 rounded-full flex-shrink-0 border-2"
                    style={{
                      background: `linear-gradient(135deg, ${customThemeColors['--accent-primary'] || '#dc2626'}, ${customThemeColors['--accent-secondary'] || '#f97316'})`,
                      borderColor: currentTheme === 'custom' ? (customThemeColors['--accent-primary'] || '#dc2626') : 'transparent',
                      boxShadow: currentTheme === 'custom' ? `0 0 8px ${customThemeColors['--accent-primary'] || '#dc2626'}40` : 'none'
                    }} />
                  <div className="flex-1">
                    <div className={`text-sm font-semibold ${currentTheme === 'custom' ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                      {t('settings.custom')}
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)]">{t('settings.customDesc')}</div>
                  </div>
                  <Pipette className="w-4 h-4 flex-shrink-0" style={{ color: currentTheme === 'custom' ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
                </button>
              </div>

              {/* Custom theme editor */}
              {currentTheme === 'custom' && (() => {
                const PALETTE = [
                  '#000000', '#1a1a2e', '#16213e', '#0f3460', '#1b1b2f', '#162447',
                  '#e94560', '#dc2626', '#f97316', '#eab308', '#22c55e', '#06b6d4',
                  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899', '#f43f5e',
                  '#f5f5f5', '#d4d4d4', '#a3a3a3', '#737373', '#404040', '#171717',
                ]
                const COLOR_ITEMS = [
                  { key: '--bg-primary', label: t('settings.colorBgPrimary') },
                  { key: '--bg-secondary', label: t('settings.colorBgSecondary') },
                  { key: '--bg-tertiary', label: t('settings.colorBgTertiary') },
                  { key: '--accent-primary', label: t('settings.colorAccentPrimary') },
                  { key: '--accent-secondary', label: t('settings.colorAccentSecondary') },
                  { key: '--text-primary', label: t('settings.colorTextPrimary') },
                  { key: '--text-secondary', label: t('settings.colorTextSecondary') },
                  { key: '--text-muted', label: t('settings.colorTextMuted') },
                  { key: '--border', label: t('settings.colorBorder') },
                ]
                return (
                  <div className="p-4 rounded-lg border space-y-4" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}>
                    <label className="flex items-center gap-3 text-[var(--text-secondary)]"><Pipette className="w-4 h-4" />{t('settings.customizeColors')}</label>

                    {/* Palette rapide */}
                    <div>
                      <span className="text-[11px] block mb-2" style={{ color: 'var(--text-muted)' }}>{t('settings.quickPalette')}</span>
                      <div className="flex flex-wrap gap-1.5">
                        {PALETTE.map(c => (
                          <button key={c}
                            onClick={() => {
                              // Copie dans le clipboard pour coller dans un input hex
                              navigator.clipboard.writeText(c.replace('#', ''))
                            }}
                            className="w-6 h-6 rounded-md border transition-transform hover:scale-125 cursor-pointer"
                            style={{ background: c, borderColor: 'var(--border)' }}
                            title={c}
                          />
                        ))}
                      </div>
                    </div>

                    {/* Color editors */}
                    <div className="grid grid-cols-3 gap-3">
                      {COLOR_ITEMS.map(item => {
                        const val = customThemeColors[item.key] || '#000000'
                        const hexVal = val.replace('#', '').toUpperCase()
                        return (
                          <div key={item.key} className="space-y-1">
                            <span className="text-[11px] font-medium block" style={{ color: 'var(--text-muted)' }}>{item.label}</span>
                            <div className="flex items-center gap-1.5">
                              {/* Color picker natif */}
                              <input
                                type="color"
                                value={val}
                                onChange={e => updateCustomColor(item.key, e.target.value)}
                                className="w-7 h-7 rounded cursor-pointer border-0 p-0 flex-shrink-0"
                                style={{ background: 'none' }}
                              />
                              {/* Input hex */}
                              <div className="flex items-center flex-1 rounded px-1.5 py-1" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                                <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>#</span>
                                <input
                                  type="text"
                                  value={hexVal}
                                  onChange={e => {
                                    let v = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6)
                                    if (v.length === 6) updateCustomColor(item.key, '#' + v)
                                  }}
                                  onBlur={e => {
                                    let v = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6)
                                    if (v.length === 3) v = v[0]+v[0]+v[1]+v[1]+v[2]+v[2]
                                    if (v.length === 6) updateCustomColor(item.key, '#' + v)
                                  }}
                                  maxLength={6}
                                  className="bg-transparent border-none outline-none text-[11px] font-mono w-full ml-0.5"
                                  style={{ color: 'var(--text-primary)' }}
                                  placeholder="FFFFFF"
                                />
                              </div>
                            </div>
                            {/* Mini palette swatches for quick pick */}
                            <div className="flex gap-0.5">
                              {PALETTE.slice(0, 12).map(c => (
                                <button key={c}
                                  onClick={() => updateCustomColor(item.key, c)}
                                  className="w-3 h-3 rounded-sm transition-transform hover:scale-150"
                                  style={{ background: c }}
                                />
                              ))}
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      Couleurs appliquées en temps réel. Utilisez le color picker, tapez un code hex (#FFFFFF), ou cliquez les pastilles.
                    </p>
                  </div>
                )
              })()}

              {/* Font size */}
              <div>
                <label className="flex items-center gap-3 text-[var(--text-secondary)] mb-3"><Type className="w-4 h-4" />{t('settings.fontSize')}</label>
                <div className="flex gap-3">
                  {[
                    { id: 'sm', label: t('settings.fontSmall'), sample: 'A', size: '11px' },
                    { id: 'md', label: t('settings.fontNormal'), sample: 'A', size: '14px' },
                    { id: 'lg', label: t('settings.fontLarge'), sample: 'A', size: '17px' },
                  ].map(fs => (
                    <button key={fs.id} onClick={() => applyFontSize(fs.id)}
                      className={`flex-1 flex flex-col items-center gap-1.5 px-4 py-3 rounded-lg border transition-all ${
                        currentFontSize === fs.id
                          ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 text-[var(--text-primary)]'
                          : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                      }`}>
                      <span style={{ fontSize: fs.size }} className="font-bold">{fs.sample}</span>
                      <span className="text-[11px]">{fs.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="flex items-center gap-3 text-[var(--text-secondary)] mb-3"><RefreshCw className="w-4 h-4" />{t('settings.updates')}</label>
                <div className="space-y-3">
                  <button onClick={handleCheckUpdate} className="w-full bg-[var(--bg-primary)] border border-[var(--border)] px-4 py-3 rounded-lg text-left flex items-center justify-between" style={{ color: 'var(--text-primary)' }}>
                    <span>{t('settings.checkUpdate')}</span><RefreshCw className="w-4 h-4" />
                  </button>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" className="w-4 h-4 rounded bg-[var(--bg-primary)] border-[var(--border)] accent-red-600" />
                    <span className="text-[var(--text-secondary)]">{t('settings.autoUpdate')}</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* -- Providers ------------------------------------------------- */}
          {activeTab === 'providers' && (
            <div className="space-y-6">
              {config?.providers && Object.entries(config.providers).map(([name, p]: [string, any]) => (
                <div key={name} className="border border-[var(--border)] rounded-lg p-4">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-medium capitalize" style={{ color: 'var(--text-primary)' }}>{name}</h3>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={providerConfigs[name]?.enabled || false}
                        onChange={e => setProviderConfigs(prev => ({ ...prev, [name]: { ...prev[name], enabled: e.target.checked } }))}
                        className="w-4 h-4 rounded bg-[var(--bg-primary)] border-[var(--border)] accent-red-600" />
                      <span className="text-[var(--text-secondary)] text-sm">{t('common.enabled')}</span>
                    </label>
                  </div>
                  <div className="space-y-3">
                    <input type="password" placeholder="API Key" value={providerConfigs[name]?.api_key || ''}
                      onChange={e => setProviderConfigs(prev => ({ ...prev, [name]: { ...prev[name], api_key: e.target.value } }))}
                      className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2 focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                    {p?.models && p.models.length > 0 && (
                      <select value={providerConfigs[name]?.default_model || p.default_model || ''}
                        onChange={e => setProviderConfigs(prev => ({ ...prev, [name]: { ...prev[name], default_model: e.target.value } }))}
                        className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2 focus:outline-none" style={{ color: 'var(--text-primary)' }}>
                        {p.models.map((m: string) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    )}
                    <button onClick={() => handleSaveProvider(name)} disabled={isSaving}
                      className="disabled:opacity-50 px-4 py-2 rounded-lg"
                      style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--scarlet-dark))' }}>
                      {isSaving ? t('common.loading') : t('setup.save')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* -- Voice ----------------------------------------------------- */}
          {activeTab === 'voice' && (
            <div className="space-y-6">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Configurez vos providers de chat vocal temps réel. Chaque provider utilise du vrai bidirectionnel WebSocket.
              </p>

              {VOICE_PROVIDERS.map(vp => {
                const cfg = voiceConfigs[vp.id] || {}
                return (
                  <div key={vp.id} className="border rounded-lg p-5 space-y-4 transition-colors"
                    style={{ borderColor: cfg.enabled ? `color-mix(in srgb, ${vp.color} 40%, var(--border))` : 'var(--border)', background: 'var(--bg-primary)' }}>

                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-3 h-3 rounded-full" style={{ background: cfg.enabled ? vp.color : 'var(--text-muted)', opacity: cfg.enabled ? 1 : 0.3 }} />
                        <div>
                          <h3 className="font-medium" style={{ color: 'var(--text-primary)' }}>{vp.label}</h3>
                          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{vp.desc}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {cfg.enabled && (
                          <button onClick={() => handleTestVoice(vp.id)} disabled={voiceTesting === vp.id}
                            className="px-3 py-1.5 text-xs rounded-lg transition-colors"
                            style={{ background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', color: 'var(--accent-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' }}>
                            {voiceTesting === vp.id ? <Loader2 className="w-3 h-3 animate-spin inline" /> : <RefreshCw className="w-3 h-3 inline" />}
                            {' '}Tester
                          </button>
                        )}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={cfg.enabled || false}
                            onChange={e => setVoiceConfigs(prev => ({ ...prev, [vp.id]: { ...prev[vp.id], enabled: e.target.checked } }))}
                            className="w-4 h-4 accent-[var(--accent-primary)]" />
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Activé</span>
                        </label>
                      </div>
                    </div>

                    {/* Status badges */}
                    <div className="flex gap-2 flex-wrap">
                      {cfg.has_voice_key && (
                        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--accent-success) 15%, transparent)', color: 'var(--accent-success)' }}>
                          <CheckCircle className="w-3 h-3 inline mr-1" />Clé vocale configurée
                        </span>
                      )}
                      {cfg.has_llm_key && !cfg.has_voice_key && (
                        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--accent-tertiary) 15%, transparent)', color: 'var(--accent-tertiary)' }}>
                          Utilise la clé du provider LLM
                        </span>
                      )}
                      {cfg.has_agent && vp.id === 'elevenlabs' && (
                        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--accent-success) 15%, transparent)', color: 'var(--accent-success)' }}>
                          <CheckCircle className="w-3 h-3 inline mr-1" />Agent créé
                        </span>
                      )}
                      {voiceTestResult[vp.id] && (
                        <span className="text-xs px-2 py-0.5 rounded-full"
                          style={{
                            background: voiceTestResult[vp.id].ok ? 'color-mix(in srgb, var(--accent-success) 15%, transparent)' : 'color-mix(in srgb, var(--accent-error) 15%, transparent)',
                            color: voiceTestResult[vp.id].ok ? 'var(--accent-success)' : 'var(--accent-error)',
                          }}>
                          {voiceTestResult[vp.id].ok ? (voiceTestResult[vp.id].message || 'Connexion OK') : (voiceTestResult[vp.id].error || 'Échec')}
                        </span>
                      )}
                    </div>

                    {/* Fields */}
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>
                          Clé API {vp.label}
                          {vp.note && <span className="ml-1 opacity-60">({vp.note})</span>}
                        </label>
                        <input type="password" value={cfg.api_key || ''} placeholder={cfg.has_voice_key ? '••• (déjà configurée)' : `Clé API ${vp.label}`}
                          onChange={e => setVoiceConfigs(prev => ({ ...prev, [vp.id]: { ...prev[vp.id], api_key: e.target.value } }))}
                          className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                      </div>

                      {vp.fields.includes('voice_id') && (
                        <div>
                          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Voice ID (optionnel)</label>
                          <input type="text" value={cfg.voice_id || ''} placeholder="ID de la voix"
                            onChange={e => setVoiceConfigs(prev => ({ ...prev, [vp.id]: { ...prev[vp.id], voice_id: e.target.value } }))}
                            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                        </div>
                      )}

                      {vp.fields.includes('agent_id') && (
                        <div>
                          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Agent ID (auto-créé si vide)</label>
                          <input type="text" value={cfg.agent_id || ''} placeholder={cfg.has_agent ? 'Agent déjà créé' : 'Sera créé automatiquement'}
                            onChange={e => setVoiceConfigs(prev => ({ ...prev, [vp.id]: { ...prev[vp.id], agent_id: e.target.value } }))}
                            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                        </div>
                      )}
                    </div>

                    {/* Save button */}
                    <button onClick={() => handleSaveVoice(vp.id)} disabled={voiceSaving === vp.id}
                      className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                      style={{ background: vp.color, color: '#000' }}>
                      {voiceSaving === vp.id ? 'Sauvegarde...' : 'Sauvegarder'}
                    </button>
                  </div>
                )
              })}

              {/* ── Custom Voice Providers ─────────────────────────────── */}
              <div className="border-t pt-6 mt-6" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="font-medium" style={{ color: 'var(--text-primary)' }}>Providers personnalisés</h3>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      Ajoutez n'importe quel provider temps réel WebSocket
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => handleNewCustomProvider('openai_compatible')}
                      className="px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1"
                      style={{ background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', color: 'var(--accent-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' }}>
                      <Plus className="w-3 h-3" /> OpenAI-compatible
                    </button>
                    <button onClick={() => handleNewCustomProvider('generic')}
                      className="px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1"
                      style={{ background: 'color-mix(in srgb, var(--text-muted) 15%, transparent)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                      <Plus className="w-3 h-3" /> Générique
                    </button>
                  </div>
                </div>

                {/* Existing custom providers */}
                {customProviders.length > 0 && (
                  <div className="space-y-3 mb-4">
                    {customProviders.map(cp => (
                      <div key={cp.id} className="border rounded-lg p-4 flex items-center justify-between"
                        style={{ background: 'var(--bg-primary)', borderColor: cp.enabled ? 'color-mix(in srgb, var(--accent-primary) 30%, var(--border))' : 'var(--border)' }}>
                        <div className="flex items-center gap-3">
                          <span className="text-lg">{cp.icon || '🔊'}</span>
                          <div>
                            <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{cp.display_name || cp.id}</span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                                {cp.protocol_type === 'openai_compatible' ? 'OpenAI-compatible' : 'Générique'}
                              </span>
                              {cp.api_key === '***' && (
                                <span className="text-xs" style={{ color: 'var(--accent-success)' }}>
                                  <CheckCircle className="w-3 h-3 inline mr-0.5" />Clé configurée
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => handleEditCustomProvider(cp)} className="p-1.5 rounded-md hover:bg-[var(--bg-secondary)]">
                            <SettingsIcon className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                          </button>
                          <button onClick={() => handleDeleteCustomProvider(cp.id)} className="p-1.5 rounded-md hover:bg-[var(--bg-secondary)]">
                            <Trash2 className="w-4 h-4" style={{ color: 'var(--accent-error, #ef4444)' }} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {customProviders.length === 0 && (
                  <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>
                    Aucun provider personnalisé. Cliquez sur un bouton ci-dessus pour en ajouter.
                  </p>
                )}
              </div>

              {/* ── Custom Provider Editor Modal ──────────────────────── */}
              {editingCustom && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditingCustom(null)}>
                  <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-xl border p-6 space-y-4"
                    style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }} onClick={e => e.stopPropagation()}>
                    <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                      {editingCustom.id ? `Modifier : ${editingCustom.display_name}` : 'Nouveau provider vocal'}
                    </h3>

                    <div className="grid grid-cols-2 gap-3">
                      {/* Basic info */}
                      <div>
                        <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Nom affiché *</label>
                        <input type="text" value={editingCustom.display_name} placeholder="Hume AI, Deepgram, etc."
                          onChange={e => setEditingCustom((p: any) => ({ ...p, display_name: e.target.value }))}
                          className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                      </div>
                      <div>
                        <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Icône (emoji)</label>
                        <input type="text" value={editingCustom.icon} placeholder="🔊"
                          onChange={e => setEditingCustom((p: any) => ({ ...p, icon: e.target.value }))}
                          className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                      </div>
                    </div>

                    <div>
                      <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Description</label>
                      <input type="text" value={editingCustom.description} placeholder="Description du provider"
                        onChange={e => setEditingCustom((p: any) => ({ ...p, description: e.target.value }))}
                        className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                    </div>

                    {/* Connection */}
                    <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                      <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Connexion WebSocket</h4>
                      <div className="space-y-3">
                        <div>
                          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>URL WebSocket * <span className="opacity-60">(peut contenir {'{api_key}'})</span></label>
                          <input type="text" value={editingCustom.ws_url} placeholder="wss://api.provider.com/v1/realtime"
                            onChange={e => setEditingCustom((p: any) => ({ ...p, ws_url: e.target.value }))}
                            className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                        </div>
                        <div>
                          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Clé API</label>
                          <input type="password" value={editingCustom.api_key} placeholder={editingCustom.api_key === '***' ? '••• (configurée)' : 'Clé API'}
                            onChange={e => setEditingCustom((p: any) => ({ ...p, api_key: e.target.value }))}
                            className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                          <div>
                            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Auth</label>
                            <select value={editingCustom.auth_method}
                              onChange={e => setEditingCustom((p: any) => ({ ...p, auth_method: e.target.value }))}
                              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }}>
                              <option value="header">Header HTTP</option>
                              <option value="query">Query param</option>
                              <option value="none">Aucune (dans URL)</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Header name</label>
                            <input type="text" value={editingCustom.auth_header_name}
                              onChange={e => setEditingCustom((p: any) => ({ ...p, auth_header_name: e.target.value }))}
                              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                          </div>
                          <div>
                            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Préfixe</label>
                            <input type="text" value={editingCustom.auth_header_prefix}
                              onChange={e => setEditingCustom((p: any) => ({ ...p, auth_header_prefix: e.target.value }))}
                              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Audio format */}
                    <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                      <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Format audio</h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Sample rate entrée (Hz)</label>
                          <input type="number" value={editingCustom.sample_rate_in}
                            onChange={e => setEditingCustom((p: any) => ({ ...p, sample_rate_in: parseInt(e.target.value) || 16000 }))}
                            className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                        </div>
                        <div>
                          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Sample rate sortie (Hz)</label>
                          <input type="number" value={editingCustom.sample_rate_out}
                            onChange={e => setEditingCustom((p: any) => ({ ...p, sample_rate_out: parseInt(e.target.value) || 16000 }))}
                            className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                        </div>
                      </div>
                    </div>

                    {/* Protocol */}
                    <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                      <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Protocole</h4>
                      <div className="space-y-3">
                        <div>
                          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Type de protocole</label>
                          <select value={editingCustom.protocol_type}
                            onChange={e => setEditingCustom((p: any) => ({ ...p, protocol_type: e.target.value }))}
                            className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }}>
                            <option value="openai_compatible">OpenAI-compatible (forwarde les events bruts)</option>
                            <option value="generic">Générique (extraction via dot-path)</option>
                          </select>
                        </div>
                        {editingCustom.protocol_type === 'generic' && (
                          <>
                            <div>
                              <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Template envoi audio <span className="opacity-60">{'{audio}'} = base64</span></label>
                              <input type="text" value={editingCustom.send_audio_wrapper}
                                onChange={e => setEditingCustom((p: any) => ({ ...p, send_audio_wrapper: e.target.value }))}
                                className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs font-mono focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Dot-path audio reçu</label>
                                <input type="text" value={editingCustom.recv_audio_path} placeholder="audio.data"
                                  onChange={e => setEditingCustom((p: any) => ({ ...p, recv_audio_path: e.target.value }))}
                                  className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs font-mono focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                              </div>
                              <div>
                                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Dot-path transcript</label>
                                <input type="text" value={editingCustom.recv_transcript_path} placeholder="transcript.text"
                                  onChange={e => setEditingCustom((p: any) => ({ ...p, recv_transcript_path: e.target.value }))}
                                  className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs font-mono focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                              </div>
                            </div>
                          </>
                        )}
                        <div>
                          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Message de setup (JSON, optionnel) <span className="opacity-60">{'{agent_name}'}, {'{api_key}'} remplacés</span></label>
                          <textarea value={editingCustom.setup_message} rows={3}
                            onChange={e => setEditingCustom((p: any) => ({ ...p, setup_message: e.target.value }))}
                            className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs font-mono focus:outline-none resize-none" style={{ color: 'var(--text-primary)' }} />
                        </div>
                        <div>
                          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>URL documentation</label>
                          <input type="text" value={editingCustom.doc_url} placeholder="https://docs.provider.com"
                            onChange={e => setEditingCustom((p: any) => ({ ...p, doc_url: e.target.value }))}
                            className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-2 pt-2">
                      <button onClick={handleSaveCustomProvider} disabled={customSaving || !editingCustom.display_name || !editingCustom.ws_url}
                        className="flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                        style={{ background: 'var(--accent-primary)', color: '#fff' }}>
                        {customSaving ? 'Sauvegarde...' : 'Sauvegarder'}
                      </button>
                      <button onClick={() => setEditingCustom(null)}
                        className="px-4 py-2 rounded-lg text-sm border transition-colors"
                        style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                        Annuler
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* -- Services -------------------------------------------------- */}
          {activeTab === 'services' && (
            <div className="space-y-6">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Configurez vos services externes. Chaque plugin peut utiliser ces services sans dépendance croisée.
              </p>

              {/* Editing modal */}
              {editingService && (() => {
                // Show only relevant fields per service
                const serviceFields: Record<string, string[]> = {
                  supabase: ['base_url', 'api_key', 'project_id'],
                  postgresql: ['base_url', 'database'],
                  s3: ['base_url', 'api_key', 'region', 'bucket'],
                  github: ['base_url', 'token'],
                  notion: ['base_url', 'token'],
                  google_drive: ['base_url', 'api_key'],
                  pinecone: ['base_url', 'api_key', 'namespace'],
                  qdrant: ['base_url', 'api_key', 'namespace'],
                  slack: ['token', 'webhook_url'],
                  discord: ['token', 'webhook_url'],
                  n8n: ['base_url', 'api_key'],
                  redis: ['base_url'],
                }
                const fieldDefs: Record<string, { label: string; placeholder: string; type?: string }> = {
                  base_url: { label: 'URL de base', placeholder: 'https://...' },
                  api_key: { label: 'Clé API', placeholder: services[editingService]?.api_key === '***' ? '••• (déjà configurée)' : 'Clé API', type: 'password' },
                  token: { label: 'Token', placeholder: services[editingService]?.token === '***' ? '••• (déjà configuré)' : 'Token OAuth / Bot', type: 'password' },
                  project_id: { label: 'Project ID', placeholder: 'ID du projet' },
                  database: { label: 'Base de données', placeholder: 'Nom de la BDD' },
                  region: { label: 'Région', placeholder: 'eu-west-1' },
                  bucket: { label: 'Bucket', placeholder: 'Nom du bucket' },
                  namespace: { label: 'Namespace', placeholder: 'Collection / namespace' },
                  webhook_url: { label: 'Webhook URL', placeholder: 'https://...' },
                }
                const fields = (serviceFields[editingService] || Object.keys(fieldDefs))
                return (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setEditingService(null)}>
                  <div className="w-full max-w-md rounded-xl border p-5 space-y-3 max-h-[80vh] overflow-y-auto" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }} onClick={e => e.stopPropagation()}>
                    <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                      {serviceLabels[editingService] || editingService}
                    </h3>

                    {/* Enabled toggle */}
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input type="checkbox" checked={serviceForm.enabled} onChange={e => setServiceForm(f => ({ ...f, enabled: e.target.checked }))}
                        className="w-4 h-4 accent-[var(--accent-primary)]" />
                      <span style={{ color: 'var(--text-secondary)' }}>Activé</span>
                    </label>

                    {/* Fields — only relevant ones per service */}
                    {fields.map(key => {
                      const f = fieldDefs[key]
                      if (!f) return null
                      return (
                        <div key={key}>
                          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{f.label}</label>
                          <input type={f.type || 'text'} value={serviceForm[key] || ''} placeholder={f.placeholder}
                            onChange={e => setServiceForm(prev => ({ ...prev, [key]: e.target.value }))}
                            className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none"
                            style={{ color: 'var(--text-primary)' }} />
                        </div>
                      )
                    })}

                    <div className="flex gap-2 pt-2">
                      <button onClick={handleSaveService} disabled={serviceSaving}
                        className="flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                        style={{ background: 'var(--accent-primary)', color: '#fff' }}>
                        {serviceSaving ? 'Sauvegarde...' : 'Sauvegarder'}
                      </button>
                      <button onClick={() => setEditingService(null)}
                        className="px-4 py-2 rounded-lg text-sm border transition-colors"
                        style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                        Annuler
                      </button>
                    </div>
                  </div>
                </div>
                )
              })()}

              {/* Service cards by category */}
              {Object.entries(serviceCategories).map(([cat, serviceNames]) => {
                const catLabels: Record<string, string> = {
                  database: 'Base de données',
                  storage: 'Stockage',
                  rag: 'RAG / Vectoriel',
                  dev: 'Développement',
                  communication: 'Communication',
                  automation: 'Automatisation',
                }
                const catIcons: Record<string, any> = {
                  database: Database,
                  storage: Cloud,
                  rag: SearchIcon,
                  dev: GitBranch,
                  communication: MessageSquare,
                  automation: Zap,
                }
                const CatIcon = catIcons[cat] || Server
                return (
                  <div key={cat}>
                    <h3 className="flex items-center gap-2 text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
                      <CatIcon className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                      {catLabels[cat] || cat}
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {(serviceNames as string[]).map(name => {
                        const svc = services[name]
                        if (!svc) return null
                        const testRes = serviceTestResult[name]
                        return (
                          <div key={name} className="border rounded-lg p-4 flex flex-col gap-2 transition-colors hover:border-[var(--accent-primary)]"
                            style={{ background: 'var(--bg-primary)', borderColor: svc.enabled ? 'color-mix(in srgb, var(--accent-primary) 40%, var(--border))' : 'var(--border)' }}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <div className={`w-2 h-2 rounded-full ${svc.enabled ? 'bg-green-400' : 'bg-gray-500'}`} />
                                <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                                  {svc.label || name}
                                </span>
                              </div>
                              <div className="flex items-center gap-1">
                                {svc.enabled && (
                                  <button onClick={() => handleTestService(name)} disabled={serviceTesting === name}
                                    className="p-1.5 rounded-md text-xs transition-colors hover:bg-[var(--bg-secondary)]"
                                    title="Tester la connexion">
                                    {serviceTesting === name ? (
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--text-muted)' }} />
                                    ) : (
                                      <RefreshCw className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                                    )}
                                  </button>
                                )}
                                <button onClick={() => handleEditService(name)}
                                  className="p-1.5 rounded-md text-xs transition-colors hover:bg-[var(--bg-secondary)]"
                                  title="Configurer">
                                  <SettingsIcon className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} />
                                </button>
                              </div>
                            </div>
                            {svc.base_url && (
                              <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{svc.base_url}</p>
                            )}
                            {svc.has_api_key && (
                              <span className="text-xs px-2 py-0.5 rounded-full w-fit" style={{ background: 'color-mix(in srgb, var(--accent-success) 15%, transparent)', color: 'var(--accent-success)' }}>
                                Clé configurée
                              </span>
                            )}
                            {testRes && (
                              <span className={`text-xs px-2 py-0.5 rounded-full w-fit ${testRes.ok ? '' : ''}`}
                                style={{
                                  background: testRes.ok ? 'color-mix(in srgb, var(--accent-success) 15%, transparent)' : 'color-mix(in srgb, var(--accent-error) 15%, transparent)',
                                  color: testRes.ok ? 'var(--accent-success)' : 'var(--accent-error)',
                                }}>
                                {testRes.ok ? (testRes.message || 'Connexion OK') : (testRes.error || 'Échec')}
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* -- Heartbeat ------------------------------------------------- */}
          {activeTab === 'heartbeat' && (
            <div className="space-y-6">
              {/* Status bar */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${hbStatus?.running ? (hbConfig.paused ? 'bg-yellow-400 animate-pulse' : 'bg-green-400') : 'bg-gray-500'}`} />
                  <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    {hbStatus?.running ? (hbConfig.paused ? 'En pause' : 'Actif') : 'Arrêté'}
                  </span>
                  {hbLoading && <span className="text-[var(--text-muted)] text-xs">chargement...</span>}
                </div>
                <div className="flex gap-2">
                  {!hbStatus?.running ? (
                    <button onClick={() => hbAction('start')} className="px-3 py-1.5 text-sm rounded-lg" style={{ color: 'var(--accent-success)', background: 'color-mix(in srgb, var(--accent-success) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-success) 30%, transparent)' }}>Démarrer</button>
                  ) : hbConfig.paused ? (
                    <button onClick={() => hbAction('resume')} className="px-3 py-1.5 text-sm text-blue-400 bg-blue-600/15 border border-blue-600/30 rounded-lg hover:bg-blue-600/25">Reprendre</button>
                  ) : (
                    <button onClick={() => hbAction('pause')} className="px-3 py-1.5 text-sm text-yellow-400 bg-yellow-600/15 border border-yellow-600/30 rounded-lg hover:bg-yellow-600/25">Pause</button>
                  )}
                  {hbStatus?.running && (
                    <button onClick={() => hbAction('stop')} className="px-3 py-1.5 text-sm rounded-lg" style={{ color: 'var(--accent-primary)', background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' }}>Arrêter</button>
                  )}
                  <button onClick={loadHeartbeat} className="p-1.5 text-[var(--text-muted)] hover:text-white"><RefreshCw className="w-3.5 h-3.5" /></button>
                </div>
              </div>

              {/* Mode Jour/Nuit — toggle + plages horaires */}
              <div className="p-4 rounded-lg border" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Mode Jour / Nuit</span>
                      {hbConfig.day_night_enabled && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide"
                          style={{
                            background: hbNightActive ? 'color-mix(in srgb, #6366f1 20%, transparent)' : 'color-mix(in srgb, #f59e0b 20%, transparent)',
                            color: hbNightActive ? '#a5b4fc' : '#fbbf24',
                            border: `1px solid ${hbNightActive ? 'color-mix(in srgb, #6366f1 40%, transparent)' : 'color-mix(in srgb, #f59e0b 40%, transparent)'}`,
                          }}>
                          {hbNightActive ? '🌙 Nuit active' : '☀️ Jour actif'}
                        </span>
                      )}
                    </div>
                    <p className="text-[var(--text-muted)] text-xs mt-1">Paramètres distincts pour la journée et la nuit (réduit la charge la nuit).</p>
                  </div>
                  <input type="checkbox" checked={hbConfig.day_night_enabled ?? false}
                    onChange={e => updateHbConfig('day_night_enabled', e.target.checked)}
                    className="w-4 h-4 rounded bg-[var(--bg-primary)] border-[var(--border)] accent-red-600" />
                </div>

                {hbConfig.day_night_enabled && (
                  <>
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div>
                        <label className="text-[var(--text-secondary)] text-xs mb-1 block">Début du jour</label>
                        <div className="flex items-center gap-2">
                          <input type="number" min={0} max={23} value={hbConfig.day_start_hour ?? 7}
                            onChange={e => updateHbConfig('day_start_hour', Math.max(0, Math.min(23, Number(e.target.value))))}
                            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none text-sm" style={{ color: 'var(--text-primary)' }} />
                          <span className="text-[var(--text-muted)] text-xs">h</span>
                        </div>
                      </div>
                      <div>
                        <label className="text-[var(--text-secondary)] text-xs mb-1 block">Début de la nuit</label>
                        <div className="flex items-center gap-2">
                          <input type="number" min={0} max={23} value={hbConfig.night_start_hour ?? 22}
                            onChange={e => updateHbConfig('night_start_hour', Math.max(0, Math.min(23, Number(e.target.value))))}
                            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none text-sm" style={{ color: 'var(--text-primary)' }} />
                          <span className="text-[var(--text-muted)] text-xs">h</span>
                        </div>
                      </div>
                    </div>

                    {/* Switch entre édition jour et nuit */}
                    <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                      <button onClick={() => setHbEditMode('day')}
                        className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all"
                        style={{
                          background: hbEditMode === 'day' ? 'color-mix(in srgb, #f59e0b 25%, transparent)' : 'transparent',
                          color: hbEditMode === 'day' ? '#fbbf24' : 'var(--text-muted)',
                        }}>
                        ☀️ Édition Jour
                      </button>
                      <button onClick={() => setHbEditMode('night')}
                        className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all"
                        style={{
                          background: hbEditMode === 'night' ? 'color-mix(in srgb, #6366f1 25%, transparent)' : 'transparent',
                          color: hbEditMode === 'night' ? '#a5b4fc' : 'var(--text-muted)',
                        }}>
                        🌙 Édition Nuit
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Config fields — intervals with unit selector */}
              {(() => {
                const isNightEdit = hbConfig.day_night_enabled && hbEditMode === 'night'
                const nightCfg = hbConfig.night_config || {}
                const fields = [
                  { key: 'check_interval_seconds', label: 'Intervalle de vérification des tâches', desc: 'Fréquence à laquelle le heartbeat vérifie les tâches planifiées.', min: 5, max: 86400 },
                  { key: 'ws_ping_interval_seconds', label: 'Intervalle ping WebSocket', desc: 'Fréquence des pings keepalive sur les connexions vocales.', min: 5, max: 7200 },
                  { key: 'offset_seconds', label: 'Décalage initial', desc: 'Délai avant le premier cycle après démarrage.', min: 0, max: 86400, dayOnly: true },
                ]
                return fields.map(f => {
                  if (isNightEdit && f.dayOnly) return null
                  const source = isNightEdit ? nightCfg : hbConfig
                  const totalSeconds = source[f.key] ?? f.min
                  const bestUnit = totalSeconds >= 3600 && totalSeconds % 3600 === 0 ? 'h' : totalSeconds >= 60 && totalSeconds % 60 === 0 ? 'm' : 's'
                  const displayValue = bestUnit === 'h' ? totalSeconds / 3600 : bestUnit === 'm' ? totalSeconds / 60 : totalSeconds
                  const writeKey = isNightEdit ? `night.${f.key}` : f.key
                  return (
                    <div key={`${isNightEdit ? 'n' : 'd'}-${f.key}`}>
                      <label className="text-[var(--text-secondary)] text-sm mb-2 block">{f.label}</label>
                      <div className="flex gap-2">
                        <input type="number" min={bestUnit === 'h' ? Math.ceil(f.min / 3600) : bestUnit === 'm' ? Math.ceil(f.min / 60) : f.min}
                          value={displayValue}
                          onChange={e => {
                            const v = Number(e.target.value)
                            const unit = (document.getElementById(`unit-${writeKey}`) as HTMLSelectElement)?.value || 's'
                            const seconds = unit === 'h' ? v * 3600 : unit === 'm' ? v * 60 : v
                            if (seconds >= f.min) updateHbConfig(writeKey, seconds)
                          }}
                          className="flex-1 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2.5 focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                        <select id={`unit-${writeKey}`} value={bestUnit}
                          onChange={e => {
                            const unit = e.target.value
                            const currentInput = document.querySelector(`#unit-${writeKey}`)?.parentElement?.querySelector('input') as HTMLInputElement
                            const v = Number(currentInput?.value || displayValue)
                            const seconds = unit === 'h' ? v * 3600 : unit === 'm' ? v * 60 : v
                            if (seconds >= f.min) updateHbConfig(writeKey, seconds)
                          }}
                          className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2.5 text-sm focus:outline-none cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                          <option value="s">secondes</option>
                          <option value="m">minutes</option>
                          <option value="h">heures</option>
                        </select>
                      </div>
                      <p className="text-[var(--text-muted)] text-xs mt-1">{f.desc}</p>
                    </div>
                  )
                })
              })()}

              {/* Max concurrent tasks — no unit needed */}
              <div>
                <label className="text-[var(--text-secondary)] text-sm mb-2 block">Tâches concurrentes max</label>
                {(() => {
                  const isNightEdit = hbConfig.day_night_enabled && hbEditMode === 'night'
                  const val = isNightEdit ? (hbConfig.night_config?.max_concurrent_tasks ?? 2) : (hbConfig.max_concurrent_tasks ?? 5)
                  const writeKey = isNightEdit ? 'night.max_concurrent_tasks' : 'max_concurrent_tasks'
                  return (
                    <input type="number" min={1} max={20} value={val}
                      onChange={e => updateHbConfig(writeKey, Number(e.target.value))}
                      className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2.5 focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                  )
                })()}
                <p className="text-[var(--text-muted)] text-xs mt-1">Nombre max de tâches planifiées en parallèle.</p>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[var(--text-secondary)] text-sm">Démarrage automatique</span>
                  <p className="text-[var(--text-muted)] text-xs">Démarrer le heartbeat au lancement du serveur.</p>
                </div>
                <input type="checkbox" checked={hbConfig.on_startup ?? true}
                  onChange={e => updateHbConfig('on_startup', e.target.checked)}
                  className="w-4 h-4 rounded bg-[var(--bg-primary)] border-[var(--border)] accent-red-600" />
              </div>

              {/* Bouton Sauvegarder + message */}
              <div className="flex items-center gap-3 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                <button onClick={saveHbConfig} disabled={!hbDirty || hbSaving}
                  className="px-4 py-2 text-sm font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    background: hbDirty ? 'color-mix(in srgb, var(--scarlet) 20%, transparent)' : 'var(--bg-secondary)',
                    color: hbDirty ? 'var(--accent-primary-light, #ff6b6b)' : 'var(--text-muted)',
                    border: `1px solid ${hbDirty ? 'color-mix(in srgb, var(--scarlet) 40%, transparent)' : 'var(--border)'}`,
                  }}>
                  {hbSaving ? 'Sauvegarde...' : hbDirty ? 'Sauvegarder' : 'Sauvegardé'}
                </button>
                {hbDirty && !hbSaving && (
                  <button onClick={loadHeartbeat}
                    className="px-3 py-2 text-xs rounded-lg"
                    style={{ color: 'var(--text-muted)', background: 'transparent', border: '1px solid var(--border)' }}>
                    Annuler
                  </button>
                )}
                {hbSaveMsg && (
                  <span className="text-xs" style={{ color: hbSaveMsg.type === 'ok' ? 'var(--accent-success)' : 'var(--accent-primary)' }}>
                    {hbSaveMsg.text}
                  </span>
                )}
              </div>

              {hbStatus?.tasks?.length > 0 && (
                <div>
                  <h4 className="text-[var(--text-secondary)] text-sm mb-3">Tâches planifiées ({hbStatus.tasks.length})</h4>
                  <div className="space-y-2">
                    {hbStatus.tasks.map((task: any) => (
                      <div key={task.id} className="flex items-center justify-between p-3 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg">
                        <div>
                          <div className="text-sm" style={{ color: 'var(--text-primary)' }}>{task.name}</div>
                          <div className="text-[var(--text-muted)] text-xs">{task.action_type} · {task.run_count} exec · {task.status}</div>
                        </div>
                        <div className="text-right">
                          {task.next_run && <div className="text-[var(--text-muted)] text-xs">Prochain : {new Date(task.next_run).toLocaleString('fr-FR')}</div>}
                          <div className="text-xs" style={{ color: task.enabled ? 'var(--accent-success)' : 'var(--text-muted)' }}>{task.enabled ? 'Activé' : 'Désactivé'}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* -- Analytics ------------------------------------------------- */}
          {/* -- Backup ---------------------------------------------------- */}
          {activeTab === 'backup' && (
            <div className="space-y-6">
              {/* Message */}
              {backupMsg && (
                <div className="flex items-center gap-2 p-3 rounded-lg text-sm" style={{
                  background: backupMsg.type === 'ok' ? 'color-mix(in srgb, var(--accent-success) 15%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 15%, transparent)',
                  color: backupMsg.type === 'ok' ? 'var(--accent-success)' : 'var(--accent-primary)',
                  border: backupMsg.type === 'ok' ? '1px solid color-mix(in srgb, var(--accent-success) 30%, transparent)' : '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)'
                }}>
                  {backupMsg.type === 'ok' ? <CheckCircle className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
                  {backupMsg.text}
                </div>
              )}

              {/* Quick backup */}
              <div>
                <h3 className="font-medium mb-3" style={{ color: 'var(--text-primary)' }}>Backup immédiat</h3>
                <button onClick={triggerBackup} disabled={backupLoading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--scarlet-dark))' }}>
                  <Download className="w-4 h-4" />{backupLoading ? 'En cours...' : 'Créer un backup maintenant'}
                </button>
              </div>

              {/* Service selection */}
              <div>
                <label className="text-[var(--text-secondary)] text-sm mb-2 block">Service de backup</label>
                <select value={backupConfig?.provider || 'local'}
                  onChange={e => saveBackupConfig({ ...backupConfig, provider: e.target.value })}
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-3 focus:outline-none" style={{ color: 'var(--text-primary)' }}>
                  <option value="local">Local (fichiers zip dans data/backups/)</option>
                  <option value="supabase">Supabase Storage</option>
                  <option value="github">GitHub Repository</option>
                </select>
              </div>

              {/* Supabase config */}
              {backupConfig?.provider === 'supabase' && (
                <div className="border border-[var(--border)] rounded-lg p-4 space-y-3">
                  <h4 className="font-medium" style={{ color: 'var(--text-primary)' }}>Configuration Supabase</h4>
                  <input type="text" placeholder="Project URL (https://xxx.supabase.co)"
                    value={backupConfig?.supabase_url || ''}
                    onChange={e => saveBackupConfig({ ...backupConfig, supabase_url: e.target.value })}
                    className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2 focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                  <input type="password" placeholder="Service Role Key"
                    value={backupConfig?.supabase_key || ''}
                    onChange={e => saveBackupConfig({ ...backupConfig, supabase_key: e.target.value })}
                    className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2 focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                  <input type="text" placeholder="Bucket name (défaut: gungnir-backups)"
                    value={backupConfig?.supabase_bucket || ''}
                    onChange={e => saveBackupConfig({ ...backupConfig, supabase_bucket: e.target.value })}
                    className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2 focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                </div>
              )}

              {/* GitHub config */}
              {backupConfig?.provider === 'github' && (
                <div className="border border-[var(--border)] rounded-lg p-4 space-y-3">
                  <h4 className="font-medium" style={{ color: 'var(--text-primary)' }}>Configuration GitHub</h4>
                  <input type="password" placeholder="Personal Access Token (repo scope)"
                    value={backupConfig?.github_token || ''}
                    onChange={e => saveBackupConfig({ ...backupConfig, github_token: e.target.value })}
                    className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2 focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                  <input type="text" placeholder="Repository (user/repo)"
                    value={backupConfig?.github_repo || ''}
                    onChange={e => saveBackupConfig({ ...backupConfig, github_repo: e.target.value })}
                    className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2 focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                  <input type="text" placeholder="Branche (défaut: main)"
                    value={backupConfig?.github_branch || ''}
                    onChange={e => saveBackupConfig({ ...backupConfig, github_branch: e.target.value })}
                    className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2 focus:outline-none" style={{ color: 'var(--text-primary)' }} />
                </div>
              )}

              {/* Auto backup */}
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[var(--text-secondary)] text-sm">Backup automatique quotidien</span>
                  <p className="text-[var(--text-muted)] text-xs">Crée un backup chaque jour à minuit.</p>
                </div>
                <input type="checkbox" checked={backupConfig?.auto_daily || false}
                  onChange={e => saveBackupConfig({ ...backupConfig, auto_daily: e.target.checked })}
                  className="w-4 h-4 rounded bg-[var(--bg-primary)] border-[var(--border)] accent-red-600" />
              </div>

              {/* Max backups */}
              <div>
                <label className="text-[var(--text-secondary)] text-sm mb-2 block">Nombre max de backups conservés</label>
                <input type="number" min={1} max={100} value={backupConfig?.max_backups || 10}
                  onChange={e => saveBackupConfig({ ...backupConfig, max_backups: Number(e.target.value) })}
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2.5 focus:outline-none" style={{ color: 'var(--text-primary)' }} />
              </div>

              {/* History */}
              <div>
                <h4 className="text-[var(--text-secondary)] text-sm mb-3">Historique des backups ({backupHistory.length})</h4>
                {backupHistory.length === 0 ? (
                  <p className="text-[var(--text-muted)] text-sm text-center py-4">Aucun backup. Créez-en un ci-dessus.</p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {backupHistory.map((b: any, i: number) => (
                      <div key={i} className="flex items-center justify-between p-3 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg">
                        <div>
                          <div className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>{b.filename}</div>
                          <div className="text-[var(--text-muted)] text-xs">
                            {b.size_mb ? `${b.size_mb} MB` : ''} · {b.provider || 'local'} · {b.created_at ? new Date(b.created_at).toLocaleString('fr-FR') : ''}
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={() => restoreBackup(b.filename)} title="Restaurer"
                            className="p-1.5 text-blue-400 hover:bg-blue-600/15 rounded">
                            <Upload className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => deleteBackup(b.filename)} title="Supprimer"
                            className="p-1.5 rounded" style={{ color: 'var(--accent-primary)' }}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {/* -- Doctor --------------------------------------------------- */}
          {activeTab === 'doctor' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium" style={{ color: 'var(--text-primary)' }}>Diagnostic système</h3>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    Vérifie la configuration, les plugins, les dépendances, les backups et la base de données.
                  </p>
                </div>
                <button onClick={runDoctor} disabled={doctorLoading}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--scarlet-dark))', color: 'white' }}>
                  {doctorLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Stethoscope className="w-4 h-4" />}
                  {doctorLoading ? 'Analyse...' : 'Lancer le diagnostic'}
                </button>
              </div>

              {doctorResult && !doctorResult.error && (
                <div className="space-y-4">
                  {/* Summary bar */}
                  {(() => {
                    const totalChecks = (doctorResult.checks || []).length
                    const okChecks = (doctorResult.checks || []).filter((c: any) => c.status === 'ok').length
                    const errCount = doctorResult.errors || 0
                    const warnCount = doctorResult.warnings || 0
                    return (
                      <div className="flex items-center gap-4 p-4 rounded-lg" style={{
                        background: errCount > 0
                          ? 'color-mix(in srgb, var(--accent-danger) 10%, transparent)'
                          : 'color-mix(in srgb, var(--accent-success) 10%, transparent)',
                        border: `1px solid ${errCount > 0 ? 'color-mix(in srgb, var(--accent-danger) 30%, transparent)' : 'color-mix(in srgb, var(--accent-success) 30%, transparent)'}`,
                      }}>
                        {errCount > 0
                          ? <AlertCircle className="w-5 h-5" style={{ color: 'var(--accent-danger)' }} />
                          : <CheckCircle className="w-5 h-5" style={{ color: 'var(--accent-success)' }} />
                        }
                        <div>
                          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {okChecks}/{totalChecks} checks OK
                          </span>
                          {warnCount > 0 && (
                            <span className="text-xs ml-2" style={{ color: 'var(--accent-warning)' }}>
                              ({warnCount} avertissement{warnCount > 1 ? 's' : ''})
                            </span>
                          )}
                          {errCount > 0 && (
                            <span className="text-xs ml-2" style={{ color: 'var(--accent-danger)' }}>
                              ({errCount} erreur{errCount > 1 ? 's' : ''})
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })()}

                  {/* Check results */}
                  <div className="space-y-1.5">
                    {(doctorResult.checks || []).map((check: any, i: number) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-2.5 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                        {check.status === 'ok' && <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-success)' }} />}
                        {check.status === 'warning' && <AlertCircle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-warning)' }} />}
                        {check.status === 'error' && <AlertCircle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-danger)' }} />}
                        {check.status === 'info' && <Stethoscope className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
                        <span className="text-sm flex-1" style={{ color: 'var(--text-primary)' }}>{check.name}</span>
                        {check.detail && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{check.detail}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {doctorResult?.error && (
                <div className="p-4 rounded-lg" style={{
                  background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--accent-danger) 30%, transparent)',
                }}>
                  <span className="text-sm" style={{ color: 'var(--accent-danger)' }}>
                    Erreur : {doctorResult.error}
                  </span>
                </div>
              )}

              {!doctorResult && !doctorLoading && (
                <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
                  <Stethoscope className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">Cliquez sur "Lancer le diagnostic" pour analyser le système.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
