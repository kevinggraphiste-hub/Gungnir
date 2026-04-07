import { readFile } from 'node:fs/promises';
import { join, relative, extname, dirname } from 'node:path';
import { glob as globFn } from 'glob';
import type { Tool } from '../types/index.js';

export interface ImpactResult {
  file: string;
  directDependents: string[];
  indirectDependents: string[];
  exportedSymbols: string[];
  importedBy: string[];
  risk: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
}

export function createImpactTools(cwd: string): Tool[] {
  return [
    {
      name: 'impact_analysis',
      description: 'Analyze the impact of modifying a file: who imports it, what depends on it',
      parameters: {
        path: {
          type: 'string',
          description: 'File path to analyze',
          required: true,
        },
        depth: {
          type: 'number',
          description: 'How deep to trace dependencies (default: 2)',
          required: false,
        },
      },
      async execute(args) {
        const filePath = join(cwd, args.path as string);
        const depth = (args.depth as number) || 2;

        const result = await analyzeImpact(cwd, filePath, depth);
        return formatImpact(result);
      },
    },
    {
      name: 'find_references',
      description: 'Find all references to a symbol (function, class, variable) across the codebase',
      parameters: {
        symbol: {
          type: 'string',
          description: 'Symbol name to search for',
          required: true,
        },
        type: {
          type: 'string',
          description: 'Symbol type: function, class, variable, all',
          required: false,
          enum: ['function', 'class', 'variable', 'all'],
        },
      },
      async execute(args) {
        const symbol = args.symbol as string;
        const type = (args.type as string) || 'all';

        const files = await globFn('**/*.{ts,tsx,js,jsx}', {
          cwd,
          ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
          nodir: true,
        });

        const references: Array<{ file: string; line: number; context: string }> = [];

        for (const file of files.slice(0, 100)) {
          try {
            const content = await readFile(join(cwd, file), 'utf-8');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              // Search for symbol usage (not definition unless it's an import)
              const regex = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
              if (regex.test(line)) {
                const isImport = /import|from|require/.test(line);
                const isDefinition = line.includes(`function ${symbol}`) ||
                  line.includes(`class ${symbol}`) ||
                  line.includes(`const ${symbol}`) ||
                  line.includes(`let ${symbol}`);

                if (type === 'all' || !isDefinition || isImport) {
                  references.push({
                    file,
                    line: i + 1,
                    context: line.trim().slice(0, 120),
                  });
                }
              }
            }
          } catch {}
        }

        if (!references.length) return `No references found for "${symbol}"`;

        const result: string[] = [`Found ${references.length} references to "${symbol}":\n`];
        for (const ref of references.slice(0, 30)) {
          result.push(`  ${ref.file}:${ref.line}  ${ref.context}`);
        }
        if (references.length > 30) {
          result.push(`\n... and ${references.length - 30} more`);
        }

        return result.join('\n');
      },
    },
    {
      name: 'dependency_graph',
      description: 'Show the dependency graph of a file (what it imports and what imports it)',
      parameters: {
        path: {
          type: 'string',
          description: 'File path',
          required: true,
        },
      },
      async execute(args) {
        const filePath = join(cwd, args.path as string);

        try {
          const content = await readFile(filePath, 'utf-8');
          const imports = extractImports(content);
          const importedBy = await findImportedBy(cwd, args.path as string);

          const lines: string[] = [];
          lines.push(`📁 ${args.path}\n`);

          if (imports.length) {
            lines.push('📥 Imports:');
            for (const imp of imports) lines.push(`  → ${imp}`);
          }

          if (importedBy.length) {
            lines.push('\n📤 Imported by:');
            for (const imp of importedBy) lines.push(`  ← ${imp}`);
          }

          if (!imports.length && !importedBy.length) {
            lines.push('(No dependencies detected)');
          }

          return lines.join('\n');
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}

async function analyzeImpact(cwd: string, filePath: string, depth: number): Promise<ImpactResult> {
  const relPath = relative(cwd, filePath);

  // Get exported symbols
  let content = '';
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return {
      file: relPath,
      directDependents: [],
      indirectDependents: [],
      exportedSymbols: [],
      importedBy: [],
      risk: 'low',
      summary: 'File not found',
    };
  }

  const exportedSymbols = extractExports(content);
  const importedBy = await findImportedBy(cwd, relPath);

  // Trace indirect dependents
  const indirect: string[] = [];
  if (depth > 1) {
    for (const importer of importedBy) {
      const transitiveImporters = await findImportedBy(cwd, importer);
      for (const ti of transitiveImporters) {
        if (!indirect.includes(ti) && !importedBy.includes(ti)) {
          indirect.push(ti);
        }
      }
    }
  }

  // Calculate risk
  let risk: ImpactResult['risk'] = 'low';
  const totalImpact = importedBy.length + indirect.length;
  if (totalImpact >= 20) risk = 'critical';
  else if (totalImpact >= 10) risk = 'high';
  else if (totalImpact >= 3) risk = 'medium';

  const summary = `${importedBy.length} direct + ${indirect.length} indirect dependents. Risk: ${risk}`;

  return {
    file: relPath,
    directDependents: importedBy,
    indirectDependents: indirect,
    exportedSymbols,
    importedBy,
    risk,
    summary,
  };
}

function formatImpact(result: ImpactResult): string {
  const lines: string[] = [];
  const riskIcon = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };

  lines.push(`${riskIcon[result.risk]} Impact Analysis: ${result.file}`);
  lines.push(`Risk level: ${result.risk.toUpperCase()}`);
  lines.push('');

  if (result.exportedSymbols.length) {
    lines.push(`📤 Exports: ${result.exportedSymbols.join(', ')}`);
  }

  if (result.directDependents.length) {
    lines.push('');
    lines.push(`📥 Direct dependents (${result.directDependents.length}):`);
    for (const dep of result.directDependents) lines.push(`  - ${dep}`);
  }

  if (result.indirectDependents.length) {
    lines.push('');
    lines.push(`📥 Indirect dependents (${result.indirectDependents.length}):`);
    for (const dep of result.indirectDependents.slice(0, 10)) lines.push(`  - ${dep}`);
    if (result.indirectDependents.length > 10) {
      lines.push(`  ... and ${result.indirectDependents.length - 10} more`);
    }
  }

  lines.push('');
  lines.push(`📊 ${result.summary}`);

  return lines.join('\n');
}

function extractImports(content: string): string[] {
  const imports: string[] = [];
  const matches = content.matchAll(/(?:from|require\()['"]([^'"./][^'"]*)['"]\)?/g);
  for (const m of matches) imports.push(m[1]);
  return [...new Set(imports)];
}

function extractExports(content: string): string[] {
  const exports: string[] = [];
  const matches = content.matchAll(/export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g);
  for (const m of matches) exports.push(m[1]);
  return exports;
}

async function findImportedBy(cwd: string, targetFile: string): Promise<string[]> {
  const files = await globFn('**/*.{ts,tsx,js,jsx}', {
    cwd,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
    nodir: true,
  });

  const relTarget = targetFile.replace(extname(targetFile), '');
  const importers: string[] = [];

  for (const file of files.slice(0, 200)) {
    if (file === targetFile) continue;
    try {
      const content = await readFile(join(cwd, file), 'utf-8');
      // Check for import of the target file
      const regex = new RegExp(`(?:from|require\\()['"].*${escapeRegex(relTarget)}['"]\\)?`);
      if (regex.test(content)) {
        importers.push(file);
      }
    } catch {}
  }

  return importers;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[/\\\\]');
}
