import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '../types/index.js';

const execFileAsync = promisify(execFile);

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header';
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface FileDiff {
  file: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export function createDiffTools(cwd: string): Tool[] {
  return [
    {
      name: 'visual_diff',
      description: 'Show a beautiful side-by-side diff of changes (staged or unstaged)',
      parameters: {
        staged: {
          type: 'boolean',
          description: 'Show staged changes',
          required: false,
        },
        path: {
          type: 'string',
          description: 'Specific file to diff',
          required: false,
        },
        width: {
          type: 'number',
          description: 'Terminal width for side-by-side (default: 80)',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['diff', '--color=never', '--unified=5'];
        if (args.staged) cmd.push('--staged');
        if (args.path) cmd.push('--', args.path as string);

        try {
          const { stdout } = await execFileAsync('git', cmd, { cwd, maxBuffer: 512 * 1024 });
          if (!stdout.trim()) return 'No changes detected';

          const files = parseDiff(stdout);
          const width = (args.width as number) || 80;

          return renderVisualDiff(files, width);
        } catch (err: unknown) {
          const error = err as { stdout?: string };
          if (error.stdout) {
            const files = parseDiff(error.stdout);
            return renderVisualDiff(files, (args.width as number) || 80);
          }
          return `Diff error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'diff_summary',
      description: 'Show a summary of all changed files with stats',
      parameters: {
        staged: {
          type: 'boolean',
          description: 'Show staged changes',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['diff', '--stat', '--color=never'];
        if (args.staged) cmd.push('--staged');

        try {
          const { stdout } = await execFileAsync('git', cmd, { cwd });
          return stdout.trim() || 'No changes';
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}

export function parseDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  const fileSections = raw.split(/^diff --git/gm).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split('\n');
    const fileMatch = lines[0]?.match(/b\/(.+)$/);
    const file = fileMatch ? fileMatch[1] : 'unknown';

    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let oldLine = 0;
    let newLine = 0;
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)/);
      if (hunkMatch) {
        oldLine = parseInt(hunkMatch[1]);
        newLine = parseInt(hunkMatch[2]);
        currentHunk = { header: line, lines: [] };
        hunks.push(currentHunk);
        continue;
      }

      if (!currentHunk) continue;

      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.lines.push({ type: 'add', newLine: newLine++, content: line.slice(1) });
        additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.lines.push({ type: 'remove', oldLine: oldLine++, content: line.slice(1) });
        deletions++;
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({ type: 'context', oldLine: oldLine++, newLine: newLine++, content: line.slice(1) });
      }
    }

    files.push({ file, additions, deletions, hunks });
  }

  return files;
}

export function renderVisualDiff(files: FileDiff[], width: number): string {
  const halfWidth = Math.floor(width / 2) - 3;
  const lines: string[] = [];

  for (const file of files) {
    // File header
    lines.push('');
    lines.push(`${'═'.repeat(width)}`);
    lines.push(`📄 ${file.file}  +${file.additions} -${file.deletions}`);
    lines.push(`${'═'.repeat(width)}`);

    for (const hunk of file.hunks) {
      lines.push('');
      lines.push(`  ${hunk.header}`);
      lines.push(`  ${'─'.repeat(width - 4)}`);

      // Render lines with add/remove pairs aligned
      let i = 0;
      while (i < hunk.lines.length) {
        const line = hunk.lines[i];

        if (line.type === 'context') {
          const padded = line.content.padEnd(halfWidth);
          const lineNum = String(line.oldLine ?? '').padStart(4);
          lines.push(`  ${lineNum} │ ${padded} │ ${lineNum} │ ${line.content}`);
        } else if (line.type === 'remove') {
          // Check if next line is an add (show side by side)
          const next = hunk.lines[i + 1];
          if (next?.type === 'add') {
            const oldPadded = truncate(line.content, halfWidth).padEnd(halfWidth);
            const newPadded = truncate(next.content, halfWidth);
            const oldNum = String(line.oldLine ?? '').padStart(4);
            const newNum = String(next.newLine ?? '').padStart(4);
            lines.push(`\x1b[31m  ${oldNum} │ ${oldPadded}\x1b[0m │ \x1b[32m${newNum} │ ${newPadded}\x1b[0m`);
            i += 2;
            continue;
          } else {
            const padded = truncate(line.content, halfWidth).padEnd(halfWidth);
            const lineNum = String(line.oldLine ?? '').padStart(4);
            lines.push(`\x1b[31m  ${lineNum} │ ${padded}\x1b[0m │      │\x1b[0m`);
          }
        } else if (line.type === 'add') {
          const padded = truncate(line.content, halfWidth).padEnd(halfWidth);
          const lineNum = String(line.newLine ?? '').padStart(4);
          lines.push(`      │ ${''.padEnd(halfWidth)} │ \x1b[32m${lineNum} │ ${padded}\x1b[0m`);
        }

        i++;
      }
    }
  }

  return lines.join('\n');
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}
