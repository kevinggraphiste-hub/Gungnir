import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const PROMPT_FILES = [
  '.spearcode-prompt.md',
  '.spearcode/prompt.md',
  'SYSTEM_PROMPT.md',
];

export async function loadCustomPrompt(cwd: string): Promise<string | undefined> {
  for (const filename of PROMPT_FILES) {
    const filePath = join(cwd, filename);
    if (existsSync(filePath)) {
      try {
        const content = await readFile(filePath, 'utf-8');
        if (content.trim()) return content.trim();
      } catch {
        // skip
      }
    }
  }
  return undefined;
}

export function buildCustomPromptSection(customPrompt: string): string {
  return `\n\n## Custom System Instructions\n\n${customPrompt}\n`;
}
