import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'
import { useStore } from '../stores/appStore'
import { api, apiFetch } from '../services/api'
import {
  Send, Plus, User, Mic, MicOff, ChevronDown, Bot,
  Search, Sparkles, MessageSquare, Star,
  Code, FileText, Globe, BarChart3, Radio,
  ChevronLeft, ChevronRight, Pencil, Check, X, Key,
  Paperclip, Image as ImageIcon, Copy, ListTodo, Folder, FolderMinus, GripVertical,
  Calendar, Play, Pause, CheckCircle2, AlertCircle, Clock
} from 'lucide-react'
import VoiceModal from '../components/VoiceModal'
import ApiKeysModal from '../components/ApiKeysModal'
import UserModal from '../components/UserModal'
import ConversationMenu from '../components/ConversationMenu'
import TaskPanel from '../components/TaskPanel'

function AgentAvatar({ size = 32 }: { size?: number }) {
  return (
    <img src="/logo.png" alt="Agent" width={size} height={size}
      className="rounded-full flex-shrink-0 object-contain" />
  )
}

function AgentIcon({ size = 16 }: { size?: number }) {
  return <img src="/logo.png" alt="Agent" width={size} height={size} className="object-contain" />
}

// Bouton de copie réutilisable (message entier ou bloc de code)
function CopyButton({ text, label, compact = false }: { text: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API indisponible — ignorer silencieusement
    }
  }
  return (
    <button
      onClick={handleCopy}
      className={`flex items-center gap-1 rounded-md transition-all ${compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs'}`}
      style={{
        background: copied ? 'color-mix(in srgb, var(--accent-success) 15%, transparent)' : 'var(--bg-secondary)',
        color: copied ? 'var(--accent-success)' : 'var(--text-muted)',
        border: `1px solid ${copied ? 'color-mix(in srgb, var(--accent-success) 30%, transparent)' : 'var(--border)'}`,
      }}
      title={copied ? 'Copié !' : 'Copier'}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {label && <span>{copied ? 'Copié' : label}</span>}
    </button>
  )
}

// Barre d'actions sous chaque message (copie, etc.) — toujours visible, style Claude
// Icône de copie flottante — sticky en haut de la bulle, apparait au survol
// Le wrapper sticky (h-0) reste collé en haut du scroll container tant que la bulle
// est visible, donc le bouton reste accessible même sur un message très long.
function FloatingCopyButton({ content, side = 'right' }: { content: string; side?: 'left' | 'right' }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <div className="sticky top-2 h-0 z-10 pointer-events-none">
      <button
        onClick={handleCopy}
        className={`pointer-events-auto absolute -top-1 ${side === 'right' ? 'right-0' : 'left-0'} p-1.5 rounded-md transition-all opacity-0 group-hover:opacity-100 hover:scale-110`}
        style={{
          background: copied
            ? 'color-mix(in srgb, var(--accent-success) 25%, var(--bg-primary))'
            : 'color-mix(in srgb, var(--scarlet) 20%, var(--bg-primary))',
          color: copied ? 'var(--accent-success)' : 'var(--accent-primary-light, #ff6b6b)',
          border: `1px solid ${copied ? 'color-mix(in srgb, var(--accent-success) 50%, transparent)' : 'color-mix(in srgb, var(--scarlet) 45%, transparent)'}`,
          backdropFilter: 'blur(6px)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        }}
        title={copied ? 'Copié !' : 'Copier le message'}
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  )
}

// Bloc de code avec entête (langage + copie) et zone monospace scrollable
function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div className="my-2 rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border)', background: '#0b0b0d' }}>
      <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-widest"
        style={{ background: 'color-mix(in srgb, var(--scarlet) 8%, #151518)', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
        <span className="font-semibold" style={{ color: 'var(--accent-primary-light, var(--accent-primary))' }}>
          {language || 'code'}
        </span>
        <CopyButton text={code} label="Copier" compact />
      </div>
      <pre className="p-3 text-xs overflow-x-auto leading-relaxed" style={{ color: '#e6e6e6', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>
        <code>{code}</code>
      </pre>
    </div>
  )
}

// Rendu d'un message : parse les fences ```lang ... ``` et alterne texte brut / CodeBlock
function MessageContent({ content }: { content: string }) {
  const parts: Array<{ type: 'text' | 'code'; content: string; language?: string }> = []
  const regex = /```(\w+)?\n?([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: content.slice(lastIndex, match.index) })
    }
    parts.push({ type: 'code', content: match[2].replace(/\n$/, ''), language: match[1] })
    lastIndex = regex.lastIndex
  }
  if (lastIndex < content.length) {
    parts.push({ type: 'text', content: content.slice(lastIndex) })
  }
  if (parts.length === 0) {
    parts.push({ type: 'text', content })
  }

  return (
    <>
      {parts.map((part, i) => {
        if (part.type === 'code') {
          return <CodeBlock key={i} code={part.content} language={part.language} />
        }
        // Rendu du texte avec `inline code` détecté
        const inlineSegments = part.content.split(/(`[^`\n]+`)/g)
        return (
          <span key={i} className="whitespace-pre-wrap">
            {inlineSegments.map((seg, j) => {
              if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
                return (
                  <code key={j} className="px-1 py-0.5 rounded text-[0.85em] font-mono"
                    style={{ background: 'color-mix(in srgb, var(--scarlet) 12%, transparent)', color: 'var(--accent-primary-light, var(--accent-primary))', border: '1px solid color-mix(in srgb, var(--scarlet) 15%, transparent)' }}>
                    {seg.slice(1, -1)}
                  </code>
                )
              }
              return <span key={j}>{seg}</span>
            })}
          </span>
        )
      })}
    </>
  )
}

