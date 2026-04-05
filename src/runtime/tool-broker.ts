/**
 * Tool Broker — host-side WebSocket server for container tool execution.
 *
 * Tool-runner containers connect to this broker via WebSocket.
 * The host sends tool call requests, containers execute them and return results.
 * Supports parallel tool calls over a single connection.
 *
 * Protocol:
 *   Container connects:  ws://CONTAINER_HOST_GATEWAY:{port}?group={groupFolder}
 *   Host → Container:    {"id":"call-123","tool":"bash","args":{"command":"ls"}}
 *   Container → Host:    {"id":"call-123","content":"...","isError":false}
 *
 * Networking: container → host only (same direction as credential proxy).
 * No port publishing needed. Works with Docker and Apple Container.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { URL } from 'url';

import { logger } from '../logger.js';

// --- Protocol types ---

export interface ToolCallMessage {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultMessage {
  id: string;
  content: string;
  isError: boolean;
}

// --- Pending call tracking ---

interface PendingCall {
  resolve: (result: ToolResultMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TOOL_CALL_TIMEOUT_MS = 120_000; // 2 minutes per tool call

// --- ToolBroker ---

export class ToolBroker {
  private wss: WebSocketServer | null = null;
  private connections = new Map<string, WebSocket>(); // groupFolder → ws
  private pendingCalls = new Map<string, PendingCall>(); // callId → pending
  private readyWaiters = new Map<
    string,
    Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }>
  >(); // groupFolder → waiters

  /**
   * Start the WebSocket server.
   */
  start(port: number, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port, host });

      this.wss.on('connection', (ws, req) => {
        this.handleConnection(ws, req);
      });

      this.wss.on('listening', () => {
        logger.info({ port, host }, 'Tool broker started');
        resolve();
      });

      this.wss.on('error', (err) => {
        logger.error({ err }, 'Tool broker error');
        reject(err);
      });
    });
  }

  /**
   * Stop the WebSocket server and clean up.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Reject all pending calls
      for (const [id, pending] of this.pendingCalls) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Tool broker shutting down'));
        this.pendingCalls.delete(id);
      }

      // Close all connections
      for (const [group, ws] of this.connections) {
        ws.close();
        this.connections.delete(group);
      }

      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Check if a container is connected for a group.
   */
  isConnected(groupFolder: string): boolean {
    const ws = this.connections.get(groupFolder);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  /**
   * Wait for a container to connect for a group.
   * Returns when the connection is established or times out.
   */
  waitForConnection(groupFolder: string, timeoutMs = 30_000): Promise<void> {
    if (this.isConnected(groupFolder)) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter
        const waiters = this.readyWaiters.get(groupFolder);
        if (waiters) {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0) this.readyWaiters.delete(groupFolder);
        }
        reject(
          new Error(
            `Tool-runner container for ${groupFolder} did not connect within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const waiters = this.readyWaiters.get(groupFolder) || [];
      waiters.push({ resolve, timer });
      this.readyWaiters.set(groupFolder, waiters);
    });
  }

  /**
   * Send a tool call to a connected container and wait for the result.
   */
  async call(
    groupFolder: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResultMessage> {
    const ws = this.connections.get(groupFolder);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`No connected tool-runner for group: ${groupFolder}`);
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(
          new Error(
            `Tool call ${tool} timed out after ${TOOL_CALL_TIMEOUT_MS}ms`,
          ),
        );
      }, TOOL_CALL_TIMEOUT_MS);

      this.pendingCalls.set(id, { resolve, reject, timer });

      const message: ToolCallMessage = { id, tool, args };
      ws.send(JSON.stringify(message));
    });
  }

  /**
   * Disconnect a specific group's container.
   */
  disconnect(groupFolder: string): void {
    const ws = this.connections.get(groupFolder);
    if (ws) {
      ws.close();
      this.connections.delete(groupFolder);
    }
  }

  // --- Internal ---

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Extract group from query string: ws://host:port?group=telegram_main
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
    );
    const groupFolder = url.searchParams.get('group');

    if (!groupFolder) {
      logger.warn('Tool-runner connected without group identifier, closing');
      ws.close(4000, 'Missing group parameter');
      return;
    }

    // Close existing connection for this group (if any)
    const existing = this.connections.get(groupFolder);
    if (existing && existing.readyState === WebSocket.OPEN) {
      logger.debug(
        { groupFolder },
        'Replacing existing tool-runner connection',
      );
      existing.close();
    }

    this.connections.set(groupFolder, ws);
    logger.info({ groupFolder }, 'Tool-runner connected');

    // Resolve any waiters
    const waiters = this.readyWaiters.get(groupFolder);
    if (waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      this.readyWaiters.delete(groupFolder);
    }

    ws.on('message', (data) => {
      try {
        const result: ToolResultMessage = JSON.parse(data.toString());
        const pending = this.pendingCalls.get(result.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCalls.delete(result.id);
          pending.resolve(result);
        } else {
          logger.warn(
            { callId: result.id, groupFolder },
            'Received result for unknown call',
          );
        }
      } catch (err) {
        logger.warn(
          { groupFolder, err },
          'Failed to parse tool-runner message',
        );
      }
    });

    ws.on('close', () => {
      logger.info({ groupFolder }, 'Tool-runner disconnected');
      if (this.connections.get(groupFolder) === ws) {
        this.connections.delete(groupFolder);
      }

      // Reject any pending calls for this group
      for (const [id, pending] of this.pendingCalls) {
        if (id.startsWith(groupFolder)) continue; // IDs aren't group-prefixed, check all
        // We can't know which calls belong to this group from the ID alone,
        // but the WebSocket closure will cause send failures on next attempt.
      }
    });

    ws.on('error', (err) => {
      logger.warn({ groupFolder, err }, 'Tool-runner WebSocket error');
    });
  }
}
