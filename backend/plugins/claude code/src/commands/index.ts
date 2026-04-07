import { readFile, readdir } from 'node:fs/promises';
import { join, basename, extname, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { glob as globFn } from 'glob';

export interface CustomCommand {
  id: string;
  name: string;
  scope: 'user' | 'project';
  description: string;
  content: string;
  filePath: string;
}

export async function loadCommands(cwd: string): Promise<CustomCommand[]> {
  const commands: CustomCommand[] = [];

  // User commands
  const userDirs = [
    join(homedir(), '.spearcode', 'commands'),
    join(homedir(), '.config', 'spearcode', 'commands'),
  ];

  for (const dir of userDirs) {
    if (existsSync(dir)) {
      const found = await loadCommandsFromDir(dir, 'user', dir);
      commands.push(...found);
    }
  }

  // Project commands
  const projectDir = join(cwd, '.spearcode', 'commands');
  if (existsSync(projectDir)) {
    const found = await loadCommandsFromDir(projectDir, 'project', projectDir);
    commands.push(...found);
  }

  return commands;
}

async function loadCommandsFromDir(
  dir: string,
  scope: 'user' | 'project',
  baseDir: string
): Promise<CustomCommand[]> {
  const commands: CustomCommand[] = [];

  try {
    const files = await globFn('**/*.md', { cwd: dir, absolute: true });

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, 'utf-8');
        const relPath = relative(baseDir, filePath);
        const name = basename(filePath, '.md');

        // Build command ID from path: e.g., "git:commit" for git/commit.md
        const dirParts = relPath.replace(/\\/g, '/').split('/');
        dirParts[dirParts.length - 1] = name;
        const id = `${scope}:${dirParts.join(':')}`;

        // Extract description from first line (H1 or first non-empty line)
        const lines = content.split('\n').filter((l) => l.trim());
        let description = '';
        for (const line of lines) {
          const h1 = line.match(/^#\s+(.+)/);
          if (h1) {
            description = h1[1];
            break;
          }
          if (line.trim() && !line.startsWith('#')) {
            description = line.slice(0, 80);
            break;
          }
        }

        commands.push({
          id,
          name,
          scope,
          description: description || `Custom command: ${name}`,
          content: content.trim(),
          filePath,
        });
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // skip
  }

  return commands;
}

export function interpolateCommand(
  content: string,
  args: Record<string, string>
): string {
  let result = content;

  for (const [key, value] of Object.entries(args)) {
    // Replace $NAME and ${NAME}
    result = result.replaceAll(`$${key}`, value);
    result = result.replaceAll(`\${${key}}`, value);
  }

  return result;
}

export function extractPlaceholders(content: string): string[] {
  const placeholders = new Set<string>();

  // Match $NAME (uppercase letters, numbers, underscores)
  const dollarMatches = content.matchAll(/\$([A-Z][A-Z0-9_]*)/g);
  for (const match of dollarMatches) {
    placeholders.add(match[1]);
  }

  // Match ${NAME}
  const braceMatches = content.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g);
  for (const match of braceMatches) {
    placeholders.add(match[1]);
  }

  return Array.from(placeholders);
}