export default function Chat() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const {
    config, agentName,
    messages, currentConversation, setCurrentConversation,
    conversations, setConversations, isLoading, setLoading,
    loadingConvoId, setLoadingConvoId,
    selectedProvider, setSelectedProvider, selectedModel, setSelectedModel,
    setMessages, addMessage,
    activePersonality, setActivePersonality
  } = useStore()

  const [input, setInput] = useState('')
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [personalities, setPersonalities] = useState<any[]>([])

  // Automata tab — "chats" = normal conversations, "automata" = scheduled task history
  const [sidebarTab, setSidebarTab] = useState<'chats' | 'automata'>('chats')
  const [automataTasks, setAutomataTasks] = useState<any[]>([])
  const [activeAutomataTaskId, setActiveAutomataTaskId] = useState<string | null>(null)
  const [automataHistory, setAutomataHistory] = useState<any[]>([])
  const [showPersonaMenu, setShowPersonaMenu] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [stats, setStats] = useState({ tokens: 0, messages: 0, cost: 0 })
  const [providerModelsMap, setProviderModelsMap] = useState<Record<string, string[]>>({})
  const [modelSearch, setModelSearch] = useState('')
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())

  // Favoris modèles (max 5, partagé via localStorage)
  const [favoriteModels, setFavoriteModels] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('gungnir_favorite_models') || '[]') } catch { return [] }
  })
  const toggleFavorite = (provider: string, model: string) => {
    const key = `${provider}::${model}`
    setFavoriteModels(prev => {
      const next = prev.includes(key) ? prev.filter(f => f !== key) : prev.length >= 5 ? prev : [...prev, key]
      localStorage.setItem('gungnir_favorite_models', JSON.stringify(next))
      return next
    })
  }

  // Skills
  const [allSkills, setAllSkills] = useState<any[]>([])
  const [activeSkill, setActiveSkill] = useState<string | null>(null)
  const [favoriteSkills, setFavoriteSkills] = useState<any[]>([])

  // Welcome onboarding
  const [onboardingState, setOnboardingState] = useState<{
    step: 'pending' | 'in_progress' | 'done'
    has_api_key: boolean
    welcome_convo_id: number | null
    agent_name: string
  } | null>(null)
  const onboardingAutoOpenedRef = useRef(false)

  // File/image attachments
  const [attachedFiles, setAttachedFiles] = useState<{ name: string; type: string; dataUrl: string; preview?: string }[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach(file => {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        setAttachedFiles(prev => [...prev, {
          name: file.name,
          type: file.type,
          dataUrl,
          preview: file.type.startsWith('image/') ? dataUrl : undefined,
        }])
      }
      reader.readAsDataURL(file)
    })
    e.target.value = ''
  }

  const removeAttachment = (idx: number) => setAttachedFiles(prev => prev.filter((_, i) => i !== idx))

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // When we create a conversation locally (handleSend / handleNewChat /
  // handleNewChatWithSummary), we already know its messages state — either
  // empty or the optimistic user message we just added. Without this ref,
  // the useEffect on currentConversation would race and wipe that state by
  // calling loadMessages() before the backend has persisted the user msg.
  // Carry the expected ID so a no-op setCurrentConversation can't leave a
  // stale skip flag that would drop a later real navigation.
  const skipLoadForRef = useRef<number | null>(null)

  // Chat sidebar collapse (Ctrl+B via custom event)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    return localStorage.getItem('gungnir_chat_sidebar') === 'true'
  })

  // Task panel (right side)
  const [showTaskPanel, setShowTaskPanel] = useState(() => {
    return localStorage.getItem('gungnir_task_panel') === 'true'
  })

  const toggleTaskPanel = useCallback(() => {
    setShowTaskPanel(prev => {
      const next = !prev
      localStorage.setItem('gungnir_task_panel', String(next))
      return next
    })
  }, [])

  const [editingTitleId, setEditingTitleId] = useState<number | null>(null)
  const [editTitleValue, setEditTitleValue] = useState('')
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [hasGeneratedTitle, setHasGeneratedTitle] = useState(() => {
    try { const saved = localStorage.getItem('gungnir_titles_generated'); return new Set(JSON.parse(saved || '[]')) }
    catch { return new Set() }
  })

  const [showApiKeysModal, setShowApiKeysModal] = useState(false)
  const [showUserModal, setShowUserModal] = useState(false)
  const [currentUser, setCurrentUser] = useState<any>(() => {
    try { const saved = localStorage.getItem('gungnir_current_user'); return saved ? JSON.parse(saved) : null }
    catch { return null }
  })

  // Folders (classification des conversations) — placé après currentUser pour éviter TDZ
  const [folders, setFolders] = useState<any[]>([])
  const [folderFilter, setFolderFilter] = useState<number | null | 'all'>('all')
  // Drag & drop état : convo en cours de drag + cible survolée
  // useRef pour éviter les closures stales sur les handlers (le dragover doit
  // pouvoir preventDefault() immédiatement, sans attendre un re-render React).
  const draggedConvoRef = useRef<number | null>(null)
  const [draggedConvoId, setDraggedConvoId] = useState<number | null>(null)
  const [dropTargetFolder, setDropTargetFolder] = useState<number | null | 'none' | undefined>(undefined)
  const [foldersCollapsed, setFoldersCollapsed] = useState(() => localStorage.getItem('gungnir_folders_collapsed') === 'true')
  const toggleFoldersCollapsed = () => {
    setFoldersCollapsed(prev => {
      const next = !prev
      localStorage.setItem('gungnir_folders_collapsed', String(next))
      return next
    })
  }
  const handleDropOnFolder = async (convoId: number, folderId: number | null) => {
    // Optimistic update
    const current = useStore.getState().conversations
    setConversations(current.map(c => c.id === convoId ? { ...c, folder_id: folderId } : c))
    // Basculer automatiquement sur le dossier cible pour voir le résultat
    setFolderFilter(folderId)
    try {
      await api.moveConversationToFolder(convoId, folderId)
    } catch (err) {
      console.error('Drop move error:', err)
      reloadConversations() // revert
    }
  }
  const reloadFolders = useCallback(async () => {
    try { setFolders(await api.listFolders()) } catch { /* ignore */ }
  }, [])
  useEffect(() => { reloadFolders() }, [reloadFolders])
  const reloadConversations = useCallback(async () => {
    try { setConversations(await api.getConversations(currentUser?.id)) } catch { /* ignore */ }
  }, [currentUser?.id, setConversations])
  const handleCreateFolder = async () => {
    const name = window.prompt('Nom du nouveau dossier :')?.trim()
    if (!name) return
    try { await api.createFolder({ name }); reloadFolders() } catch (err) { console.error('Create folder error:', err) }
  }
  const handleDeleteFolder = async (folderId: number) => {
    if (!window.confirm('Supprimer ce dossier ? Les conversations qu\'il contient seront conservées (sans dossier).')) return
    try { await api.deleteFolder(folderId); reloadFolders(); reloadConversations() } catch (err) { console.error('Delete folder error:', err) }
  }

  const [showVoiceModal, setShowVoiceModal] = useState(false)
  const [pttStatus, setPttStatus] = useState<'idle' | 'recording' | 'processing'>('idle')
  const recognitionRef = useRef<any>(null)

  const startPTT = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) return
    if (recognitionRef.current) return
    const recognition = new SpeechRecognition()
    recognition.lang = i18n.language === 'en' ? 'en-US' : `${i18n.language}-${i18n.language.toUpperCase()}`
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.continuous = false
    recognition.onstart = () => setPttStatus('recording')
    recognition.onresult = (event: any) => {
      const transcript = event.results[0]?.[0]?.transcript || ''
      if (transcript) { setInput(prev => (prev ? prev + ' ' : '') + transcript); setTimeout(() => inputRef.current?.focus(), 50) }
    }
    recognition.onerror = () => { setPttStatus('idle'); recognitionRef.current = null }
    recognition.onend = () => { setPttStatus('idle'); recognitionRef.current = null }
    recognitionRef.current = recognition
    recognition.start()
  }, [])

  const stopPTT = useCallback(() => {
    if (recognitionRef.current) { setPttStatus('processing'); recognitionRef.current.stop() }
  }, [])

  // Listen for Ctrl+B custom event from useKeyboard hook
  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed(prev => {
      const newVal = !prev
      localStorage.setItem('gungnir_chat_sidebar', String(newVal))
      return newVal
    })
  }, [])

  useEffect(() => {
    const handler = () => toggleSidebar()
    window.addEventListener('gungnir:toggle-chat-sidebar', handler)
    return () => window.removeEventListener('gungnir:toggle-chat-sidebar', handler)
  }, [toggleSidebar])

  // ─── Reload conversations when user changes ───────────────────────
  useEffect(() => {
    const loadUserConversations = async () => {
      try {
        const convos = await api.getConversations(currentUser?.id)
        setConversations(convos)
        // Reset current conversation if it doesn't belong to this user
        if (currentConversation && !convos.find((c: any) => c.id === currentConversation)) {
          setCurrentConversation(null)
          setMessages([])
        }
      } catch { /* ignore */ }
    }
    loadUserConversations()
  }, [currentUser?.id])

  // ─── Welcome onboarding gate ──────────────────────────────────────
  // On first mount (or when the user changes), check whether the caller
  // needs the welcome chat. If they already have an API key and haven't
  // finished onboarding, create+open the welcome conversation once.
  useEffect(() => {
    if (!currentUser?.id) return
    onboardingAutoOpenedRef.current = false
    const loadOnboarding = async () => {
      try {
        const res = await apiFetch('/api/onboarding/state')
        if (!res.ok) return
        const data = await res.json()
        setOnboardingState(data)

        if (data.step === 'done' || !data.has_api_key) return

        // Needs onboarding + has key: create welcome conv if missing, then open it
        if (!onboardingAutoOpenedRef.current) {
          onboardingAutoOpenedRef.current = true
          let convoId = data.welcome_convo_id
          if (!convoId) {
            try {
              const createRes = await apiFetch('/api/onboarding/welcome', { method: 'POST' })
              if (createRes.ok) {
                const created = await createRes.json()
                convoId = created.welcome_convo_id
                setOnboardingState((prev) => prev ? { ...prev, welcome_convo_id: convoId, step: 'in_progress' } : prev)
                // Refresh the conversations list so the sidebar shows "Bienvenue"
                try {
                  const convos = await api.getConversations(currentUser?.id)
                  setConversations(convos)
                } catch { /* ignore */ }
              }
            } catch { /* ignore */ }
          }
          if (convoId) setCurrentConversation(convoId)
        }
      } catch { /* ignore */ }
    }
    loadOnboarding()
  }, [currentUser?.id])

  const refreshOnboardingState = useCallback(async () => {
    if (!currentUser?.id) return
    try {
      const res = await apiFetch('/api/onboarding/state')
      if (!res.ok) return
      const data = await res.json()
      setOnboardingState(data)

      // If the user just configured their API key elsewhere and came back,
      // auto-create + open the welcome conversation now.
      if (data.step !== 'done' && data.has_api_key && !onboardingAutoOpenedRef.current) {
        onboardingAutoOpenedRef.current = true
        let convoId = data.welcome_convo_id
        if (!convoId) {
          try {
            const createRes = await apiFetch('/api/onboarding/welcome', { method: 'POST' })
            if (createRes.ok) {
              const created = await createRes.json()
              convoId = created.welcome_convo_id
              setOnboardingState((prev) => prev ? { ...prev, welcome_convo_id: convoId, step: 'in_progress' } : prev)
              try {
                const convos = await api.getConversations(currentUser?.id)
                setConversations(convos)
              } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        }
        if (convoId) setCurrentConversation(convoId)
      }
    } catch { /* ignore */ }
  }, [currentUser?.id])

  // Re-fetch onboarding state when the tab regains focus or the user comes
  // back from Settings → Providers — so the welcome card disappears as soon
  // as the key lands in UserSettings.provider_keys.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshOnboardingState()
    }
    window.addEventListener('focus', refreshOnboardingState)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', refreshOnboardingState)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refreshOnboardingState])

  const skipOnboarding = async () => {
    try {
      await apiFetch('/api/onboarding/skip', { method: 'POST' })
      setOnboardingState((prev) => prev ? { ...prev, step: 'done' } : prev)
    } catch { /* ignore */ }
  }

  // ─── Conversation operations ───────────────────────────────────────
  const handleDeleteConversation = async (id: number, confirm: boolean) => {
    if (!confirm) { setDeletingId(null); return }
    try {
      await api.deleteConversation(id)
      setConversations(conversations.filter(c => c.id !== id))
      if (currentConversation === id) { setCurrentConversation(null); setMessages([]) }
    } catch (err) { console.error('Delete error:', err) }
    finally { setDeletingId(null) }
  }

  const handleStartEditing = (convo: any) => { setEditingTitleId(convo.id); setEditTitleValue(convo.title) }

  const handleSaveTitle = async (id: number) => {
    const newTitle = editTitleValue.trim()
    if (!newTitle) { setEditingTitleId(null); return }
    try {
      await api.updateConversation(id, { title: newTitle })
      setConversations(conversations.map(c => c.id === id ? { ...c, title: newTitle } : c))
    } catch (err) { console.error('Update title error:', err) }
    finally { setEditingTitleId(null) }
  }

  const handleCancelEdit = () => { setEditingTitleId(null); setEditTitleValue('') }

  const generateTitleForConversation = useCallback(async (conversationId: number, userMessage: string) => {
    if (hasGeneratedTitle.has(conversationId)) return
    try {
      const result = await api.generateTitle(conversationId, selectedProvider, selectedModel)
      const newTitle = result.title || userMessage.substring(0, 50).trim()
      setConversations(useStore.getState().conversations.map(c => c.id === conversationId ? { ...c, title: newTitle } : c))
      const updatedSet = new Set(hasGeneratedTitle); updatedSet.add(conversationId)
      setHasGeneratedTitle(updatedSet)
      localStorage.setItem('gungnir_titles_generated', JSON.stringify([...updatedSet]))
    } catch (err) { console.error('Auto-title generation error:', err) }
  }, [hasGeneratedTitle])

  // ─── Model loading ─────────────────────────────────────────────────
  useEffect(() => {
    if (!config?.providers) return
    const initialMap: Record<string, string[]> = {}
    Object.entries(config.providers).forEach(([name, p]) => {
      const prov = p as any
      if ((prov.enabled || prov.has_api_key) && prov.models?.length > 0) initialMap[name] = prov.models
    })
    if (Object.keys(initialMap).length > 0) setProviderModelsMap(initialMap)

    const enabledNames = Object.entries(config.providers).filter(([, p]) => (p as any).enabled || (p as any).has_api_key).map(([name]) => name)
    Promise.all(
      enabledNames.map(async (name) => {
        try { const res = await apiFetch(`/api/models/${name}`); const data = await res.json(); return { name, models: (data.models || []) as string[] } }
        catch { return { name, models: [] } }
      })
    ).then(results => {
      setProviderModelsMap(prev => {
        const next = { ...prev }
        results.forEach(({ name, models }) => { if (models.length > 0) next[name] = models })
        return next
      })
    })
  }, [config])

  const groupedProviders = Object.entries(providerModelsMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, models]) => {
      const defaultModel = (config?.providers?.[name] as any)?.default_model as string | undefined
      const sorted = [...models].sort((a, b) => a.localeCompare(b))
      const filtered = modelSearch.trim() ? sorted.filter(m => m.toLowerCase().includes(modelSearch.toLowerCase())) : sorted
      return { name, models: filtered, allModels: sorted, defaultModel }
    })
    .filter(p => p.allModels.length > 0)

  useEffect(() => {
    api.getPersonalities().then((data: any) => {
      if (Array.isArray(data)) setPersonalities(data)
      else if (data && Array.isArray(data.personalities)) setPersonalities(data.personalities)
      const list = Array.isArray(data) ? data : (data?.personalities || [])
      const active = list.find((p: any) => p.active)
      if (active) setActivePersonality(active.name)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    api.getSkills().then((data: any) => {
      const list = Array.isArray(data) ? data : []
      setAllSkills(list)
      setFavoriteSkills(list.filter((s: any) => s.is_favorite))
      // Check active skill
      api.getActiveSkill().then((res: any) => {
        if (res?.skill) setActiveSkill(res.skill.name || res.skill)
      }).catch(() => {})
    }).catch(() => {})
  }, [])

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => {
    if (!currentConversation) return
    if (skipLoadForRef.current === currentConversation) {
      skipLoadForRef.current = null
      return
    }
    loadMessages()
  }, [currentConversation])
  useEffect(() => {
    const totalMsgs = messages.length
    const totalTokens = messages.reduce((acc, m) => acc + (m.content.length / 4), 0)
    setStats({ tokens: Math.round(totalTokens), messages: totalMsgs, cost: totalTokens * 0.00001 })
  }, [messages])

  const loadMessages = async () => {
    if (!currentConversation) return
    try { const msgs = await api.getMessages(currentConversation); setMessages(msgs) }
    catch (err) { console.error('Load messages error:', err) }
  }

  // ─── Automata tab helpers ──────────────────────────────────────────
  const automataFetch = async (path: string) => {
    const token = localStorage.getItem('gungnir_auth_token')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`/api/plugins/scheduler${path}`, { headers })
    if (!res.ok) return null
    return res.json()
  }
  const loadAutomataTasks = useCallback(async () => {
    const data = await automataFetch('/tasks')
    if (data) setAutomataTasks(data.tasks || [])
  }, [])
  const loadAutomataHistory = useCallback(async (taskId: string) => {
    const data = await automataFetch(`/tasks/${taskId}/history`)
    if (data) setAutomataHistory(data.entries || [])
  }, [])
  useEffect(() => {
    if (sidebarTab === 'automata') loadAutomataTasks()
  }, [sidebarTab, loadAutomataTasks])
  useEffect(() => {
    if (activeAutomataTaskId) loadAutomataHistory(activeAutomataTaskId)
    else setAutomataHistory([])
  }, [activeAutomataTaskId, loadAutomataHistory])

  const activeAutomataTask = activeAutomataTaskId
    ? automataTasks.find(t => t.id === activeAutomataTaskId) || null
    : null

  const handleNewChat = async () => {
    try {
      const payload = { title: 'Nouveau chat', provider: selectedProvider, model: selectedModel || 'mistralai/mistral-large', user_id: currentUser?.id }
      const newConvo = await api.createConversation(payload)
      // Si un dossier précis est filtré, la nouvelle conversation y atterrit automatiquement
      const targetFolder = typeof folderFilter === 'number' ? folderFilter : null
      if (targetFolder !== null && newConvo.id) {
        try { await api.moveConversationToFolder(newConvo.id, targetFolder) } catch { /* ignore */ }
      }
      const fullConvo = {
        ...payload,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...newConvo,
        folder_id: targetFolder,
      }
      setConversations([fullConvo, ...conversations])
      skipLoadForRef.current = fullConvo.id
      setCurrentConversation(fullConvo.id)
      setMessages([])
    } catch (err) { console.error('New chat error:', err) }
  }

  const handleNewChatWithSummary = async (summary: string) => {
    try {
      const payload = { title: 'Suite de conversation', provider: selectedProvider, model: selectedModel || 'mistralai/mistral-large', user_id: currentUser?.id }
      const newConvo = await api.createConversation(payload)
      const targetFolder = typeof folderFilter === 'number' ? folderFilter : null
      if (targetFolder !== null && newConvo.id) {
        try { await api.moveConversationToFolder(newConvo.id, targetFolder) } catch { /* ignore */ }
      }
      const fullConvo = {
        ...payload,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...newConvo,
        folder_id: targetFolder,
      }
      setConversations([fullConvo, ...conversations])
      skipLoadForRef.current = fullConvo.id
      setCurrentConversation(fullConvo.id)
      setMessages([])
      setInput(`Voici le résumé de notre conversation précédente pour contexte :\n\n${summary}\n\nOn peut continuer à partir de là.`)
    } catch (err) { console.error('New chat with summary error:', err) }
  }

  const handleSend = async () => {
    if ((!input.trim() && attachedFiles.length === 0) || isLoading) return

    // Auto-create conversation if none selected
    let convoId: number | null = currentConversation
    if (!convoId) {
      try {
        const payload = { title: 'Nouveau chat', provider: selectedProvider, model: selectedModel || 'mistralai/mistral-large', user_id: currentUser?.id }
        const newConvo = await api.createConversation(payload)
        const targetFolder = typeof folderFilter === 'number' ? folderFilter : null
        if (targetFolder !== null && newConvo.id) {
          try { await api.moveConversationToFolder(newConvo.id, targetFolder) } catch { /* ignore */ }
        }
        const fullConvo = {
          ...payload,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...newConvo,
          folder_id: targetFolder,
        }
        setConversations([fullConvo, ...conversations])
        skipLoadForRef.current = fullConvo.id
        setCurrentConversation(fullConvo.id)
        convoId = fullConvo.id
      } catch (err) {
        console.error('Auto-create conversation error:', err)
        return
      }
    }

    const userMessage = input.trim()
    const currentImages = attachedFiles.filter(f => f.type.startsWith('image/')).map(f => f.dataUrl)
    const currentDocs = attachedFiles.filter(f => !f.type.startsWith('image/'))
    // Pour les documents non-image, ajouter le contenu texte au message
    let fullMessage = userMessage
    if (currentDocs.length > 0) {
      const docTexts = currentDocs.map(d => {
        // Pour les fichiers texte, extraire le contenu base64
        if (d.type.startsWith('text/') || d.type === 'application/json') {
          try {
            const b64 = d.dataUrl.split(',')[1]
            return `\n\n--- Fichier: ${d.name} ---\n${atob(b64)}\n--- Fin ${d.name} ---`
          } catch { return '' }
        }
        return `\n[Fichier joint: ${d.name} (${d.type})]`
      })
      fullMessage += docTexts.join('')
    }
    setInput('')
    setAttachedFiles([])
    setLoading(true)
    setLoadingConvoId(convoId)
    // Afficher le message user avec miniatures des images jointes
    const displayContent = currentImages.length > 0
      ? userMessage + currentImages.map(() => '\n[Image jointe]').join('')
      : fullMessage
    addMessage({ id: Date.now(), role: 'user', content: displayContent, created_at: new Date().toISOString(), images: currentImages })
    try {
      const response = await api.chat(convoId!, {
        message: fullMessage, provider: selectedProvider, model: selectedModel,
        ...(currentImages.length > 0 ? { images: currentImages } : {}),
      })
      // Read the live current conversation — the user may have switched
      // chats while we were awaiting. If so, the response is already saved
      // server-side and we must NOT append it to the local messages array
      // (which now belongs to a different conversation).
      const stillOnSameConvo = useStore.getState().currentConversation === convoId
      if (response.error) {
        if (stillOnSameConvo) {
          addMessage({ id: Date.now() + 1, role: 'assistant', content: `[Erreur: ${response.error}]`, created_at: new Date().toISOString() })
        }
      } else {
        if (stillOnSameConvo) {
          addMessage({
            id: Date.now() + 1, role: 'assistant', content: response.content,
            created_at: new Date().toISOString(),
            model: response.model, provider: response.provider,
            tokens_input: response.tokens_input, tokens_output: response.tokens_output,
          })
        }
        // If agent switched provider/model, update the frontend selection
        if (response.switch_provider) {
          const sw = response.switch_provider
          if (sw.provider) setSelectedProvider(sw.provider)
          if (sw.model) setSelectedModel(sw.model)
        }
      }
      // Générer le titre après le 2e message user (pas le 1er — trop tôt pour identifier le sujet)
      // Only if we're still on the convo that just sent — otherwise `messages`
      // refers to a different conversation and the count is meaningless.
      if (stillOnSameConvo) {
        const userMsgCount = messages.filter(m => m.role === 'user').length + 1 // +1 pour celui qu'on vient d'envoyer
        if (userMsgCount === 2 && !hasGeneratedTitle.has(convoId!)) {
          generateTitleForConversation(convoId!, userMessage)
        }
      }
      // If we were in the welcome chat, re-fetch onboarding state so the UI
      // reflects the "done" flag as soon as finalize_onboarding has fired.
      if (onboardingState && onboardingState.step !== 'done' && onboardingState.welcome_convo_id === convoId) {
        try {
          const res = await apiFetch('/api/onboarding/state')
          if (res.ok) {
            const data = await res.json()
            setOnboardingState(data)
          }
        } catch { /* ignore */ }
      }
    } catch (err) { console.error('Chat error:', err) }
    setLoading(false)
    setLoadingConvoId(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const formatModelName = (modelId: string) => { if (!modelId) return '—'; const parts = modelId.split('/'); return parts[parts.length - 1] || modelId }
  const formatCost = (cost: number) => `$${cost.toFixed(4)}`
  const filteredConversations = conversations.filter(c => {
    if (!(c.title || '').toLowerCase().includes(searchQuery.toLowerCase())) return false
    if (folderFilter === 'all') return true
    if (folderFilter === null) return !c.folder_id
    return c.folder_id === folderFilter
  })

  return (
    <div className="flex h-full" style={{ background: 'var(--bg-primary)' }}>

      {/* ── CHAT SIDEBAR ── */}
      <aside className={`flex-shrink-0 flex flex-col transition-all duration-300 ease-in-out ${isSidebarCollapsed ? 'w-16' : 'w-[280px]'}`}
        style={{ background: 'var(--bg-primary)', borderRight: '1px solid var(--border-subtle)' }}>
        <div className={`flex flex-col h-full ${isSidebarCollapsed ? 'items-center px-2' : ''}`}>
          <div className={`flex items-center justify-between ${isSidebarCollapsed ? 'px-2 py-4' : 'px-4 py-4'}`} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            {!isSidebarCollapsed ? (
              <>
                <div className="flex items-center gap-2">
                  <AgentAvatar size={28} />
                  <span className="font-bold text-base tracking-wide gradient-text" style={{ color: 'var(--text-primary)' }}>{agentName.toUpperCase()}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={handleNewChat} className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors" style={{ color: 'var(--text-muted)' }} title={t('chat.newChat')}>
                    <Plus className="w-4 h-4" />
                  </button>
                  <button onClick={toggleSidebar} className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors" style={{ color: 'var(--text-muted)' }} title={`${t('nav.collapse')} (Ctrl+B)`}>
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                </div>
              </>
            ) : (
              <button onClick={toggleSidebar} className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }} title="Ouvrir (Ctrl+B)">
                <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
              </button>
            )}
          </div>

          {!isSidebarCollapsed && (
            <>
              <div className="px-3 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                    placeholder={t('chat.search')} className="flex-1 bg-transparent text-sm placeholder-[#555] outline-none" style={{ color: 'var(--text-primary)' }} />
                </div>
              </div>

              {/* Tabs: Chats / Automata */}
              <div className="px-3 pt-2 pb-1 flex gap-1">
                <button onClick={() => { setSidebarTab('chats'); setActiveAutomataTaskId(null) }}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                  style={sidebarTab === 'chats'
                    ? { background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }
                    : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid transparent' }}>
                  <MessageSquare className="w-3 h-3" /> Chats
                </button>
                <button onClick={() => setSidebarTab('automata')}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                  style={sidebarTab === 'automata'
                    ? { background: 'color-mix(in srgb, var(--scarlet) 14%, transparent)', color: 'var(--accent-primary-light)', border: '1px solid color-mix(in srgb, var(--scarlet) 30%, transparent)' }
                    : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid transparent' }}>
                  <Calendar className="w-3 h-3" /> Automata
                </button>
              </div>

              <div className="flex-1 overflow-y-auto py-2" style={{ display: sidebarTab === 'chats' ? undefined : 'none' }}>
                {/* Dossiers */}
                <div className="px-3 py-1 mb-1 flex items-center justify-between">
                  <button onClick={toggleFoldersCollapsed}
                    className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest transition-colors"
                    style={{ color: 'var(--text-muted)' }} title={foldersCollapsed ? 'Déplier' : 'Replier'}>
                    <ChevronRight className="w-3 h-3 transition-transform" style={{ transform: foldersCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }} />
                    Dossiers
                    {folders.length > 0 && <span className="ml-1 normal-case tracking-normal">({folders.length})</span>}
                  </button>
                  <button onClick={handleCreateFolder} className="p-0.5 rounded transition-colors" title="Nouveau dossier" style={{ color: 'var(--text-muted)' }}>
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
                <div className="px-2 mb-2 space-y-0.5" style={{ display: foldersCollapsed ? 'none' : undefined }}>
                  <button onClick={() => setFolderFilter('all')}
                    className="w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors"
                    style={{ background: folderFilter === 'all' ? 'var(--bg-elevated)' : undefined, color: folderFilter === 'all' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    <MessageSquare className="w-3 h-3" /> Toutes
                    <span className="ml-auto text-[9px]">{conversations.length}</span>
                  </button>
                  <div
                    onDragEnter={(e) => { e.preventDefault() }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropTargetFolder !== 'none') setDropTargetFolder('none') }}
                    onDragLeave={(e) => { if (e.currentTarget === e.target) setDropTargetFolder(undefined) }}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const id = draggedConvoRef.current ?? (Number(e.dataTransfer.getData('text/plain')) || null); if (id !== null) handleDropOnFolder(id, null); draggedConvoRef.current = null; setDropTargetFolder(undefined); setDraggedConvoId(null) }}
                    onClick={() => setFolderFilter(null)}
                    role="button"
                    className="w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors cursor-pointer"
                    style={{
                      background: dropTargetFolder === 'none' ? 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' : folderFilter === null ? 'var(--bg-elevated)' : undefined,
                      border: dropTargetFolder === 'none' ? '1px dashed var(--accent-primary)' : '1px solid transparent',
                      color: folderFilter === null ? 'var(--text-primary)' : 'var(--text-muted)'
                    }}>
                    <FolderMinus className="w-3 h-3 pointer-events-none" /> <span className="pointer-events-none">Sans dossier</span>
                  </div>
                  {folders.map(f => {
                    const isDropTarget = dropTargetFolder === f.id
                    return (
                      <div key={f.id} className="group/folder flex items-center">
                        <div
                          onDragEnter={(e) => { e.preventDefault() }}
                          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropTargetFolder !== f.id) setDropTargetFolder(f.id) }}
                          onDragLeave={(e) => { if (e.currentTarget === e.target) setDropTargetFolder(undefined) }}
                          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const id = draggedConvoRef.current ?? (Number(e.dataTransfer.getData('text/plain')) || null); if (id !== null) handleDropOnFolder(id, f.id); draggedConvoRef.current = null; setDropTargetFolder(undefined); setDraggedConvoId(null) }}
                          onClick={() => setFolderFilter(f.id)}
                          role="button"
                          className="flex-1 flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors min-w-0 cursor-pointer"
                          style={{
                            background: isDropTarget ? 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' : folderFilter === f.id ? 'var(--bg-elevated)' : undefined,
                            border: isDropTarget ? '1px dashed var(--accent-primary)' : '1px solid transparent',
                            color: folderFilter === f.id ? 'var(--text-primary)' : 'var(--text-muted)'
                          }}>
                          <Folder className="w-3 h-3 flex-shrink-0 pointer-events-none" style={{ color: f.color || 'var(--accent-primary)' }} />
                          <span className="truncate pointer-events-none">{f.name}</span>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteFolder(f.id) }}
                          className="opacity-0 group-hover/folder:opacity-100 px-1 transition-opacity" title="Supprimer"
                          style={{ color: 'var(--text-muted)' }}>
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )
                  })}
                </div>

                <div className="px-3 py-1 mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Conversations</span>
                </div>
                {filteredConversations.map(convo => {
                  const isActive = currentConversation === convo.id
                  const isEditing = editingTitleId === convo.id
                  const isDragging = draggedConvoId === convo.id
                  return (
                    <div key={convo.id} onClick={() => !isEditing && setCurrentConversation(convo.id)}
                      draggable={!isEditing}
                      onDragStart={(e) => { draggedConvoRef.current = convo.id; setDraggedConvoId(convo.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(convo.id)) }}
                      onDragEnd={() => { draggedConvoRef.current = null; setDraggedConvoId(null); setDropTargetFolder(undefined) }}
                      className="group mx-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all mb-0.5 flex items-center justify-between"
                      style={{
                        background: isEditing ? 'var(--border)' : isActive ? 'var(--bg-elevated)' : undefined,
                        border: isEditing ? '1px solid var(--border)' : undefined,
                        opacity: isDragging ? 0.4 : 1,
                      }}>
                      <div className="flex-1 min-w-0">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <input type="text" value={editTitleValue} onChange={e => setEditTitleValue(e.target.value)}
                              className="flex-1 text-sm rounded px-2 py-1 outline-none" autoFocus
                              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                              onClick={e => e.stopPropagation()}
                              onKeyDown={e => { if (e.key === 'Enter') handleSaveTitle(convo.id); if (e.key === 'Escape') handleCancelEdit() }} />
                            <button onClick={(e) => { e.stopPropagation(); handleSaveTitle(convo.id) }} className="p-0.5" style={{ color: 'var(--accent-success)' }}><Check className="w-3 h-3" /></button>
                            <button onClick={(e) => { e.stopPropagation(); handleCancelEdit() }} className="p-0.5" style={{ color: 'var(--accent-primary)' }}><X className="w-3 h-3" /></button>
                          </div>
                        ) : (
                          <>
                            <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{convo.title}</div>
                            <div className="text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{formatModelName(convo.model)}</div>
                          </>
                        )}
                      </div>
                      {!isEditing && (
                        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>$0.000</span>
                          <ConversationMenu conversationId={convo.id} conversationTitle={convo.title}
                            provider={selectedProvider} model={selectedModel}
                            onTitleUpdated={(id, title) => setConversations(conversations.map(c => c.id === id ? { ...c, title } : c))}
                            onDelete={(id) => handleDeleteConversation(id, true)}
                            onStartEdit={() => handleStartEditing(convo)}
                            onNewChatWithSummary={handleNewChatWithSummary}
                            onFolderChanged={reloadConversations} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Automata tab: task list */}
              <div className="flex-1 overflow-y-auto py-2" style={{ display: sidebarTab === 'automata' ? undefined : 'none' }}>
                <div className="px-3 py-1 mb-1 flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Tâches planifiées</span>
                  <button onClick={loadAutomataTasks} title="Rafraîchir"
                    className="p-0.5 rounded transition-colors" style={{ color: 'var(--text-muted)' }}>
                    <span style={{ fontSize: 11 }}>↻</span>
                  </button>
                </div>
                {automataTasks.length === 0 ? (
                  <div className="mx-3 mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    Aucune tâche encore. Va sur la page Automata ou demande à l'agent d'en créer une.
                  </div>
                ) : (
                  automataTasks.map(task => {
                    const isActive = activeAutomataTaskId === task.id
                    const schedule = task.task_type === 'cron' ? task.cron_expression
                      : task.task_type === 'interval' ? `toutes les ${task.interval_seconds}s`
                      : task.run_at || '—'
                    return (
                      <div key={task.id} onClick={() => setActiveAutomataTaskId(task.id)}
                        className="mx-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all mb-0.5"
                        style={{
                          background: isActive ? 'color-mix(in srgb, var(--scarlet) 14%, transparent)' : undefined,
                          border: isActive ? '1px solid color-mix(in srgb, var(--scarlet) 30%, transparent)' : '1px solid transparent',
                        }}>
                        <div className="flex items-center gap-2">
                          <Calendar className="w-3.5 h-3.5 flex-shrink-0" style={{ color: task.enabled ? 'var(--accent-primary-light)' : 'var(--text-muted)' }} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{task.name}</div>
                            <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                              {schedule} · {task.run_count || 0} run{(task.run_count || 0) > 1 ? 's' : ''}
                            </div>
                          </div>
                          {!task.enabled && <Pause className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              <div className="p-3 space-y-1" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <div className="flex items-center justify-between text-xs px-1" style={{ color: 'var(--text-muted)' }}>
                  <span>{t('chat.tokensUsed')}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{stats.tokens > 999 ? `${(stats.tokens/1000).toFixed(1)}K` : stats.tokens}</span>
                </div>
                <div className="flex items-center justify-between text-xs px-1" style={{ color: 'var(--text-muted)' }}>
                  <span>{t('chat.sessionCost')}</span>
                  <span style={{ color: 'var(--accent-success)' }}>{formatCost(stats.cost)}</span>
                </div>
              </div>
            </>
          )}

          {isSidebarCollapsed && (
            <div className="flex-1 flex flex-col items-center justify-center py-4">
              <button onClick={handleNewChat} className="w-10 h-10 rounded-lg flex items-center justify-center transition-colors"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-muted)' }} title={t('chat.newChat')}>
                <Plus className="w-5 h-5" />
              </button>
              <div className="mt-8 space-y-3">
                {filteredConversations.slice(0, 3).map(convo => {
                  const initial = convo.title.charAt(0).toUpperCase() || '?'
                  return (
                    <button key={convo.id} onClick={() => setCurrentConversation(convo.id)} title={convo.title}
                      className="w-10 h-10 rounded-lg flex items-center justify-center font-medium text-sm transition-all"
                      style={currentConversation === convo.id
                        ? { background: 'linear-gradient(to right, var(--scarlet), var(--ember))', color: 'var(--text-primary)' }
                        : { background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                      {initial}
                    </button>
                  )
                })}
              </div>
              <div className="mt-auto mb-4">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: 'linear-gradient(to right, var(--scarlet), var(--ember))' }} />
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* ── MAIN CHAT ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center justify-between px-5 py-3" style={{ background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <AgentIcon size={14} />
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{formatModelName(selectedModel)}</span>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
              style={{ background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', color: 'var(--accent-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 25%, transparent)' }}>
              {selectedProvider}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Personality dropdown */}
            <div className="relative">
              <button onClick={() => setShowPersonaMenu(!showPersonaMenu)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                <Bot className="w-3.5 h-3.5" /><span className="capitalize">{activePersonality}</span>
                <ChevronDown className={`w-3 h-3 transition-transform ${showPersonaMenu ? 'rotate-180' : ''}`} />
              </button>
              {showPersonaMenu && (
                <div className="absolute top-full right-0 mt-1 w-56 rounded-xl shadow-2xl z-50 p-1.5" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div className="text-[9px] font-bold uppercase tracking-widest px-2 py-1 mb-1" style={{ color: 'var(--text-muted)' }}>Personnalité <span style={{ opacity: 0.5 }}>(glisser pour réordonner)</span></div>
                  {personalities.map((p: any, idx: number) => (
                    <div key={p.name}
                      draggable
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)) }}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                      onDrop={async (e) => {
                        e.preventDefault()
                        const fromIdx = Number(e.dataTransfer.getData('text/plain'))
                        if (isNaN(fromIdx) || fromIdx === idx) return
                        const reordered = [...personalities]
                        const [moved] = reordered.splice(fromIdx, 1)
                        reordered.splice(idx, 0, moved)
                        setPersonalities(reordered)
                        await api.reorderPersonalities(reordered.map((pp: any) => pp.name))
                      }}
                      onClick={async () => {
                        await api.setPersonality(p.name); setActivePersonality(p.name)
                        setPersonalities(prev => prev.map(pp => ({ ...pp, active: pp.name === p.name }))); setShowPersonaMenu(false)
                      }}
                      className="w-full text-left px-3 py-2 rounded-lg text-xs transition-colors flex items-center gap-2 cursor-grab active:cursor-grabbing"
                      style={p.active || p.name === activePersonality
                        ? { background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', color: 'var(--accent-primary-light)' }
                        : { color: 'var(--text-secondary)' }}>
                      <GripVertical className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
                      <Bot className="w-3 h-3 flex-shrink-0" /><span className="capitalize">{p.name}</span>
                      <span className="ml-auto text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{p.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button onClick={toggleTaskPanel} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
              style={{
                background: showTaskPanel ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'var(--bg-secondary)',
                border: `1px solid ${showTaskPanel ? 'color-mix(in srgb, var(--accent-primary) 30%, transparent)' : 'var(--border)'}`,
                color: showTaskPanel ? 'var(--accent-primary-light, var(--accent-primary))' : 'var(--text-secondary)',
              }}
              title="Todo-list de la conversation">
              <ListTodo className="w-3.5 h-3.5" /> Tâches
            </button>
            <button onClick={() => setShowApiKeysModal(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
              <Key className="w-3.5 h-3.5" /> {t('common.apiKeys')}
            </button>
            <button onClick={() => setShowUserModal(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
              {currentUser ? (
                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold"
                  style={{ background: 'linear-gradient(to bottom right, var(--scarlet), var(--ember))', color: 'var(--text-primary)' }}>
                  {currentUser.display_name?.charAt(0)?.toUpperCase() || 'U'}
                </div>
              ) : <User className="w-3.5 h-3.5" />}
              {currentUser?.display_name || t('common.user')}
            </button>
          </div>
        </div>

        {/* Automata task view — read-only history shown when a task is picked in the sidebar */}
        {activeAutomataTaskId && activeAutomataTask && (
          <AutomataTaskView
            task={activeAutomataTask}
            history={automataHistory}
            onRefresh={() => loadAutomataHistory(activeAutomataTaskId)}
            onClose={() => setActiveAutomataTaskId(null)}
            onToggle={async () => {
              const token = localStorage.getItem('gungnir_auth_token')
              const headers: Record<string, string> = { 'Content-Type': 'application/json' }
              if (token) headers['Authorization'] = `Bearer ${token}`
              await fetch(`/api/plugins/scheduler/tasks/${activeAutomataTaskId}/toggle`, { method: 'POST', headers })
              loadAutomataTasks()
            }}
            onRunNow={async () => {
              const token = localStorage.getItem('gungnir_auth_token')
              const headers: Record<string, string> = { 'Content-Type': 'application/json' }
              if (token) headers['Authorization'] = `Bearer ${token}`
              await fetch(`/api/plugins/scheduler/tasks/${activeAutomataTaskId}/run`, { method: 'POST', headers })
              setTimeout(() => loadAutomataHistory(activeAutomataTaskId), 1500)
            }}
          />
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-6 space-y-4" style={{ display: activeAutomataTaskId ? 'none' : undefined }}>
          {messages.length === 0 && onboardingState && onboardingState.step !== 'done' && !onboardingState.has_api_key && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 rounded-2xl mb-5 flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--scarlet) 18%, transparent), color-mix(in srgb, var(--ember) 12%, transparent))' }}>
                <AgentIcon size={32} />
              </div>
              <h3 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Bienvenue sur Gungnir&nbsp;👋</h3>
              <p className="text-sm max-w-md mb-6" style={{ color: 'var(--text-secondary)' }}>
                Avant qu'on puisse vraiment discuter, il me faut <strong>une clé API</strong> pour te parler. Ça prend 2 minutes : tu choisis un provider (OpenRouter est le plus simple), tu colles ta clé, tu reviens ici et on fait connaissance.
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => navigate('/settings?tab=providers')}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                  style={{
                    background: 'linear-gradient(135deg, var(--scarlet), var(--ember))',
                    color: '#fff',
                    border: '1px solid color-mix(in srgb, var(--scarlet) 40%, transparent)',
                  }}
                >
                  Configurer ma clé API →
                </button>
                <button
                  onClick={skipOnboarding}
                  className="px-4 py-2 rounded-xl text-xs transition-colors hover:opacity-80"
                  style={{ color: 'var(--text-muted)', background: 'transparent', border: '1px solid var(--border)' }}
                >
                  Passer l'onboarding
                </button>
              </div>
              <p className="text-[10px] mt-5 max-w-md" style={{ color: 'var(--text-muted)' }}>
                Une fois la clé configurée, reviens ici : un chat de bienvenue s'ouvrira automatiquement pour que tu puisses me façonner (mon nom, ma personnalité, ta préférence de tutoiement, etc.).
              </p>
            </div>
          )}

          {messages.length === 0 && (!onboardingState || onboardingState.step === 'done' || onboardingState.has_api_key) && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 rounded-2xl mb-5 flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--scarlet) 12%, transparent), color-mix(in srgb, var(--ember) 8%, transparent))' }}>
                <AgentIcon size={32} />
              </div>
              <h3 className="text-lg font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>{t('chat.helpIntro')}</h3>
              <p className="text-sm max-w-sm mb-6" style={{ color: 'var(--text-muted)' }}>{agentName}{t('chat.helpDesc')}</p>
              <div className="flex flex-wrap gap-2 justify-center max-w-md">
                {[t('chat.codeHelp'), t('chat.explainConcept'), t('chat.writeText'), t('chat.analyzeData')].map((s, i) => (
                  <button key={i} onClick={() => setInput(s)} className="px-3 py-1.5 rounded-lg text-xs transition-colors"
                    style={{ color: 'var(--text-secondary)', background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className={`flex gap-3 animate-fade-in ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
              {msg.role === 'assistant' ? (
                <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                  style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--scarlet) 10%, var(--bg-primary)), color-mix(in srgb, var(--scarlet) 15%, var(--bg-primary)))', border: '1px solid color-mix(in srgb, var(--scarlet) 20%, transparent)' }}>
                  <AgentIcon size={14} />
                </div>
              ) : currentUser?.avatar_url ? (
                <img src={currentUser.avatar_url} alt={currentUser.display_name || 'User'} className="w-8 h-8 rounded-full flex-shrink-0 mt-0.5 object-cover" style={{ border: '1px solid var(--border)' }} />
              ) : (
                <div className="w-8 h-8 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center text-xs font-bold"
                  style={{ background: 'linear-gradient(to bottom right, var(--scarlet), var(--ember))', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
                  {currentUser?.display_name?.charAt(0)?.toUpperCase() || 'U'}
                </div>
              )}

              <div className={`flex flex-col gap-1 max-w-[70%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`flex items-center gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                  <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
                    {msg.role === 'user' ? (currentUser?.display_name || t('common.user')) : formatModelName((msg as any).model || selectedModel)}
                  </span>
                  {msg.role === 'assistant' && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide"
                      style={{ background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)', color: 'var(--accent-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 15%, transparent)' }}>
                      {(msg as any).provider || selectedProvider}
                    </span>
                  )}
                </div>

                {msg.role === 'assistant' && (msg as any).tool_events?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-1">
                    {(msg as any).tool_events.map((evt: any, i: number) => (
                      <div key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
                        style={{
                          background: evt.result?.ok !== false ? 'color-mix(in srgb, var(--accent-success) 8%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 8%, transparent)',
                          border: `1px solid ${evt.result?.ok !== false ? 'color-mix(in srgb, var(--accent-success) 20%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 20%, transparent)'}`,
                          color: evt.result?.ok !== false ? 'var(--accent-success)' : 'var(--accent-danger, var(--accent-primary-light))',
                        }}>
                        <Sparkles className="w-2.5 h-2.5 flex-shrink-0" /><span>{evt.tool}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className={`group relative rounded-2xl px-4 py-3 text-sm leading-relaxed ${msg.role === 'user' ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}
                  style={msg.role === 'assistant' ? {
                    background: 'linear-gradient(135deg, color-mix(in srgb, var(--scarlet) 4%, transparent), color-mix(in srgb, var(--ember) 2%, transparent))',
                    border: '1px solid color-mix(in srgb, var(--scarlet) 10%, transparent)', color: 'var(--text-primary)',
                  } : { background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                  {/* Bouton de copie flottant (sticky en haut, apparait au survol) */}
                  <FloatingCopyButton
                    content={msg.content.replace(/\n\[Image jointe\]/g, '')}
                    side={msg.role === 'user' ? 'left' : 'right'}
                  />
                  {/* Images jointes */}
                  {msg.images && msg.images.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {msg.images.map((img: string, i: number) => (
                        <img key={i} src={img} alt={`Image ${i + 1}`} className="max-h-48 rounded-lg border border-[var(--border)] cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => window.open(img, '_blank')} />
                      ))}
                    </div>
                  )}
                  <MessageContent content={msg.content.replace(/\n\[Image jointe\]/g, '')} />
                </div>
              </div>
            </div>
          ))}

          {loadingConvoId === currentConversation && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--scarlet) 10%, var(--bg-primary)), color-mix(in srgb, var(--scarlet) 15%, var(--bg-primary)))', border: '1px solid color-mix(in srgb, var(--scarlet) 20%, transparent)' }}>
                <AgentIcon size={14} />
              </div>
              <div className="rounded-2xl px-4 py-3 text-sm rounded-tl-sm"
                style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--scarlet) 4%, transparent), color-mix(in srgb, var(--ember) 2%, transparent))', border: '1px solid color-mix(in srgb, var(--scarlet) 10%, transparent)' }}>
                <div className="flex gap-1.5">
                  <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: 'color-mix(in srgb, var(--accent-primary) 60%, transparent)', animationDelay: '0ms' }} />
                  <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: 'color-mix(in srgb, var(--accent-primary) 60%, transparent)', animationDelay: '150ms' }} />
                  <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: 'color-mix(in srgb, var(--accent-primary) 60%, transparent)', animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="px-5 py-4" style={{ background: 'var(--bg-primary)', borderTop: '1px solid var(--border-subtle)', display: activeAutomataTaskId ? 'none' : undefined }}>
          <div className="flex items-end gap-3 max-w-4xl mx-auto">
            <div className="relative">
              <button onClick={() => setShowModelMenu(!showModelMenu)}
                className="flex items-center gap-1.5 px-3 rounded-xl text-xs transition-colors whitespace-nowrap"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', height: '44px' }}>
                <AgentIcon size={12} /><span>{formatModelName(selectedModel)}</span>
                <ChevronDown className={`w-3 h-3 transition-transform ${showModelMenu ? 'rotate-180' : ''}`} />
              </button>
              {showModelMenu && (
                <div className="absolute bottom-full left-0 mb-2 w-80 rounded-xl shadow-2xl z-50 max-h-80 flex flex-col"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div className="p-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <input type="text" value={modelSearch} onChange={e => setModelSearch(e.target.value)}
                      placeholder="Rechercher un modèle..." className="w-full rounded-lg px-3 py-1.5 text-xs placeholder-[#555] outline-none"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  </div>
                  <div className="overflow-y-auto p-1.5">
                    {/* Favoris */}
                    {favoriteModels.length > 0 && !modelSearch.trim() && (
                      <div className="mb-2 pb-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <div className="px-2 py-1 text-[9px] font-bold uppercase tracking-widest flex items-center gap-1" style={{ color: 'var(--accent-tertiary)' }}>
                          <Star className="w-2.5 h-2.5" /> Favoris
                        </div>
                        {favoriteModels.map(fav => {
                          const [prov, mod] = fav.split('::')
                          return (
                            <button key={fav} onClick={() => { setSelectedModel(mod); setSelectedProvider(prov); setShowModelMenu(false); setModelSearch('') }}
                              className="w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors flex items-center justify-between"
                              style={selectedModel === mod && selectedProvider === prov ? { background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', color: 'var(--accent-primary-light)' } : { color: 'var(--text-secondary)' }}>
                              <span className="truncate">{mod.split('/').pop()} <span style={{ color: 'var(--text-muted)' }}>({prov})</span></span>
                              <Star className="w-3 h-3 flex-shrink-0 fill-current" style={{ color: 'var(--accent-tertiary)' }}
                                onClick={e => { e.stopPropagation(); toggleFavorite(prov, mod) }} />
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {groupedProviders.map(group => {
                      const isSearching = !!modelSearch.trim()
                      const isExpanded = expandedProviders.has(group.name)
                      // Show ALL models by default. Provider lists like
                      // OpenRouter (300+) are scrollable inside the dropdown.
                      // Search still acts as a filter.
                      const limit = group.models.length
                      const displayModels = group.models.slice(0, limit)
                      const hasMore = group.models.length > limit
                      return (
                      <div key={group.name}>
                        <div className="px-2 py-1 text-[9px] font-bold uppercase tracking-widest flex items-center justify-between" style={{ color: 'var(--text-muted)' }}>
                          <span>{group.name}</span>
                          <span className="text-[8px] font-normal">{group.models.length}</span>
                        </div>
                        {displayModels.map(m => {
                          const isFav = favoriteModels.includes(`${group.name}::${m}`)
                          return (
                            <button key={m} onClick={() => { setSelectedModel(m); setSelectedProvider(group.name); setShowModelMenu(false); setModelSearch('') }}
                              className="w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors flex items-center justify-between group"
                              style={selectedModel === m ? { background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', color: 'var(--accent-primary-light)' } : { color: 'var(--text-secondary)' }}>
                              <span className="truncate">{m}</span>
                              <Star className={`w-3 h-3 flex-shrink-0 cursor-pointer transition-colors ${isFav ? 'fill-current' : ''}`}
                                style={{ color: isFav ? 'var(--accent-tertiary)' : 'var(--border)' }}
                                onClick={e => { e.stopPropagation(); toggleFavorite(group.name, m) }} />
                            </button>
                          )
                        })}
                        {hasMore && (
                          <button onClick={() => setExpandedProviders(prev => { const next = new Set(prev); next.add(group.name); return next })}
                            className="w-full text-center py-1.5 text-[10px] transition-colors rounded-lg"
                            style={{ color: 'var(--accent-primary)' }}>
                            + {group.models.length - limit} modèles...
                          </button>
                        )}
                      </div>
                    )})}
                  </div>
                </div>
              )}
            </div>

            {/* Bouton fichier */}
            <input ref={fileInputRef} type="file" multiple accept="image/*,.txt,.md,.json,.csv,.xml,.html,.py,.js,.ts,.tsx,.jsx,.css,.yaml,.yml,.log,.sql,.sh,.bat" className="hidden"
              onChange={handleFileSelect} />
            <button onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center rounded-xl transition-colors flex-shrink-0"
              style={{ width: '44px', height: '44px', background: attachedFiles.length > 0 ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'var(--bg-secondary)', border: `1px solid ${attachedFiles.length > 0 ? 'color-mix(in srgb, var(--accent-primary) 30%, transparent)' : 'var(--border)'}`, color: attachedFiles.length > 0 ? 'var(--accent-primary)' : 'var(--text-muted)' }}
              title={t('chat.attachFile')}>
              <Paperclip className="w-4 h-4" />
            </button>

            <div className="flex-1 relative">
              {/* Aperçu fichiers joints */}
              {attachedFiles.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {attachedFiles.map((f, i) => (
                    <div key={i} className="relative group rounded-lg overflow-hidden border border-[var(--border)]"
                      style={{ background: 'var(--bg-secondary)' }}>
                      {f.preview ? (
                        <img src={f.preview} alt={f.name} className="h-16 w-16 object-cover" />
                      ) : (
                        <div className="h-16 w-16 flex items-center justify-center">
                          <FileText className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
                        </div>
                      )}
                      <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                        <span className="text-[8px] text-white truncate block">{f.name}</span>
                      </div>
                      <button onClick={() => removeAttachment(i)}
                        className="absolute top-0 right-0 p-0.5 bg-black/60 rounded-bl opacity-0 group-hover:opacity-100 transition-opacity">
                        <X className="w-3 h-3 text-white" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                placeholder={t('chat.placeholder')} rows={1}
                className="w-full rounded-xl px-4 py-3 pr-12 text-sm placeholder-[#555] outline-none resize-none transition-colors"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', minHeight: '44px', maxHeight: '200px' }}
                onInput={(e) => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px' }} />
            </div>

            <button onClick={() => pttStatus === 'recording' ? stopPTT() : startPTT()}
              className="flex items-center justify-center rounded-xl transition-colors"
              style={pttStatus === 'recording'
                ? { width: '44px', height: '44px', background: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 40%, transparent)', color: 'var(--accent-primary)' }
                : { width: '44px', height: '44px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
              title={t('chat.speak')}>
              {pttStatus === 'recording' ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>

            <button onClick={() => setShowVoiceModal(true)} className="flex items-center justify-center rounded-xl transition-colors"
              style={showVoiceModal
                ? { width: '44px', height: '44px', background: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 40%, transparent)', color: 'var(--accent-primary)' }
                : { width: '44px', height: '44px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
              title={t('chat.realtime')}>
              <Radio className="w-4 h-4" />
            </button>

            <button onClick={handleSend} disabled={(!input.trim() && attachedFiles.length === 0) || isLoading} className="flex items-center justify-center rounded-xl disabled:opacity-30 transition-all"
              style={{ width: '44px', height: '44px', background: (input.trim() || attachedFiles.length > 0) && !isLoading ? 'linear-gradient(135deg, var(--scarlet), var(--scarlet-dark, #b91c1c))' : 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
              <Send className="w-4 h-4" />
            </button>
          </div>
          {/* Skills bar — favorites first, or first 6 if no favorites */}
          {allSkills.length > 0 && (() => {
            const displaySkills = favoriteSkills.length > 0 ? favoriteSkills : allSkills.slice(0, 6)
            return (
              <div className="flex items-center gap-2 max-w-4xl mx-auto mt-2 overflow-x-auto">
                <Sparkles className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-tertiary)' }} />
                {displaySkills.map((skill: any, idx: number) => {
                  const isActive = skill.name === activeSkill
                  return (
                    <div
                      key={skill.name}
                      draggable
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)) }}
                      onDragEnter={(e) => e.preventDefault()}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                      onDrop={async (e) => {
                        e.preventDefault()
                        const fromIdx = Number(e.dataTransfer.getData('text/plain'))
                        if (isNaN(fromIdx) || fromIdx === idx) return
                        const reordered = [...allSkills]
                        const fromSkill = displaySkills[fromIdx]
                        const toSkill = displaySkills[idx]
                        const realFrom = reordered.findIndex(s => s.name === fromSkill?.name)
                        let realTo = reordered.findIndex(s => s.name === toSkill?.name)
                        if (realFrom < 0 || realTo < 0 || realFrom === realTo) return
                        const [moved] = reordered.splice(realFrom, 1)
                        // After splice, indices shift if dragging forward
                        if (realFrom < realTo) realTo--
                        reordered.splice(realTo, 0, moved)
                        setAllSkills(reordered)
                        setFavoriteSkills(reordered.filter((sk: any) => sk.is_favorite))
                        await api.reorderSkills(reordered.map((sk: any) => sk.name))
                      }}
                      onClick={async () => {
                        if (isActive) {
                          await api.clearActiveSkill(); setActiveSkill(null)
                        } else {
                          await api.setActiveSkill(skill.name); setActiveSkill(skill.name)
                        }
                      }}
                      role="button"
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] whitespace-nowrap transition-all hover:scale-105 cursor-grab active:cursor-grabbing select-none"
                      style={{
                        background: isActive ? 'color-mix(in srgb, var(--accent-tertiary) 18%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                        border: `1px solid ${isActive ? 'color-mix(in srgb, var(--accent-tertiary) 40%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 20%, transparent)'}`,
                        color: isActive ? 'var(--accent-tertiary)' : 'var(--text-secondary)',
                      }}
                      title={skill.description}
                    >
                      {skill.icon ? <span className="text-sm leading-none">{skill.icon}</span> : <Code className="w-3 h-3" style={{ color: isActive ? 'var(--accent-tertiary)' : 'var(--accent-primary)' }} />}
                      {skill.name.replace(/_/g, ' ')}
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </div>
      </div>

      {/* ── TASK PANEL (right side) ── */}
      {showTaskPanel && (
        <TaskPanel conversationId={currentConversation} onClose={() => toggleTaskPanel()} />
      )}

      {/* Modals */}
      <VoiceModal isOpen={showVoiceModal} onClose={() => setShowVoiceModal(false)} />
      <ApiKeysModal isOpen={showApiKeysModal} onClose={() => setShowApiKeysModal(false)} config={config}
        onConfigUpdate={(newConfig) => useStore.getState().setConfig(newConfig)} />
      <UserModal isOpen={showUserModal} onClose={() => setShowUserModal(false)} currentUser={currentUser} onUserChange={setCurrentUser} />
    </div>
  )
}


// ── Automata task view (read-only history rendered chat-style) ─────────────

function AutomataTaskView({ task, history, onRefresh, onClose, onToggle, onRunNow }: {
  task: any
  history: any[]
  onRefresh: () => void
  onClose: () => void
  onToggle: () => void
  onRunNow: () => void
}) {
  const schedule = task.task_type === 'cron' ? task.cron_expression
    : task.task_type === 'interval' ? `toutes les ${task.interval_seconds}s`
    : task.run_at || '—'

  const fmt = (iso: string | null | undefined) => {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleString('fr-FR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    } catch { return iso }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="px-5 py-3 flex items-center justify-between"
        style={{ background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'color-mix(in srgb, var(--scarlet) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--scarlet) 25%, transparent)' }}>
            <Calendar className="w-4 h-4" style={{ color: 'var(--accent-primary-light)' }} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{task.name}</div>
            <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
              {task.task_type} · {schedule} · {task.run_count || 0} exécution{(task.run_count || 0) > 1 ? 's' : ''}
              {task.enabled ? ' · ACTIF' : ' · EN PAUSE'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={onRunNow} title="Exécuter maintenant"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
            <Play className="w-3 h-3" /> Lancer
          </button>
          <button onClick={onToggle} title={task.enabled ? 'Mettre en pause' : 'Activer'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
            {task.enabled ? <><Pause className="w-3 h-3" /> Pause</> : <><Play className="w-3 h-3" /> Activer</>}
          </button>
          <button onClick={onRefresh} title="Rafraîchir"
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>↻</button>
          <button onClick={onClose} title="Fermer"
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-5 py-6 space-y-4">
        {/* Static prompt bubble */}
        <div className="flex gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
            style={{ background: 'color-mix(in srgb, var(--scarlet) 15%, var(--bg-primary))', border: '1px solid color-mix(in srgb, var(--scarlet) 30%, transparent)' }}>
            <Calendar className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary-light)' }} />
          </div>
          <div className="rounded-2xl px-4 py-3 text-sm rounded-tl-sm max-w-2xl"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
            <div className="text-[10px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: 'var(--text-muted)' }}>Prompt envoyé à chaque exécution</div>
            <div className="whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{task.prompt}</div>
          </div>
        </div>

        {history.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Clock className="w-10 h-10 mb-3" style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Aucune exécution pour le moment.
            </div>
            <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {task.enabled ? `Prochaine exécution selon ${schedule}.` : 'La tâche est en pause — active-la pour qu\'elle tourne.'}
            </div>
          </div>
        ) : (
          [...history].reverse().map((entry) => {
            const ok = entry.status === 'success'
            return (
              <div key={entry.id || entry.timestamp} className="flex gap-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                  style={{ background: ok ? 'color-mix(in srgb, var(--accent-success) 12%, var(--bg-primary))' : 'color-mix(in srgb, var(--scarlet) 12%, var(--bg-primary))', border: '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
                  {ok ? <CheckCircle2 className="w-3.5 h-3.5" style={{ color: 'var(--accent-success)' }} />
                      : <AlertCircle className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary-light)' }} />}
                </div>
                <div className="flex-1 min-w-0 max-w-3xl">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                      {fmt(entry.timestamp || entry.triggered_at)}
                    </span>
                    {entry.model && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                        {entry.model}
                      </span>
                    )}
                    {!ok && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold" style={{ background: 'color-mix(in srgb, var(--scarlet) 15%, transparent)', color: 'var(--accent-primary-light)' }}>
                        {entry.status}
                      </span>
                    )}
                  </div>
                  <div className="rounded-2xl px-4 py-3 text-sm rounded-tl-sm"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
                    <div className="whitespace-pre-wrap">
                      {entry.response || entry.error || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>(vide)</span>}
                    </div>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
