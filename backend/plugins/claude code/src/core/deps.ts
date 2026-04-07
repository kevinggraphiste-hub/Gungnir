import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool } from '../types/index.js';

export interface DependencyInfo {
  name: string;
  currentVersion: string;
  latestVersion?: string;
  isDev: boolean;
  vulnerabilities: Vulnerability[];
  outdated: boolean;
}

export interface Vulnerability {
  severity: 'critical' | 'high' | 'moderate' | 'low';
  title: string;
  url?: string;
  patchedIn?: string;
}

export function createDependencyTools(cwd: string): Tool[] {
  return [
    {
      name: 'check_dependencies',
      description: 'Check project dependencies for outdated packages and vulnerabilities',
      parameters: {
        check_vulns: {
          type: 'boolean',
          description: 'Also check for known vulnerabilities (default: true)',
          required: false,
        },
      },
      async execute(args) {
        const checkVulns = args.check_vulns !== false;

        // Detect package manager
        if (existsSync(join(cwd, 'package.json'))) {
          return checkNodeDeps(cwd, checkVulns);
        }
        if (existsSync(join(cwd, 'requirements.txt')) || existsSync(join(cwd, 'pyproject.toml'))) {
          return checkPythonDeps(cwd, checkVulns);
        }
        if (existsSync(join(cwd, 'Cargo.toml'))) {
          return checkRustDeps(cwd);
        }
        if (existsSync(join(cwd, 'go.mod'))) {
          return checkGoDeps(cwd);
        }

        return 'No dependency files found (package.json, requirements.txt, Cargo.toml, go.mod)';
      },
    },
    {
      name: 'analyze_dependency_tree',
      description: 'Analyze dependency tree: find unused deps, heavy deps, duplicates',
      parameters: {},
      async execute() {
        if (!existsSync(join(cwd, 'package.json'))) {
          return 'Only Node.js projects supported for tree analysis';
        }

        try {
          const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
          const deps = Object.keys(pkg.dependencies || {});
          const devDeps = Object.keys(pkg.devDependencies || {});

          const lines: string[] = [];
          lines.push(`📦 Dependencies: ${deps.length}`);
          lines.push(`🔧 Dev Dependencies: ${devDeps.length}`);
          lines.push('');

          // Find potentially unused dependencies
          const { glob } = await import('glob');
          const sourceFiles = await glob('**/*.{ts,tsx,js,jsx}', {
            cwd,
            ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.config.*'],
            nodir: true,
          });

          const usedDeps = new Set<string>();
          for (const file of sourceFiles.slice(0, 100)) {
            try {
              const content = await readFile(join(cwd, file), 'utf-8');
              const imports = content.matchAll(/(?:from|require\()['"]([^'"./][^'"]*)['"]\)?/g);
              for (const m of imports) {
                const pkgName = m[1].startsWith('@')
                  ? m[1].split('/').slice(0, 2).join('/')
                  : m[1].split('/')[0];
                usedDeps.add(pkgName);
              }
            } catch {}
          }

          const potentiallyUnused = deps.filter((d) => !usedDeps.has(d));
          if (potentiallyUnused.length) {
            lines.push('⚠️ Potentially unused dependencies:');
            for (const d of potentiallyUnused) {
              lines.push(`  - ${d}`);
            }
            lines.push('');
          }

          // Heavy dependencies (common ones)
          const heavyDeps = ['moment', 'lodash', 'webpack', 'babel-core', 'typescript'];
          const foundHeavy = deps.filter((d) => heavyDeps.includes(d));
          if (foundHeavy.length) {
            lines.push('🏋️ Heavy dependencies (consider lighter alternatives):');
            const alternatives: Record<string, string> = {
              moment: 'date-fns or dayjs',
              lodash: 'lodash-es or native methods',
              webpack: 'vite or esbuild',
            };
            for (const d of foundHeavy) {
              lines.push(`  - ${d}${alternatives[d] ? ` → ${alternatives[d]}` : ''}`);
            }
          }

          return lines.join('\n');
        } catch (err) {
          return `Analysis error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'suggest_upgrades',
      description: 'Suggest safe dependency upgrades',
      parameters: {
        type: {
          type: 'string',
          description: 'Filter by type: major, minor, patch, all',
          required: false,
          enum: ['major', 'minor', 'patch', 'all'],
        },
      },
      async execute(args) {
        if (!existsSync(join(cwd, 'package.json'))) {
          return 'Only Node.js projects supported';
        }

        const filterType = (args.type as string) || 'all';

        try {
          const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

          const lines: string[] = [];
          lines.push('## Upgrade Suggestions\n');

          let checked = 0;
          for (const [name, version] of Object.entries(allDeps)) {
            if (checked >= 20) {
              lines.push(`... and ${Object.keys(allDeps).length - 20} more`);
              break;
            }

            try {
              const res = await fetch(`https://registry.npmjs.org/${name}/latest`, {
                signal: AbortSignal.timeout(3000),
              });
              if (!res.ok) continue;

              const latest = await res.json() as { version: string };
              const current = (version as string).replace(/^[\^~]/, '');

              if (latest.version !== current) {
                const bump = getVersionBump(current, latest.version);
                if (filterType !== 'all' && bump !== filterType) continue;

                const icon = bump === 'major' ? '🔴' : bump === 'minor' ? '🟡' : '🟢';
                lines.push(`${icon} ${name}: ${current} → ${latest.version} (${bump})`);
              }
              checked++;
            } catch {}
          }

          if (lines.length === 1) {
            lines.push('All dependencies are up to date!');
          }

          return lines.join('\n');
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}

async function checkNodeDeps(cwd: string, checkVulns: boolean): Promise<string> {
  const lines: string[] = [];

  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
    const deps = Object.entries(pkg.dependencies || {});
    const devDeps = Object.entries(pkg.devDependencies || {});

    lines.push(`📦 ${deps.length} dependencies, ${devDeps.length} dev dependencies`);
    lines.push('');

    if (checkVulns) {
      lines.push('Running npm audit...');
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const exec = promisify(execFile);

        const { stdout } = await exec('npm', ['audit', '--json'], { cwd, timeout: 30000 });
        const audit = JSON.parse(stdout);

        if (audit.metadata?.vulnerabilities) {
          const vulns = audit.metadata.vulnerabilities;
          lines.push('');
          lines.push('🔒 Vulnerabilities:');
          if (vulns.critical) lines.push(`  🔴 Critical: ${vulns.critical}`);
          if (vulns.high) lines.push(`  🟠 High: ${vulns.high}`);
          if (vulns.moderate) lines.push(`  🟡 Moderate: ${vulns.moderate}`);
          if (vulns.low) lines.push(`  🟢 Low: ${vulns.low}`);

          if (audit.vulnerabilities) {
            for (const [name, vuln] of Object.entries(audit.vulnerabilities as Record<string, { severity: string; via: unknown[] }>)) {
              if (vuln.severity === 'critical' || vuln.severity === 'high') {
                lines.push(`  - ${name}: ${vuln.severity} (${vuln.via?.length ?? 0} issues)`);
              }
            }
          }
        } else {
          lines.push('✅ No known vulnerabilities');
        }
      } catch {
        lines.push('(npm audit not available)');
      }
    }
  } catch (err) {
    lines.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return lines.join('\n');
}

async function checkPythonDeps(cwd: string, checkVulns: boolean): Promise<string> {
  const lines: string[] = [];

  if (existsSync(join(cwd, 'requirements.txt'))) {
    const content = await readFile(join(cwd, 'requirements.txt'), 'utf-8');
    const deps = content.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    lines.push(`🐍 ${deps.length} Python dependencies`);
    lines.push('');
    for (const dep of deps.slice(0, 20)) {
      lines.push(`  - ${dep.trim()}`);
    }
  }

  if (checkVulns) {
    lines.push('');
    lines.push('💡 Run `pip-audit` to check for vulnerabilities');
  }

  return lines.join('\n');
}

async function checkRustDeps(cwd: string): Promise<string> {
  try {
    const content = await readFile(join(cwd, 'Cargo.toml'), 'utf-8');
    const deps = content.match(/^\w+[\w-]*\s*=/gm) || [];
    return `🦀 ${deps.length} Rust dependencies\n💡 Run \`cargo audit\` to check for vulnerabilities`;
  } catch {
    return 'Error reading Cargo.toml';
  }
}

async function checkGoDeps(cwd: string): Promise<string> {
  try {
    const content = await readFile(join(cwd, 'go.mod'), 'utf-8');
    const deps = content.match(/^\t/gm) || [];
    return `🔵 ${deps.length} Go dependencies\n💡 Run \`govulncheck ./...\` to check for vulnerabilities`;
  } catch {
    return 'Error reading go.mod';
  }
}

function getVersionBump(current: string, latest: string): 'major' | 'minor' | 'patch' {
  const c = current.split('.').map(Number);
  const l = latest.split('.').map(Number);

  if (l[0] > c[0]) return 'major';
  if (l[1] > c[1]) return 'minor';
  return 'patch';
}
