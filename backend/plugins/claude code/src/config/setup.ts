import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { SpearCodeConfig } from '../types/index.js';

interface SetupResult {
  provider: string;
  model: string;
  configPath: string;
}

export async function runSetupWizard(cwd: string): Promise<SetupResult> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  console.log('\n⚔  SpearCode — Setup\n');

  // Detect available providers
  const available: { name: string; label: string; models: string[]; envKey?: string }[] = [];

  if (process.env.OPENROUTER_API_KEY) {
    available.push({
      name: 'openrouter',
      label: 'OpenRouter (30+ models — Claude, GPT, Gemini, MiMo, Kimi, DeepSeek...)',
      models: [
        'anthropic/claude-sonnet-4',
        'anthropic/claude-3.5-sonnet',
        'openai/gpt-4o',
        'openai/gpt-4.1',
        'google/gemini-2.5-pro-preview',
        'deepseek/deepseek-r1',
        'deepseek/deepseek-chat-v3',
        'xiaomi/mimo-v2-pro',
        'moonshotai/kimi-k2',
        'qwen/qwen-2.5-coder-32b-instruct',
        'qwen/qwq-32b',
        'meta-llama/llama-4-maverick',
        'mistralai/codestral-2501',
        'mistralai/mistral-large',
      ],
    });
  }

  if (process.env.ANTHROPIC_API_KEY) {
    available.push({
      name: 'anthropic',
      label: 'Anthropic (Claude direct)',
      models: [
        'claude-sonnet-4-20250514',
        'claude-3-7-sonnet-20250219',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-3-opus-20240229',
      ],
    });
  }

  if (process.env.OPENAI_API_KEY) {
    available.push({
      name: 'openai',
      label: 'OpenAI (GPT direct)',
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini', 'o4-mini'],
    });
  }

  // Ollama is always available (local)
  available.push({
    name: 'ollama',
    label: 'Ollama (local — gratuit, nécessite un serveur local)',
    models: [],
  });

  if (available.length === 1) {
    // Only Ollama
    console.log('  Aucune clé API détectée.');
    console.log('  Configure une clé dans .env ou en variable d\'environnement :\n');
    console.log('    set OPENROUTER_API_KEY=sk-or-...');
    console.log('    set ANTHROPIC_API_KEY=sk-...');
    console.log('    set OPENAI_API_KEY=sk-...\n');
    console.log('  Ou utilise Ollama en local (http://localhost:11434).\n');
    rl.close();
    throw new Error('No API keys configured');
  }

  // Step 1: Select provider
  console.log('  Provider disponibles :\n');
  available.forEach((p, i) => {
    console.log(`    ${i + 1}. ${p.label}`);
  });
  console.log('');

  let providerIndex = 0;
  if (available.length > 1) {
    const answer = await ask('  Choisis un provider (numéro) : ');
    providerIndex = Math.max(0, Math.min(parseInt(answer) - 1, available.length - 1));
  }

  const selectedProvider = available[providerIndex];
  console.log(`\n  ✓ Provider: ${selectedProvider.name}\n`);

  // Step 2: Select model
  let selectedModel: string;

  if (selectedProvider.models.length === 0) {
    // Ollama — ask for model name
    const answer = await ask('  Nom du modèle Ollama (ex: llama3.1, codellama, qwen2.5-coder) : ');
    selectedModel = answer.trim() || 'llama3.1';
  } else {
    console.log('  Modèles disponibles :\n');
    selectedProvider.models.forEach((m, i) => {
      console.log(`    ${i + 1}. ${m}`);
    });
    console.log('');

    const answer = await ask('  Choisis un modèle (numéro) [1] : ');
    const modelIndex = Math.max(0, Math.min((parseInt(answer) || 1) - 1, selectedProvider.models.length - 1));
    selectedModel = selectedProvider.models[modelIndex];
  }

  console.log(`\n  ✓ Modèle: ${selectedModel}\n`);

  // Step 3: Save config
  const configPath = join(cwd, '.spearcode.json');
  const config: Partial<SpearCodeConfig> = {
    providers: {},
    agents: {
      coder: { model: selectedModel, maxTokens: 4096 },
      task: { model: selectedModel, maxTokens: 4096 },
      title: { model: selectedModel, maxTokens: 80 },
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(`  ✓ Config sauvegardée: ${configPath}\n`);
  console.log('  Tu peux changer de modèle à tout moment avec Ctrl+O dans la TUI.\n');

  rl.close();

  return {
    provider: selectedProvider.name,
    model: selectedModel,
    configPath,
  };
}

export function isFirstRun(cwd: string): boolean {
  const configPaths = [
    join(cwd, '.spearcode.json'),
    join(cwd, '.spearcode', 'config.json'),
  ];
  return !configPaths.some((p) => existsSync(p));
}
