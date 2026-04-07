import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateContextTokens, isNearContextLimit } from '../../src/core/compact.js';
import type { Message } from '../../src/types/index.js';

function makeMessage(content: string, role: Message['role'] = 'user'): Message {
  return {
    id: 'test',
    sessionId: 'test',
    role,
    content,
    timestamp: Date.now(),
  };
}

describe('Compact', () => {
  it('should estimate tokens', () => {
    const messages = [makeMessage('hello world')];
    const tokens = estimateContextTokens(messages);
    assert.ok(tokens > 0);
  });

  it('should detect near context limit', () => {
    // Create a lot of messages
    const messages = Array.from({ length: 100 }, () =>
      makeMessage('x'.repeat(1000))
    );

    // With a small limit, should be near limit
    assert.ok(isNearContextLimit(messages, 5000));
  });

  it('should not be near limit with few messages', () => {
    const messages = [makeMessage('short')];
    assert.ok(!isNearContextLimit(messages, 100000));
  });
});
