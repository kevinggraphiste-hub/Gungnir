import type {
  LLMProvider,
  Message,
  StreamOptions,
  ChatOptions,
  StreamChunk,
  ProviderTool,
  ToolParameter,
} from '../types/index.js';

function toolToOpenAI(tool: ProviderTool) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, param] of Object.entries(tool.parameters)) {
    properties[key] = paramToOpenAI(param);
    if (param.required) required.push(key);
  }

  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties,
        required,
      },
    },
  };
}

function paramToOpenAI(param: ToolParameter): Record<string, unknown> {
  const result: Record<string, unknown> = { type: param.type, description: param.description };
  if (param.enum) result.enum = param.enum;
  if (param.items) result.items = paramToOpenAI(param.items);
  if (param.properties) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(param.properties)) {
      props[k] = paramToOpenAI(v);
    }
    result.properties = props;
  }
  return result;
}

export function createAnthropicProvider(apiKey: string): LLMProvider {
  const base = 'https://api.anthropic.com/v1';

  async function* streamChat(messages: Message[], options: StreamOptions): AsyncIterable<StreamChunk> {
    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');

    const body = {
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      system: systemMsg?.content,
      messages: nonSystem.map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'user' as const,
            content: [
              {
                type: 'tool_result' as const,
                tool_use_id: m.toolCallId,
                content: m.content,
              },
            ],
          };
        }
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.toolCalls?.length) {
          msg.content = [
            { type: 'text', text: m.content || '' },
            ...m.toolCalls.map((tc) => ({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            })),
          ];
        }
        return msg;
      }),
      stream: true,
      ...(options.tools?.length
        ? { tools: options.tools.map(toolToAnthropic) }
        : {}),
    };

    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error: ${res.status} ${err}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolCall: { id: string; name: string; input: string } | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }

        try {
          const event = JSON.parse(data);

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const text = event.delta.text;
            options.onToken?.(text);
            yield { type: 'content', content: text };
          }

          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            currentToolCall = {
              id: event.content_block.id,
              name: event.content_block.name,
              input: '',
            };
          }

          if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && currentToolCall) {
            currentToolCall.input += event.delta.partial_json;
          }

          if (event.type === 'content_block_stop' && currentToolCall) {
            const tc = {
              id: currentToolCall.id,
              name: currentToolCall.name,
              arguments: JSON.parse(currentToolCall.input || '{}'),
            };
            options.onToolCall?.(tc);
            yield { type: 'tool_call', toolCall: tc };
            currentToolCall = null;
          }
        } catch {
          // skip malformed events
        }
      }
    }
  }

  async function chat(messages: Message[], options: ChatOptions): Promise<Message> {
    let content = '';
    const toolCalls: import('../types/index.js').ToolCall[] = [];

    for await (const chunk of streamChat(messages, { ...options, onToken: undefined })) {
      if (chunk.type === 'content') content += chunk.content;
      if (chunk.type === 'tool_call' && chunk.toolCall) toolCalls.push(chunk.toolCall);
    }

    return {
      id: crypto.randomUUID(),
      sessionId: messages[0]?.sessionId ?? '',
      role: 'assistant',
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      timestamp: Date.now(),
    };
  }

  return {
    name: 'anthropic',
    models: [
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
    ],
    streamChat,
    chat,
  };
}

function toolToAnthropic(tool: ProviderTool) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, param] of Object.entries(tool.parameters)) {
    properties[key] = paramToAnthropic(param);
    if (param.required) required.push(key);
  }

  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties,
      required,
    },
  };
}

function paramToAnthropic(param: ToolParameter): Record<string, unknown> {
  const result: Record<string, unknown> = { type: param.type, description: param.description };
  if (param.enum) result.enum = param.enum;
  if (param.items) result.items = paramToAnthropic(param.items);
  if (param.properties) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(param.properties)) {
      props[k] = paramToAnthropic(v);
    }
    result.properties = props;
  }
  return result;
}

export function createOpenAIProvider(apiKey: string, baseUrl?: string): LLMProvider {
  const base = baseUrl ?? 'https://api.openai.com/v1';

  async function* streamChat(messages: Message[], options: StreamOptions): AsyncIterable<StreamChunk> {
    const body = {
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      messages: messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'tool' as const, content: m.content, tool_call_id: m.toolCallId };
        }
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }));
        }
        return msg;
      }),
      stream: true,
      ...(options.tools?.length ? { tools: options.tools.map(toolToOpenAI) } : {}),
    };

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API error: ${res.status} ${err}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            options.onToken?.(delta.content);
            yield { type: 'content', content: delta.content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const toolCall = {
                id: tc.id ?? crypto.randomUUID(),
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
              };
              if (tc.function?.name) {
                options.onToolCall?.(toolCall);
                yield { type: 'tool_call', toolCall };
              }
            }
          }
        } catch {
          // skip
        }
      }
    }
  }

  async function chat(messages: Message[], options: ChatOptions): Promise<Message> {
    let content = '';
    const toolCalls: import('../types/index.js').ToolCall[] = [];

    for await (const chunk of streamChat(messages, { ...options, onToken: undefined })) {
      if (chunk.type === 'content') content += chunk.content;
      if (chunk.type === 'tool_call' && chunk.toolCall) toolCalls.push(chunk.toolCall);
    }

    return {
      id: crypto.randomUUID(),
      sessionId: messages[0]?.sessionId ?? '',
      role: 'assistant',
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      timestamp: Date.now(),
    };
  }

  return {
    name: 'openai',
    models: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'o3-mini',
      'o4-mini',
    ],
    streamChat,
    chat,
  };
}

