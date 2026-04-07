export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
}

export interface Session {
  id: string;
  title: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  workingDirectory: string;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  disabled?: boolean;
}

export interface AgentConfig {
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface SpearCodeConfig {
  data: {
    directory: string;
  };
  providers: Record<string, ProviderConfig>;
  agents: {
    coder: AgentConfig;
    task: AgentConfig;
    title: AgentConfig;
  };
  shell: {
    path: string;
    args: string[];
  };
  mcpServers: Record<string, McpServerConfig>;
  autoCompact: boolean;
}

export interface McpServerConfig {
  type: 'stdio' | 'sse';
  command?: string;
  url?: string;
  env?: string[];
  args?: string[];
}

export interface LLMProvider {
  name: string;
  models: string[];
  streamChat(messages: Message[], options: StreamOptions): AsyncIterable<StreamChunk>;
  chat(messages: Message[], options: ChatOptions): Promise<Message>;
}

export interface StreamOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ProviderTool[];
  onToken?: (token: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
}

export interface ChatOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ProviderTool[];
}

export interface StreamChunk {
  type: 'content' | 'tool_call' | 'done';
  content?: string;
  toolCall?: ToolCall;
}

export interface ProviderTool {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
}

export type OutputFormat = 'text' | 'json';

export interface GungnirAgent {
  id: string;
  name: string;
  description: string;
  start(options?: { cwd?: string; provider?: string; model?: string }): Promise<void>;
  stop(): Promise<void>;
  send(prompt: string): Promise<string>;
  stream(prompt: string): AsyncIterable<string>;
  getTools(): Tool[];
  registerTool(tool: Tool): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  getStatus(): AgentStatus;
}

export interface AgentStatus {
  id: string;
  state: 'idle' | 'running' | 'error' | 'stopped';
  currentSession?: string;
  provider?: string;
  model?: string;
  toolCalls: number;
  messageCount: number;
}
