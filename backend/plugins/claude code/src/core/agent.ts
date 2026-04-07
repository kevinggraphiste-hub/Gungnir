import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  LLMProvider,
  Message,
  Tool,
  ProviderTool,
  SpearCodeConfig,
  Session,
  ToolCall,
  GungnirAgent,
  AgentStatus,
  StreamChunk,
} from '../types/index.js';
import { SessionManager } from './session.js';
import { createAllTools } from './tools.js';
import { createGitTools } from './git.js';
import { createWebTools } from './web.js';
import { createVisionTools } from './vision.js';
import { createSemanticSearchTools } from './semantic.js';
import { createTestGenerationTools } from './testGen.js';
import { createDiffTools } from './diff.js';
import { createPRReviewTools } from './prReview.js';
import { createDependencyTools } from './deps.js';
import { createGitHubTools } from './github.js';
import { createExplainerTools } from './explainer.js';
import { createImpactTools } from './impact.js';
import { SessionForker } from './fork.js';
import { SessionSharing } from './sharing.js';
import { loadMemory, initMemory, buildMemoryPrompt } from './memory.js';
import { loadCustomPrompt, buildCustomPromptSection } from './customPrompt.js';
import { loadCorrections, buildCorrectionsPrompt, detectCorrection, saveCorrection } from './learning.js';
import { loadCosts, saveCost, calculateCost, summarizeCosts, formatCostSummary } from './cost.js';
import { buildPersonaPrompt, getPersona, PERSONAS } from './personas.js';
import { getContextWindowSize, countMessagesTokens, countMessageTokens } from './tokens.js';
import { exportConversationToDocs } from './docs.js';
import { createAnthropicProvider, createOpenAIProvider, createOpenRouterProvider, createOllamaProvider } from './providers.js';
import { withRetry } from './retry.js';
import { isNearContextLimit, compactContext } from './compact.js';
import { PermissionManager } from './permissions.js';
import { loadConfig } from '../config/index.js';

export class Agent extends EventEmitter implements GungnirAgent {
  readonly id: string;
  readonly name: string;
  readonly description: string;

  private providers: Map<string, LLMProvider> = new Map();
  private tools: Map<string, Tool> = new Map();
  private sessionManager!: SessionManager;
  private config!: SpearCodeConfig;
  private cwd: string;
  private currentSession: Session | null = null;
  private currentProvider: LLMProvider | null = null;
  private currentModel: string = '';
  private _state: AgentStatus['state'] = 'idle';
  private toolCallCount = 0;
  private messageCount = 0;
  private abortController: AbortController | null = null;
  private permissionManager: PermissionManager = new PermissionManager();
  private activePersona: string | null = null;
  private forker!: SessionForker;
  private sharing!: SessionSharing;

  constructor(name = 'SpearCode', description = 'AI coding agent for the terminal') {
    super();
    this.id = randomUUID();
    this.name = name;
    this.description = description;
    this.cwd = process.cwd();
  }

  async init(cwd?: string, configPath?: string) {
    this.cwd = cwd ?? this.cwd;
    this.config = await loadConfig(this.cwd);
    this.sessionManager = new SessionManager(resolve(this.cwd, this.config.data.directory));
    this.forker = new SessionForker(this.sessionManager);
    this.sharing = new SessionSharing(this.sessionManager, resolve(this.cwd, this.config.data.directory));
    this.registerProviders();
    this.registerTools();
    this.emit('ready');
  }

  private registerProviders() {
    const retryOpts = {
      onRetry: (attempt: number, error: Error, delayMs: number) => {
        this.emit('retry', { attempt, error: error.message, delayMs });
      },
    };

    if (this.config.providers.anthropic?.apiKey && !this.config.providers.anthropic.disabled) {
      this.providers.set('anthropic', withRetry(createAnthropicProvider(this.config.providers.anthropic.apiKey), retryOpts));
    }
    if (this.config.providers.openai?.apiKey && !this.config.providers.openai.disabled) {
      this.providers.set('openai', withRetry(createOpenAIProvider(this.config.providers.openai.apiKey, this.config.providers.openai.baseUrl), retryOpts));
    }
    if (this.config.providers.openrouter?.apiKey && !this.config.providers.openrouter.disabled) {
      this.providers.set('openrouter', withRetry(createOpenRouterProvider(this.config.providers.openrouter.apiKey), retryOpts));
    }
    if (!this.config.providers.ollama?.disabled) {
      this.providers.set('ollama', withRetry(createOllamaProvider(this.config.providers.ollama?.baseUrl), retryOpts));
    }
  }

  private registerTools() {
    const tools = createAllTools(this.cwd, this.config.shell.path);
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }

    // Git tools
    const gitTools = createGitTools(this.cwd);
    for (const tool of gitTools) {
      this.tools.set(tool.name, tool);
    }