export function createOpenRouterProvider(apiKey: string): LLMProvider {
  const base = 'https://openrouter.ai/api/v1';

  async function* streamChat(messages: Message[], options: StreamOptions): AsyncIterable<StreamChunk> {
    const body = {
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      messages: messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'tool' as const, content: m.content, tool_call_id: m.toolCallId };
        }
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }));
        }
        return msg;
      }),
      stream: true,
      ...(options.tools?.length ? { tools: options.tools.map(toolToOpenAI) } : {}),
    };

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://spearcode.dev',
        'X-Title': 'SpearCode',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenRouter API error: ${res.status} ${err}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            options.onToken?.(delta.content);
            yield { type: 'content', content: delta.content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const toolCall = {
                id: tc.id ?? crypto.randomUUID(),
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
              };
              if (tc.function?.name) {
                options.onToolCall?.(toolCall);
                yield { type: 'tool_call', toolCall };
              }
            }
          }
        } catch {
          // skip
        }
      }
    }
  }

  async function chat(messages: Message[], options: ChatOptions): Promise<Message> {
    let content = '';
    const toolCalls: import('../types/index.js').ToolCall[] = [];

    for await (const chunk of streamChat(messages, { ...options, onToken: undefined })) {
      if (chunk.type === 'content') content += chunk.content;
      if (chunk.type === 'tool_call' && chunk.toolCall) toolCalls.push(chunk.toolCall);
    }

    return {
      id: crypto.randomUUID(),
      sessionId: messages[0]?.sessionId ?? '',
      role: 'assistant',
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      timestamp: Date.now(),
    };
  }

  return {
    name: 'openrouter',
    models: [
      // Anthropic
      'anthropic/claude-sonnet-4',
      'anthropic/claude-3.7-sonnet',
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3.5-haiku',
      'anthropic/claude-3-opus',
      // OpenAI
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'openai/gpt-4.1',
      'openai/gpt-4.1-mini',
      'openai/o3-mini',
      'openai/o4-mini',
      // Google
      'google/gemini-2.5-pro-preview',
      'google/gemini-2.5-flash-preview',
      'google/gemini-2.0-flash',
      // Meta
      'meta-llama/llama-4-maverick',
      'meta-llama/llama-4-scout',
      'meta-llama/llama-3.3-70b-instruct',
      // DeepSeek
      'deepseek/deepseek-r1',
      'deepseek/deepseek-chat-v3',
      'deepseek/deepseek-coder-v2',
      // Moonshot (Kimi)
      'moonshotai/kimi-k2',
      'moonshot/moonshot-v1-128k',
      // Xiaomi (MiMo)
      'xiaomi/mimo-v2-pro',
      // Qwen
      'qwen/qwen-2.5-coder-32b-instruct',
      'qwen/qwen-2.5-72b-instruct',
      'qwen/qwq-32b',
      // Mistral
      'mistralai/codestral-2501',
      'mistralai/mistral-large',
      // Cohere
      'cohere/command-r-plus',
      // Perplexity
      'perplexity/sonar-pro',
      // Others
      'databricks/dbrx-instruct',
    ],
    streamChat,
    chat,
  };
}

export function createOllamaProvider(baseUrl?: string): LLMProvider {
  const base = baseUrl ?? process.env.LOCAL_ENDPOINT ?? 'http://localhost:11434';

  async function* streamChat(messages: Message[], options: StreamOptions): AsyncIterable<StreamChunk> {
    const body = {
      model: options.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
      ...(options.tools?.length ? { tools: options.tools.map(toolToOpenAI) } : {}),
    };

    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama API error: ${res.status} ${err}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            options.onToken?.(parsed.message.content);
            yield { type: 'content', content: parsed.message.content };
          }
          if (parsed.done) {
            yield { type: 'done' };
            return;
          }
        } catch {
          // skip
        }
      }
    }
  }

  async function chat(messages: Message[], options: ChatOptions): Promise<Message> {
    let content = '';
    for await (const chunk of streamChat(messages, { ...options, onToken: undefined })) {
      if (chunk.type === 'content') content += chunk.content;
    }

    return {
      id: crypto.randomUUID(),
      sessionId: messages[0]?.sessionId ?? '',
      role: 'assistant',
      content,
      timestamp: Date.now(),
    };
  }

  return {
    name: 'ollama',
    models: [], // dynamically populated
    streamChat,
    chat,
  };
}
