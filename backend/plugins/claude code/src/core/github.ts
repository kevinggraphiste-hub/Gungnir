import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '../types/index.js';

const execFileAsync = promisify(execFile);

async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      cwd,
      maxBuffer: 1024 * 1024,
      timeout: 30000,
    });
    return [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    if (output) return output;
    throw new Error(error.message ?? 'GitHub CLI command failed');
  }
}

export function createGitHubTools(cwd: string): Tool[] {
  return [
    {
      name: 'gh_pr_list',
      description: 'List pull requests on GitHub',
      parameters: {
        state: {
          type: 'string',
          description: 'PR state: open, closed, merged, all',
          required: false,
          enum: ['open', 'closed', 'merged', 'all'],
        },
        limit: {
          type: 'number',
          description: 'Number of PRs to show (default: 10)',
          required: false,
        },
        author: {
          type: 'string',
          description: 'Filter by author',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['pr', 'list', '--json', 'number,title,state,author,createdAt,headRefName,additions,deletions'];
        if (args.state) cmd.push('--state', args.state as string);
        else cmd.push('--state', 'open');
        cmd.push('--limit', String(args.limit || 10));
        if (args.author) cmd.push('--author', args.author as string);

        const raw = await gh(cwd, cmd);
        try {
          const prs = JSON.parse(raw) as Array<{
            number: number;
            title: string;
            state: string;
            author: { login: string };
            createdAt: string;
            headRefName: string;
            additions: number;
            deletions: number;
          }>;

          if (!prs.length) return 'No pull requests found';

          return prs.map((pr) => {
            const icon = pr.state === 'OPEN' ? '🟢' : pr.state === 'MERGED' ? '🟣' : '🔴';
            return `${icon} #${pr.number} ${pr.title}\n   by ${pr.author.login} | ${pr.headRefName} | +${pr.additions} -${pr.deletions} | ${pr.createdAt.slice(0, 10)}`;
          }).join('\n');
        } catch {
          return raw;
        }
      },
    },
    {
      name: 'gh_pr_create',
      description: 'Create a pull request on GitHub',
      parameters: {
        title: {
          type: 'string',
          description: 'PR title',
          required: true,
        },
        body: {
          type: 'string',
          description: 'PR description (supports markdown)',
          required: false,
        },
        base: {
          type: 'string',
          description: 'Base branch (default: main)',
          required: false,
        },
        draft: {
          type: 'boolean',
          description: 'Create as draft PR',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['pr', 'create', '--title', args.title as string];
        if (args.body) cmd.push('--body', args.body as string);
        else cmd.push('--body', 'Created with SpearCode ⚔');
        if (args.base) cmd.push('--base', args.base as string);
        if (args.draft) cmd.push('--draft');

        return gh(cwd, cmd);
      },
    },
    {
      name: 'gh_pr_view',
      description: 'View a pull request details, comments, and reviews',
      parameters: {
        number: {
          type: 'number',
          description: 'PR number',
          required: true,
        },
      },
      async execute(args) {
        const cmd = ['pr', 'view', String(args.number), '--json', 'title,body,state,author,reviewDecision,comments,reviews,files'];
        const raw = await gh(cwd, cmd);
        try {
          const pr = JSON.parse(raw) as {
            title: string;
            body: string;
            state: string;
            author: { login: string };
            reviewDecision: string;
            comments: Array<{ author: { login: string }; body: string }>;
            reviews: Array<{ author: { login: string }; state: string; body: string }>;
            files: Array<{ path: string; additions: number; deletions: number }>;
          };

          const lines: string[] = [];
          lines.push(`# ${pr.title}`);
          lines.push(`State: ${pr.state} | Author: ${pr.author.login} | Review: ${pr.reviewDecision || 'pending'}`);
          lines.push('');
          lines.push('## Description');
          lines.push(pr.body?.slice(0, 1000) || '(no description)');

          if (pr.files?.length) {
            lines.push('');
            lines.push('## Files changed');
            for (const f of pr.files) {
              lines.push(`  ${f.path} +${f.additions} -${f.deletions}`);
            }
          }

          if (pr.reviews?.length) {
            lines.push('');
            lines.push('## Reviews');
            for (const r of pr.reviews) {
              lines.push(`  ${r.author.login}: ${r.state} - ${r.body?.slice(0, 200) || ''}`);
            }
          }

          if (pr.comments?.length) {
            lines.push('');
            lines.push('## Comments');
            for (const c of pr.comments.slice(-5)) {
              lines.push(`  ${c.author.login}: ${c.body?.slice(0, 200) || ''}`);
            }
          }

          return lines.join('\n');
        } catch {
          return raw;
        }
      },
    },
    {
      name: 'gh_pr_merge',
      description: 'Merge a pull request',
      parameters: {
        number: {
          type: 'number',
          description: 'PR number',
          required: true,
        },
        method: {
          type: 'string',
          description: 'Merge method: merge, squash, rebase',
          required: false,
          enum: ['merge', 'squash', 'rebase'],
        },
        delete_branch: {
          type: 'boolean',
          description: 'Delete branch after merge',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['pr', 'merge', String(args.number)];
        if (args.method === 'squash') cmd.push('--squash');
        else if (args.method === 'rebase') cmd.push('--rebase');
        else cmd.push('--merge');
        if (args.delete_branch) cmd.push('--delete-branch');

        return gh(cwd, cmd);
      },
    },
    {
      name: 'gh_issue_list',
      description: 'List GitHub issues',
      parameters: {
        state: {
          type: 'string',
          description: 'Issue state: open, closed, all',
          required: false,
          enum: ['open', 'closed', 'all'],
        },
        labels: {
          type: 'string',
          description: 'Filter by labels (comma-separated)',
          required: false,
        },
        limit: {
          type: 'number',
          description: 'Number of issues (default: 10)',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['issue', 'list', '--json', 'number,title,state,author,labels,createdAt'];
        if (args.state) cmd.push('--state', args.state as string);
        else cmd.push('--state', 'open');
        if (args.labels) cmd.push('--label', args.labels as string);
        cmd.push('--limit', String(args.limit || 10));

        const raw = await gh(cwd, cmd);
        try {
          const issues = JSON.parse(raw) as Array<{
            number: number;
            title: string;
            state: string;
            author: { login: string };
            labels: Array<{ name: string }>;
            createdAt: string;
          }>;

          if (!issues.length) return 'No issues found';

          return issues.map((issue) => {
            const icon = issue.state === 'OPEN' ? '🟢' : '🔴';
            const labels = issue.labels.map((l) => l.name).join(', ');
            return `${icon} #${issue.number} ${issue.title}\n   by ${issue.author.login}${labels ? ` [${labels}]` : ''} | ${issue.createdAt.slice(0, 10)}`;
          }).join('\n');
        } catch {
          return raw;
        }
      },
    },
    {
      name: 'gh_issue_create',
      description: 'Create a GitHub issue',
      parameters: {
        title: {
          type: 'string',
          description: 'Issue title',
          required: true,
        },
        body: {
          type: 'string',
          description: 'Issue description',
          required: false,
        },
        labels: {
          type: 'string',
          description: 'Labels (comma-separated)',
          required: false,
        },
        assignees: {
          type: 'string',
          description: 'Assignees (comma-separated)',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['issue', 'create', '--title', args.title as string];
        if (args.body) cmd.push('--body', args.body as string);
        if (args.labels) cmd.push('--label', args.labels as string);
        if (args.assignees) cmd.push('--assignee', args.assignees as string);

        return gh(cwd, cmd);
      },
    },
    {
      name: 'gh_issue_view',
      description: 'View a GitHub issue details and comments',
      parameters: {
        number: {
          type: 'number',
          description: 'Issue number',
          required: true,
        },
      },
      async execute(args) {
        const cmd = ['issue', 'view', String(args.number), '--json', 'title,body,state,author,labels,comments,assignees'];
        const raw = await gh(cwd, cmd);
        try {
          const issue = JSON.parse(raw) as {
            title: string;
            body: string;
            state: string;
            author: { login: string };
            labels: Array<{ name: string }>;
            comments: Array<{ author: { login: string }; body: string }>;
            assignees: Array<{ login: string }>;
          };

          const lines: string[] = [];
          lines.push(`# ${issue.title}`);
          lines.push(`State: ${issue.state} | Author: ${issue.author.login}`);
          if (issue.labels.length) lines.push(`Labels: ${issue.labels.map((l) => l.name).join(', ')}`);
          if (issue.assignees.length) lines.push(`Assignees: ${issue.assignees.map((a) => a.login).join(', ')}`);
          lines.push('');
          lines.push(issue.body?.slice(0, 2000) || '(no description)');

          if (issue.comments?.length) {
            lines.push('');
            lines.push('## Comments');
            for (const c of issue.comments.slice(-10)) {
              lines.push(`\n**${c.author.login}:**`);
              lines.push(c.body?.slice(0, 500) || '');
            }
          }

          return lines.join('\n');
        } catch {
          return raw;
        }
      },
    },
    {
      name: 'gh_repo_info',
      description: 'Get repository information (stars, forks, issues, contributors)',
      parameters: {},
      async execute() {
        const cmd = ['repo', 'view', '--json', 'name,description,stargazerCount,forkCount,issues,pullRequests,primaryLanguage,licenseInfo,defaultBranchRef'];
        return gh(cwd, cmd);
      },
    },
    {
      name: 'gh_workflow_runs',
      description: 'List recent GitHub Actions workflow runs',
      parameters: {
        limit: {
          type: 'number',
          description: 'Number of runs (default: 5)',
          required: false,
        },
      },
      async execute(args) {
        const cmd = ['run', 'list', '--limit', String(args.limit || 5), '--json', 'name,status,conclusion,createdAt,headBranch,event,url'];
        const raw = await gh(cwd, cmd);
        try {
          const runs = JSON.parse(raw) as Array<{
            name: string;
            status: string;
            conclusion: string;
            createdAt: string;
            headBranch: string;
            event: string;
            url: string;
          }>;

          if (!runs.length) return 'No workflow runs found';

          return runs.map((run) => {
            const icon = run.conclusion === 'success' ? '✅' : run.conclusion === 'failure' ? '❌' : '⏳';
            return `${icon} ${run.name} (${run.status})\n   ${run.headBranch} | ${run.event} | ${run.createdAt.slice(0, 16)}`;
          }).join('\n');
        } catch {
          return raw;
        }
      },
    },
  ];
}
