import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  addedAt: number;
  lastUsed: number;
  provider?: string;
  model?: string;
}

const WORKSPACES_FILE = join(homedir(), '.spearcode', 'workspaces.json');

export async function loadWorkspaces(): Promise<Workspace[]> {
  if (!existsSync(WORKSPACES_FILE)) return [];

  try {
    const raw = await readFile(WORKSPACES_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function saveWorkspaces(workspaces: Workspace[]): Promise<void> {
  const dir = join(homedir(), '.spearcode');
  await mkdir(dir, { recursive: true });
  await writeFile(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2), 'utf-8');
}

export async function addWorkspace(path: string, name?: string, provider?: string, model?: string): Promise<Workspace> {
  const workspaces = await loadWorkspaces();

  // Check if already exists
  const existing = workspaces.find((w) => w.path === path);
  if (existing) {
    existing.lastUsed = Date.now();
    existing.provider = provider ?? existing.provider;
    existing.model = model ?? existing.model;
    await saveWorkspaces(workspaces);
    return existing;
  }

  const workspace: Workspace = {
    id: randomUUID(),
    name: name ?? path.split(/[\\/]/).pop() ?? 'workspace',
    path,
    addedAt: Date.now(),
    lastUsed: Date.now(),
    provider,
    model,
  };

  workspaces.push(workspace);
  await saveWorkspaces(workspaces);

  return workspace;
}

export async function removeWorkspace(id: string): Promise<void> {
  const workspaces = await loadWorkspaces();
  const filtered = workspaces.filter((w) => w.id !== id);
  await saveWorkspaces(filtered);
}

export async function getWorkspace(id: string): Promise<Workspace | undefined> {
  const workspaces = await loadWorkspaces();
  return workspaces.find((w) => w.id === id);
}

export async function updateWorkspaceLastUsed(path: string): Promise<void> {
  const workspaces = await loadWorkspaces();
  const ws = workspaces.find((w) => w.path === path);
  if (ws) {
    ws.lastUsed = Date.now();
    await saveWorkspaces(workspaces);
  }
}
