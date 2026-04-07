import { createInterface } from 'node:readline';

export type PermissionLevel = 'allow' | 'deny' | 'ask';

export interface PermissionRule {
  toolName: string;
  level: PermissionLevel;
  // Optional: specific args patterns to always allow/deny
  allowPatterns?: RegExp[];
  denyPatterns?: RegExp[];
}

export interface PermissionResult {
  allowed: boolean;
  rememberSession?: boolean;
}

const DEFAULT_RULES: PermissionRule[] = [
  // Always allow safe reads
  { toolName: 'read_file', level: 'allow' },
  { toolName: 'list_files', level: 'allow' },
  { toolName: 'glob', level: 'allow' },
  { toolName: 'grep', level: 'allow' },
  { toolName: 'get_project_context', level: 'allow' },
  // Ask for writes and edits
  { toolName: 'write_file', level: 'ask' },
  { toolName: 'edit_file', level: 'ask' },
  // Ask for shell commands
  { toolName: 'bash', level: 'ask' },
];

export class PermissionManager {
  private rules: Map<string, PermissionRule> = new Map();
  private sessionAllowed: Set<string> = new Set();
  private sessionDenied: Set<string> = new Set();
  private autoApproveAll = false;
  private interactive = true;

  constructor(customRules?: PermissionRule[]) {
    const rules = customRules ?? DEFAULT_RULES;
    for (const rule of rules) {
      this.rules.set(rule.toolName, rule);
    }
  }

  setInteractive(value: boolean) {
    this.interactive = value;
  }

  setAutoApproveAll(value: boolean) {
    this.autoApproveAll = value;
  }

  async check(toolName: string, args: Record<string, unknown>): Promise<PermissionResult> {
    // If auto-approve is on (non-interactive mode / -p flag)
    if (this.autoApproveAll || !this.interactive) {
      return { allowed: true };
    }

    // Check session-level remembers
    const key = `${toolName}`;
    if (this.sessionAllowed.has(key)) return { allowed: true };
    if (this.sessionDenied.has(key)) return { allowed: false };

    const rule = this.rules.get(toolName);

    // No rule = ask by default for unknown tools
    if (!rule) {
      return this.promptUser(toolName, args);
    }

    switch (rule.level) {
      case 'allow':
        return { allowed: true };
      case 'deny':
        return { allowed: false };
      case 'ask':
        return this.promptUser(toolName, args);
    }
  }

  private async promptUser(toolName: string, args: Record<string, unknown>): Promise<PermissionResult> {
    if (!this.interactive) return { allowed: true };

    const argsPreview = formatArgsForDisplay(args);

    console.log('');
    console.log(`\x1b[33m  ⚠ Tool execution request:\x1b[0m`);
    console.log(`\x1b[1m    ${toolName}\x1b[0m(${argsPreview})`);
    console.log('');
    console.log('  [A] Allow once    [S] Allow session    [D] Deny    [X] Deny session');
    console.log('');

    const answer = await this.prompt('  Your choice [A] : ');
    const choice = answer.trim().toLowerCase();

    switch (choice) {
      case 'a':
      case '':
        return { allowed: true };
      case 's':
        this.sessionAllowed.add(toolName);
        return { allowed: true, rememberSession: true };
      case 'd':
        return { allowed: false };
      case 'x':
        this.sessionDenied.add(toolName);
        return { allowed: false, rememberSession: true };
      default:
        return { allowed: false };
    }
  }

  private prompt(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((res) => {
      rl.question(question, (answer) => {
        rl.close();
        res(answer);
      });
    });
  }

  clearSession() {
    this.sessionAllowed.clear();
    this.sessionDenied.clear();
  }
}

function formatArgsForDisplay(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      if (typeof v === 'string' && v.length > 80) {
        return `${k}="${v.slice(0, 80)}..."`;
      }
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(', ');
}
