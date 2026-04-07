import { randomUUID } from 'node:crypto';
import type { Session, Message } from '../types/index.js';
import { SessionManager } from './session.js';

export interface Fork {
  id: string;
  originalSessionId: string;
  forkedSessionId: string;
  forkPointMessageId: string;
  createdAt: number;
  label?: string;
}

export class SessionForker {
  private forks: Map<string, Fork> = new Map();

  constructor(private sessionManager: SessionManager) {}

  fork(originalSessionId: string, label?: string): Fork {
    const original = this.sessionManager.getSession(originalSessionId);
    if (!original) throw new Error(`Session not found: ${originalSessionId}`);

    // Create new session with same config
    const forked = this.sessionManager.createSession(
      original.provider,
      original.model,
      original.workingDirectory
    );

    // Copy messages up to now
    const messages = this.sessionManager.getMessages(originalSessionId);
    for (const msg of messages) {
      this.sessionManager.addMessage(
        forked.id,
        msg.role,
        msg.content,
        msg.toolCalls,
        msg.toolCallId
      );
    }

    // Set title
    const title = label ? `${original.title} [${label}]` : `${original.title} (fork)`;
    this.sessionManager.updateSessionTitle(forked.id, title);

    const fork: Fork = {
      id: randomUUID(),
      originalSessionId,
      forkedSessionId: forked.id,
      forkPointMessageId: messages[messages.length - 1]?.id ?? '',
      createdAt: Date.now(),
      label,
    };

    this.forks.set(fork.id, fork);
    return fork;
  }

  getForks(sessionId: string): Fork[] {
    return Array.from(this.forks.values()).filter(
      (f) => f.originalSessionId === sessionId || f.forkedSessionId === sessionId
    );
  }

  mergeBack(forkId: string, targetSessionId: string): number {
    const fork = this.forks.get(forkId);
    if (!fork) throw new Error(`Fork not found: ${forkId}`);

    // Get messages from forked session after the fork point
    const forkMessages = this.sessionManager.getMessages(fork.forkedSessionId);
    const forkPointIndex = forkMessages.findIndex((m) => m.id === fork.forkPointMessageId);
    const newMessages = forkPointIndex === -1 ? forkMessages : forkMessages.slice(forkPointIndex + 1);

    // Append to target
    let merged = 0;
    for (const msg of newMessages) {
      this.sessionManager.addMessage(
        targetSessionId,
        msg.role,
        msg.content,
        msg.toolCalls,
        msg.toolCallId
      );
      merged++;
    }

    return merged;
  }

  listAllForks(): Fork[] {
    return Array.from(this.forks.values());
  }
}