    // Web tools
    const webTools = createWebTools();
    for (const tool of webTools) {
      this.tools.set(tool.name, tool);
    }

    // Vision tools
    const visionTools = createVisionTools(this.cwd);
    for (const tool of visionTools) {
      this.tools.set(tool.name, tool);
    }

    // Semantic search
    const semanticTools = createSemanticSearchTools(this.cwd);
    for (const tool of semanticTools) {
      this.tools.set(tool.name, tool);
    }

    // Test generation
    const testTools = createTestGenerationTools(this.cwd);
    for (const tool of testTools) {
      this.tools.set(tool.name, tool);
    }

    // Diff tools
    const diffTools = createDiffTools(this.cwd);
    for (const tool of diffTools) {
      this.tools.set(tool.name, tool);
    }

    // PR review
    const prTools = createPRReviewTools(this.cwd);
    for (const tool of prTools) {
      this.tools.set(tool.name, tool);
    }

    // Dependency intelligence
    const depTools = createDependencyTools(this.cwd);
    for (const tool of depTools) {
      this.tools.set(tool.name, tool);
    }

    // GitHub integration
    const githubTools = createGitHubTools(this.cwd);
    for (const tool of githubTools) {
      this.tools.set(tool.name, tool);
    }

    // Code explainer
    const explainerTools = createExplainerTools(this.cwd);
    for (const tool of explainerTools) {
      this.tools.set(tool.name, tool);
    }

