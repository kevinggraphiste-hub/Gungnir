import { spawn } from 'node:child_process';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export async function openInEditor(initialContent = ''): Promise<string> {
  const editor = getEditor();
  const tmpFile = join(tmpdir(), `spearcode-${randomUUID()}.md`);

  await writeFile(tmpFile, initialContent, 'utf-8');

  return new Promise((resolve, reject) => {
    const proc = spawn(editor, [tmpFile], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    proc.on('exit', async (code) => {
      try {
        if (code === 0) {
          const content = await readFile(tmpFile, 'utf-8');
          await unlink(tmpFile).catch(() => {});
          resolve(content.trim());
        } else {
          await unlink(tmpFile).catch(() => {});
          reject(new Error(`Editor exited with code ${code}`));
        }
      } catch (err) {
        reject(err);
      }
    });

    proc.on('error', async (err) => {
      await unlink(tmpFile).catch(() => {});
      reject(err);
    });
  });
}

function getEditor(): string {
  // Priority: VISUAL > EDITOR > platform default
  if (process.env.VISUAL) return process.env.VISUAL;
  if (process.env.EDITOR) return process.env.EDITOR;

  // Check for common editors
  if (process.platform === 'win32') {
    return 'notepad';
  }

  // Try to detect common Unix editors
  return 'vi';
}

export function getEditorHint(): string {
  const editor = getEditor();
  return `Ctrl+E to open ${editor}`;
}
