/**
 * Gungnir — Core API Service
 *
 * All API calls to the Gungnir backend.
 * Plugin-specific endpoints live in their own modules.
 */

interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

interface Conversation {
  id: number
  title: string
  provider: string
  model: string
  created_at: string
  updated_at: string
}

const API_BASE = '/api'

const TOKEN_KEY = 'gungnir_auth_token'

function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setAuthToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearAuthToken() {
  localStorage.removeItem(TOKEN_KEY)
}

export const apiFetch = (url: string, init?: RequestInit) => {
  const token = getAuthToken()
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> || {}),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return fetch(url, { ...init, headers, cache: 'no-store' as RequestCache })
}

const handleResponse = async (response: Response) => {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    throw new Error('Le backend ne répond pas (réponse HTML au lieu de JSON). Vérifiez que le serveur est démarré.')
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Network error' }))
    throw new Error(error.error || 'Network error')
  }
  return response.json()
}

export const api = {
  // ── Conversations ─────────────────────────────────────────────────
  getConversations: async (userId?: number): Promise<Conversation[]> => {
    const params = userId ? `?user_id=${userId}` : ''
    const response = await apiFetch(`${API_BASE}/conversations${params}`)
    return handleResponse(response)
  },

  createConversation: async (data: { title: string; provider: string; model: string; user_id?: number }) => {
    const response = await apiFetch(`${API_BASE}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  deleteConversation: async (id: number) => {
    const response = await apiFetch(`${API_BASE}/conversations/${id}`, { method: 'DELETE' })
    return handleResponse(response)
  },

  deleteAllConversations: async () => {
    const response = await apiFetch(`${API_BASE}/conversations`, { method: 'DELETE' })
    return handleResponse(response)
  },

  updateConversation: async (id: number, data: Partial<Omit<Conversation, 'id' | 'created_at' | 'updated_at'>>) => {
    const response = await apiFetch(`${API_BASE}/conversations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  getMessages: async (conversationId: number): Promise<Message[]> => {
    const response = await apiFetch(`${API_BASE}/conversations/${conversationId}/messages`)
    return handleResponse(response)
  },

  chat: async (conversationId: number, data: { message: string; provider: string; model: string; images?: string[] }) => {
    const response = await apiFetch(`${API_BASE}/conversations/${conversationId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  // ── Export conversations ──────────────────────────────────────────
  exportConversation: async (id: number, format: 'json' | 'txt' | 'md' | 'html' | 'pdf') => {
    const response = await apiFetch(`${API_BASE}/conversations/${id}/export/${format}`)
    if (!response.ok) throw new Error(`Export failed: ${response.status}`)
    return response.blob()
  },

  generateTitle: async (id: number) => {
    const response = await apiFetch(`${API_BASE}/conversations/${id}/generate-title`, { method: 'POST' })
    return handleResponse(response)
  },

  summarizeConversation: async (id: number, provider: string, model: string) => {
    const response = await apiFetch(`${API_BASE}/conversations/${id}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    })
    return handleResponse(response)
  },

  // ── Conversation tasks (todo-list façon Claude Code) ─────────────
  listConversationTasks: async (convoId: number) => {
    const response = await apiFetch(`${API_BASE}/conversations/${convoId}/tasks`)
    return handleResponse(response)
  },
  createConversationTask: async (convoId: number, data: { content: string; active_form?: string; status?: string }) => {
    const response = await apiFetch(`${API_BASE}/conversations/${convoId}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
    return handleResponse(response)
  },
  updateConversationTask: async (convoId: number, taskId: number, data: { content?: string; active_form?: string; status?: string; position?: number }) => {
    const response = await apiFetch(`${API_BASE}/conversations/${convoId}/tasks/${taskId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
    return handleResponse(response)
  },
  deleteConversationTask: async (convoId: number, taskId: number) => {
    const response = await apiFetch(`${API_BASE}/conversations/${convoId}/tasks/${taskId}`, { method: 'DELETE' })
    return handleResponse(response)
  },

  // ── Folders (arborescence) ────────────────────────────────────────
  listFolders: async () => {
    const response = await apiFetch(`${API_BASE}/folders`)
    return handleResponse(response)
  },
  createFolder: async (data: { name: string; parent_id?: number | null; color?: string; icon?: string }) => {
    const response = await apiFetch(`${API_BASE}/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
    return handleResponse(response)
  },
  updateFolder: async (folderId: number, data: Record<string, any>) => {
    const response = await apiFetch(`${API_BASE}/folders/${folderId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
    return handleResponse(response)
  },
  deleteFolder: async (folderId: number) => {
    const response = await apiFetch(`${API_BASE}/folders/${folderId}`, { method: 'DELETE' })
    return handleResponse(response)
  },
  moveConversationToFolder: async (convoId: number, folderId: number | null) => {
    const response = await apiFetch(`${API_BASE}/conversations/${convoId}/folder`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder_id: folderId }),
    })
    return handleResponse(response)
  },

  // ── Tags ──────────────────────────────────────────────────────────
  listTags: async () => {
    const response = await apiFetch(`${API_BASE}/tags`)
    return handleResponse(response)
  },
  createTag: async (data: { name: string; color?: string }) => {
    const response = await apiFetch(`${API_BASE}/tags`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
    return handleResponse(response)
  },
  deleteTag: async (tagId: number) => {
    const response = await apiFetch(`${API_BASE}/tags/${tagId}`, { method: 'DELETE' })
    return handleResponse(response)
  },
  attachTagToConversation: async (convoId: number, tagId: number) => {
    const response = await apiFetch(`${API_BASE}/conversations/${convoId}/tags/${tagId}`, { method: 'POST' })
    return handleResponse(response)
  },
  detachTagFromConversation: async (convoId: number, tagId: number) => {
    const response = await apiFetch(`${API_BASE}/conversations/${convoId}/tags/${tagId}`, { method: 'DELETE' })
    return handleResponse(response)
  },

  // ── Config ────────────────────────────────────────────────────────
  getConfig: async () => {
    const response = await apiFetch(`${API_BASE}/config`)
    const config = await handleResponse(response)
    // Merge per-user provider keys over global config
    try {
      const userProvResp = await apiFetch(`${API_BASE}/config/user/providers`)
      if (userProvResp.ok) {
        const userProvData = await userProvResp.json()
        if (userProvData.providers) {
          for (const [name, uprov] of Object.entries(userProvData.providers) as any) {
            if (config.providers[name]) {
              // User has a key → show as configured
              if (uprov.has_api_key) {
                config.providers[name].has_api_key = true
                config.providers[name].enabled = uprov.enabled
              }
            }
          }
        }
      }
    } catch {}
    return config
  },

  saveProvider: async (provider: string, data: { enabled?: boolean; api_key?: string; default_model?: string }) => {
    // Save to per-user endpoint (each user manages their own keys)
    const response = await apiFetch(`${API_BASE}/config/user/providers/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  deleteProvider: async (provider: string) => {
    const response = await apiFetch(`${API_BASE}/config/user/providers/${provider}`, { method: 'DELETE' })
    return handleResponse(response)
  },

  // Admin-only: global provider config
  saveGlobalProvider: async (provider: string, data: Record<string, any>) => {
    const response = await apiFetch(`${API_BASE}/config/providers/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  saveAppConfig: async (data: Record<string, any>) => {
    const response = await apiFetch(`${API_BASE}/config/app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  checkUpdate: async () => {
    const response = await apiFetch(`${API_BASE}/update/check`)
    return handleResponse(response)
  },

  // ── Services ───────────────────────────────────────────────────────
  getServices: async () => {
    const response = await apiFetch(`${API_BASE}/config/services`)
    return handleResponse(response)
  },

  getService: async (name: string) => {
    const response = await apiFetch(`${API_BASE}/config/services/${name}`)
    return handleResponse(response)
  },

  saveService: async (name: string, data: Record<string, any>) => {
    const response = await apiFetch(`${API_BASE}/config/services/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  deleteService: async (name: string) => {
    const response = await apiFetch(`${API_BASE}/config/services/${name}`, { method: 'DELETE' })
    return handleResponse(response)
  },

  testService: async (name: string) => {
    const response = await apiFetch(`${API_BASE}/config/services/${name}/test`, { method: 'POST' })
    return handleResponse(response)
  },

  // ── Voice ─────────────────────────────────────────────────────────
  saveVoiceConfig: async (provider: string, data: Record<string, any>) => {
    const response = await apiFetch(`${API_BASE}/config/voice/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  // ── Models ────────────────────────────────────────────────────────
  getModels: async (provider: string) => {
    const response = await apiFetch(`${API_BASE}/models/${provider}`)
    return handleResponse(response)
  },

  // ── Personalities ─────────────────────────────────────────────────
  getPersonalities: async () => {
    const response = await apiFetch(`${API_BASE}/personality`)
    return handleResponse(response)
  },

  setPersonality: async (personalityName: string) => {
    const response = await apiFetch(`${API_BASE}/personality/${personalityName}`, { method: 'POST' })
    return handleResponse(response)
  },

  createPersonality: async (data: { name: string; description: string; system_prompt: string }) => {
    const response = await apiFetch(`${API_BASE}/personality`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  updatePersonality: async (name: string, data: { description?: string; system_prompt?: string; traits?: string[] }) => {
    const response = await apiFetch(`${API_BASE}/personality/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  deletePersonality: async (name: string) => {
    const response = await apiFetch(`${API_BASE}/personality/${name}`, { method: 'DELETE' })
    return handleResponse(response)
  },

  reorderPersonalities: async (order: string[]) => {
    const response = await apiFetch(`${API_BASE}/personality/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    })
    return handleResponse(response)
  },

  getSkills: async () => {
    const response = await apiFetch(`${API_BASE}/skills`)
    return handleResponse(response)
  },

  reorderSkills: async (order: string[]) => {
    const response = await apiFetch(`${API_BASE}/skills/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    })
    return handleResponse(response)
  },

  toggleSkillFavorite: async (skillName: string) => {
    const response = await apiFetch(`${API_BASE}/skills/favorite/${skillName}`, {
      method: 'PUT',
    })
    return handleResponse(response)
  },

  getActiveSkill: async () => {
    const response = await apiFetch(`${API_BASE}/skills/active`)
    return handleResponse(response)
  },

  setActiveSkill: async (skillName: string) => {
    const response = await apiFetch(`${API_BASE}/skills/active/${skillName}`, {
      method: 'POST',
    })
    return handleResponse(response)
  },

  clearActiveSkill: async () => {
    const response = await apiFetch(`${API_BASE}/skills/active`, {
      method: 'DELETE',
    })
    return handleResponse(response)
  },

  // ── Users ─────────────────────────────────────────────────────────
  getUsers: async () => {
    const response = await apiFetch(`${API_BASE}/users`)
    return handleResponse(response)
  },

  createUser: async (data: { username: string; display_name?: string; password?: string; avatar_url?: string }) => {
    const response = await apiFetch(`${API_BASE}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  updateUser: async (id: number, data: Record<string, any>) => {
    const response = await apiFetch(`${API_BASE}/users/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  deleteUser: async (id: number) => {
    const response = await apiFetch(`${API_BASE}/users/${id}`, { method: 'DELETE' })
    return handleResponse(response)
  },

  loginUser: async (data: { username: string; password: string }) => {
    const response = await apiFetch(`${API_BASE}/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const result = await handleResponse(response)
    // Store auth token if returned
    if (result.token) {
      setAuthToken(result.token)
    }
    return result
  },

  checkAuth: async () => {
    // Renvoie un objet explicite plutôt que de throw, pour que App.tsx puisse
    // distinguer 'pas loggué' (needs_login) de 'backend ko' (no_auth) sans
    // dépendre du contenu du message d'erreur.
    try {
      const response = await apiFetch(`${API_BASE}/users/me`)
      if (response.status === 401) {
        return { ok: false, reason: 'needs_login' as const }
      }
      if (!response.ok) {
        return { ok: false, reason: 'backend_error' as const }
      }
      const data = await response.json().catch(() => null)
      if (data && data.ok) return { ok: true, user: data.user }
      return { ok: false, reason: 'needs_login' as const }
    } catch {
      return { ok: false, reason: 'network_error' as const }
    }
  },

  // ── Voice ─────────────────────────────────────────────────────────
  voiceChat: async (data: { text: string; history: any[]; provider?: string; model?: string }) => {
    const response = await apiFetch(`${API_BASE}/voice/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  voiceRealTime: () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return new WebSocket(`${protocol}//${window.location.host}/api/voice/realtime`)
  },

  voiceSTT: async (audioData: Blob) => {
    const response = await apiFetch(`${API_BASE}/voice/stt`, { method: 'POST', body: audioData })
    return handleResponse(response)
  },

  // ── Analytics ────────────────────────────────────────────────────
  getAnalyticsSummary: async () => {
    const response = await apiFetch(`${API_BASE}/analytics/summary`)
    return handleResponse(response)
  },

  getAnalyticsByModel: async () => {
    const response = await apiFetch(`${API_BASE}/analytics/by-model`)
    return handleResponse(response)
  },

  getAnalyticsByProvider: async () => {
    const response = await apiFetch(`${API_BASE}/analytics/by-provider`)
    return handleResponse(response)
  },

  getAnalyticsByDay: async (days: number = 30) => {
    const response = await apiFetch(`${API_BASE}/analytics/by-day?days=${days}`)
    return handleResponse(response)
  },

  getAnalyticsByWeek: async (weeks: number = 12) => {
    const response = await apiFetch(`${API_BASE}/analytics/by-week?weeks=${weeks}`)
    return handleResponse(response)
  },

  getAnalyticsByMonth: async (months: number = 12) => {
    const response = await apiFetch(`${API_BASE}/analytics/by-month?months=${months}`)
    return handleResponse(response)
  },

  getAnalyticsByYear: async () => {
    const response = await apiFetch(`${API_BASE}/analytics/by-year`)
    return handleResponse(response)
  },

  getAnalyticsHeatmap: async (days: number = 90) => {
    const response = await apiFetch(`${API_BASE}/analytics/heatmap?days=${days}`)
    return handleResponse(response)
  },

  getBudgetSettings: async () => {
    const response = await apiFetch(`${API_BASE}/analytics/budget`)
    return handleResponse(response)
  },

  updateBudgetSettings: async (data: Record<string, any>) => {
    const response = await apiFetch(`${API_BASE}/analytics/budget`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  getConversationsCost: async (limit: number = 100) => {
    const response = await apiFetch(`${API_BASE}/analytics/conversations?limit=${limit}`)
    return handleResponse(response)
  },

  checkBudgetAlerts: async () => {
    const response = await apiFetch(`${API_BASE}/analytics/check-budget`)
    return handleResponse(response)
  },

  getProviderBudgets: async () => {
    const response = await apiFetch(`${API_BASE}/analytics/provider-budgets`)
    return handleResponse(response)
  },

  upsertProviderBudget: async (provider: string, data: Record<string, any>) => {
    const response = await apiFetch(`${API_BASE}/analytics/provider-budgets/${encodeURIComponent(provider)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  deleteProviderBudget: async (provider: string) => {
    const response = await apiFetch(`${API_BASE}/analytics/provider-budgets/${encodeURIComponent(provider)}`, {
      method: 'DELETE',
    })
    return handleResponse(response)
  },

  // ── Agent ────────────────────────────────────────────────────────
  getSoul: async () => {
    const response = await apiFetch(`${API_BASE}/agent/soul`)
    return handleResponse(response)
  },

  saveSoul: async (content: string) => {
    const response = await apiFetch(`${API_BASE}/agent/soul`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    return handleResponse(response)
  },

  // ── Search (plugin, but core uses it for presearch) ───────────────
  searchStream: (query: string, proSearch: boolean = false, maxResults: number = 15) => {
    return fetch(`${API_BASE}/search/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, pro_search: proSearch, max_results: maxResults }),
      cache: 'no-store' as RequestCache,
    })
  },

  search: async (query: string, proSearch: boolean = false, maxResults: number = 15) => {
    const response = await apiFetch(`${API_BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, pro_search: proSearch, max_results: maxResults }),
    })
    return handleResponse(response)
  },

  searchHealth: async () => {
    const response = await apiFetch(`${API_BASE}/search/health`)
    return handleResponse(response)
  },
}