    // Impact analysis
    const impactTools = createImpactTools(this.cwd);
    for (const tool of impactTools) {
      this.tools.set(tool.name, tool);
    }
  }

  async start(options?: { cwd?: string; provider?: string; model?: string }) {
    if (options?.cwd) this.cwd = options.cwd;

    const providerName = options?.provider ?? this.getFirstProvider();
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`Provider not found: ${providerName}`);

    const model = options?.model ?? this.config.agents.coder.model;

    this.currentProvider = provider;
    this.currentModel = model;
    this.currentSession = this.sessionManager.createSession(providerName, model, this.cwd);
    this._state = 'idle';
    this.emit('started', { session: this.currentSession });
  }

  async stop() {
    this.abortController?.abort();
    this._state = 'stopped';
    this.emit('stopped');
  }

  getStatus(): AgentStatus {
    return {
      id: this.id,
      state: this._state,
      currentSession: this.currentSession?.id,
      provider: this.currentProvider?.name,
      model: this.currentModel,
      toolCalls: this.toolCallCount,
      messageCount: this.messageCount,
    };
  }

  getTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  registerTool(tool: Tool) {
    this.tools.set(tool.name, tool);
    this.emit('tool_registered', tool.name);
  }

  listProviders(): { name: string; models: string[] }[] {
    return Array.from(this.providers.entries()).map(([name, p]) => ({
      name,
      models: p.models,
    }));
  }

  switchProvider(providerName: string, model?: string) {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`Provider not found: ${providerName}`);
    this.currentProvider = provider;
    if (model) this.currentModel = model;
    if (this.currentSession) {
      this.currentSession.provider = providerName;
      if (model) this.currentSession.model = model;
    }
    this.emit('provider_switched', { provider: providerName, model: this.currentModel });
  }

  async send(prompt: string): Promise<string> {
    if (!this.currentProvider || !this.currentSession) {
      throw new Error('Agent not started. Call start() first.');
    }

    this._state = 'running';
    this.abortController = new AbortController();

    // Add user message
    this.sessionManager.addMessage(this.currentSession.id, 'user', prompt);
    this.messageCount++;

    // Get conversation history
    const messages = this.sessionManager.getMessages(this.currentSession.id);

    // Auto-compact if approaching context limit
    if (this.config.autoCompact && this.currentProvider) {
      const maxTokens = (this.config.agents.coder.maxTokens ?? 4096) * 32; // rough context window
      if (isNearContextLimit(messages, maxTokens)) {
        this.emit('compact_start', { messageCount: messages.length });
        try {
          const result = await compactContext(messages, this.currentProvider, this.currentModel, maxTokens);
          // Replace history with summary
          this.sessionManager.clearMessages(this.currentSession.id);
          this.sessionManager.addMessage(this.currentSession.id, 'system',
            `[Context compacted from ${result.originalMessageCount} messages]\n\n${result.summary}`
          );
          this.sessionManager.addMessage(this.currentSession.id, 'user', prompt);
          this.emit('compact_done', { summary: result.summary.slice(0, 200) });
        } catch {
          // If compact fails, continue with full history
          this.emit('compact_error', 'Compact failed, using full history');
        }
      }
    }

    // Convert tools to provider format
    const providerTools: ProviderTool[] = Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // System prompt
    const systemMessage: Message = {
      id: 'system',
      sessionId: this.currentSession.id,
      role: 'system',
      content: await this.buildSystemPrompt(),
      timestamp: 0,
    };

    const allMessages = [systemMessage, ...messages];

    try {
      let response = '';
      const toolCalls: ToolCall[] = [];

      for await (const chunk of this.currentProvider.streamChat(allMessages, {
        model: this.currentModel,
        maxTokens: this.config.agents.coder.maxTokens,
        tools: providerTools,
        onToken: (token) => {
          response += token;
          this.emit('token', token);
        },
        onToolCall: (tc) => {
          toolCalls.push(tc);
          this.toolCallCount++;
          this.emit('tool_call', tc);
        },
      })) {
        if (this.abortController.signal.aborted) break;
        if (chunk.type === 'tool_call' && chunk.toolCall) {
          // Execute tool
          await this.executeToolCall(chunk.toolCall);
        }
      }

      // Save assistant message
      if (response || toolCalls.length) {
        this.sessionManager.addMessage(
          this.currentSession.id,
          'assistant',
          response,
          toolCalls.length ? toolCalls : undefined
        );
        this.messageCount++;
      }

      this._state = 'idle';
      this.emit('response', response);
      return response;
    } catch (err) {
      this._state = 'error';
      this.emit('error', err);
      throw err;
    }
  }

  async *stream(prompt: string): AsyncIterable<string> {
    if (!this.currentProvider || !this.currentSession) {
      throw new Error('Agent not started. Call start() first.');
    }

    this._state = 'running';
    this.abortController = new AbortController();

    this.sessionManager.addMessage(this.currentSession.id, 'user', prompt);
    this.messageCount++;

    const messages = this.sessionManager.getMessages(this.currentSession.id);

    // Auto-compact if approaching context limit
    if (this.config.autoCompact && this.currentProvider) {
      const maxTokens = (this.config.agents.coder.maxTokens ?? 4096) * 32;
      if (isNearContextLimit(messages, maxTokens)) {
        yield '\n[Auto-compacting context...]\n';
        try {
          const result = await compactContext(messages, this.currentProvider, this.currentModel, maxTokens);
          this.sessionManager.clearMessages(this.currentSession.id);
          this.sessionManager.addMessage(this.currentSession.id, 'system',
            `[Context compacted from ${result.originalMessageCount} messages]\n\n${result.summary}`
          );
          this.sessionManager.addMessage(this.currentSession.id, 'user', prompt);
          yield '[Context compacted, continuing...]\n\n';
        } catch {
          yield '[Compact failed, using full history]\n\n';
        }
      }
    }

    const providerTools: ProviderTool[] = Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const systemMessage: Message = {
      id: 'system',
      sessionId: this.currentSession.id,
      role: 'system',
      content: await this.buildSystemPrompt(),
      timestamp: 0,
    };

    let response = '';
    const toolCalls: ToolCall[] = [];

    try {
      for await (const chunk of this.currentProvider.streamChat([systemMessage, ...messages], {
        model: this.currentModel,
        maxTokens: this.config.agents.coder.maxTokens,
        tools: providerTools,
        onToken: (token) => {
          response += token;
          this.emit('token', token);
        },
        onToolCall: (tc) => {
          toolCalls.push(tc);
          this.toolCallCount++;
          this.emit('tool_call', tc);
        },
      })) {
        if (this.abortController.signal.aborted) break;

        if (chunk.type === 'content' && chunk.content) {
          yield chunk.content;
        }

        if (chunk.type === 'tool_call' && chunk.toolCall) {
          const result = await this.executeToolCall(chunk.toolCall);
          yield `\n[tool:${chunk.toolCall.name}] ${result}\n`;
        }
      }

      if (response || toolCalls.length) {
        this.sessionManager.addMessage(
          this.currentSession.id,
          'assistant',
          response,
          toolCalls.length ? toolCalls : undefined
        );
        this.messageCount++;
      }

      this._state = 'idle';
    } catch (err) {
      this._state = 'error';
      throw err;
    }
  }

  private async executeToolCall(toolCall: ToolCall): Promise<string> {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      const error = `Unknown tool: ${toolCall.name}`;
      this.sessionManager.addMessage(this.currentSession!.id, 'tool', error, undefined, toolCall.id);
      return error;
    }

    // Check permissions
    const perm = await this.permissionManager.check(toolCall.name, toolCall.arguments);
    if (!perm.allowed) {
      const error = `Permission denied for tool: ${toolCall.name}`;
      this.sessionManager.addMessage(this.currentSession!.id, 'tool', error, undefined, toolCall.id);
      this.emit('tool_denied', { name: toolCall.name, args: toolCall.arguments });
      return error;
    }

    this.emit('tool_execute', { name: toolCall.name, args: toolCall.arguments });

    try {
      const result = await tool.execute(toolCall.arguments);
      this.sessionManager.addMessage(this.currentSession!.id, 'tool', result, undefined, toolCall.id);
      this.emit('tool_result', { name: toolCall.name, result });
      return result;
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this.sessionManager.addMessage(this.currentSession!.id, 'tool', `Error: ${error}`, undefined, toolCall.id);
      this.emit('tool_error', { name: toolCall.name, error });
      return `Error: ${error}`;
    }
  }

  private async buildSystemPrompt(): Promise<string> {
    const memory = await loadMemory(this.cwd);
    const customPrompt = await loadCustomPrompt(this.cwd);
    const corrections = await loadCorrections(this.cwd);

    let prompt = `You are SpearCode, an AI coding assistant. You help the user with software engineering tasks.

Working directory: ${this.cwd}

You have access to the following tools:
${Array.from(this.tools.values()).map((t) => `- ${t.name}: ${t.description}`).join('\n')}

Rules:
- Be concise and direct. Short responses are preferred.
- Use tools to read, write, and edit files. Always prefer editing existing files over creating new ones.
- Use git tools to understand the project history and context.
- Use web_fetch or web_search to look up documentation or information.
- Use semantic_search to find code by meaning, not just text.
- When executing commands, explain what they do briefly.
- After completing a task, run relevant lint/typecheck commands if available.
- Do not add comments to code unless explicitly asked.
- Do not commit changes unless explicitly asked.
- Update .spearcode.md when you learn important project information.
${buildMemoryPrompt(memory)}`;

    if (customPrompt) {
      prompt += buildCustomPromptSection(customPrompt);
    }

    // Add persona
    if (this.activePersona) {
      const persona = getPersona(this.activePersona);
      if (persona) prompt += buildPersonaPrompt(persona);
    }

    // Add learned corrections
    if (corrections.length) {
      prompt += buildCorrectionsPrompt(corrections);
    }

    prompt += `\nCurrent platform: ${process.platform}\nCurrent time: ${new Date().toISOString()}`;

    return prompt;
  }

  private getFirstProvider(): string {
    for (const [name, config] of Object.entries(this.config.providers)) {
      if (!config.disabled) return name;
    }
    throw new Error('No LLM providers configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  }

  // Session management
  getSessions() { return this.sessionManager.listSessions(); }
  getSession(id: string) { return this.sessionManager.getSession(id); }
  loadSession(id: string) {
    const session = this.sessionManager.getSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    this.currentSession = session;
    const provider = this.providers.get(session.provider);
    if (provider) this.currentProvider = provider;
    this.currentModel = session.model;
    return session;
  }
  deleteSession(id: string) { this.sessionManager.deleteSession(id); }
  getMessages(sessionId: string) { return this.sessionManager.getMessages(sessionId); }

  // Permissions
  setAutoApprove(value: boolean) { this.permissionManager.setAutoApproveAll(value); }
  setInteractive(value: boolean) { this.permissionManager.setInteractive(value); }

  // Personas
  setPersona(personaId: string | null) {
    if (personaId && !getPersona(personaId)) {
      throw new Error(`Unknown persona: ${personaId}. Available: ${Object.keys(PERSONAS).join(', ')}`);
    }
    this.activePersona = personaId;
    this.emit('persona_changed', personaId);
  }
  getActivePersona() { return this.activePersona ? getPersona(this.activePersona) : null; }
  listPersonas() { return Object.values(PERSONAS); }

  // Cost tracking
  async getCostSummary() {
    const costs = await loadCosts(this.cwd);
    return summarizeCosts(costs);
  }

  // Learning
  async learnCorrection(original: string, corrected: string, category: string) {
    return saveCorrection(this.cwd, {
      original,
      corrected,
      context: corrected,
      category: category as 'code' | 'explanation' | 'approach' | 'tool_usage' | 'style',
      tags: [],
    });
  }

  // Docs export
  async exportDocs(title?: string) {
    if (!this.currentSession) throw new Error('No active session');
    const messages = this.sessionManager.getMessages(this.currentSession.id);
    return exportConversationToDocs(messages, this.cwd, title);
  }

  // Session forking
  forkSession(label?: string) {
    if (!this.currentSession) throw new Error('No active session');
    return this.forker.fork(this.currentSession.id, label);
  }
  getForks() {
    if (!this.currentSession) return [];
    return this.forker.getForks(this.currentSession.id);
  }
  mergeFork(forkId: string) {
    if (!this.currentSession) throw new Error('No active session');
    return this.forker.mergeBack(forkId, this.currentSession.id);
  }

  // Session sharing
  async shareSession(expiresInHours?: number) {
    if (!this.currentSession) throw new Error('No active session');
    return this.sharing.share(this.currentSession.id, expiresInHours);
  }
  async importSharedSession(shareId: string) {
    return this.sharing.import(shareId);
  }

  destroy() {
    this.sessionManager?.close();
    this.removeAllListeners();
  }
}
