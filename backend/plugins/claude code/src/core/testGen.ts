import { readFile, readdir } from 'node:fs/promises';
import { join, extname, basename, relative } from 'node:path';
import { glob as globFn } from 'glob';
import type { Tool } from '../types/index.js';

export interface TestCase {
  name: string;
  input: string;
  expected: string;
  description: string;
}

export interface FunctionInfo {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  params: string[];
  returnType?: string;
  isAsync: boolean;
  isExported: boolean;
  body: string;
}

export function createTestGenerationTools(cwd: string): Tool[] {
  return [
    {
      name: 'generate_tests',
      description: 'Analyze a function/file and generate test cases. Shows the function signature and suggested tests.',
      parameters: {
        path: {
          type: 'string',
          description: 'File path to generate tests for',
          required: true,
        },
        function_name: {
          type: 'string',
          description: 'Specific function name (optional, analyzes all exported functions if omitted)',
          required: false,
        },
        framework: {
          type: 'string',
          description: 'Test framework: jest, vitest, mocha, node (default: auto-detect)',
          required: false,
          enum: ['jest', 'vitest', 'mocha', 'node'],
        },
      },
      async execute(args) {
        const filePath = join(cwd, args.path as string);
        const content = await readFile(filePath, 'utf-8');
        const specificFn = args.function_name as string | undefined;

        const functions = extractFunctions(content, filePath);

        const targetFns = specificFn
          ? functions.filter((f) => f.name === specificFn)
          : functions.filter((f) => f.isExported);

        if (!targetFns.length) {
          return `No ${specificFn ? `function "${specificFn}"` : 'exported functions'} found in ${args.path}`;
        }

        const framework = (args.framework as string) || detectTestFramework(cwd);
        const testFilePath = getTestFilePath(args.path as string, framework);

        const tests = targetFns.map((fn) => generateTestForFunction(fn, framework, args.path as string));

        return `Test file: ${testFilePath}\n\n${tests.join('\n\n')}`;
      },
    },
    {
      name: 'analyze_test_coverage',
      description: 'Find functions that don\'t have corresponding tests',
      parameters: {},
      async execute() {
        const sourceFiles = await globFn('**/*.{ts,tsx,js,jsx}', {
          cwd,
          ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**'],
          nodir: true,
        });

        const testFiles = await globFn('**/*.{test,spec}.{ts,tsx,js,jsx}', {
          cwd,
          ignore: ['**/node_modules/**', '**/dist/**'],
          nodir: true,
        });

        const untested: string[] = [];

        for (const file of sourceFiles.slice(0, 50)) {
          try {
            const content = await readFile(join(cwd, file), 'utf-8');
            const functions = extractFunctions(content, file);
            const exported = functions.filter((f) => f.isExported);

            for (const fn of exported) {
              const hasTest = testFiles.some((tf) => {
                const testContent = ''; // Would need to read
                return tf.includes(basename(file, extname(file)));
              });

              if (!hasTest) {
                untested.push(`${file}: ${fn.name} (line ${fn.startLine})`);
              }
            }
          } catch {
            // skip
          }
        }

        if (!untested.length) return 'All exported functions appear to have test files';

        return `Untested functions:\n${untested.map((u) => `  - ${u}`).join('\n')}`;
      },
    },
  ];
}

