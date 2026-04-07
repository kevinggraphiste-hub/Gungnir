import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export interface CostEntry {
  timestamp: number;
  sessionId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface CostSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: Record<string, { cost: number; tokens: number }>;
  byModel: Record<string, { cost: number; tokens: number }>;
  bySession: Record<string, { cost: number; tokens: number }>;
  byDay: Record<string, { cost: number; tokens: number }>;
}

// Pricing per 1M tokens (USD)
const PRICING: Record<string, { input: number; output: number }> = {
  // OpenRouter / Anthropic
  'anthropic/claude-sonnet-4': { input: 3, output: 15 },
  'anthropic/claude-3.7-sonnet': { input: 3, output: 15 },
  'anthropic/claude-3.5-sonnet': { input: 3, output: 15 },
  'anthropic/claude-3.5-haiku': { input: 0.80, output: 4 },
  'anthropic/claude-3-opus': { input: 15, output: 75 },
  // OpenRouter / OpenAI
  'openai/gpt-4o': { input: 2.50, output: 10 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
  'openai/gpt-4.1': { input: 2, output: 8 },
  'openai/gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'openai/o3-mini': { input: 1.10, output: 4.40 },
  'openai/o4-mini': { input: 1.10, output: 4.40 },
  // OpenRouter / Google
  'google/gemini-2.5-pro-preview': { input: 1.25, output: 10 },
  'google/gemini-2.5-flash-preview': { input: 0.15, output: 0.60 },
  'google/gemini-2.0-flash': { input: 0.10, output: 0.40 },
  // OpenRouter / DeepSeek
  'deepseek/deepseek-r1': { input: 0.55, output: 2.19 },
  'deepseek/deepseek-chat-v3': { input: 0.27, output: 1.10 },
  'deepseek/deepseek-coder-v2': { input: 0.14, output: 0.28 },
  // OpenRouter / Others
  'xiaomi/mimo-v2-pro': { input: 0.20, output: 0.60 },
  'moonshotai/kimi-k2': { input: 0.50, output: 2 },
  'qwen/qwen-2.5-coder-32b-instruct': { input: 0.20, output: 0.60 },
  'qwen/qwen-2.5-72b-instruct': { input: 0.40, output: 1.20 },
  'qwen/qwq-32b': { input: 0.20, output: 0.60 },
  'mistralai/codestral-2501': { input: 0.30, output: 0.90 },
  'mistralai/mistral-large': { input: 2, output: 6 },
  'cohere/command-r-plus': { input: 2.50, output: 10 },
  // Direct Anthropic
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-3-7-sonnet-20250219': { input: 3, output: 15 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4 },
  'claude-3-opus-20240229': { input: 15, output: 75 },
  // Direct OpenAI
  'gpt-4o': { input: 2.50, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
};

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

const COSTS_FILE = 'costs.json';

export async function loadCosts(cwd: string): Promise<CostEntry[]> {
  const dir = join(cwd, '.spearcode');
  const file = join(dir, COSTS_FILE);

  if (!existsSync(file)) return [];

  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return [];
  }
}

export async function saveCost(cwd: string, entry: Omit<CostEntry, 'timestamp'>): Promise<void> {
  const dir = join(cwd, '.spearcode');
  await mkdir(dir, { recursive: true });

  const costs = await loadCosts(cwd);

  costs.push({
    ...entry,
    timestamp: Date.now(),
  });

  // Keep max 10000 entries
  if (costs.length > 10000) {
    costs.splice(0, costs.length - 10000);
  }

  await writeFile(join(dir, COSTS_FILE), JSON.stringify(costs), 'utf-8');
}

export function summarizeCosts(costs: CostEntry[]): CostSummary {
  const summary: CostSummary = {
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    byProvider: {},
    byModel: {},
    bySession: {},
    byDay: {},
  };

  for (const entry of costs) {
    summary.totalCost += entry.cost;
    summary.totalInputTokens += entry.inputTokens;
    summary.totalOutputTokens += entry.outputTokens;

    // By provider
    if (!summary.byProvider[entry.provider]) {
      summary.byProvider[entry.provider] = { cost: 0, tokens: 0 };
    }
    summary.byProvider[entry.provider].cost += entry.cost;
    summary.byProvider[entry.provider].tokens += entry.inputTokens + entry.outputTokens;

    // By model
    if (!summary.byModel[entry.model]) {
      summary.byModel[entry.model] = { cost: 0, tokens: 0 };
    }
    summary.byModel[entry.model].cost += entry.cost;
    summary.byModel[entry.model].tokens += entry.inputTokens + entry.outputTokens;

    // By session
    if (!summary.bySession[entry.sessionId]) {
      summary.bySession[entry.sessionId] = { cost: 0, tokens: 0 };
    }
    summary.bySession[entry.sessionId].cost += entry.cost;
    summary.bySession[entry.sessionId].tokens += entry.inputTokens + entry.outputTokens;

    // By day
    const day = new Date(entry.timestamp).toISOString().slice(0, 10);
    if (!summary.byDay[day]) {
      summary.byDay[day] = { cost: 0, tokens: 0 };
    }
    summary.byDay[day].cost += entry.cost;
    summary.byDay[day].tokens += entry.inputTokens + entry.outputTokens;
  }

  return summary;
}

export function formatCostSummary(summary: CostSummary): string {
  const lines: string[] = [];

  lines.push(`💰 Total: $${summary.totalCost.toFixed(4)}`);
  lines.push(`📊 Tokens: ${formatNumber(summary.totalInputTokens)} in / ${formatNumber(summary.totalOutputTokens)} out`);

  if (Object.keys(summary.byProvider).length) {
    lines.push('\nBy provider:');
    for (const [provider, data] of Object.entries(summary.byProvider)) {
      lines.push(`  ${provider}: $${data.cost.toFixed(4)} (${formatNumber(data.tokens)} tokens)`);
    }
  }

  if (Object.keys(summary.byModel).length) {
    lines.push('\nBy model:');
    const sorted = Object.entries(summary.byModel).sort((a, b) => b[1].cost - a[1].cost);
    for (const [model, data] of sorted.slice(0, 5)) {
      lines.push(`  ${model}: $${data.cost.toFixed(4)}`);
    }
  }

  return lines.join('\n');
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
