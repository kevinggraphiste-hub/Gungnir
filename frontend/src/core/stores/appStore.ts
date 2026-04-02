/**
 * Gungnir — Core App Store (Zustand)
 *
 * Contains only core state: config, conversations, messages, provider/model selection.
 * Plugin-specific state lives in pluginStore or within each plugin.
 */
import { create } from 'zustand'

interface Message {
  id: number
  role: string
  content: string
  tool_calls?: any
  created_at: string
  tokens_input?: number
  tokens_output?: number
}

interface Conversation {
  id: number
  title: string
  provider: string
  model: string
  created_at: string
  updated_at: string
  is_pinned: boolean
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
}

export const useStore = create<AppState>((set) => ({
  config: null,
  setConfig: (config) => set({ config }),

  agentName: localStorage.getItem('gungnir_agent_name') || 'Gungnir',
  setAgentName: (name) => {
    localStorage.setItem('gungnir_agent_name', name)
    set({ agentName: name })
  },

  conversations: [],
  setConversations: (conversations) => set({ conversations }),
  currentConversation: null,
  setCurrentConversation: (id) => set({ currentConversation: id }),

  messages: [],
  setMessages: (messages) => set({ messages }),
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),

  selectedProvider: 'openrouter',
  setSelectedProvider: (provider) => set({ selectedProvider: provider }),
  selectedModel: 'minimax/minimax-m2.7',
  setSelectedModel: (model) => set({ selectedModel: model }),

  activePersonality: 'default',
  setActivePersonality: (name) => set({ activePersonality: name }),

  isLoading: false,
  setLoading: (loading) => set({ isLoading: loading }),
}))
