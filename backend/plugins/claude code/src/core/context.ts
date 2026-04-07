import { readFile, stat } from 'node:fs/promises';
import { join, relative, extname, basename, dirname } from 'node:path';
import { glob as globFn } from 'glob';

export interface ProjectContext {
  root: string;
  name: string;
  language: string;
  framework?: string;
  tree: FileNode[];
  readme?: string;
  configFiles: Record<string, string>;
  recentFiles: string[];
  stats: ProjectStats;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  size?: number;
  language?: string;
}

export interface ProjectStats {
  totalFiles: number;
  totalLines: number;
  byLanguage: Record<string, { files: number; lines: number }>;
}

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/vendor/**',
  '**/__pycache__/**',
  '**/.spearcode/**',
  '**/*.min.js',
  '**/*.map',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
];

const CODE_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.hs': 'haskell',
  '.ml': 'ocaml',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
};

const FRAMEWORK_DETECTORS: { files: string[]; framework: string; language: string }[] = [
  { files: ['package.json'], framework: 'node', language: 'javascript' },
  { files: ['tsconfig.json'], framework: 'typescript', language: 'typescript' },
  { files: ['Cargo.toml'], framework: 'rust', language: 'rust' },
  { files: ['go.mod'], framework: 'go', language: 'go' },
  { files: ['requirements.txt', 'pyproject.toml', 'setup.py'], framework: 'python', language: 'python' },
  { files: ['Gemfile'], framework: 'ruby', language: 'ruby' },
  { files: ['pom.xml', 'build.gradle'], framework: 'java', language: 'java' },
  { files: ['composer.json'], framework: 'php', language: 'php' },
  { files: ['Package.swift'], framework: 'swift', language: 'swift' },
];

export async function analyzeProject(root: string): Promise<ProjectContext> {
  const [tree, language, framework, configFiles, readme] = await Promise.all([
    buildFileTree(root),
    detectLanguage(root),
    detectFramework(root),
    loadConfigFiles(root),
    loadReadme(root),
  ]);

  const stats = computeStats(tree);
  const recentFiles = await findRecentFiles(root);

  return {
    root,
    name: basename(root),
    language,
    framework,
    tree,
    readme,
    configFiles,
    recentFiles,
    stats,
  };
}

async function buildFileTree(root: string, maxDepth = 3, depth = 0): Promise<FileNode[]> {
  if (depth > maxDepth) return [];

  const entries = await globFn('*', {
    cwd: root,
    dot: false,
    ignore: IGNORE_PATTERNS,
  });

  const nodes: FileNode[] = [];

  for (const entry of entries.sort()) {
    const fullPath = join(root, entry);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        const children = depth < maxDepth ? await buildFileTree(fullPath, maxDepth, depth + 1) : undefined;
        nodes.push({
          name: basename(entry),
          path: entry,
          type: 'directory',
          children,
        });
      } else {
        nodes.push({
          name: basename(entry),
          path: entry,
          type: 'file',
          size: s.size,
          language: CODE_EXTENSIONS[extname(entry).toLowerCase()],
        });
      }
    } catch {
      // skip inaccessible files
    }
  }

  return nodes;
}

async function detectLanguage(root: string): Promise<string> {
  for (const det of FRAMEWORK_DETECTORS) {
    for (const file of det.files) {
      try {
        await stat(join(root, file));
        return det.language;
      } catch {
        // continue
      }
    }
  }
  return 'unknown';
}

