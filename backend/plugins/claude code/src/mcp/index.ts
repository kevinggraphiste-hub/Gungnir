import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Tool, McpServerConfig, ProviderTool, ToolParameter } from '../types/index.js';

export interface McpClientManager {
  connect(serverName: string, config: McpServerConfig): Promise<void>;
  disconnect(serverName: string): Promise<void>;
  disconnectAll(): Promise<void>;
  listTools(serverName?: string): Promise<ProviderTool[]>;
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string>;
  isConnected(serverName: string): boolean;
  getConnectedServers(): string[];
}

export function createMcpClientManager(): McpClientManager {
  const clients: Map<string, { client: Client; transport: StdioClientTransport | SSEClientTransport }> = new Map();

  return {
    async connect(serverName: string, config: McpServerConfig) {
      if (clients.has(serverName)) {
        throw new Error(`MCP server already connected: ${serverName}`);
      }

      let transport: StdioClientTransport | SSEClientTransport;

      if (config.type === 'stdio' && config.command) {
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: config.env ? Object.fromEntries(config.env.map((e) => {
            const [k, ...v] = e.split('=');
            return [k, v.join('=')];
          })) : undefined,
        });
      } else if (config.type === 'sse' && config.url) {
        const url = new URL(config.url);
        transport = new SSEClientTransport(url);
      } else {
        throw new Error(`Invalid MCP server config for ${serverName}`);
      }

      const client = new Client({
        name: `spearcode-mcp-${serverName}`,
        version: '0.1.0',
      });

      await client.connect(transport);
      clients.set(serverName, { client, transport });
    },

    async disconnect(serverName: string) {
      const entry = clients.get(serverName);
      if (entry) {
        await entry.client.close();
        clients.delete(serverName);
      }
    },

    async disconnectAll() {
      for (const [name] of clients) {
        await this.disconnect(name);
      }
    },

    async listTools(serverName?: string): Promise<ProviderTool[]> {
      const allTools: ProviderTool[] = [];

      const servers = serverName
        ? [serverName]
        : Array.from(clients.keys());

      for (const name of servers) {
        const entry = clients.get(name);
        if (!entry) continue;

        try {
          const result = await entry.client.listTools();
          for (const tool of result.tools) {
            allTools.push({
              name: `mcp_${name}_${tool.name}`,
              description: `[MCP:${name}] ${tool.description ?? ''}`,
              parameters: convertMcpSchema(tool.inputSchema),
            });
          }
        } catch {
          // skip server errors
        }
      }

      return allTools;
    },

    async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
      const entry = clients.get(serverName);
      if (!entry) throw new Error(`MCP server not connected: ${serverName}`);

      // Strip the mcp_serverName_ prefix from tool name
      const realName = toolName.replace(new RegExp(`^mcp_${serverName}_`), '');

      const result = await entry.client.callTool({ name: realName, arguments: args });

      // Extract text content
      if (Array.isArray(result.content)) {
        return result.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text)
          .join('\n') || JSON.stringify(result.content);
      }

      return JSON.stringify(result);
    },

    isConnected(serverName: string): boolean {
      return clients.has(serverName);
    },

    getConnectedServers(): string[] {
      return Array.from(clients.keys());
    },
  };
}

export function createToolsFromMcp(
  manager: McpClientManager,
  providerTools: ProviderTool[]
): Tool[] {
  return providerTools.map((pt) => {
    // Extract server name from tool name: mcp_serverName_toolName
    const parts = pt.name.split('_');
    const serverName = parts[1];

    return {
      name: pt.name,
      description: pt.description,
      parameters: pt.parameters,
      async execute(args: Record<string, unknown>) {
        return manager.callTool(serverName, pt.name, args);
      },
    };
  });
}

// Convert MCP JSON Schema to our ToolParameter format
function convertMcpSchema(schema: unknown): Record<string, ToolParameter> {
  if (!schema || typeof schema !== 'object') return {};

  const s = schema as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };

  if (s.type !== 'object' || !s.properties) return {};

  const result: Record<string, ToolParameter> = {};
  const required = new Set(s.required ?? []);

  for (const [key, prop] of Object.entries(s.properties)) {
    const p = prop as { type?: string; description?: string; enum?: string[] };
    result[key] = {
      type: (p.type as ToolParameter['type']) ?? 'string',
      description: p.description ?? '',
      required: required.has(key),
      enum: p.enum,
    };
  }

  return result;
}
