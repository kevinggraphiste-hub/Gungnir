import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '../types/index.js';

const execFileAsync = promisify(execFile);

export interface PRReview {
  title: string;
  author: string;
  files: PRFileReview[];
  summary: string;
  score: number;
  issues: PRIssue[];
}

export interface PRFileReview {
  path: string;
  additions: number;
  deletions: number;
  issues: PRIssue[];
}

export interface PRIssue {
  severity: 'critical' | 'warning' | 'suggestion';
  category: 'security' | 'performance' | 'bug' | 'style' | 'architecture';
  message: string;
  line?: number;
  suggestion?: string;
}

export function createPRReviewTools(cwd: string): Tool[] {
  return [
    {
      name: 'pr_review',
      description: 'Review a pull request: analyze changes, find issues, suggest improvements',
      parameters: {
        branch: {
          type: 'string',
          description: 'Branch to review (compared to current branch or main)',
          required: false,
        },
        base: {
          type: 'string',
          description: 'Base branch to compare against (default: main or master)',
          required: false,
        },
      },
      async execute(args) {
        const branch = (args.branch as string) || 'HEAD';
        const base = (args.base as string) || await detectBaseBranch(cwd);

        try {
          // Get PR info
          const { stdout: log } = await execFileAsync('git', ['log', '--oneline', `${base}..${branch}`], { cwd });
          const commits = log.trim().split('\n').filter(Boolean);

          // Get changed files
          const { stdout: diffStat } = await execFileAsync('git', ['diff', '--stat', `${base}...${branch}`], { cwd });

          // Get actual diff
          const { stdout: diff } = await execFileAsync('git', ['diff', '--unified=3', `${base}...${branch}`], { cwd });

          // Analyze
          const analysis = analyzeDiff(diff, commits);

          return formatReview(analysis, commits, diffStat);
        } catch (err) {
          return `PR review error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'pr_diff',
      description: 'Show the diff of a PR/branch comparison',
      parameters: {
        branch: {
          type: 'string',
          description: 'Branch to compare',
          required: false,
        },
        base: {
          type: 'string',
          description: 'Base branch (default: main)',
          required: false,
        },
        path: {
          type: 'string',
          description: 'Specific file to show',
          required: false,
        },
      },
      async execute(args) {
        const branch = (args.branch as string) || 'HEAD';
        const base = (args.base as string) || await detectBaseBranch(cwd);

        const cmd = ['diff', '--unified=5', `${base}...${branch}`];
        if (args.path) cmd.push('--', args.path as string);

        try {
          const { stdout } = await execFileAsync('git', cmd, { cwd, maxBuffer: 512 * 1024 });
          return stdout.trim() || 'No differences';
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'pr_commits',
      description: 'List commits in a PR/branch',
      parameters: {
        branch: {
          type: 'string',
          description: 'Branch name (default: current)',
          required: false,
        },
        base: {
          type: 'string',
          description: 'Base branch (default: main)',
          required: false,
        },
      },
      async execute(args) {
        const branch = (args.branch as string) || 'HEAD';
        const base = (args.base as string) || await detectBaseBranch(cwd);

        try {
          const { stdout } = await execFileAsync('git', [
            'log', '--oneline', '--graph', '--decorate',
            `${base}..${branch}`,
          ], { cwd });
          return stdout.trim() || 'No commits found';
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}

async function detectBaseBranch(cwd: string): Promise<string> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'main'], { cwd });
    return 'main';
  } catch {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', 'master'], { cwd });
      return 'master';
    } catch {
      return 'origin/main';
    }
  }
}

function analyzeDiff(diff: string, commits: string[]): PRIssue[] {
  const issues: PRIssue[] = [];
  const lines = diff.split('\n');
  let currentFile = '';
  let lineNum = 0;

  for (const line of lines) {
    // Track current file
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      lineNum = 0;
      continue;
    }

    // Track line numbers
    if (line.startsWith('@@')) {
      const match = line.match(/\+(\d+)/);
      if (match) lineNum = parseInt(match[1]) - 1;
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNum++;
      const content = line.slice(1);

      // Security checks
      if (/eval\s*\(/.test(content)) {
        issues.push({
          severity: 'critical',
          category: 'security',
          message: 'Use of eval() - potential code injection',
          line: lineNum,
          suggestion: 'Use safer alternatives like JSON.parse() or Function constructor',
        });
      }

      if (/innerHTML\s*=/.test(content)) {
        issues.push({
          severity: 'critical',
          category: 'security',
          message: 'Direct innerHTML assignment - XSS risk',
          line: lineNum,
          suggestion: 'Use textContent or a sanitizer library',
        });
      }

      if (/password|secret|token|api_key/i.test(content) && /['"]\w+['"]/.test(content)) {
        issues.push({
          severity: 'critical',
          category: 'security',
          message: 'Possible hardcoded secret',
          line: lineNum,
          suggestion: 'Use environment variables for secrets',
        });
      }

      if (/console\.(log|debug|info)/.test(content)) {
        issues.push({
          severity: 'suggestion',
          category: 'style',
          message: 'Console statement left in code',
          line: lineNum,
          suggestion: 'Remove or use a proper logger',
        });
      }

      // Performance checks
      if (/SELECT\s+\*\s+FROM/i.test(content)) {
        issues.push({
          severity: 'warning',
          category: 'performance',
          message: 'SELECT * - fetches all columns',
          line: lineNum,
          suggestion: 'Select only needed columns',
        });
      }

      if (/\.forEach\(/.test(content) && /async|await/.test(content)) {
        issues.push({
          severity: 'warning',
          category: 'performance',
          message: 'forEach with async/await - promises not awaited',
          line: lineNum,
          suggestion: 'Use for...of loop or Promise.all()',
        });
      }

      // Bug checks
      if (/==\s*(null|undefined|0|''|""|false)/.test(content) && !/===/.test(content)) {
        issues.push({
          severity: 'warning',
          category: 'bug',
          message: 'Loose equality comparison',
          line: lineNum,
          suggestion: 'Use === for strict equality',
        });
      }

      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(content)) {
        issues.push({
          severity: 'warning',
          category: 'bug',
          message: 'Empty catch block - errors silently swallowed',
          line: lineNum,
          suggestion: 'Log the error or handle it properly',
        });
      }

      // TODO/FIXME
      if (/\/\/\s*(TODO|FIXME|HACK|XXX)/i.test(content)) {
        issues.push({
          severity: 'suggestion',
          category: 'style',
          message: 'TODO/FIXME left in code',
          line: lineNum,
        });
      }

      // Large diff
      if (content.length > 200) {
        issues.push({
          severity: 'suggestion',
          category: 'style',
          message: 'Very long line (consider breaking it up)',
          line: lineNum,
        });
      }
    }
  }

  // Check for too many commits (squash suggestion)
  if (commits.length > 10) {
    issues.push({
      severity: 'suggestion',
      category: 'architecture',
      message: `${commits.length} commits - consider squashing`,
      suggestion: 'Squash related commits before merging',
    });
  }

  return issues;
}

function formatReview(issues: PRIssue[], commits: string[], diffStat: string): string {
  const lines: string[] = [];

  lines.push('## PR Review Summary');
  lines.push('');
  lines.push(`**Commits:** ${commits.length}`);
  lines.push('');

  if (diffStat.trim()) {
    lines.push('**Changes:**');
    lines.push('```');
    lines.push(diffStat.trim());
    lines.push('```');
    lines.push('');
  }

  const critical = issues.filter((i) => i.severity === 'critical');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const suggestions = issues.filter((i) => i.severity === 'suggestion');

  // Score
  const score = Math.max(0, 100 - critical.length * 20 - warnings.length * 5 - suggestions.length * 1);
  lines.push(`**Score:** ${score}/100`);
  lines.push('');

  if (critical.length) {
    lines.push('### 🔴 Critical Issues');
    lines.push('');
    for (const issue of critical) {
      lines.push(`- **${issue.category}** (line ${issue.line ?? '?'}): ${issue.message}`);
      if (issue.suggestion) lines.push(`  💡 ${issue.suggestion}`);
    }
    lines.push('');
  }

  if (warnings.length) {
    lines.push('### 🟡 Warnings');
    lines.push('');
    for (const issue of warnings) {
      lines.push(`- **${issue.category}** (line ${issue.line ?? '?'}): ${issue.message}`);
      if (issue.suggestion) lines.push(`  💡 ${issue.suggestion}`);
    }
    lines.push('');
  }

  if (suggestions.length) {
    lines.push('### 🟢 Suggestions');
    lines.push('');
    for (const issue of suggestions) {
      lines.push(`- ${issue.message}${issue.line ? ` (line ${issue.line})` : ''}`);
      if (issue.suggestion) lines.push(`  💡 ${issue.suggestion}`);
    }
    lines.push('');
  }

  if (!issues.length) {
    lines.push('### ✅ No issues found!');
    lines.push('');
  }

  return lines.join('\n');
}
