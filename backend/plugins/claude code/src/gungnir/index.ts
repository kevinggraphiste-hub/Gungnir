import { EventEmitter } from 'node:events';
import { Agent } from '../core/agent.js';
import type { Tool, GungnirAgent, AgentStatus, SpearCodeConfig } from '../types/index.js';

/**
 * GungnirAgentAdapter wraps a SpearCode Agent to be used as a Gungnir skill/agent.
 *
 * Usage in Gungnir:
 * ```typescript
 * import { GungnirAgentAdapter } from 'spearcode/gungnir';
 *
 * const codingAgent = new GungnirAgentAdapter('coder', 'Code generation agent');
 * await codingAgent.start({ cwd: '/path/to/project' });
 *
 * // Use as sub-agent
 * const response = await codingAgent.send('Fix the bug in src/index.ts');
 *
 * // Or stream
 * for await (const chunk of codingAgent.stream('Refactor this function')) {
 *   process.stdout.write(chunk);
 * }
 *
 * // Register custom tools
 * codingAgent.registerTool({
 *   name: 'gungnir_task',
 *   description: 'Create a task in Gungnir',
 *   parameters: { ... },
 *   execute: async (args) => { ... }
 * });
 * ```
 */
export class GungnirAgentAdapter extends EventEmitter implements GungnirAgent {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  private agent: Agent;

  constructor(name: string, description: string) {
    super();
    this.agent = new Agent(name, description);
    this.id = this.agent.id;
    this.name = name;
    this.description = description;

    // Forward all events
    this.agent.on('token', (token) => this.emit('token', token));
    this.agent.on('tool_call', (tc) => this.emit('tool_call', tc));
    this.agent.on('tool_execute', (data) => this.emit('tool_execute', data));
    this.agent.on('tool_result', (data) => this.emit('tool_result', data));
    this.agent.on('tool_error', (data) => this.emit('tool_error', data));
    this.agent.on('response', (r) => this.emit('response', r));
    this.agent.on('error', (e) => this.emit('error', e));
  }

  async start(options?: { cwd?: string; provider?: string; model?: string }) {
    await this.agent.init(options?.cwd);
    await this.agent.start(options);
  }

  async stop() {
    await this.agent.stop();
  }

  async send(prompt: string): Promise<string> {
    return this.agent.send(prompt);
  }

  async *stream(prompt: string): AsyncIterable<string> {
    yield* this.agent.stream(prompt);
  }

  getTools(): Tool[] {
    return this.agent.getTools();
  }

  registerTool(tool: Tool) {
    this.agent.registerTool(tool);
  }

  getStatus(): AgentStatus {
    return this.agent.getStatus();
  }

  // Gungnir-specific: expose provider switching
  switchProvider(provider: string, model?: string) {
    this.agent.switchProvider(provider, model);
  }

  // Gungnir-specific: expose session management
  getSessions() { return this.agent.getSessions(); }
  loadSession(id: string) { return this.agent.loadSession(id); }
  deleteSession(id: string) { this.agent.deleteSession(id); }

  destroy() {
    this.agent.destroy();
    this.removeAllListeners();
  }
}

/**
 * Factory for creating multiple agents (Gungnir sub-agents)
 */
export class AgentFactory {
  private agents: Map<string, GungnirAgentAdapter> = new Map();

  create(name: string, description: string): GungnirAgentAdapter {
    const agent = new GungnirAgentAdapter(name, description);
    this.agents.set(agent.id, agent);
    return agent;
  }

  get(id: string): GungnirAgentAdapter | undefined {
    return this.agents.get(id);
  }

  list(): GungnirAgentAdapter[] {
    return Array.from(this.agents.values());
  }

  async destroyAll() {
    for (const agent of this.agents.values()) {
      agent.destroy();
    }
    this.agents.clear();
  }
}
