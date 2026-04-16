/**
 * Gungnir — Core App Store (Zustand)
 *
 * Contains only core state: config, conversations, messages, provider/model selection.
 * Plugin-specific state lives in pluginStore or within each plugin.
 */
import { create } from 'zustand'
import { apiFetch } from '../services/api'

interface Message {
  id: number
  role: string
  content: string
  tool_calls?: any
  created_at: string
  tokens_input?: number
  tokens_output?: number
  model?: string
  provider?: string
  images?: string[]
}

interface Conversation {
  id: number
  title: string
  provider: string
  model: string
  created_at: string
  updated_at: string
  is_pinned?: boolean
  folder_id?: number | null
  tags?: { id: number; name: string; color: string }[]
}

interface AppState {
  // Config
  config: any | null
  setConfig: (config: any) => void

  // Agent name (customizable by user)
  agentName: string
  setAgentName: (name: string) => void

  // Conversations
  conversations: Conversation[]
  setConversations: (convos: Conversation[]) => void
  currentConversation: number | null
  setCurrentConversation: (id: number | null) => void

  // Messages
  messages: Message[]
  setMessages: (msgs: Message[]) => void
  addMessage: (msg: Message) => void

  // LLM selection
  selectedProvider: string
  setSelectedProvider: (provider: string) => void
  selectedModel: string
  setSelectedModel: (model: string) => void

  // Personality
  activePersonality: string
  setActivePersonality: (name: string) => void

  // Loading
  isLoading: boolean
  setLoading: (loading: boolean) => void
  // ID of the conversation currently awaiting a response (null if none).
  // Used so the thinking animation only shows in the chat that actually has
  // a request in flight, not every chat the user switches to.
  loadingConvoId: number | null
  setLoadingConvoId: (id: number | null) => void

  // Auth
  onLogout: (() => void) | null
  setOnLogout: (fn: (() => void) | null) => void
}

export const useStore = create<AppState>((set) => ({
  config: null,
  setConfig: (config) => set({ config }),

  agentName: localStorage.getItem('gungnir_agent_name') || 'Gungnir',
  setAgentName: (name) => {
    localStorage.setItem('gungnir_agent_name', name)
    set({ agentName: name })
    // Persist per-user to UserSettings.agent_name so chat.py picks it up.
    // Before this sync, the Settings input was purely cosmetic: the backend
    // kept reading the legacy Settings.app.agent_name global.
    const token = localStorage.getItem('gungnir_auth_token')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    apiFetch('/api/config/user/app', {
      method: 'POST',
      headers,
      body: JSON.stringify({ agent_name: name }),
    }).catch(() => {})
  },

  conversations: [],
  setConversations: (conversations) => set({ conversations }),
  currentConversation: null,
  setCurrentConversation: (id) => set({ currentConversation: id }),

  messages: [],
  setMessages: (messages) => set({ messages }),
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),

  selectedProvider: localStorage.getItem('gungnir_provider') || 'openrouter',
  setSelectedProvider: (provider) => {
    localStorage.setItem('gungnir_provider', provider)
    set({ selectedProvider: provider })
    // Sync to backend (per-user endpoint, fallback to global)
    const token = localStorage.getItem('gungnir_auth_token')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    apiFetch('/api/config/user/app', {
      method: 'POST',
      headers,
      body: JSON.stringify({ active_provider: provider }),
    }).catch(() => {})
  },
  selectedModel: localStorage.getItem('gungnir_model') || 'mistralai/mistral-large',
  setSelectedModel: (model) => {
    localStorage.setItem('gungnir_model', model)
    set({ selectedModel: model })
    // Sync to backend (per-user endpoint, fallback to global)
    const token = localStorage.getItem('gungnir_auth_token')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    apiFetch('/api/config/user/app', {
      method: 'POST',
      headers,
      body: JSON.stringify({ active_model: model }),
    }).catch(() => {})
  },

  activePersonality: 'default',
  setActivePersonality: (name) => set({ activePersonality: name }),

  isLoading: false,
  setLoading: (loading) => set({ isLoading: loading }),
  loadingConvoId: null,
  setLoadingConvoId: (id) => set({ loadingConvoId: id }),

  onLogout: null,
  setOnLogout: (fn) => set({ onLogout: fn }),
}))
