import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Message, Session, ToolCall } from '../types/index.js';

export class SessionManager {
  private db: Database.Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'spearcode.db'));
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New Session',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        working_directory TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    `);
  }

  createSession(provider: string, model: string, workingDirectory: string): Session {
    const id = randomUUID();
    const now = Date.now();

    this.db.prepare(
      'INSERT INTO sessions (id, title, provider, model, created_at, updated_at, working_directory) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'New Session', provider, model, now, now, workingDirectory);

    return { id, title: 'New Session', provider, model, createdAt: now, updatedAt: now, workingDirectory };
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      title: row.title as string,
      provider: row.provider as string,
      model: row.model as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      workingDirectory: row.working_directory as string,
    };
  }

  listSessions(limit = 50): Session[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      provider: row.provider as string,
      model: row.model as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      workingDirectory: row.working_directory as string,
    }));
  }

  updateSessionTitle(id: string, title: string) {
    this.db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id);
  }

  deleteSession(id: string) {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  addMessage(sessionId: string, role: Message['role'], content: string, toolCalls?: ToolCall[], toolCallId?: string): Message {
    const id = randomUUID();
    const timestamp = Date.now();

    this.db.prepare(
      'INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, sessionId, role, content, toolCalls ? JSON.stringify(toolCalls) : null, toolCallId ?? null, timestamp);

    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(timestamp, sessionId);

    return { id, sessionId, role, content, toolCalls, toolCallId, timestamp };
  }

  getMessages(sessionId: string): Message[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC'
    ).all(sessionId) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      role: row.role as Message['role'],
      content: row.content as string,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls as string) : undefined,
      toolCallId: row.tool_call_id as string | undefined,
      timestamp: row.timestamp as number,
    }));
  }

  clearMessages(sessionId: string) {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  }

  close() {
    this.db.close();
  }
}
