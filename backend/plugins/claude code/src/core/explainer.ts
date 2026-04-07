import { readFile } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import type { Tool } from '../types/index.js';

export function createExplainerTools(cwd: string): Tool[] {
  return [
    {
      name: 'explain_code',
      description: 'Explain a code snippet or file in simple terms. Supports multiple languages.',
      parameters: {
        path: {
          type: 'string',
          description: 'File path to explain (or use code parameter)',
          required: false,
        },
        code: {
          type: 'string',
          description: 'Code snippet to explain (or use path parameter)',
          required: false,
        },
        language: {
          type: 'string',
          description: 'Programming language (auto-detected from file extension)',
          required: false,
        },
        detail: {
          type: 'string',
          description: 'Level of detail: brief, normal, detailed',
          required: false,
          enum: ['brief', 'normal', 'detailed'],
        },
      },
      async execute(args) {
        let code = args.code as string;
        let language = (args.language as string) || 'code';

        if (args.path) {
          const filePath = resolve(cwd, args.path as string);
          try {
            code = await readFile(filePath, 'utf-8');
            const ext = extname(filePath).slice(1);
            language = detectLanguage(ext);
          } catch (err) {
            return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        if (!code) return 'Provide either a file path or code snippet';

        const detail = (args.detail as string) || 'normal';
        const analysis = analyzeCode(code, language, detail);

        return formatExplanation(analysis, language, args.path as string | undefined);
      },
    },
    {
      name: 'explain_function',
      description: 'Explain a specific function in a file',
      parameters: {
        path: {
          type: 'string',
          description: 'File path',
          required: true,
        },
        function_name: {
          type: 'string',
          description: 'Function name to explain',
          required: true,
        },
      },
      async execute(args) {
        const filePath = resolve(cwd, args.path as string);
        const content = await readFile(filePath, 'utf-8');
        const fnName = args.function_name as string;

        // Find the function
        const lines = content.split('\n');
        let startLine = -1;
        let endLine = -1;
        let braceCount = 0;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.includes(fnName) && (line.includes('function') || line.includes('=>') || line.includes(`${fnName}(`))) {
            startLine = i;
            for (let j = i; j < lines.length; j++) {
              braceCount += (lines[j].match(/{/g) || []).length;
              braceCount -= (lines[j].match(/}/g) || []).length;
              if (braceCount === 0 && j > i) {
                endLine = j;
                break;
              }
            }
            break;
          }
        }

        if (startLine === -1) return `Function "${fnName}" not found in ${args.path}`;

        const fnCode = lines.slice(startLine, endLine + 1).join('\n');
        const analysis = analyzeCode(fnCode, 'function', 'detailed');

        const result: string[] = [];
        result.push(`# Function: ${fnName}`);
        result.push(`📍 ${args.path}:${startLine + 1}-${endLine + 1}`);
        result.push('');
        result.push('## What it does');
        result.push(analysis.purpose);
        result.push('');
        if (analysis.inputs.length) {
          result.push('## Inputs');
          for (const input of analysis.inputs) {
            result.push(`- ${input}`);
          }
          result.push('');
        }
        if (analysis.outputs.length) {
          result.push('## Outputs');
          for (const output of analysis.outputs) {
            result.push(`- ${output}`);
          }
          result.push('');
        }
        if (analysis.sideEffects.length) {
          result.push('## Side effects');
          for (const se of analysis.sideEffects) {
            result.push(`- ${se}`);
          }
          result.push('');
        }
        if (analysis.complexity) {
          result.push(`## Complexity: ${analysis.complexity}`);
        }

        return result.join('\n');
      },
    },
  ];
}

interface CodeAnalysis {
  purpose: string;
  inputs: string[];
  outputs: string[];
  sideEffects: string[];
  complexity: string;
  patterns: string[];
  dependencies: string[];
  lines: number;
}

