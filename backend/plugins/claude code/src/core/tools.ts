import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { glob as globFn } from 'glob';
import type { Tool } from '../types/index.js';

const execFileAsync = promisify(execFile);

export function createFileTools(cwd: string): Tool[] {
  return [
    {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        path: {
          type: 'string',
          description: 'Path to the file to read (relative to working directory)',
          required: true,
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (1-indexed)',
          required: false,
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read',
          required: false,
        },
      },
      async execute(args) {
        const filePath = resolve(cwd, args.path as string);
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        const start = (args.offset as number) ? (args.offset as number) - 1 : 0;
        const end = args.limit ? start + (args.limit as number) : lines.length;
        const sliced = lines.slice(start, end);

        return sliced.map((line, i) => `${start + i + 1}: ${line}`).join('\n');
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file. Creates directories if needed.',
      parameters: {
        path: {
          type: 'string',
          description: 'Path to the file to write (relative to working directory)',
          required: true,
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
          required: true,
        },
      },
      async execute(args) {
        const filePath = resolve(cwd, args.path as string);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, args.content as string, 'utf-8');
        return `Successfully wrote to ${args.path}`;
      },
    },
    {
      name: 'edit_file',
      description: 'Edit a file by replacing text. Uses exact string matching.',
      parameters: {
        path: {
          type: 'string',
          description: 'Path to the file to edit',
          required: true,
        },
        old_string: {
          type: 'string',
          description: 'The exact text to find and replace',
          required: true,
        },
        new_string: {
          type: 'string',
          description: 'The replacement text',
          required: true,
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences',
          required: false,
        },
      },
      async execute(args) {
        const filePath = resolve(cwd, args.path as string);
        let content = await readFile(filePath, 'utf-8');
        const oldStr = args.old_string as string;
        const newStr = args.new_string as string;

        if (!content.includes(oldStr)) {
          throw new Error(`String not found in ${args.path}: "${oldStr.slice(0, 100)}..."`);
        }

        if (args.replace_all) {
          content = content.replaceAll(oldStr, newStr);
        } else {
          content = content.replace(oldStr, newStr);
        }

        await writeFile(filePath, content, 'utf-8');
        return `Successfully edited ${args.path}`;
      },
    },
    {
      name: 'list_files',
      description: 'List files and directories at a given path',
      parameters: {
        path: {
          type: 'string',
          description: 'Directory path to list (defaults to current directory)',
          required: false,
        },
      },
      async execute(args) {
        const dirPath = resolve(cwd, (args.path as string) || '.');
        const entries = await readdir(dirPath, { withFileTypes: true });
        const results: string[] = [];

        for (const entry of entries) {
          const suffix = entry.isDirectory() ? '/' : '';
          const fullPath = join(dirPath, entry.name);
          const s = await stat(fullPath);
          const size = entry.isFile() ? ` (${formatBytes(s.size)})` : '';
          results.push(`${entry.name}${suffix}${size}`);
        }

        return results.join('\n') || '(empty directory)';
      },
    },
  ];
}

export function createSearchTools(cwd: string): Tool[] {
  return [
    {
      name: 'glob',
      description: 'Find files matching a glob pattern',
      parameters: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match (e.g., "**/*.ts")',
          required: true,
        },
        path: {
          type: 'string',
          description: 'Directory to search in (defaults to working directory)',
          required: false,
        },
      },
      async execute(args) {
        const searchPath = resolve(cwd, (args.path as string) || '.');
        const files = await globFn(args.pattern as string, { cwd: searchPath, absolute: false });
        const relativeFiles = files.map((f: string) => relative(cwd, join(searchPath, f)));
        return relativeFiles.join('\n') || 'No files found';
      },
    },
    {
      name: 'grep',
      description: 'Search file contents using a regex pattern',
      parameters: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for',
          required: true,
        },
        path: {
          type: 'string',
          description: 'Directory or file to search in',
          required: false,
        },
        include: {
          type: 'string',
          description: 'File pattern to include (e.g., "*.ts")',
          required: false,
        },
      },
      async execute(args) {
        const searchPath = resolve(cwd, (args.path as string) || '.');
        const include = (args.include as string) || '*';
        const files = await globFn(include, { cwd: searchPath, absolute: true });
        const regex = new RegExp(args.pattern as string, 'gi');
        const results: string[] = [];

        for (const file of files) {
          try {
            const content = await readFile(file, 'utf-8');
            const lines = content.split('\n');
            const relPath = relative(cwd, file);

            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
              }
              regex.lastIndex = 0;
            }
          } catch {
            // skip unreadable files
          }
        }

        return results.slice(0, 100).join('\n') || 'No matches found';
      },
    },
  ];
}

export function createShellTools(cwd: string, shellPath?: string): Tool[] {
  return [
    {
      name: 'bash',
      description: 'Execute a shell command',
      parameters: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
          required: true,
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
          required: false,
        },
      },
      async execute(args) {
        const timeout = (args.timeout as number) || 30000;
        const shell = shellPath || process.env.SHELL || (process.platform === 'win32' ? 'cmd' : '/bin/bash');
        const shellArgs = process.platform === 'win32' ? ['/c', args.command as string] : ['-c', args.command as string];

        try {
          const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
            cwd,
            timeout,
            maxBuffer: 1024 * 1024,
          });
          const output = [stdout, stderr].filter(Boolean).join('\n').trim();
          return output || '(no output)';
        } catch (err: unknown) {
          const error = err as { stdout?: string; stderr?: string; message?: string };
          const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
          if (output) return output;
          throw new Error(error.message ?? 'Command failed');
        }
      },
    },
  ];
}

export function createAllTools(cwd: string, shellPath?: string): Tool[] {
  return [
    ...createFileTools(cwd),
    ...createSearchTools(cwd),
    ...createShellTools(cwd, shellPath),
  ];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
