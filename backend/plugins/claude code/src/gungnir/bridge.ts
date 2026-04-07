import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Agent } from '../core/agent.js';
import { analyzeProject, renderTree } from '../core/context.js';
import type { Tool, GungnirAgent, AgentStatus } from '../types/index.js';

// ─── Gungnir Protocol Types ───

export interface GungnirMessage {
  id: string;
  type: GungnirMessageType;
  from: string;
  to: string;
  payload: unknown;
  timestamp: number;
  correlationId?: string;
}

export type GungnirMessageType =
  | 'agent.start'
  | 'agent.stop'
  | 'agent.status'
  | 'agent.task'
  | 'agent.result'
  | 'agent.error'
  | 'agent.heartbeat'
  | 'agent.skill.register'
  | 'agent.skill.invoke'
  | 'agent.skill.result'
  | 'agent.subagent.spawn'
  | 'agent.subagent.kill'
  | 'agent.context.sync'
  | 'agent.mode.set';

export type AgentMode = 'autonomous' | 'controlled' | 'supervised';

export interface GungnirSkill {
  id: string;
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  parameters?: Record<string, unknown>;
}

export interface GungnirSubAgent {
  id: string;
  name: string;
  agent: Agent;
  parentId: string;
  status: 'idle' | 'running' | 'stopped' | 'error';
  createdAt: number;
}

export interface HeartbeatConfig {
  intervalMs: number;
  enabled: boolean;
}

// ─── Gungnir Bridge ───

export class GungnirBridge extends EventEmitter {
  readonly id: string;
  readonly name: string;
  private agent: Agent;
  private skills: Map<string, GungnirSkill> = new Map();
  private subAgents: Map<string, GungnirSubAgent> = new Map();
  private mode: AgentMode = 'controlled';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatConfig: HeartbeatConfig = { intervalMs: 5000, enabled: false };
  private messageQueue: GungnirMessage[] = [];
  private running = false;

  constructor(name = 'spearcode-gungnir', agent?: Agent) {
    super();
    this.id = randomUUID();
    this.name = name;
    this.agent = agent ?? new Agent(name);
  }

  // ─── Lifecycle ───

  async start(options?: { cwd?: string; provider?: string; model?: string; mode?: AgentMode }) {
    await this.agent.init(options?.cwd);
    await this.agent.start(options);
    if (options?.mode) this.mode = options.mode;
    this.running = true;

    // Register default skills
    this.registerDefaultSkills();

    // Start heartbeat if enabled
    if (this.heartbeatConfig.enabled) {
      this.startHeartbeat();
    }

    // Forward agent events as Gungnir messages
    this.agent.on('token', (token: unknown) => {
      this.emit('gungnir:stream', { from: this.id, content: token });
    });

    this.agent.on('tool_execute', (data: unknown) => {
      this.emit('gungnir:tool', data);
    });

    this.emit('gungnir:message', {
      id: randomUUID(),
      type: 'agent.start',
      from: this.id,
      to: 'gungnir',
      payload: { mode: this.mode, status: this.agent.getStatus() },
      timestamp: Date.now(),
    });
  }

  async stop() {
    this.running = false;
    this.stopHeartbeat();
    await this.agent.stop();

    // Stop all sub-agents
    for (const [id, sub] of this.subAgents) {
      await sub.agent.stop();
      sub.status = 'stopped';
    }

    this.emit('gungnir:message', {
      id: randomUUID(),
      type: 'agent.stop',
      from: this.id,
      to: 'gungnir',
      payload: {},
      timestamp: Date.now(),
    });
  }

  // ─── Mode Management ───

  setMode(mode: AgentMode) {
    this.mode = mode;
    this.emit('gungnir:message', {
      id: randomUUID(),
      type: 'agent.mode.set',
      from: this.id,
      to: 'gungnir',
      payload: { mode },
      timestamp: Date.now(),
    });
  }

  getMode(): AgentMode {
    return this.mode;
  }

  isAutonomous(): boolean {
    return this.mode === 'autonomous';
  }

  // ─── Task Execution ───

  async executeTask(task: string): Promise<string> {
    if (!this.running) throw new Error('Bridge not started');

    const taskMessage: GungnirMessage = {
      id: randomUUID(),
      type: 'agent.task',
      from: 'gungnir',
      to: this.id,
      payload: { task },
      timestamp: Date.now(),
    };
    this.emit('gungnir:message', taskMessage);

    try {
      const result = await this.agent.send(task);

      this.emit('gungnir:message', {
        id: randomUUID(),
        type: 'agent.result',
        from: this.id,
        to: 'gungnir',
        payload: { task, result },
        timestamp: Date.now(),
        correlationId: taskMessage.id,
      });

      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit('gungnir:message', {
        id: randomUUID(),
        type: 'agent.error',
        from: this.id,
        to: 'gungnir',
        payload: { task, error },
        timestamp: Date.now(),
        correlationId: taskMessage.id,
      });
      throw err;
    }
  }

