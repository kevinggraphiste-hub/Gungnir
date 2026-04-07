import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { Tool } from '../types/index.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    });
    return [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    if (output) return output;
    throw new Error(error.message ?? 'Git command failed');
  }
}

export function createGitTools(cwd: string): Tool[] {
  return [
    {
      name: 'git_status',
      description: 'Show git working tree status (modified, staged, untracked files)',
      parameters: {},
      async execute() {
        return git(cwd, ['status', '--short', '--branch']);
      },
    },
    {
      name: 'git_diff',
      description: 'Show git diff. Can show staged or unstaged changes.',
      parameters: {
        staged: {
          type: 'boolean',
          description: 'Show staged changes instead of unstaged',
          required: false,
        },
        path: {
          type: 'string',
          description: 'Specific file path to diff',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['diff'];
        if (args.staged) cmd.push('--staged');
        if (args.path) { cmd.push('--', args.path as string); }
        return git(cwd, cmd);
      },
    },
    {
      name: 'git_log',
      description: 'Show recent git commit history',
      parameters: {
        limit: {
          type: 'number',
          description: 'Number of commits to show (default: 10)',
          required: false,
        },
        path: {
          type: 'string',
          description: 'Filter commits affecting a specific file',
          required: false,
        },
      },
      async execute(args) {
        const limit = (args.limit as number) || 10;
        const cmd = ['log', `--max-count=${limit}`, '--oneline', '--graph', '--decorate'];
        if (args.path) { cmd.push('--', args.path as string); }
        return git(cwd, cmd);
      },
    },
    {
      name: 'git_blame',
      description: 'Show who last modified each line of a file',
      parameters: {
        path: {
          type: 'string',
          description: 'File path to blame',
          required: true,
        },
        line_start: {
          type: 'number',
          description: 'Start line number',
          required: false,
        },
        line_end: {
          type: 'number',
          description: 'End line number',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['blame', '-L'];
        const start = (args.line_start as number) || 1;
        const end = (args.line_end as number) || start + 50;
        cmd.push(`${start},${end}`);
        cmd.push(args.path as string);
        return git(cwd, cmd);
      },
    },
    {
      name: 'git_show',
      description: 'Show a specific commit or file content at a commit',
      parameters: {
        ref: {
          type: 'string',
          description: 'Commit hash, tag, or branch (e.g., HEAD, abc123, main)',
          required: true,
        },
        path: {
          type: 'string',
          description: 'Specific file to show from that commit',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['show', '--stat'];
        if (args.path) {
          cmd.push(`${args.ref}:${args.path as string}`);
        } else {
          cmd.push(args.ref as string);
        }
        return git(cwd, cmd);
      },
    },
    {
      name: 'git_branch',
      description: 'List branches or show current branch',
      parameters: {
        all: {
          type: 'boolean',
          description: 'Show all branches including remote',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['branch'];
        if (args.all) cmd.push('-a');
        cmd.push('--sort=-committerdate');
        return git(cwd, cmd);
      },
    },
    {
      name: 'git_stash',
      description: 'Stash current changes or list stashes',
      parameters: {
        action: {
          type: 'string',
          description: 'Action: list, push, pop, apply',
          required: false,
          enum: ['list', 'push', 'pop', 'apply'],
        },
        message: {
          type: 'string',
          description: 'Stash message (for push)',
          required: false,
        },
      },
      async execute(args) {
        const action = (args.action as string) || 'list';
        const cmd = ['stash'];
        if (action === 'list') cmd.push('list');
        else if (action === 'push') {
          cmd.push('push');
          if (args.message) cmd.push('-m', args.message as string);
        }
        else if (action === 'pop') cmd.push('pop');
        else if (action === 'apply') cmd.push('apply');
        return git(cwd, cmd);
      },
    },
    {
      name: 'git_add',
      description: 'Stage files for commit',
      parameters: {
        path: {
          type: 'string',
          description: 'File path to stage (use "." for all)',
          required: true,
        },
      },
      async execute(args) {
        return git(cwd, ['add', args.path as string]);
      },
    },
    {
      name: 'git_commit',
      description: 'Create a commit with staged changes',
      parameters: {
        message: {
          type: 'string',
          description: 'Commit message',
          required: true,
        },
        all: {
          type: 'boolean',
          description: 'Stage all modified files before committing',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['commit'];
        if (args.all) cmd.push('-a');
        cmd.push('-m', args.message as string);
        return git(cwd, cmd);
      },
    },
    {
      name: 'git_checkout',
      description: 'Switch branch or restore files',
      parameters: {
        branch: {
          type: 'string',
          description: 'Branch name to switch to',
          required: true,
        },
        create: {
          type: 'boolean',
          description: 'Create the branch if it doesn\'t exist',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['checkout'];
        if (args.create) cmd.push('-b');
        cmd.push(args.branch as string);
        return git(cwd, cmd);
      },
    },
  ];
}
