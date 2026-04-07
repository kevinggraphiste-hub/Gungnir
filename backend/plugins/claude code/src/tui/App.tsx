import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import type { Agent } from '../core/agent.js';
import type { Message, Session, ToolCall } from '../types/index.js';
import { loadCommands, interpolateCommand, extractPlaceholders } from '../commands/index.js';
import { openInEditor } from '../core/editor.js';

// Syntax highlighting for terminal
function highlightCode(code: string, language?: string): React.ReactNode[] {
  const lines = code.split('\n');
  return lines.map((line, i) => {
    const highlighted = highlightLine(line, language);
    return React.createElement(Text, { key: i, wrap: 'wrap' }, highlighted);
  });
}

function highlightLine(line: string, language?: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = line;
  let key = 0;

  while (remaining.length > 0) {
    let matched = false;

    // Comments
    const commentMatch = remaining.match(/^(\s*(?:\/\/|#|--|;|\/\*|\*|%).*)/);
    if (commentMatch) {
      parts.push(React.createElement(Text, { key: key++, color: 'gray', dimColor: true }, commentMatch[1]));
      remaining = remaining.slice(commentMatch[1].length);
      matched = true;
    }

    // Strings
    if (!matched) {
      const strMatch = remaining.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/);
      if (strMatch) {
        parts.push(React.createElement(Text, { key: key++, color: 'green' }, strMatch[1]));
        remaining = remaining.slice(strMatch[1].length);
        matched = true;
      }
    }

    // Keywords
    if (!matched) {
      const kwMatch = remaining.match(/^(import|export|from|const|let|var|function|class|interface|type|enum|extends|implements|return|if|else|for|while|do|switch|case|break|continue|try|catch|throw|finally|async|await|yield|new|this|super|typeof|instanceof|in|of|default|public|private|protected|static|readonly|abstract|override)\b/);
      if (kwMatch) {
        parts.push(React.createElement(Text, { key: key++, color: 'magenta', bold: true }, kwMatch[1]));
        remaining = remaining.slice(kwMatch[1].length);
        matched = true;
      }
    }

    // Numbers
    if (!matched) {
      const numMatch = remaining.match(/^(\d+\.?\d*(?:e[+-]?\d+)?)/);
      if (numMatch) {
        parts.push(React.createElement(Text, { key: key++, color: 'cyan' }, numMatch[1]));
        remaining = remaining.slice(numMatch[1].length);
        matched = true;
      }
    }

    // Function calls
    if (!matched) {
      const fnMatch = remaining.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/);
      if (fnMatch) {
        parts.push(React.createElement(Text, { key: key++, color: 'yellow' }, fnMatch[1]));
        remaining = remaining.slice(fnMatch[1].length);
        matched = true;
      }
    }

    // Types/Classes (capitalized words)
    if (!matched) {
      const typeMatch = remaining.match(/^([A-Z][a-zA-Z0-9_]*)/);
      if (typeMatch) {
        parts.push(React.createElement(Text, { key: key++, color: 'blue', bold: true }, typeMatch[1]));
        remaining = remaining.slice(typeMatch[1].length);
        matched = true;
      }
    }

    // Operators and punctuation
    if (!matched) {
      const opMatch = remaining.match(/^([{}()\[\];:=<>!&|+\-*/%^~?,.]+)/);
      if (opMatch) {
        parts.push(React.createElement(Text, { key: key++, color: 'white' }, opMatch[1]));
        remaining = remaining.slice(opMatch[1].length);
        matched = true;
      }
    }

    if (!matched) {
      // Regular text
      const nextBreak = remaining.search(/["'`{}()\[\];:=<>!&|+\-*/%^~?,.\s]/);
      const word = nextBreak === -1 ? remaining : remaining.slice(0, nextBreak);
      parts.push(React.createElement(Text, { key: key++ }, word));
      remaining = remaining.slice(word.length);
    }
  }

  return parts;
}

// Parse markdown-like content and render with highlights
function renderMarkdown(content: string): React.ReactNode[] {
  const lines = content.split('\n');
  const nodes: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeLanguage = '';
  let codeLines: string[] = [];
  let key = 0;

  for (const line of lines) {
    // Code block start/end
    const codeStart = line.match(/^```(\w*)/);
    if (codeStart && !inCodeBlock) {
      inCodeBlock = true;
      codeLanguage = codeStart[1] || '';
      codeLines = [];
      nodes.push(React.createElement(Text, { key: key++, color: 'gray', dimColor: true }, `┌─ ${codeLanguage || 'code'}`));
      continue;
    }

    if (line.startsWith('```') && inCodeBlock) {
      inCodeBlock = false;
      nodes.push(React.createElement(Box, { key: key++, flexDirection: 'column', paddingLeft: 1, borderStyle: 'single', borderColor: 'gray' },
        ...highlightCode(codeLines.join('\n'), codeLanguage)
      ));
      nodes.push(React.createElement(Text, { key: key++, color: 'gray', dimColor: true }, '└─'));
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const color = level === 1 ? 'cyan' : level === 2 ? 'blue' : 'white';
      nodes.push(React.createElement(Text, { key: key++, bold: true, color }, headerMatch[2]));
      continue;
    }

    // Inline code
    const parts = line.split(/(`[^`]+`)/);
    if (parts.length > 1) {
      const rendered = parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return React.createElement(Text, { key: i, color: 'cyan', backgroundColor: 'gray' }, part);
        }
        return part;
      });
      nodes.push(React.createElement(Text, { key: key++, wrap: 'wrap' }, ...rendered));
      continue;
    }

    // Bold
    const boldParts = line.split(/(\*\*[^*]+\*\*)/);
    if (boldParts.length > 1) {
      const rendered = boldParts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return React.createElement(Text, { key: i, bold: true }, part.slice(2, -2));
        }
        return part;
      });
      nodes.push(React.createElement(Text, { key: key++, wrap: 'wrap' }, ...rendered));
      continue;
    }

    // List items
    const listMatch = line.match(/^(\s*[-*]\s+)(.*)/);
    if (listMatch) {
      nodes.push(React.createElement(Text, { key: key++, wrap: 'wrap' },
        React.createElement(Text, { color: 'cyan' }, '•'),
        ' ',
        listMatch[2]
      ));
      continue;
    }

    // Regular text
    if (line.trim()) {
      nodes.push(React.createElement(Text, { key: key++, wrap: 'wrap' }, line));
    } else {
      nodes.push(React.createElement(Text, { key: key++ }, ''));
    }
  }

  // Handle unclosed code block
  if (inCodeBlock) {
    nodes.push(React.createElement(Box, { key: key++, flexDirection: 'column', paddingLeft: 1, borderStyle: 'single', borderColor: 'gray' },
      ...highlightCode(codeLines.join('\n'), codeLanguage)
    ));
  }

  return nodes;
}

type Page = 'chat' | 'sessions' | 'models' | 'help' | 'logs';

interface AppProps {
  agent: Agent;
}

export function App({ agent }: AppProps) {
  const { exit } = useApp();
  const [page, setPage] = useState<Page>('chat');
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [status, setStatus] = useState(agent.getStatus());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [providers, setProviders] = useState(agent.listProviders());
  const [cursor, setCursor] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const messagesRef = useRef<DisplayMessage[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Event listeners
  useEffect(() => {
    agent.on('token', (token: unknown) => {
      const t = token as string;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last._streaming) {
          const updated = [...prev];
          updated[updated.length - 1] = { ...last, content: last.content + t };
          return updated;
        }
        return prev;
      });
    });

    agent.on('tool_call', (tc: unknown) => {
      const toolCall = tc as ToolCall;
      setCurrentTool(toolCall.name);
      setMessages((prev) => [
        ...prev,
        { role: 'tool', content: `🔧 ${toolCall.name}(${formatArgs(toolCall.arguments)})`, timestamp: Date.now() },
      ]);
    });

    agent.on('tool_result', (data: unknown) => {
      const { name, result } = data as { name: string; result: string };
      setCurrentTool(null);
      setLogs((prev) => [...prev, `[tool:${name}] ${result.slice(0, 200)}`]);
    });

    agent.on('response', () => {
      setIsStreaming(false);
      setCurrentTool(null);
      setStatus(agent.getStatus());
    });

    agent.on('error', (err: unknown) => {
      setIsStreaming(false);
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: `❌ ${msg}`, timestamp: Date.now() },
      ]);
    });
  }, [agent]);

  // Keyboard input
  useInput((input, key) => {
    // Ctrl+C = quit or cancel
    if (key.ctrl && input === 'c') {
      if (isStreaming) {
        agent.stop();
        setIsStreaming(false);
      } else {
        exit();
      }
      return;
    }

    // Ctrl+N = new session
    if (key.ctrl && input === 'n') {
      createNewSession();
      return;
    }

    // Ctrl+A = sessions
    if (key.ctrl && input === 'a') {
      setSessions(agent.getSessions());
      setPage(page === 'sessions' ? 'chat' : 'sessions');
      setCursor(0);
      return;
    }

    // Ctrl+O = models
    if (key.ctrl && input === 'o') {
      setProviders(agent.listProviders());
      setPage(page === 'models' ? 'chat' : 'models');
      setCursor(0);
      return;
    }

    // Ctrl+L = logs
    if (key.ctrl && input === 'l') {
      setPage(page === 'logs' ? 'chat' : 'logs');
      return;
    }

    // Ctrl+E = external editor
    if (key.ctrl && input === 'e') {
      handleExternalEditor();
      return;
    }

    // ? = help (when not typing, i.e. not in text input focus)
    if (input === '?' && !key.ctrl) {
      setPage(page === 'help' ? 'chat' : 'help');
      return;
    }

    // Esc = close overlay
    if (key.escape) {
      setPage('chat');
      return;
    }

    // Navigation in lists
    if (page === 'sessions' || page === 'models') {
      if (key.upArrow || input === 'k') {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        const max = page === 'sessions' ? sessions.length : providers.reduce((a, p) => a + p.models.length, 0);
        setCursor((c) => Math.min(max - 1, c + 1));
        return;
      }
      if (key.return) {
        if (page === 'sessions') selectSession(cursor);
        else selectModel(cursor);
        return;
      }
    }
  });

  const createNewSession = useCallback(async () => {
    await agent.start({ cwd: agent.getStatus().currentSession ? undefined : process.cwd() });
    setMessages([]);
    setStatus(agent.getStatus());
  }, [agent]);

  const selectSession = useCallback(
    (index: number) => {
      if (sessions[index]) {
        agent.loadSession(sessions[index].id);
        setMessages([]);
        setStatus(agent.getStatus());
        setSessions(agent.getSessions());
      }
      setPage('chat');
    },
    [agent, sessions]
  );

  const selectModel = useCallback(
    (index: number) => {
      let i = 0;
      for (const p of providers) {
        for (const m of p.models) {
          if (i === index) {
            agent.switchProvider(p.name, m);
            setStatus(agent.getStatus());
            setPage('chat');
            return;
          }
          i++;
        }
      }
      setPage('chat');
    },
    [agent, providers]
  );

  const handleListCommands = useCallback(async () => {
    try {
      const commands = await loadCommands(process.cwd());
      if (!commands.length) {
        setMessages((prev) => [
          ...prev,
          { role: 'system', content: 'No custom commands found. Create .md files in ~/.spearcode/commands/ or .spearcode/commands/', timestamp: Date.now() },
        ]);
      } else {
        const list = commands.map((c) => `  ${c.id.padEnd(30)} ${c.description}`).join('\n');
        setMessages((prev) => [
          ...prev,
          { role: 'system', content: `Custom commands:\n${list}\n\nRun with: /run <command_id>`, timestamp: Date.now() },
        ]);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: `Failed to load commands: ${e}`, timestamp: Date.now() },
      ]);
    }
  }, []);

  const handleRunCommand = useCallback(async (commandId: string) => {
    if (!commandId) {
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: 'Usage: /run <command_id>', timestamp: Date.now() },
      ]);
      return;
    }

    try {
      const commands = await loadCommands(process.cwd());
      const cmd = commands.find((c) => c.id === commandId || c.name === commandId);

      if (!cmd) {
        setMessages((prev) => [
          ...prev,
          { role: 'error', content: `Command not found: ${commandId}. Use /commands to list.`, timestamp: Date.now() },
        ]);
        return;
      }

      const placeholders = extractPlaceholders(cmd.content);
      // For now, just send the content as-is (placeholders without values stay as $NAME)
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: `[Running: ${cmd.name}]`, timestamp: Date.now() },
        { role: 'assistant', content: '', _streaming: true, timestamp: Date.now() },
      ]);
      setIsStreaming(true);

      try {
        await agent.send(cmd.content);
      } catch {
        // handled by event listener
      }

      setMessages((prev) =>
        prev.map((m) => (m._streaming ? { ...m, _streaming: false } : m))
      );
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: `Failed to run command: ${e}`, timestamp: Date.now() },
      ]);
    }
  }, [agent]);

  const handleExternalEditor = useCallback(async () => {
    try {
      const content = await openInEditor(input);
      if (content.trim()) {
        setInput(content);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: `Editor error: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() },
      ]);
    }
  }, [input]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    // Slash commands
    if (text.startsWith('/')) {
      handleCommand(text);
      return;
    }

    setInput('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text, timestamp: Date.now() },
      { role: 'assistant', content: '', _streaming: true, timestamp: Date.now() },
    ]);
    setIsStreaming(true);

    try {
      await agent.send(text);
    } catch {
      // handled by event listener
    }

    setMessages((prev) =>
      prev.map((m) => (m._streaming ? { ...m, _streaming: false } : m))
    );
  }, [input, isStreaming, agent]);

  const handleCommand = useCallback(
    (cmd: string) => {
      const parts = cmd.slice(1).split(' ');
      const command = parts[0];

      switch (command) {
        case 'quit':
        case 'exit':
          exit();
          break;
        case 'clear':
          setMessages([]);
          break;
        case 'sessions':
          setSessions(agent.getSessions());
          setPage('sessions');
          break;
        case 'model':
          setProviders(agent.listProviders());
          setPage('models');
          break;
        case 'status':
          setMessages((prev) => [
            ...prev,
            { role: 'system', content: JSON.stringify(agent.getStatus(), null, 2), timestamp: Date.now() },
          ]);
          break;
        case 'tools':
          const tools = agent.getTools();
          setMessages((prev) => [
            ...prev,
            { role: 'system', content: tools.map((t) => `  ${t.name}: ${t.description}`).join('\n'), timestamp: Date.now() },
          ]);
          break;
        case 'help':
          setPage('help');
          break;
        case 'commands':
          handleListCommands();
          break;
        case 'run':
          handleRunCommand(parts.slice(1).join(' '));
          break;
        default:
          setMessages((prev) => [
            ...prev,
            { role: 'error', content: `Unknown command: /${command}`, timestamp: Date.now() },
          ]);
      }
      setInput('');
    },
    [agent, exit]
  );

  // Auto-start session
  useEffect(() => {
    (async () => {
      try {
        await agent.start();
        setStatus(agent.getStatus());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages([{ role: 'error', content: `Failed to start: ${msg}`, timestamp: Date.now() }]);
      }
    })();
  }, [agent]);

  // Render
  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Header status={status} page={page} />

      {/* Main content */}
      <Box flexDirection="column" flexGrow={1}>
        {page === 'chat' && (
          <ChatView messages={messages} currentTool={currentTool} />
        )}
        {page === 'sessions' && (
          <SessionListView sessions={sessions} cursor={cursor} />
        )}
        {page === 'models' && (
          <ModelListView providers={providers} cursor={cursor} />
        )}
        {page === 'help' && <HelpView />}
        {page === 'logs' && <LogView logs={logs} />}
      </Box>

      {/* Input */}
      {page === 'chat' && (
        <Box borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan">{isStreaming ? '⟳' : '❯'} </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder={isStreaming ? 'Generating...' : 'Type a message, / for commands, ? for help'}
          />
        </Box>
      )}
    </Box>
  );
}

