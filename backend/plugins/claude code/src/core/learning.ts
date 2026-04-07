import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export interface Correction {
  id: string;
  timestamp: number;
  original: string;
  corrected: string;
  context: string;
  category: 'code' | 'explanation' | 'approach' | 'tool_usage' | 'style';
  tags: string[];
}

const CORRECTIONS_FILE = 'corrections.json';

export async function loadCorrections(cwd: string): Promise<Correction[]> {
  const dir = join(cwd, '.spearcode');
  const file = join(dir, CORRECTIONS_FILE);

  if (!existsSync(file)) return [];

  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return [];
  }
}

export async function saveCorrection(cwd: string, correction: Omit<Correction, 'id' | 'timestamp'>): Promise<Correction> {
  const dir = join(cwd, '.spearcode');
  await mkdir(dir, { recursive: true });

  const corrections = await loadCorrections(cwd);

  const entry: Correction = {
    ...correction,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  };

  corrections.push(entry);

  // Keep max 500 corrections
  if (corrections.length > 500) {
    corrections.splice(0, corrections.length - 500);
  }

  await writeFile(join(dir, CORRECTIONS_FILE), JSON.stringify(corrections, null, 2));

  return entry;
}

export function buildCorrectionsPrompt(corrections: Correction[]): string {
  if (!corrections.length) return '';

  // Get recent corrections (last 50)
  const recent = corrections.slice(-50);

  // Group by category
  const grouped: Record<string, Correction[]> = {};
  for (const c of recent) {
    if (!grouped[c.category]) grouped[c.category] = [];
    grouped[c.category].push(c);
  }

  const lines: string[] = ['## Learned Corrections (from previous sessions)\n'];

  for (const [category, corrs] of Object.entries(grouped)) {
    lines.push(`### ${category}\n`);
    for (const c of corrs.slice(-10)) {
      lines.push(`- ❌ Don't: ${c.original.slice(0, 100)}`);
      lines.push(`  ✅ Do: ${c.corrected.slice(0, 100)}`);
      if (c.tags.length) lines.push(`  Tags: ${c.tags.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function detectCorrection(userMessage: string, previousAiResponse: string): Omit<Correction, 'id' | 'timestamp'> | null {
  const lower = userMessage.toLowerCase();

  // Detect correction patterns
  const correctionPatterns = [
    { pattern: /^(no|non|wrong|faux|incorrect)[,.]?\s*/i, category: 'approach' as const },
    { pattern: /^(it should|ça devrait|use|utilise|instead|au lieu)[,.]?\s*/i, category: 'approach' as const },
    { pattern: /^(don'?t|ne\s+(pas|fais\s+pas))[,.]?\s*/i, category: 'style' as const },
    { pattern: /^(actually|en fait|correction)[,.]?\s*/i, category: 'explanation' as const },
    { pattern: /^(fix|corrige|répare)[,.]?\s*/i, category: 'code' as const },
    { pattern: /^(better|mieux|prefer|préfère)[,.]?\s*/i, category: 'style' as const },
  ];

  for (const { pattern, category } of correctionPatterns) {
    if (pattern.test(userMessage)) {
      const corrected = userMessage.replace(pattern, '').trim();
      if (corrected.length > 10) {
        return {
          original: previousAiResponse.slice(0, 500),
          corrected: corrected.slice(0, 500),
          context: userMessage.slice(0, 200),
          category,
          tags: extractTags(userMessage),
        };
      }
    }
  }

  return null;
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  const techTerms = text.match(/\b(typescript|javascript|react|python|go|rust|git|sql|css|html|api|async|await|function|class|interface|test|error|bug)\b/gi);
  if (techTerms) {
    tags.push(...new Set(techTerms.map((t) => t.toLowerCase())));
  }
  return tags;
}
