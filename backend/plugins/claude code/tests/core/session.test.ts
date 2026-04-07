import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../../src/core/session.js';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DIR = join(tmpdir(), 'spearcode-test-' + Date.now());

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    manager = new SessionManager(TEST_DIR);
  });

  afterEach(() => {
    manager.close();
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('should create a session', () => {
    const session = manager.createSession('openrouter', 'anthropic/claude-sonnet-4', '/test');
    assert.ok(session.id);
    assert.equal(session.provider, 'openrouter');
    assert.equal(session.model, 'anthropic/claude-sonnet-4');
    assert.equal(session.title, 'New Session');
  });

  it('should get a session', () => {
    const created = manager.createSession('openrouter', 'gpt-4o', '/test');
    const got = manager.getSession(created.id);
    assert.ok(got);
    assert.equal(got!.id, created.id);
  });

  it('should list sessions', () => {
    manager.createSession('openrouter', 'gpt-4o', '/test');
    manager.createSession('anthropic', 'claude-3', '/test');
    const sessions = manager.listSessions();
    assert.equal(sessions.length, 2);
  });

  it('should add and get messages', () => {
    const session = manager.createSession('openrouter', 'gpt-4o', '/test');

    manager.addMessage(session.id, 'user', 'Hello');
    manager.addMessage(session.id, 'assistant', 'Hi there!');

    const messages = manager.getMessages(session.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'Hello');
    assert.equal(messages[1].role, 'assistant');
  });

  it('should add message with tool calls', () => {
    const session = manager.createSession('openrouter', 'gpt-4o', '/test');

    manager.addMessage(session.id, 'assistant', 'Let me check', [
      { id: 'tc1', name: 'read_file', arguments: { path: 'test.ts' } },
    ]);

    const messages = manager.getMessages(session.id);
    assert.ok(messages[0].toolCalls);
    assert.equal(messages[0].toolCalls![0].name, 'read_file');
  });

  it('should clear messages', () => {
    const session = manager.createSession('openrouter', 'gpt-4o', '/test');
    manager.addMessage(session.id, 'user', 'test');
    manager.clearMessages(session.id);

    const messages = manager.getMessages(session.id);
    assert.equal(messages.length, 0);
  });

  it('should update session title', () => {
    const session = manager.createSession('openrouter', 'gpt-4o', '/test');
    manager.updateSessionTitle(session.id, 'My Project');

    const got = manager.getSession(session.id);
    assert.equal(got!.title, 'My Project');
  });

  it('should delete a session', () => {
    const session = manager.createSession('openrouter', 'gpt-4o', '/test');
    manager.deleteSession(session.id);

    const got = manager.getSession(session.id);
    assert.equal(got, undefined);
  });
});
