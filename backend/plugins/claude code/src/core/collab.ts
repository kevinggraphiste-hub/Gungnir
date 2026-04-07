import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Message } from '../types/index.js';

export interface CollabSession {
  id: string;
  hostId: string;
  participants: Map<string, CollabParticipant>;
  messages: CollabMessage[];
  createdAt: number;
}

export interface CollabParticipant {
  id: string;
  name: string;
  ws: WebSocket;
  color: string;
  cursor?: { file: string; line: number };
}

export interface CollabMessage {
  id: string;
  from: string;
  type: 'chat' | 'tool_call' | 'tool_result' | 'cursor' | 'selection' | 'join' | 'leave';
  content: string;
  timestamp: number;
}

const COLORS = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'white'];

export class CollaborationServer extends EventEmitter {
  private httpServer: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private sessions: Map<string, CollabSession> = new Map();
  private port: number;

  constructor(port = 9876) {
    super();
    this.port = port;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = createServer();
      this.wsServer = new WebSocketServer({ server: this.httpServer });

      this.wsServer.on('connection', (ws, req) => {
        const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);
        const sessionId = url.searchParams.get('session');
        const userName = url.searchParams.get('name') ?? 'Anonymous';

        if (!sessionId) {
          ws.close(4000, 'Session ID required');
          return;
        }

        this.joinSession(sessionId, userName, ws);
      });

      this.httpServer.listen(this.port, () => {
        this.emit('listening', this.port);
        resolve();
      });
    });
  }

  stop(): void {
    this.wsServer?.close();
    this.httpServer?.close();
  }

  createSession(hostId: string, hostName: string): CollabSession {
    const sessionId = randomUUID().slice(0, 8);
    const session: CollabSession = {
      id: sessionId,
      hostId,
      participants: new Map(),
      messages: [],
      createdAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    this.emit('session_created', { sessionId, hostId });
    return session;
  }

  getSession(sessionId: string): CollabSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): CollabSession[] {
    return Array.from(this.sessions.values());
  }

  private joinSession(sessionId: string, name: string, ws: WebSocket): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      // Auto-create session
      session = this.createSession(name, name);
      // Use the requested ID
      this.sessions.delete(session.id);
      session.id = sessionId;
      this.sessions.set(sessionId, session);
    }

    const participant: CollabParticipant = {
      id: randomUUID().slice(0, 8),
      name,
      ws,
      color: COLORS[session.participants.size % COLORS.length],
    };

    session.participants.set(participant.id, participant);

    // Notify others
    this.broadcast(sessionId, {
      id: randomUUID(),
      from: participant.id,
      type: 'join',
      content: `${name} joined`,
      timestamp: Date.now(),
    }, participant.id);

    // Send welcome
    ws.send(JSON.stringify({
      type: 'welcome',
      sessionId,
      participantId: participant.id,
      participants: Array.from(session.participants.values()).map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
      })),
      messages: session.messages.slice(-50),
    }));

    // Handle messages
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { type: string; content: string };
        const collabMsg: CollabMessage = {
          id: randomUUID(),
          from: participant.id,
          type: msg.type as CollabMessage['type'],
          content: msg.content,
          timestamp: Date.now(),
        };

        session!.messages.push(collabMsg);
        this.broadcast(sessionId, collabMsg, participant.id);
        this.emit('message', { sessionId, message: collabMsg });
      } catch {}
    });

    // Handle disconnect
    ws.on('close', () => {
      session!.participants.delete(participant.id);
      this.broadcast(sessionId, {
        id: randomUUID(),
        from: participant.id,
        type: 'leave',
        content: `${name} left`,
        timestamp: Date.now(),
      }, participant.id);
    });
  }

  private broadcast(sessionId: string, message: CollabMessage, excludeId?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const data = JSON.stringify({ kind: 'message', ...message });
    for (const [id, participant] of session.participants) {
      if (id !== excludeId && participant.ws.readyState === 1) {
        participant.ws.send(data);
      }
    }
  }

  getWsUrl(sessionId: string): string {
    return `ws://localhost:${this.port}?session=${sessionId}`;
  }
}

// Client-side collaboration
export class CollaborationClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private participantId: string | null = null;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  async connect(url: string, name: string): Promise<void> {
    const wsUrl = `${url}?session=${this.sessionId}&name=${encodeURIComponent(name)}`;

    return new Promise((resolve, reject) => {
      // Dynamic import for ws in case it's not available
      const wsModule = require('ws');
      this.ws = new wsModule.WebSocket(wsUrl);

      this.ws!.on('open', () => resolve());
      this.ws!.on('error', (err: Error) => reject(err));

      this.ws!.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'welcome') {
            this.participantId = msg.participantId;
          }
          this.emit(msg.type, msg);
        } catch {}
      });
    });
  }

  send(type: string, content: string): void {
    if (!this.ws) throw new Error('Not connected');
    this.ws.send(JSON.stringify({ type, content }));
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}
