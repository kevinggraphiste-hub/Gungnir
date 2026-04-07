import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import 'dotenv/config';
import type { SpearCodeConfig } from '../types/index.js';

const DEFAULT_CONFIG: SpearCodeConfig = {
  data: { directory: '.spearcode' },
  providers: {},
  agents: {
    coder: { model: 'anthropic/claude-sonnet-4', maxTokens: 4096 },
    task: { model: 'anthropic/claude-sonnet-4', maxTokens: 4096 },
    title: { model: 'openai/gpt-4.1-mini', maxTokens: 80 },
  },
  shell: { path: process.env.SHELL ?? (process.platform === 'win32' ? 'cmd' : '/bin/bash'), args: [] },
  mcpServers: {},
  autoCompact: true,
};

export async function loadConfig(cwd: string): Promise<SpearCodeConfig> {
  const configPaths = [
    join(cwd, '.spearcode.json'),
    join(cwd, '.spearcode', 'config.json'),
    join(homedir(), '.spearcode.json'),
  ];

  let fileConfig: Record<string, unknown> = {};

  for (const path of configPaths) {
    if (existsSync(path)) {
      try {
        const raw = await readFile(path, 'utf-8');
        fileConfig = JSON.parse(raw);
        break;
      } catch {
        // skip invalid JSON
      }
    }
  }

  const config: SpearCodeConfig = {
    data: mergeField(DEFAULT_CONFIG.data, fileConfig.data),
    providers: mergeField(DEFAULT_CONFIG.providers, fileConfig.providers),
    agents: mergeField(DEFAULT_CONFIG.agents, fileConfig.agents),
    shell: mergeField(DEFAULT_CONFIG.shell, fileConfig.shell),
    mcpServers: mergeField(DEFAULT_CONFIG.mcpServers, fileConfig.mcpServers),
    autoCompact: typeof fileConfig.autoCompact === 'boolean' ? fileConfig.autoCompact : DEFAULT_CONFIG.autoCompact,
  };

  // Merge environment variables for providers
  if (!config.providers.anthropic?.apiKey && process.env.ANTHROPIC_API_KEY) {
    config.providers.anthropic = {
      ...config.providers.anthropic,
      apiKey: process.env.ANTHROPIC_API_KEY,
    };
  }
  if (!config.providers.openai?.apiKey && process.env.OPENAI_API_KEY) {
    config.providers.openai = {
      ...config.providers.openai,
      apiKey: process.env.OPENAI_API_KEY,
    };
  }
  if (!config.providers.openrouter?.apiKey && process.env.OPENROUTER_API_KEY) {
    config.providers.openrouter = {
      ...config.providers.openrouter,
      apiKey: process.env.OPENROUTER_API_KEY,
    };
  }
  if (!config.providers.ollama && process.env.LOCAL_ENDPOINT) {
    config.providers.ollama = {
      baseUrl: process.env.LOCAL_ENDPOINT,
    };
  }

  return config;
}

function mergeField<T>(base: T, override: unknown): T {
  if (override === null || override === undefined || typeof override !== 'object' || Array.isArray(override)) {
    return base;
  }
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return override as T;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  const over = override as Record<string, unknown>;
  for (const key of Object.keys(over)) {
    if (over[key] !== undefined) {
      const baseVal = result[key];
      const overVal = over[key];
      if (
        typeof baseVal === 'object' && baseVal !== null && !Array.isArray(baseVal) &&
        typeof overVal === 'object' && overVal !== null && !Array.isArray(overVal)
      ) {
        result[key] = mergeField(baseVal, overVal);
      } else {
        result[key] = overVal;
      }
    }
  }
  return result as T;
}
