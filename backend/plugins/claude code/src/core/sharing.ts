import { randomUUID } from 'node:crypto';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session, Message } from '../types/index.js';
import { SessionManager } from './session.js';

export interface SharedSession {
  shareId: string;
  sessionId: string;
  title: string;
  createdAt: number;
  expiresAt?: number;
  messages: Array<{
    role: string;
    content: string;
    timestamp: number;
  }>;
  metadata: {
    provider: string;
    model: string;
    messageCount: number;
    tokenEstimate: number;
  };
}

const SHARED_DIR = 'shared';

export class SessionSharing {
  constructor(
    private sessionManager: SessionManager,
    private dataDir: string
  ) {}

  async share(sessionId: string, expiresInHours?: number): Promise<SharedSession> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const messages = this.sessionManager.getMessages(sessionId);
    const shareId = randomUUID().slice(0, 12);

    const shared: SharedSession = {
      shareId,
      sessionId,
      title: session.title,
      createdAt: Date.now(),
      expiresAt: expiresInHours ? Date.now() + expiresInHours * 3600000 : undefined,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
      metadata: {
        provider: session.provider,
        model: session.model,
        messageCount: messages.length,
        tokenEstimate: Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4),
      },
    };

    // Save to disk
    const dir = join(this.dataDir, SHARED_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${shareId}.json`), JSON.stringify(shared, null, 2));

    return shared;
  }

  async load(shareId: string): Promise<SharedSession | null> {
    const file = join(this.dataDir, SHARED_DIR, `${shareId}.json`);

    try {
      const content = await readFile(file, 'utf-8');
      const shared: SharedSession = JSON.parse(content);

      // Check expiration
      if (shared.expiresAt && Date.now() > shared.expiresAt) {
        return null;
      }

      return shared;
    } catch {
      return null;
    }
  }

  async import(shareId: string): Promise<Session> {
    const shared = await this.load(shareId);
    if (!shared) throw new Error(`Shared session not found or expired: ${shareId}`);

    // Create new session
    const session = this.sessionManager.createSession(
      shared.metadata.provider,
      shared.metadata.model,
      process.cwd()
    );

    this.sessionManager.updateSessionTitle(session.id, `[Imported] ${shared.title}`);

    // Import messages
    for (const msg of shared.messages) {
      this.sessionManager.addMessage(
        session.id,
        msg.role as Message['role'],
        msg.content
      );
    }

    return session;
  }

  async listShared(): Promise<SharedSession[]> {
    const dir = join(this.dataDir, SHARED_DIR);

    try {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(dir);
      const sessions: SharedSession[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await readFile(join(dir, file), 'utf-8');
          const shared: SharedSession = JSON.parse(content);
          if (!shared.expiresAt || Date.now() <= shared.expiresAt) {
            sessions.push(shared);
          }
        } catch {}
      }

      return sessions.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  generateShareUrl(shareId: string, baseUrl?: string): string {
    const base = baseUrl || 'https://spearcode.dev/share';
    return `${base}/${shareId}`;
  }

  exportAsMarkdown(shareId: string): Promise<string> {
    return this.load(shareId).then((shared) => {
      if (!shared) throw new Error('Session not found');

      const lines: string[] = [];
      lines.push(`# ${shared.title}`);
      lines.push('');
      lines.push(`Shared session from SpearCode`);
      lines.push(`Model: ${shared.metadata.provider}/${shared.metadata.model}`);
      lines.push(`Messages: ${shared.metadata.messageCount}`);
      lines.push(`Created: ${new Date(shared.createdAt).toISOString()}`);
      lines.push('');
      lines.push('---');
      lines.push('');

      for (const msg of shared.messages) {
        const icon = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '🔧';
        lines.push(`## ${icon} ${msg.role}`);
        lines.push('');
        lines.push(msg.content);
        lines.push('');
        lines.push('---');
        lines.push('');
      }

      return lines.join('\n');
    });
  }
}