async function detectFramework(root: string): Promise<string | undefined> {
  try {
    const pkgRaw = await readFile(join(root, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps.react) return 'react';
    if (deps.vue) return 'vue';
    if (deps.svelte) return 'svelte';
    if (deps.next) return 'nextjs';
    if (deps.nuxt) return 'nuxt';
    if (deps.express) return 'express';
    if (deps.fastify) return 'fastify';
    if (deps.nest) return 'nestjs';
    if (deps.astro) return 'astro';
  } catch {
    // no package.json
  }

  try {
    await stat(join(root, 'Cargo.toml'));
    return 'rust';
  } catch {}

  try {
    await stat(join(root, 'go.mod'));
    return 'go';
  } catch {}

  return undefined;
}

async function loadConfigFiles(root: string): Promise<Record<string, string>> {
  const configNames = [
    'package.json', 'tsconfig.json', '.eslintrc.json', '.prettierrc',
    'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt',
    'Dockerfile', 'docker-compose.yml', '.env.example', 'Makefile',
  ];

  const configs: Record<string, string> = {};
  for (const name of configNames) {
    try {
      configs[name] = await readFile(join(root, name), 'utf-8');
    } catch {
      // file doesn't exist
    }
  }
  return configs;
}

async function loadReadme(root: string): Promise<string | undefined> {
  for (const name of ['README.md', 'readme.md', 'README.rst', 'README']) {
    try {
      return await readFile(join(root, name), 'utf-8');
    } catch {}
  }
  return undefined;
}

function computeStats(nodes: FileNode[]): ProjectStats {
  const stats: ProjectStats = { totalFiles: 0, totalLines: 0, byLanguage: {} };

  function walk(fileNodes: FileNode[]) {
    for (const node of fileNodes) {
      if (node.type === 'directory' && node.children) {
        walk(node.children);
      } else if (node.type === 'file' && node.language) {
        stats.totalFiles++;
        const lang = node.language;
        if (!stats.byLanguage[lang]) {
          stats.byLanguage[lang] = { files: 0, lines: 0 };
        }
        stats.byLanguage[lang].files++;
      }
    }
  }

  walk(nodes);
  return stats;
}

async function findRecentFiles(root: string): Promise<string[]> {
  const files = await globFn('**/*.{ts,tsx,js,jsx,py,go,rs,rb,java}', {
    cwd: root,
    ignore: IGNORE_PATTERNS,
    nodir: true,
  });

  // Get modification times for last 10 files
  const withMtime = await Promise.all(
    files.slice(0, 50).map(async (f: string) => {
      try {
        const s = await stat(join(root, f));
        return { path: f, mtime: s.mtimeMs };
      } catch {
        return { path: f, mtime: 0 };
      }
    })
  );

  return withMtime
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 10)
    .map((f) => f.path);
}

export function renderTree(nodes: FileNode[], prefix = '', maxItems = 30): string {
  const lines: string[] = [];
  const shown = nodes.slice(0, maxItems);

  for (let i = 0; i < shown.length; i++) {
    const node = shown[i];
    const isLast = i === shown.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const icon = node.type === 'directory' ? '📁 ' : getFileIcon(node.name);

    lines.push(`${prefix}${connector}${icon}${node.name}`);

    if (node.type === 'directory' && node.children && i < maxItems) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      lines.push(...renderTree(node.children, childPrefix, maxItems - shown.length).split('\n').filter(Boolean));
    }
  }

  if (nodes.length > maxItems) {
    lines.push(`${prefix}└── ... (${nodes.length - maxItems} more)`);
  }

  return lines.join('\n');
}

function getFileIcon(name: string): string {
  const ext = extname(name).toLowerCase();
  const iconMap: Record<string, string> = {
    '.ts': '🔷 ', '.tsx': '⚛️ ', '.js': '🟨 ', '.jsx': '⚛️ ',
    '.py': '🐍 ', '.go': '🔵 ', '.rs': '🦀 ', '.rb': '💎 ',
    '.json': '📋 ', '.yaml': '⚙️ ', '.yml': '⚙️ ', '.toml': '⚙️ ',
    '.md': '📝 ', '.css': '🎨 ', '.html': '🌐 ',
    '.sql': '🗃️ ', '.sh': '🐚 ',
  };
  return iconMap[ext] || '📄 ';
}
