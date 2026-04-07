import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Tool, ToolParameter } from '../types/index.js';

export interface LspConfig {
  command: string;
  args?: string[];
  disabled?: boolean;
}

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string | number;
}

export interface LspServer {
  language: string;
  start(rootUri: string): Promise<void>;
  stop(): Promise<void>;
  getDiagnostics(filePath?: string): Diagnostic[];
  isConnected(): boolean;
}

export function createLspClient(language: string, config: LspConfig): LspServer {
  let lspProcess: ChildProcess | null = null;
  let connected = false;
  let requestId = 0;
  const pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  const diagnostics: Map<string, Diagnostic[]> = new Map();
  let buffer = '';

  async function sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!lspProcess?.stdin || !connected) throw new Error('LSP not connected');

    const id = ++requestId;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      lspProcess!.stdin!.write(header + message);

      // Timeout after 10s
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`LSP request timeout: ${method}`));
        }
      }, 10000);
    });
  }

  async function sendNotification(method: string, params: unknown): Promise<void> {
    if (!lspProcess?.stdin || !connected) return;

    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
    lspProcess.stdin.write(header + message);
  }

  function handleResponse(data: string) {
    buffer += data;

    while (true) {
      // Find Content-Length header
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headerMatch = buffer.match(/Content-Length: (\d+)/i);
      if (!headerMatch) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(headerMatch[1]);
      const messageStart = headerEnd + 4;

      if (buffer.length < messageStart + contentLength) break;

      const messageBody = buffer.slice(messageStart, messageStart + contentLength);
      buffer = buffer.slice(messageStart + contentLength);

      try {
        const msg = JSON.parse(messageBody);

        if (msg.id !== undefined && pendingRequests.has(msg.id)) {
          const pending = pendingRequests.get(msg.id)!;
          pendingRequests.delete(msg.id);

          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }

        // Handle diagnostics notifications
        if (msg.method === 'textDocument/publishDiagnostics') {
          const params = msg.params;
          if (params?.uri && params?.diagnostics) {
            const filePath = params.uri.replace('file:///', '').replace(/\//g, '\\');
            const diags: Diagnostic[] = params.diagnostics.map((d: {
              range?: { start?: { line?: number; character?: number } };
              severity?: number;
              message?: string;
              source?: string;
              code?: string | number;
            }) => ({
              file: filePath,
              line: (d.range?.start?.line ?? 0) + 1,
              column: (d.range?.start?.character ?? 0) + 1,
              severity: diagnosticSeverity(d.severity),
              message: d.message ?? '',
              source: d.source,
              code: d.code,
            }));
            diagnostics.set(filePath, diags);
          }
        }
      } catch {
        // skip malformed messages
      }
    }
  }

  return {
    language,

    async start(rootUri: string) {
      if (connected) return;

      lspProcess = spawn(config.command, config.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      lspProcess.stdout?.on('data', (data: Buffer) => handleResponse(data.toString()));
      lspProcess.stderr?.on('data', () => {}); // ignore stderr

      lspProcess.on('exit', () => {
        connected = false;
        lspProcess = null;
      });

      connected = true;

      // Initialize
      await sendRequest('initialize', {
        processId: lspProcess.pid,
        rootUri: `file:///${rootUri.replace(/\\/g, '/')}`,
        capabilities: {
          textDocument: {
            publishDiagnostics: { relatedInformation: true },
          },
        },
        clientInfo: { name: 'spearcode', version: '0.1.0' },
      });

      await sendNotification('initialized', {});
    },

    async stop() {
      if (!connected) return;

      try {
        await sendRequest('shutdown', null);
        await sendNotification('exit', null);
      } catch {
        // ignore
      }

      lspProcess?.kill();
      connected = false;
      lspProcess = null;
    },

    getDiagnostics(filePath?: string): Diagnostic[] {
      if (filePath) {
        return diagnostics.get(filePath) ?? [];
      }
      // Return all diagnostics
      const all: Diagnostic[] = [];
      for (const diags of diagnostics.values()) {
        all.push(...diags);
      }
      return all;
    },

    isConnected(): boolean {
      return connected;
    },
  };
}

function diagnosticSeverity(severity?: number): Diagnostic['severity'] {
  switch (severity) {
    case 1: return 'error';
    case 2: return 'warning';
    case 3: return 'info';
    default: return 'hint';
  }
}

export function createLspTools(servers: LspServer[]): Tool[] {
  return [
    {
      name: 'diagnostics',
      description: 'Get code diagnostics (errors, warnings) from language servers',
      parameters: {
        path: {
          type: 'string',
          description: 'File path to get diagnostics for (optional, all files if omitted)',
          required: false,
        },
      },
      async execute(args) {
        const filePath = args.path as string | undefined;
        const allDiags: Diagnostic[] = [];

        for (const server of servers) {
          if (server.isConnected()) {
            allDiags.push(...server.getDiagnostics(filePath));
          }
        }

        if (!allDiags.length) return 'No diagnostics found';

        return allDiags
          .map((d) => {
            const icon = d.severity === 'error' ? '❌' : d.severity === 'warning' ? '⚠️' : 'ℹ️';
            return `${icon} ${d.file}:${d.line}:${d.column} ${d.message}${d.source ? ` [${d.source}]` : ''}`;
          })
          .join('\n');
      },
    },
  ];
}

// Default LSP configs
export const DEFAULT_LSP_CONFIGS: Record<string, LspConfig> = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
  },
  python: {
    command: 'pyright-langserver',
    args: ['--stdio'],
  },
  go: {
    command: 'gopls',
  },
  rust: {
    command: 'rust-analyzer',
  },
};
