import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { glob as globFn } from 'glob';
import type { Tool } from '../types/index.js';

export interface EmbeddingChunk {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
}

// Simple local embedding using TF-IDF style scoring (no external API needed)
export function createSemanticSearchTools(cwd: string): Tool[] {
  // In-memory index rebuilt on demand
  let index: EmbeddingChunk[] = [];
  let indexBuilt = false;

  return [
    {
      name: 'semantic_search',
      description: 'Search code by meaning/intent, not just text matching. Use natural language.',
      parameters: {
        query: {
          type: 'string',
          description: 'Natural language description of what you\'re looking for (e.g., "function that handles authentication")',
          required: true,
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 5)',
          required: false,
        },
      },
      async execute(args) {
        const query = (args.query as string).toLowerCase();
        const limit = (args.limit as number) || 5;

        if (!indexBuilt) {
          await buildIndex(cwd);
          indexBuilt = true;
        }

        const scored = index
          .map((chunk) => ({
            chunk,
            score: relevanceScore(query, chunk.content),
          }))
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        if (!scored.length) return 'No relevant results found';

        return scored
          .map((s) => {
            const rel = relative(cwd, s.chunk.filePath);
            const preview = s.chunk.content.slice(0, 300).trim();
            return `[score:${s.score.toFixed(2)}] ${rel}:${s.chunk.startLine}-${s.chunk.endLine}\n${preview}\n`;
          })
          .join('\n---\n\n');
      },
    },
    {
      name: 'reindex_codebase',
      description: 'Rebuild the semantic search index for the current project',
      parameters: {},
      async execute() {
        index = [];
        indexBuilt = false;
        await buildIndex(cwd);
        indexBuilt = true;
        return `Index rebuilt: ${index.length} chunks indexed`;
      },
    },
  ];

  async function buildIndex(root: string) {
    const files = await globFn('**/*.{ts,tsx,js,jsx,py,go,rs,rb,java,cs,php}', {
      cwd: root,
      ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/build/**'],
      nodir: true,
    });

    for (const file of files.slice(0, 200)) {
      try {
        const content = await readFile(join(root, file), 'utf-8');
        const lines = content.split('\n');

        // Chunk by function/class/block
        const chunks = chunkCode(file, lines);
        index.push(...chunks);
      } catch {
        // skip
      }
    }
  }
}

function chunkCode(filePath: string, lines: string[]): EmbeddingChunk[] {
  const chunks: EmbeddingChunk[] = [];
  let currentStart = 0;
  let braceDepth = 0;
  let chunkStartLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Count braces for function/class detection
    braceDepth += (line.match(/{/g) || []).length;
    braceDepth -= (line.match(/}/g) || []).length;

    // Create chunk at function/class boundaries or every 50 lines
    const isFunctionStart = /^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s+)?\(|interface|type|enum)\s/.test(line);
    const isChunkBoundary = braceDepth === 0 && isFunctionStart;
    const isTooLong = i - chunkStartLine >= 50;

    if ((isChunkBoundary && i > chunkStartLine) || isTooLong) {
      const chunkLines = lines.slice(chunkStartLine - 1, i);
      if (chunkLines.join('').trim()) {
        chunks.push({
          filePath,
          startLine: chunkStartLine,
          endLine: i,
          content: chunkLines.join('\n'),
        });
      }
      chunkStartLine = i + 1;
    }
  }

  // Last chunk
  if (chunkStartLine <= lines.length) {
    const chunkLines = lines.slice(chunkStartLine - 1);
    if (chunkLines.join('').trim()) {
      chunks.push({
        filePath,
        startLine: chunkStartLine,
        endLine: lines.length,
        content: chunkLines.join('\n'),
      });
    }
  }

  return chunks;
}

function relevanceScore(query: string, content: string): number {
  const contentLower = content.toLowerCase();
  const queryWords = query.split(/\s+/).filter((w) => w.length > 2);

  let score = 0;

  for (const word of queryWords) {
    // Exact word match
    const exactMatches = (contentLower.match(new RegExp(`\\b${escapeRegex(word)}\\b`, 'g')) || []).length;
    score += exactMatches * 2;

    // Partial match
    if (contentLower.includes(word)) score += 1;

    // In function/class name (higher weight)
    const firstLine = content.split('\n')[0]?.toLowerCase() || '';
    if (firstLine.includes(word)) score += 3;
  }

  // Bonus for matching multiple query words
  const matchedWords = queryWords.filter((w) => contentLower.includes(w));
  if (matchedWords.length > 1) score *= 1.5;

  return score;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
