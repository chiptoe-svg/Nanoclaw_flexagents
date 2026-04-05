/**
 * ContainerManager — manages container lifecycle for all runtimes.
 *
 * Two container modes:
 *   Agent session: Claude SDK runs its own agent loop inside the container.
 *     Delegates to runContainerAgent() in container-runner.ts.
 *   Tool execution: Tool-runner container connects via WebSocket broker.
 *     Host sends individual tool calls, container executes and returns results.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getContainerImage, DATA_DIR, TIMEZONE } from '../config.js';
import {
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from '../container-runner.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
} from '../container-runtime.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../group-folder.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';

import type {
  ContainerInput,
  ContainerManager as IContainerManager,
  ContainerOutput,
  ContainerSession,
  RuntimeId,
  ToolCall,
  ToolResult,
} from './types.js';
import { ToolBroker } from './tool-broker.js';

const TOOL_RUNNER_IMAGE =
  process.env.CONTAINER_IMAGE_TOOL_RUNNER || 'nanoclaw-tool-runner:latest';

export class DefaultContainerManager implements IContainerManager {
  private toolBroker: ToolBroker | null = null;
  private toolBrokerPort = 0;
  private activeSessions = new Map<string, ContainerSession>();

  /**
   * Set the tool broker instance. Called by the host during startup.
   */
  setToolBroker(broker: ToolBroker, port: number): void {
    this.toolBroker = broker;
    this.toolBrokerPort = port;
  }

  async acquire(opts: {
    group: RegisteredGroup;
    runtime: RuntimeId;
    forceNew?: boolean;
  }): Promise<ContainerSession> {
    const key = opts.group.folder;

    // Reuse existing session if available
    if (!opts.forceNew) {
      const existing = this.activeSessions.get(key);
      if (existing && this.toolBroker?.isConnected(key)) {
        return existing;
      }
    }

    if (!this.toolBroker || this.toolBrokerPort === 0) {
      throw new Error(
        'Tool broker not initialized — call setToolBroker() first',
      );
    }

    // Spawn a tool-runner container
    const safeName = opts.group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
    const containerName = `nanoclaw-tools-${safeName}-${Date.now()}`;

    const groupDir = resolveGroupFolderPath(opts.group.folder);
    fs.mkdirSync(groupDir, { recursive: true });

    const ipcDir = resolveGroupIpcPath(opts.group.folder);
    fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });

    const args: string[] = [
      'run',
      '--rm',
      '--name',
      containerName,
      '-e',
      `TZ=${TIMEZONE}`,
      '-e',
      `TOOL_BROKER_URL=ws://${CONTAINER_HOST_GATEWAY}:${this.toolBrokerPort}`,
      '-e',
      `GROUP_FOLDER=${opts.group.folder}`,
      ...hostGatewayArgs(),
      // Mount group workspace
      '-v',
      `${groupDir}:/workspace/group`,
      // Mount IPC
      '-v',
      `${ipcDir}:/workspace/ipc`,
    ];

    // Run as host user for bind-mount compatibility
    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
      args.push('--user', `${hostUid}:${hostGid}`);
      args.push('-e', 'HOME=/home/node');
    }

    args.push(TOOL_RUNNER_IMAGE);

    logger.info(
      { group: opts.group.name, containerName, runtime: opts.runtime },
      'Spawning tool-runner container',
    );

    const proc = spawn(CONTAINER_RUNTIME_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Log container output
    proc.stdout?.on('data', (data) => {
      logger.debug({ container: opts.group.folder }, data.toString().trim());
    });
    proc.stderr?.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: opts.group.folder }, line);
      }
    });

    proc.on('close', (code) => {
      logger.info(
        { containerName, code, group: opts.group.folder },
        'Tool-runner container exited',
      );
      this.activeSessions.delete(key);
    });

    const session: ContainerSession = {
      containerId: containerName,
      containerName,
      groupFolder: opts.group.folder,
      process: proc,
      runtime: opts.runtime,
    };

    this.activeSessions.set(key, session);

    // Wait for the container to connect to the broker
    await this.toolBroker.waitForConnection(opts.group.folder, 30_000);
    logger.info({ containerName }, 'Tool-runner connected to broker');

    return session;
  }

  async executeInContainer(call: ToolCall): Promise<ToolResult> {
    if (!this.toolBroker) {
      throw new Error('Tool broker not initialized');
    }

    const groupFolder = call.context.groupFolder;

    // Ensure we have a connected tool-runner for this group
    if (!this.toolBroker.isConnected(groupFolder)) {
      throw new Error(
        `No tool-runner connected for group: ${groupFolder}. Call acquire() first.`,
      );
    }

    const result = await this.toolBroker.call(
      groupFolder,
      call.name,
      call.arguments,
    );

    return {
      content: result.content,
      isError: result.isError,
    };
  }

  async runAgentSession(opts: {
    group: RegisteredGroup;
    input: ContainerInput;
    onProcess: (proc: ChildProcess, containerName: string) => void;
    onOutput?: (output: ContainerOutput) => Promise<void>;
  }): Promise<ContainerOutput> {
    return runContainerAgent(
      opts.group,
      opts.input,
      opts.onProcess,
      opts.onOutput,
    );
  }

  closeSession(groupFolder: string): void {
    // Close agent session via IPC sentinel
    const ipcDir = resolveGroupIpcPath(groupFolder);
    const sentinel = path.join(ipcDir, 'input', '_close');
    try {
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, '');
    } catch (err) {
      logger.warn({ groupFolder, err }, 'Failed to write close sentinel');
    }

    // Disconnect tool-runner if connected
    this.toolBroker?.disconnect(groupFolder);
  }

  sendToContainer(groupFolder: string, text: string): boolean {
    const ipcDir = resolveGroupIpcPath(groupFolder);
    const inputDir = path.join(ipcDir, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      const filepath = path.join(inputDir, filename);
      fs.writeFileSync(filepath, JSON.stringify({ type: 'message', text }));
      return true;
    } catch (err) {
      logger.warn({ groupFolder, err }, 'Failed to send to container');
      return false;
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    // Stop all tool-runner containers
    for (const [key, session] of this.activeSessions) {
      try {
        session.process.kill();
      } catch {
        /* ignore */
      }
      this.activeSessions.delete(key);
    }

    // Stop the broker
    if (this.toolBroker) {
      await this.toolBroker.stop();
    }
  }

  cleanupOrphans(): void {
    // Delegated to container-runtime.ts cleanupOrphans() called from index.ts.
  }
}

// Re-export snapshot helpers
export { writeTasksSnapshot, writeGroupsSnapshot };
