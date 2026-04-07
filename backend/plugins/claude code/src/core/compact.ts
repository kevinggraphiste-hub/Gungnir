import type { Message, LLMProvider } from '../types/index.js';

// Rough token estimation: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg: Message): number {
  let tokens = estimateTokens(msg.content) + 4; // role overhead
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      tokens += estimateTokens(tc.name) + estimateTokens(JSON.stringify(tc.arguments)) + 4;
    }
  }
  return tokens;
}

export interface CompactResult {
  summary: string;
  tokenCount: number;
  originalMessageCount: number;
}

export function estimateContextTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

export function isNearContextLimit(messages: Message[], maxTokens: number, threshold = 0.95): boolean {
  const used = estimateContextTokens(messages);
  return used >= maxTokens * threshold;
}

export async function compactContext(
  messages: Message[],
  provider: LLMProvider,
  model: string,
  maxTokens: number
): Promise<CompactResult> {
  const originalTokenCount = estimateContextTokens(messages);
  const originalMessageCount = messages.length;

  // Build summarization prompt
  const conversationText = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      let text = `[${m.role}]`;
      if (m.role === 'tool') text += ` (tool: ${m.toolCallId?.slice(0, 8)})`;
      text += ` ${m.content.slice(0, 500)}`;
      if (m.toolCalls?.length) {
        text += `\n  Tool calls: ${m.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 100)})`).join(', ')}`;
      }
      return text;
    })
    .join('\n\n');

  const summaryMessage: Message = {
    id: 'compact',
    sessionId: messages[0]?.sessionId ?? '',
    role: 'user',
    content: `You are summarizing a conversation between a developer and an AI coding assistant.

Produce a concise summary that preserves:
1. All files that were read, created, or modified (with paths)
2. Key decisions and changes made
3. Current state of the work (what's done, what's pending)
4. Any errors encountered and how they were resolved
5. The project context (language, framework, structure)

Be specific with file paths and function names. The summary will be used to continue the conversation without losing context.

Conversation:
${conversationText}`,
    timestamp: Date.now(),
  };

  const summarySystem: Message = {
    id: 'sys',
    sessionId: '',
    role: 'system',
    content: 'You are a conversation summarizer. Be concise but preserve all important details like file paths, code changes, and decisions.',
    timestamp: 0,
  };

  const response = await provider.chat([summarySystem, summaryMessage], {
    model,
    maxTokens: Math.min(2000, maxTokens),
    temperature: 0.3,
  });

  return {
    summary: response.content,
    tokenCount: estimateTokens(response.content),
    originalMessageCount,
  };
}