  async *streamTask(task: string): AsyncIterable<string> {
    if (!this.running) throw new Error('Bridge not started');
    yield* this.agent.stream(task);
  }

  // ─── Sub-Agents ───

  async spawnSubAgent(name: string, options?: { provider?: string; model?: string }): Promise<GungnirSubAgent> {
    const subId = randomUUID();
    const subAgent = new Agent(name);

    await subAgent.init(this.agent.getStatus().currentSession ? undefined : process.cwd());
    await subAgent.start(options);

    const sub: GungnirSubAgent = {
      id: subId,
      name,
      agent: subAgent,
      parentId: this.id,
      status: 'running',
      createdAt: Date.now(),
    };

    this.subAgents.set(subId, sub);

    this.emit('gungnir:message', {
      id: randomUUID(),
      type: 'agent.subagent.spawn',
      from: this.id,
      to: 'gungnir',
      payload: { subAgentId: subId, name, options },
      timestamp: Date.now(),
    });

    return sub;
  }

  async killSubAgent(subId: string) {
    const sub = this.subAgents.get(subId);
    if (!sub) throw new Error(`Sub-agent not found: ${subId}`);

    await sub.agent.stop();
    sub.status = 'stopped';
    sub.agent.destroy();
    this.subAgents.delete(subId);

    this.emit('gungnir:message', {
      id: randomUUID(),
      type: 'agent.subagent.kill',
      from: this.id,
      to: 'gungnir',
      payload: { subAgentId: subId },
      timestamp: Date.now(),
    });
  }

  getSubAgents(): GungnirSubAgent[] {
    return Array.from(this.subAgents.values());
  }

  // ─── Skills ───