function extractFunctions(content: string, filePath: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = content.split('\n');

  // Patterns for different function declarations
  const patterns = [
    // export function name(...) : ReturnType { ... }
    {
      regex: /^(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?\s*\{/,
      nameIdx: 4,
      paramsIdx: 5,
      returnIdx: 6,
    },
    // export const name = (...) : ReturnType => { ... }
    {
      regex: /^(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s+)?\(([^)]*)\)\s*(?::\s*([^{=]+))?\s*=>\s*\{/,
      nameIdx: 3,
      paramsIdx: 5,
      returnIdx: 6,
    },
    // export const name = async function(...) { ... }
    {
      regex: /^(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s+)?function\s*\(([^)]*)\)\s*\{/,
      nameIdx: 3,
      paramsIdx: 5,
      returnIdx: undefined,
    },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (match) {
        const name = match[pattern.nameIdx];
        const params = (match[pattern.paramsIdx] || '').split(',').map((p) => p.trim()).filter(Boolean);
        const returnType = pattern.returnIdx ? match[pattern.returnIdx]?.trim() : undefined;
        const isAsync = line.includes('async');
        const isExported = line.includes('export');

        // Find function end (rough estimation)
        let braceCount = 0;
        let endLine = i;
        for (let j = i; j < Math.min(i + 200, lines.length); j++) {
          braceCount += (lines[j].match(/{/g) || []).length;
          braceCount -= (lines[j].match(/}/g) || []).length;
          if (braceCount === 0 && j > i) {
            endLine = j;
            break;
          }
        }

        functions.push({
          name,
          filePath,
          startLine: i + 1,
          endLine: endLine + 1,
          params,
          returnType,
          isAsync,
          isExported,
          body: lines.slice(i, endLine + 1).join('\n'),
        });

        break;
      }
    }
  }

  return functions;
}

function detectTestFramework(cwd: string): string {
  try {
    // Check package.json for test dependencies
    const pkgPath = join(cwd, 'package.json');
    const fs = require('node:fs');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps.vitest) return 'vitest';
      if (deps.jest) return 'jest';
      if (deps.mocha) return 'mocha';
    }
  } catch {}

  return 'node';
}

function getTestFilePath(sourcePath: string, framework: string): string {
  const ext = extname(sourcePath);
  const base = sourcePath.replace(ext, '');

  if (framework === 'vitest' || framework === 'jest') {
    return `${base}.test${ext}`;
  }

  return `tests/${basename(sourcePath, ext)}.test${ext}`;
}

function generateTestForFunction(fn: FunctionInfo, framework: string, sourcePath: string): string {
  const importPath = relative('tests', sourcePath).replace(/\\/g, '/').replace(extname(sourcePath), '');

  const describe = framework === 'mocha' ? 'describe' : 'describe';
  const it = framework === 'mocha' ? 'it' : 'it';
  const expect = framework === 'mocha' ? 'assert' : 'expect';
  const assertImport = framework === 'mocha' ? "import assert from 'node:assert';" : "import { describe, it, expect } from 'vitest';";

  const lines: string[] = [];

  if (framework === 'node') {
    lines.push("import { describe, it } from 'node:test';");
    lines.push("import assert from 'node:assert/strict';");
  } else if (framework === 'vitest') {
    lines.push("import { describe, it, expect } from 'vitest';");
  } else if (framework === 'jest') {
    lines.push("// Jest globals: describe, it, expect");
  } else {
    lines.push(assertImport);
  }

  lines.push(`import { ${fn.name} } from '${importPath}';`);
  lines.push('');
  lines.push(`describe('${fn.name}', () => {`);

  // Generate basic happy path test
  const paramMocks = fn.params.map((p) => {
    const paramName = p.split(':')[0].trim().replace('?', '');
    if (paramName.includes('path') || paramName.includes('file')) return `'test/path'`;
    if (paramName.includes('name') || paramName.includes('id')) return `'test-id'`;
    if (paramName.includes('count') || paramName.includes('limit') || paramName.includes('size')) return '10';
    if (paramName.includes('options') || paramName.includes('config')) return '{}';
    if (paramName.includes('callback') || paramName.includes('fn')) return '() => {}';
    return `'test'`;
  });

  lines.push(`  ${it}('should handle valid input', ${fn.isAsync ? 'async ' : ''}() => {`);
  lines.push(`    const result = ${fn.isAsync ? 'await ' : ''}${fn.name}(${paramMocks.join(', ')});`);
  lines.push(`    // TODO: Add assertions`);
  lines.push(`    ${expect === 'expect' ? 'expect(result).toBeDefined();' : 'assert.ok(result !== undefined);'}`);
  lines.push('  });');
  lines.push('');

  // Error case
  lines.push(`  ${it}('should handle edge cases', ${fn.isAsync ? 'async ' : ''}() => {`);
  lines.push(`    // TODO: Test with invalid/edge case inputs`);
  lines.push('  });');
  lines.push('');

  // Params test
  for (const param of fn.params) {
    const paramName = param.split(':')[0].trim().replace('?', '');
    if (param.includes('?') || param.includes('undefined')) {
      lines.push(`  ${it}('should work without optional param ${paramName}', ${fn.isAsync ? 'async ' : ''}() => {`);
      lines.push(`    // TODO: Test ${fn.name} without ${paramName}`);
      lines.push('  });');
      lines.push('');
    }
  }

  lines.push('});');

  return lines.join('\n');
}
