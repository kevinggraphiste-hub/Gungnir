#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'node:path';
import 'dotenv/config';
import { Agent } from '../core/agent.js';
import { analyzeProject, renderTree } from '../core/context.js';
import { runSetupWizard, isFirstRun } from '../config/setup.js';

const program = new Command();

program
  .name('spearcode')
  .description('AI coding agent for the terminal — integrable with Gungnir')
  .version('0.1.0');

async function ensureSetup(cwd: string, provider?: string, model?: string) {
  if (provider || model) return; // User explicitly chose
  if (!isFirstRun(cwd)) return;
  await runSetupWizard(cwd);
}

program
  .command('setup')
  .description('Run the interactive setup wizard')
  .option('-c, --cwd <dir>', 'Working directory', process.cwd())
  .action(async (opts) => {
    await runSetupWizard(opts.cwd);
  });

program
  .command('chat', { isDefault: true })
  .description('Start an interactive coding session (TUI)')
  .option('-c, --cwd <dir>', 'Working directory', process.cwd())
  .option('-p, --provider <name>', 'LLM provider to use')
  .option('-m, --model <name>', 'Model to use')
  .option('-d, --debug', 'Enable debug mode')
  .action(async (opts) => {
    await ensureSetup(opts.cwd, opts.provider, opts.model);

    const agent = new Agent();
    await agent.init(opts.cwd);

    try {
      await agent.start({
        cwd: opts.cwd,
        provider: opts.provider,
        model: opts.model,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      console.error('\nConfigure a provider with:');
      console.error('  set OPENROUTER_API_KEY=sk-or-...');
      console.error('  set ANTHROPIC_API_KEY=sk-...');
      console.error('  set OPENAI_API_KEY=sk-...');
      console.error('\nO lance le wizard: spearcode setup');
      process.exit(1);
    }

    try {
      const React = await import('react');
      const { render } = await import('ink');
      const { App } = await import('../tui/App.js');

      render(React.createElement(App, { agent }));
    } catch (err: unknown) {
      // Show why TUI failed
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`\nTUI Error: ${errorMsg}\n`);
      console.error('Falling back to text mode...\n');

      // Fallback to REPL if Ink fails
      console.log(`SpearCode v0.1.0 — ${agent.getStatus().provider}/${agent.getStatus().model}`);
      console.log(`Working directory: ${opts.cwd}\n`);

      const readline = await import('node:readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> ',
      });

      rl.prompt();

      rl.on('line', async (line) => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }
        if (input === '/quit' || input === '/exit') { agent.destroy(); rl.close(); return; }
        if (input === '/status') { console.log(JSON.stringify(agent.getStatus(), null, 2)); rl.prompt(); return; }
        if (input === '/sessions') { agent.getSessions().forEach(s => console.log(`${s.id.slice(0,8)} ${s.title} ${s.provider}/${s.model}`)); rl.prompt(); return; }
        if (input.startsWith('/provider ')) { const [,p,m] = input.split(' '); try { agent.switchProvider(p,m); console.log(`Switched to ${p}/${agent.getStatus().model}`); } catch(e) { console.error(e); } rl.prompt(); return; }
        if (input === '/tools') { agent.getTools().forEach(t => console.log(`  ${t.name}: ${t.description}`)); rl.prompt(); return; }

        process.stdout.write('\n');
        try {
          for await (const chunk of agent.stream(input)) process.stdout.write(chunk);
          process.stdout.write('\n\n');
        } catch (e) { console.error(`\nError: ${e}\n`); }
        rl.prompt();
      });

      rl.on('close', () => { agent.destroy(); process.exit(0); });
    }
  });

program
  .command('prompt <text>')
  .description('Run a single prompt (non-interactive)')
  .option('-c, --cwd <dir>', 'Working directory', process.cwd())
  .option('-p, --provider <name>', 'LLM provider')
  .option('-m, --model <name>', 'Model to use')
  .option('-f, --format <fmt>', 'Output format (text|json)', 'text')
  .action(async (text, opts) => {
    await ensureSetup(opts.cwd, opts.provider, opts.model);

    const agent = new Agent();
    await agent.init(opts.cwd);

    try {
      await agent.start({ cwd: opts.cwd, provider: opts.provider, model: opts.model });
      agent.setAutoApprove(true); // non-interactive mode
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    try {
      const response = await agent.send(text);
      if (opts.format === 'json') {
        console.log(JSON.stringify({ response, status: agent.getStatus() }, null, 2));
      } else {
        console.log(response);
      }
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      agent.destroy();
    }
  });

program
  .command('providers')
  .description('List available LLM providers and models')
  .action(async () => {
    const agent = new Agent();
    await agent.init();

    const providers = agent.listProviders();
    if (!providers.length) {
      console.log('No providers configured. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.');
    } else {
      for (const p of providers) {
        console.log(`\n${p.name}:`);
        for (const m of p.models) console.log(`  - ${m}`);
      }
    }
    agent.destroy();
  });

program
  .command('sessions')
  .description('List saved sessions')
  .option('-c, --cwd <dir>', 'Working directory', process.cwd())
  .action(async (opts) => {
    const agent = new Agent();
    await agent.init(opts.cwd);

    const sessions = agent.getSessions();
    if (!sessions.length) console.log('No sessions found.');
    else for (const s of sessions) {
      const date = new Date(s.updatedAt).toLocaleDateString();
      console.log(`${s.id.slice(0,8)} ${s.title.padEnd(30)} ${s.provider}/${s.model}  ${date}`);
    }
    agent.destroy();
  });

program
  .command('context')
  .description('Analyze current project context')
  .option('-c, --cwd <dir>', 'Working directory', process.cwd())
  .action(async (opts) => {
    const ctx = await analyzeProject(opts.cwd);
    console.log(`Project: ${ctx.name}`);
    console.log(`Language: ${ctx.language}`);
    console.log(`Framework: ${ctx.framework ?? 'none'}`);
    console.log(`\nFiles: ${ctx.stats.totalFiles}`);
    for (const [lang, s] of Object.entries(ctx.stats.byLanguage)) {
      console.log(`  ${lang}: ${s.files} files`);
    }
    console.log(`\nRecent files:`);
    for (const f of ctx.recentFiles) console.log(`  ${f}`);
    console.log(`\nTree:\n${renderTree(ctx.tree)}`);
  });

program.parse();