// --- Sub-components ---

interface DisplayMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error';
  content: string;
  timestamp: number;
  _streaming?: boolean;
}

function Header({ status, page }: { status: { provider?: string; model?: string; state: string }; page: string }) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">⚔ SpearCode</Text>
      <Text color="gray">
        {status.provider}/{status.model}{' '}
        {status.state === 'running' && <Text color="yellow">⟳ generating</Text>}
      </Text>
      <Text color="gray">{page !== 'chat' ? `[${page}]` : 'Ctrl+? help'}</Text>
    </Box>
  );
}

function ChatView({ messages, currentTool }: { messages: DisplayMessage[]; currentTool: string | null }) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
      {messages.map((msg, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          {msg.role === 'user' && (
            <Box>
              <Text color="green" bold>❯ </Text>
              <Text>{msg.content}</Text>
            </Box>
          )}
          {msg.role === 'assistant' && (
            <Box flexDirection="column">
              <Text color="blue" bold>⬢ </Text>
              {msg.content ? (
                <Box flexDirection="column" paddingLeft={1}>
                  {renderMarkdown(msg.content)}
                </Box>
              ) : (
                <Text>{msg._streaming ? '...' : ''}</Text>
              )}
              {msg._streaming && <Text color="cyan">▋</Text>}
            </Box>
          )}
          {msg.role === 'tool' && (
            <Box paddingLeft={2}>
              <Text color="yellow" dimColor>{msg.content}</Text>
            </Box>
          )}
          {msg.role === 'system' && (
            <Box paddingLeft={2}>
              <Text color="gray">{msg.content}</Text>
            </Box>
          )}
          {msg.role === 'error' && (
            <Box paddingLeft={2}>
              <Text color="red">{msg.content}</Text>
            </Box>
          )}
        </Box>
      ))}
      {currentTool && (
        <Box paddingLeft={2}>
          <Text color="yellow">Executing: {currentTool}...</Text>
        </Box>
      )}
    </Box>
  );
}

