// ── Types partagés SpearCode ─────────────────────────────────────────────────
// Toutes les interfaces exposées aux composants du plugin vivent ici.

export interface TreeEntry { name: string; path: string; is_dir: boolean; size?: number; ext?: string; language?: string; children_count?: number }
export interface FileData { path: string; is_text: boolean; content?: string; size: number; language?: string; lines?: number }
export interface SearchResult { path: string; name: string; match: 'filename' | 'content'; line?: number; snippet?: string }
export interface RunResult { ok: boolean; exit_code: number; stdout: string; stderr: string; elapsed: number; command?: string }
export interface OpenTab { path: string; name: string; language: string; content: string; modified: boolean; originalContent: string; cursorLine: number; cursorCol: number }
export interface CodingPersona { id: string; name: string; icon: string; description: string; system_prompt: string }
export interface GitFile { status: string; path: string }
export interface GitStatus { is_repo: boolean; branch?: string; files?: GitFile[]; log?: string[] }
export interface ProviderInfo { name: string; default_model: string; enabled: boolean; models: string[]; registered?: boolean }
export interface QuickFile { path: string; name: string; language: string; ext: string }
export interface TermEntry { cmd: string; result: RunResult; isAI?: boolean; streaming?: boolean }
export interface TermSession { id: string; name: string; history: TermEntry[]; aiHistory: Array<{ role: string; content: string }> }

// ── Session persistence ─────────────────────────────────────────────────────

export interface SCSession {
  openPaths: Array<{ path: string; name: string; language: string }>
  activeTab: string | null
  sideView: string
  showTerminal: boolean
}

// ── Git ──────────────────────────────────────────────────────────────────────

export interface GitRemote { name: string; url: string; host?: string | null }
export interface GitCredentialHost { host: string; configured: boolean; enabled: boolean }
export interface GitCredentialsState { hosts: GitCredentialHost[]; user_name?: string; user_email?: string }

// ── AI sessions ──────────────────────────────────────────────────────────────

export interface AISession { id: string; name: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; tokens: number }
export interface AgentStep { type: 'thinking' | 'tool_call' | 'tool_result' | 'response' | 'error'; step: number; tool?: string; args?: any; result?: string; content?: string; reasoning?: string; error?: string }

// ── Versions ─────────────────────────────────────────────────────────────────

export interface VersionInfo { version_id: string; timestamp: string; label: string; file_path: string; lines: number; size: number }

// ── Snippets ─────────────────────────────────────────────────────────────────

export interface Snippet { id: string; name: string; language: string; code: string; description: string; tags: string[]; created: string }
