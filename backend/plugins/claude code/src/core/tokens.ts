import type { Message } from '../types/index.js';

// Approximate token counting without external dependency
// Based on cl100k_base encoding (GPT-4/Claude style)

const SPECIAL_CHARS = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

export function countTokens(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    // Whitespace
    if (/\s/.test(char)) {
      tokens += 0.25; // Whitespace is cheap
      i++;
      continue;
    }

    // Special characters
    if (SPECIAL_CHARS.has(char)) {
      tokens += 0.5;
      i++;
      continue;
    }

    // Numbers
    if (/\d/.test(char)) {
      while (i < text.length && /[\d.]/.test(text[i])) i++;
      tokens += 1;
      continue;
    }

    // Words
    if (/[a-zA-Z]/.test(char)) {
      const start = i;
      while (i < text.length && /[a-zA-Z]/.test(text[i])) i++;
      const word = text.slice(start, i);
      // Common words are ~1 token, longer/rarer words split into more
      tokens += estimateWordTokens(word);
      continue;
    }

    // Unicode / CJK characters (1 char ≈ 1-2 tokens)
    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(char)) {
      tokens += 1.5;
      i++;
      continue;
    }

    // Other characters
    tokens += 0.5;
    i++;
  }

  return Math.ceil(tokens);
}

function estimateWordTokens(word: string): number {
  if (word.length <= 2) return 0.75;
  if (word.length <= 4) return 1;
  if (word.length <= 6) return 1.25;
  if (word.length <= 10) return 1.5;
  // Long words get split
  return Math.ceil(word.length / 4);
}

export function countMessageTokens(msg: Message): number {
  let tokens = countTokens(msg.role) + 4; // role + overhead

  tokens += countTokens(msg.content);

  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      tokens += countTokens(tc.name) + countTokens(JSON.stringify(tc.arguments)) + 6;
    }
  }

  if (msg.toolCallId) {
    tokens += 4;
  }

  return tokens;
}

export function countMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + countMessageTokens(m), 0);
}

export function getContextWindowStats(messages: Message[], maxContextTokens: number) {
  const used = countMessagesTokens(messages);
  const remaining = maxContextTokens - used;
  const percent = Math.round((used / maxContextTokens) * 100);

  return {
    used,
    remaining: Math.max(0, remaining),
    total: maxContextTokens,
    percent,
    nearLimit: percent >= 90,
    atLimit: percent >= 95,
  };
}

// Model context window sizes
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'anthropic/claude-sonnet-4': 200000,
  'anthropic/claude-3.7-sonnet': 200000,
  'anthropic/claude-3.5-sonnet': 200000,
  'anthropic/claude-3.5-haiku': 200000,
  'anthropic/claude-3-opus': 200000,
  'openai/gpt-4o': 128000,
  'openai/gpt-4.1': 1047576,
  'openai/o3-mini': 200000,
  'google/gemini-2.5-pro-preview': 1000000,
  'google/gemini-2.0-flash': 1000000,
  'deepseek/deepseek-r1': 128000,
  'deepseek/deepseek-chat-v3': 128000,
  'xiaomi/mimo-v2-pro': 32000,
  'moonshotai/kimi-k2': 128000,
  'qwen/qwen-2.5-coder-32b-instruct': 128000,
  'mistralai/codestral-2501': 256000,
};

export function getContextWindowSize(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? 128000;
}