function SessionListView({ sessions, cursor }: { sessions: Session[]; cursor: number }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">Sessions</Text>
      <Text color="gray">↑↓ navigate, Enter select, Esc close</Text>
      <Box flexDirection="column" marginTop={1}>
        {sessions.length === 0 && <Text color="gray">No sessions</Text>}
        {sessions.map((s, i) => (
          <Box key={s.id}>
            <Text color={i === cursor ? 'cyan' : 'white'} bold={i === cursor}>
              {i === cursor ? '▸ ' : '  '}
              {s.title.slice(0, 30).padEnd(30)} {s.provider}/{s.model}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ModelListView({ providers, cursor }: { providers: { name: string; models: string[] }[]; cursor: number }) {
  let i = 0;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">Models</Text>
      <Text color="gray">↑↓ navigate, Enter select, Esc close</Text>
      <Box flexDirection="column" marginTop={1}>
        {providers.map((p) => (
          <Box key={p.name} flexDirection="column">
            <Text bold color="yellow">{p.name}</Text>
            {p.models.map((m) => {
              const idx = i++;
              return (
                <Box key={m} paddingLeft={2}>
                  <Text color={idx === cursor ? 'cyan' : 'white'} bold={idx === cursor}>
                    {idx === cursor ? '▸ ' : '  '}{m}
                  </Text>
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function HelpView() {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">Keyboard Shortcuts</Text>
      <Box flexDirection="column" marginTop={1}>
        <Shortcut keys="Ctrl+C" desc="Quit (or cancel generation)" />
        <Shortcut keys="Ctrl+N" desc="New session" />
        <Shortcut keys="Ctrl+A" desc="Switch session" />
        <Shortcut keys="Ctrl+O" desc="Switch model" />
        <Shortcut keys="Ctrl+L" desc="View logs" />
        <Shortcut keys="Ctrl+E" desc="Open external editor" />
        <Shortcut keys="?" desc="Toggle help" />
        <Shortcut keys="Esc" desc="Close dialog" />
        <Box marginTop={1}>
          <Text bold color="cyan">Commands</Text>
        </Box>
        <Shortcut keys="/clear" desc="Clear chat" />
        <Shortcut keys="/sessions" desc="List sessions" />
        <Shortcut keys="/model" desc="Switch model" />
        <Shortcut keys="/status" desc="Show status" />
        <Shortcut keys="/tools" desc="List available tools" />
        <Shortcut keys="/quit" desc="Exit" />
      </Box>
    </Box>
  );
}

function LogView({ logs }: { logs: string[] }) {
  const recent = logs.slice(-20);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">Logs (last 20)</Text>
      <Text color="gray">Backspace or q to return</Text>
      <Box flexDirection="column" marginTop={1}>
        {recent.map((log, i) => (
          <Text key={i} color="gray">{log}</Text>
        ))}
        {recent.length === 0 && <Text color="gray">No logs yet</Text>}
      </Box>
    </Box>
  );
}

function Shortcut({ keys, desc }: { keys: string; desc: string }) {
  return (
    <Box>
      <Text color="cyan" bold>{keys.padEnd(12)}</Text>
      <Text>{desc}</Text>
    </Box>
  );
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v.slice(0, 50) : JSON.stringify(v);
      return `${k}=${val}`;
    })
    .join(', ');
}