function analyzeCode(code: string, language: string, detail: string): CodeAnalysis {
  const lines = code.split('\n');
  const analysis: CodeAnalysis = {
    purpose: '',
    inputs: [],
    outputs: [],
    sideEffects: [],
    complexity: '',
    patterns: [],
    dependencies: [],
    lines: lines.length,
  };

  // Detect purpose from function/variable names and comments
  const comments = lines.filter((l) => /^\s*(\/\/|\/\*|\*|#)/.test(l)).map((l) => l.trim());
  const fnNames = code.match(/(?:function|const|let|var)\s+(\w+)/g) || [];
  analysis.purpose = fnNames.length
    ? `Defines: ${fnNames.map((n) => n.split(/\s+/).pop()).join(', ')}`
    : 'Code block';

  if (comments.length) {
    analysis.purpose += `. ${comments[0]}`;
  }

  // Detect inputs (parameters, imports)
  const params = code.match(/(?:function|=>)\s*\(([^)]*)\)/)?.[1];
  if (params) {
    analysis.inputs = params.split(',').map((p) => p.trim()).filter(Boolean);
  }

  // Detect outputs (return statements)
  const returns = code.matchAll(/return\s+(.{1,100})/g);
  for (const r of returns) {
    analysis.outputs.push(r[1].trim());
  }

  // Detect side effects
  if (/console\./.test(code)) analysis.sideEffects.push('Console output');
  if (/fs\.|writeFile|readFile/.test(code)) analysis.sideEffects.push('File system operations');
  if (/fetch|axios|http/.test(code)) analysis.sideEffects.push('Network requests');
  if (/setTimeout|setInterval/.test(code)) analysis.sideEffects.push('Timers');
  if (/\.send\(|\.emit\(/.test(code)) analysis.sideEffects.push('Events/messages');
  if (/process\.exit/.test(code)) analysis.sideEffects.push('Process termination');

  // Detect patterns
  if (/async|await/.test(code)) analysis.patterns.push('Async/await');
  if (/Promise/.test(code)) analysis.patterns.push('Promises');
  if (/try\s*{/.test(code)) analysis.patterns.push('Error handling (try/catch)');
  if (/for\s*\(|\.forEach|\.map|\.filter|\.reduce/.test(code)) analysis.patterns.push('Iteration');
  if (/class\s+/.test(code)) analysis.patterns.push('OOP (class)');
  if (/interface\s+/.test(code)) analysis.patterns.push('TypeScript interface');
  if (/export/.test(code)) analysis.patterns.push('Module export');
  if (/import/.test(code)) analysis.patterns.push('Module import');

  // Detect dependencies
  const imports = code.matchAll(/(?:from|require\()['"]([^'"]+)['"]/g);
  for (const m of imports) {
    analysis.dependencies.push(m[1]);
  }

  // Complexity estimation
  const cyclomatic = 1 +
    (code.match(/\b(if|else if|for|while|switch|case|\?\?|\|\||&&)\b/g) || []).length;

  if (cyclomatic <= 3) analysis.complexity = 'Low (simple logic)';
  else if (cyclomatic <= 8) analysis.complexity = `Medium (cyclomatic: ~${cyclomatic})`;
  else analysis.complexity = `High (cyclomatic: ~${cyclomatic}) - consider refactoring`;

  return analysis;
}

function formatExplanation(analysis: CodeAnalysis, language: string, filePath?: string): string {
  const lines: string[] = [];

  lines.push(`## ${language.charAt(0).toUpperCase() + language.slice(1)} Code${filePath ? ` (${filePath})` : ''}`);
  lines.push(`📊 ${analysis.lines} lines`);
  lines.push('');
  lines.push(`**Purpose:** ${analysis.purpose}`);

  if (analysis.inputs.length) {
    lines.push('');
    lines.push('**Inputs:**');
    for (const input of analysis.inputs) lines.push(`- \`${input}\``);
  }

  if (analysis.outputs.length) {
    lines.push('');
    lines.push('**Returns:**');
    for (const output of analysis.outputs) lines.push(`- \`${output}\``);
  }

  if (analysis.sideEffects.length) {
    lines.push('');
    lines.push('**Side effects:**');
    for (const se of analysis.sideEffects) lines.push(`- ⚠️ ${se}`);
  }

  if (analysis.patterns.length) {
    lines.push('');
    lines.push('**Patterns:** ' + analysis.patterns.join(', '));
  }

  if (analysis.dependencies.length) {
    lines.push('');
    lines.push('**Dependencies:** ' + analysis.dependencies.join(', '));
  }

  lines.push('');
  lines.push(`**Complexity:** ${analysis.complexity}`);

  return lines.join('\n');
}

function detectLanguage(ext: string): string {
  const langMap: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript React', js: 'JavaScript', jsx: 'JavaScript React',
    py: 'Python', go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java',
    cs: 'C#', cpp: 'C++', c: 'C', php: 'PHP', swift: 'Swift',
    kt: 'Kotlin', scala: 'Scala', ex: 'Elixir', hs: 'Haskell',
    sh: 'Shell', sql: 'SQL', html: 'HTML', css: 'CSS',
  };
  return langMap[ext] || ext.toUpperCase();
}