  registerSkill(skill: GungnirSkill) {
    this.skills.set(skill.id, skill);

    // Also register as a tool in the agent
    this.agent.registerTool({
      name: `skill_${skill.name}`,
      description: `[Skill] ${skill.description}`,
      parameters: (skill.parameters ?? {}) as Record<string, import('../types/index.js').ToolParameter>,
      execute: async (args) => {
        const result = await skill.handler(args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    });

    this.emit('gungnir:message', {
      id: randomUUID(),
      type: 'agent.skill.register',
      from: this.id,
      to: 'gungnir',
      payload: { skillId: skill.id, name: skill.name },
      timestamp: Date.now(),
    });
  }

  invokeSkill(skillId: string, args: Record<string, unknown>): Promise<unknown> {
    const skill = this.skills.get(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);
    return skill.handler(args);
  }

  getSkills(): GungnirSkill[] {
    return Array.from(this.skills.values());
  }

  // ─── Heartbeat ───

  enableHeartbeat(intervalMs = 5000) {
    this.heartbeatConfig = { intervalMs, enabled: true };
    if (this.running) this.startHeartbeat();
  }

  disableHeartbeat() {
    this.heartbeatConfig.enabled = false;
    this.stopHeartbeat();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.running) return;

      this.emit('gungnir:message', {
        id: randomUUID(),
        type: 'agent.heartbeat',
        from: this.id,
        to: 'gungnir',
        payload: {
          status: this.agent.getStatus(),
          mode: this.mode,
          subAgents: this.subAgents.size,
          skills: this.skills.size,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        },
        timestamp: Date.now(),
      });
    }, this.heartbeatConfig.intervalMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Context Sync ───

  async syncContext(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const context = await analyzeProject(dir);

    this.emit('gungnir:message', {
      id: randomUUID(),
      type: 'agent.context.sync',
      from: this.id,
      to: 'gungnir',
      payload: {
        project: context.name,
        language: context.language,
        framework: context.framework,
        tree: renderTree(context.tree),
        stats: context.stats,
        recentFiles: context.recentFiles,
      },
      timestamp: Date.now(),
    });

    // Inject context into system prompt
    const contextPrompt = buildContextPrompt(context);
    this.agent.registerTool({
      name: 'get_project_context',
      description: 'Get information about the current project structure and context',
      parameters: {},
      async execute() {
        return contextPrompt;
      },
    });
  }

  // ─── Default Skills ───

  private registerDefaultSkills() {
    // Project analysis skill
    this.registerSkill({
      id: 'analyze-project',
      name: 'analyze_project',
      description: 'Analyze the current project structure, languages, and frameworks',
      handler: async (args) => {
        const cwd = (args.cwd as string) ?? process.cwd();
        const ctx = await analyzeProject(cwd);
        return {
          name: ctx.name,
          language: ctx.language,
          framework: ctx.framework,
          tree: renderTree(ctx.tree),
          stats: ctx.stats,
          recentFiles: ctx.recentFiles,
        };
      },
      parameters: {
        cwd: { type: 'string', description: 'Project root directory' },
      },
    });

    // Spawn sub-agent skill
    this.registerSkill({
      id: 'spawn-agent',
      name: 'spawn_agent',
      description: 'Spawn a sub-agent for parallel task execution',
      handler: async (args) => {
        const sub = await this.spawnSubAgent(
          args.name as string,
          { provider: args.provider as string, model: args.model as string }
        );
        if (args.task) {
          const result = await sub.agent.send(args.task as string);
          return { subAgentId: sub.id, result };
        }
        return { subAgentId: sub.id, status: 'spawned' };
      },
      parameters: {
        name: { type: 'string', description: 'Sub-agent name', required: true },
        task: { type: 'string', description: 'Initial task to execute' },
        provider: { type: 'string', description: 'LLM provider' },
        model: { type: 'string', description: 'Model to use' },
      },
    });

    // Web search skill (placeholder — integrate with gungnir's Perplexity)
    this.registerSkill({
      id: 'web-search',
      name: 'web_search',
      description: 'Search the web for information (delegates to gungnir Perplexity)',
      handler: async (args) => {
        // This will be connected to gungnir's Perplexity integration
        this.emit('gungnir:perplexity:query', {
          query: args.query,
          from: this.id,
        });
        return { status: 'delegated', query: args.query };
      },
      parameters: {
        query: { type: 'string', description: 'Search query', required: true },
      },
    });
  }

  // ─── Gungnir Message Handler ───

  async handleMessage(message: GungnirMessage): Promise<GungnirMessage | null> {
    switch (message.type) {
      case 'agent.task': {
        const task = (message.payload as { task: string }).task;
        const result = await this.executeTask(task);
        return {
          id: randomUUID(),
          type: 'agent.result',
          from: this.id,
          to: message.from,
          payload: { result },
          timestamp: Date.now(),
          correlationId: message.id,
        };
      }

      case 'agent.mode.set': {
        const mode = (message.payload as { mode: AgentMode }).mode;
        this.setMode(mode);
        return null;
      }

      case 'agent.skill.invoke': {
        const { skillId, args } = message.payload as { skillId: string; args: Record<string, unknown> };
        try {
          const result = await this.invokeSkill(skillId, args);
          return {
            id: randomUUID(),
            type: 'agent.skill.result',
            from: this.id,
            to: message.from,
            payload: { skillId, result },
            timestamp: Date.now(),
            correlationId: message.id,
          };
        } catch (err) {
          return {
            id: randomUUID(),
            type: 'agent.error',
            from: this.id,
            to: message.from,
            payload: { skillId, error: err instanceof Error ? err.message : String(err) },
            timestamp: Date.now(),
            correlationId: message.id,
          };
        }
      }

      case 'agent.status': {
        return {
          id: randomUUID(),
          type: 'agent.status',
          from: this.id,
          to: message.from,
          payload: {
            ...this.agent.getStatus(),
            mode: this.mode,
            subAgents: this.getSubAgents().map((s) => ({ id: s.id, name: s.name, status: s.status })),
            skills: this.getSkills().map((s) => ({ id: s.id, name: s.name })),
          },
          timestamp: Date.now(),
        };
      }

      default:
        return null;
    }
  }

  // ─── Expose Agent ───

  getAgent(): Agent {
    return this.agent;
  }

  getStatus(): GungnirBridgeStatus {
    return {
      id: this.id,
      name: this.name,
      running: this.running,
      mode: this.mode,
      agentStatus: this.agent.getStatus(),
      subAgents: this.subAgents.size,
      skills: this.skills.size,
      heartbeat: this.heartbeatConfig,
    };
  }

  destroy() {
    this.stopHeartbeat();
    for (const [, sub] of this.subAgents) {
      sub.agent.destroy();
    }
    this.subAgents.clear();
    this.skills.clear();
    this.agent.destroy();
    this.removeAllListeners();
  }
}

// ─── Helpers ───

interface ProjectInfo {
  name: string;
  language: string;
  framework?: string;
  stats: { totalFiles: number; totalLines: number; byLanguage: Record<string, { files: number; lines: number }> };
  recentFiles: string[];
  readme?: string;
}

function buildContextPrompt(ctx: ProjectInfo): string {
  const lines = [
    `# Project: ${ctx.name}`,
    `Language: ${ctx.language}`,
    ctx.framework ? `Framework: ${ctx.framework}` : '',
    '',
    '## Stats',
    `Total files: ${ctx.stats.totalFiles}`,
    ...Object.entries(ctx.stats.byLanguage).map(
      ([lang, s]) => `${lang}: ${s.files} files`
    ),
    '',
    '## Recent Files',
    ...ctx.recentFiles.map((f) => `- ${f}`),
  ];

  if (ctx.readme) {
    lines.push('', '## README (excerpt)', ctx.readme.slice(0, 1000));
  }

  return lines.filter(Boolean).join('\n');
}

export interface GungnirBridgeStatus {
  id: string;
  name: string;
  running: boolean;
  mode: AgentMode;
  agentStatus: AgentStatus;
  subAgents: number;
  skills: number;
  heartbeat: HeartbeatConfig;
}
