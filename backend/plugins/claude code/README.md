# SpearCode ⚔️

**AI coding agent for the terminal.** 51 tools, 31 models, built for developers who want more than ChatGPT in a box.

[![npm](https://img.shields.io/npm/v/spearcode)](https://www.npmjs.com/package/spearcode)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/spearcode/spearcode/actions/workflows/ci.yml/badge.svg)](https://github.com/spearcode/spearcode/actions)

## Features

### Core
- **31 models** via OpenRouter, Anthropic, OpenAI, Ollama
- **Streaming** responses with tool calling
- **Session management** with SQLite persistence
- **Auto-compact** when context window fills up
- **Permission system** for dangerous operations
- **Syntax highlighting** in terminal responses

### 51 Tools
| Category | Tools |
|----------|-------|
| Files | `read_file`, `write_file`, `edit_file`, `list_files` |
| Search | `glob`, `grep`, `semantic_search` |
| Shell | `bash` |
| Git | `git_status`, `git_diff`, `git_log`, `git_blame`, `git_show`, `git_branch`, `git_stash`, `git_add`, `git_commit`, `git_checkout` |
| GitHub | `gh_pr_list`, `gh_pr_create`, `gh_pr_view`, `gh_pr_merge`, `gh_issue_list`, `gh_issue_create`, `gh_issue_view`, `gh_repo_info`, `gh_workflow_runs` |
| Web | `web_fetch`, `web_search` |
| Vision | `read_image`, `read_pdf` |
| Analysis | `generate_tests`, `analyze_test_coverage`, `visual_diff`, `diff_summary`, `pr_review`, `pr_diff`, `pr_commits`, `check_dependencies`, `analyze_dependency_tree`, `suggest_upgrades`, `explain_code`, `explain_function`, `impact_analysis`, `find_references`, `dependency_graph` |
| Context | `get_project_context`, `diagnostics` |
| MCP | External MCP servers via stdio/SSE |
| LSP | Language Server Protocol diagnostics |

### Unique Features (nobody else has these)
- **Semantic search** — find code by meaning, not just text
- **Learning from corrections** — the AI remembers when you correct it
- **Cost tracking** — know exactly how much each session costs
- **AI personas** — switch between Architect, Debugger, Reviewer, Writer, Tester, Optimizer, Hacker
- **PR review** — automated code review with scoring
- **Session forking** — explore 2 approaches in parallel
- **Real-time collaboration** — work with other devs on the same session
- **Gungnir integration** — sub-agents, skills, heartbeat, autonomous mode

## Installation

```bash
# npm
npm install -g spearcode

# Quick install (macOS/Linux)
curl -fsSL https://raw.githubusercontent.com/spearcode/spearcode/main/install.sh | bash

# Windows
# Download install.bat from releases
```

## Quick Start

```bash
# Interactive setup wizard
spearcode setup

# Or set your API key directly
export OPENROUTER_API_KEY=sk-or-...

# Launch TUI
spearcode

# Single prompt
spearcode prompt "Fix the bug in src/auth.ts"

# Analyze project
spearcode context
```

## Configuration

SpearCode looks for config in:
- `.spearcode.json` (project root)
- `~/.spearcode.json` (home directory)
- `.env` (environment variables)

```json
{
  "agents": {
    "coder": { "model": "anthropic/claude-sonnet-4", "maxTokens": 4096 }
  },
  "shell": { "path": "/bin/bash", "args": ["-l"] },
  "mcpServers": {
    "example": { "type": "stdio", "command": "path/to/server" }
  },
  "autoCompact": true
}
```

### Environment Variables
```bash
OPENROUTER_API_KEY=sk-or-...    # 30+ models
ANTHROPIC_API_KEY=sk-ant-...    # Claude direct
OPENAI_API_KEY=sk-...           # GPT direct
LOCAL_ENDPOINT=http://localhost:11434  # Ollama
```

## Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `Ctrl+C` | Quit / Cancel |
| `Ctrl+N` | New session |
| `Ctrl+A` | Switch session |
| `Ctrl+O` | Switch model |
| `Ctrl+E` | External editor |
| `Ctrl+L` | View logs |
| `?` | Help |

## Commands
| Command | Description |
|---------|-------------|
| `/clear` | Clear chat |
| `/sessions` | List sessions |
| `/model` | Switch model |
| `/tools` | List tools |
| `/commands` | Custom commands |
| `/run <id>` | Run custom command |
| `/status` | Show status |

## AI Personas
```bash
# In TUI, switch persona for different expertise:
# Architect  - System design, scalability
# Debugger   - Bug hunting, root cause
# Reviewer   - Code review, security
# Writer     - Documentation
# Tester     - Test generation
# Optimizer  - Performance
# Hacker     - Security audit
```

## Gungnir Integration
```typescript
import { GungnirBridge } from 'spearcode';

const bridge = new GungnirBridge('my-agent');
await bridge.start({ mode: 'autonomous' });
bridge.enableHeartbeat(5000);

// Register skills
bridge.registerSkill({
  id: 'deploy',
  name: 'deploy',
  description: 'Deploy the project',
  handler: async (args) => { /* ... */ },
});

// Execute tasks
const result = await bridge.executeTask('Fix the auth bug');

// Spawn sub-agents
const sub = await bridge.spawnSubAgent('researcher');
```

## Development
```bash
git clone https://github.com/spearcode/spearcode
cd spearcode
npm install
npm run dev        # Run from source
npm run build      # Build TypeScript
npm test           # Run tests
npm run typecheck  # Check types
```

## License
MIT
