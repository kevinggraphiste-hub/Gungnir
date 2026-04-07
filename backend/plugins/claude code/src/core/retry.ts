import type { Message, StreamOptions, ChatOptions, LLMProvider, StreamChunk } from '../types/index.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY = 1000; // 1s

interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export function withRetry(provider: LLMProvider, retryOptions?: RetryOptions): LLMProvider {
  const maxRetries = retryOptions?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = retryOptions?.baseDelay ?? DEFAULT_BASE_DELAY;

  async function* streamChat(messages: Message[], options: StreamOptions): AsyncIterable<StreamChunk> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        yield* provider.streamChat(messages, options);
        return; // Success
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (!isRetryable(lastError)) {
          throw lastError;
        }

        if (attempt === maxRetries) {
          throw lastError;
        }

        const delay = getRetryDelay(lastError, baseDelay, attempt);
        retryOptions?.onRetry?.(attempt + 1, lastError, delay);

        await sleep(delay);
      }
    }

    throw lastError ?? new Error('Retry failed');
  }

  async function chat(messages: Message[], options: ChatOptions): Promise<Message> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await provider.chat(messages, options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (!isRetryable(lastError)) {
          throw lastError;
        }

        if (attempt === maxRetries) {
          throw lastError;
        }

        const delay = getRetryDelay(lastError, baseDelay, attempt);
        retryOptions?.onRetry?.(attempt + 1, lastError, delay);

        await sleep(delay);
      }
    }

    throw lastError ?? new Error('Retry failed');
  }

  return {
    name: provider.name,
    models: provider.models,
    streamChat,
    chat,
  };
}

function isRetryable(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Rate limit
  if (message.includes('rate limit') || message.includes('429')) return true;
  if (message.includes('too many requests')) return true;

  // Server errors
  if (message.includes('500') || message.includes('502') || message.includes('503')) return true;
  if (message.includes('524') || message.includes('529')) return true;
  if (message.includes('overloaded')) return true;

  // Timeout
  if (message.includes('timeout') || message.includes('timed out')) return true;
  if (message.includes('network') || message.includes('econnreset')) return true;

  // Context window (shouldn't retry, but sometimes transient)
  if (message.includes('context length') || message.includes('too long')) return false;

  return false;
}

function getRetryDelay(error: Error, baseDelay: number, attempt: number): number {
  const message = error.message;

  // Check for Retry-After header in error message
  const retryAfter = message.match(/retry.after[:\s]*(\d+)/i);
  if (retryAfter) {
    return parseInt(retryAfter[1]) * 1000;
  }

  // Check for specific rate limit delays
  const rateLimitDelay = message.match(/(\d+)\s*seconds?/i);
  if (rateLimitDelay) {
    return parseInt(rateLimitDelay[1]) * 1000;
  }

  // Exponential backoff with jitter
  const exponential = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelay * 0.5;
  return Math.min(exponential + jitter, 60000); // Max 60s
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
