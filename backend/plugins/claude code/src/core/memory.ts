import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const MEMORY_FILENAME = '.spearcode.md';

export interface ProjectMemory {
  filePath: string;
  content: string;
  exists: boolean;
}

export async function loadMemory(cwd: string): Promise<ProjectMemory> {
  const filePath = join(cwd, MEMORY_FILENAME);

  if (!existsSync(filePath)) {
    return { filePath, content: '', exists: false };
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    return { filePath, content, exists: true };
  } catch {
    return { filePath, content: '', exists: false };
  }
}

export async function saveMemory(cwd: string, content: string): Promise<void> {
  const filePath = join(cwd, MEMORY_FILENAME);
  await writeFile(filePath, content, 'utf-8');
}

export async function appendToMemory(cwd: string, section: string, entry: string): Promise<void> {
  const memory = await loadMemory(cwd);

  // Find the section
  const sectionRegex = new RegExp(`^## ${section}`, 'mi');
  const match = memory.content.match(sectionRegex);

  if (match && match.index !== undefined) {
    // Find the end of this section (next ## or end of file)
    const afterSection = memory.content.slice(match.index + match[0].length);
    const nextSection = afterSection.search(/^## /m);
    const insertPoint = nextSection === -1
      ? memory.content.length
      : match.index + match[0].length + nextSection;

    const updated =
      memory.content.slice(0, insertPoint) +
      `\n- ${entry}\n` +
      memory.content.slice(insertPoint);

    await saveMemory(cwd, updated);
  } else {
    // Section doesn't exist, append it
    const newSection = `\n\n## ${section}\n\n- ${entry}\n`;
    await appendFile(join(cwd, MEMORY_FILENAME), newSection, 'utf-8');
  }
}

export async function initMemory(cwd: string, projectName?: string): Promise<string> {
  const memory = await loadMemory(cwd);
  if (memory.exists) return memory.content;

  const name = projectName ?? cwd.split(/[\\/]/).pop() ?? 'project';

  const template = `# ${name}

Project memory for SpearCode. This file is automatically updated during coding sessions.

## Architecture

<!-- Describe your project architecture -->

## Conventions

<!-- Coding conventions, style, patterns -->

## Important Files

<!-- Key files and their purposes -->

## Decisions

<!-- Technical decisions and rationale -->

## Pending

<!-- Tasks and TODOs -->

## Notes

<!-- General notes -->

`;

  await saveMemory(cwd, template);
  return template;
}

export function buildMemoryPrompt(memory: ProjectMemory): string {
  if (!memory.exists || !memory.content.trim()) return '';

  return `\n\n## Project Memory (.spearcode.md)\n\n${memory.content}\n`;
}
