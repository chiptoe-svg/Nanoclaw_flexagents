/**
 * Google Gemini CLI Core runtime for the container agent-runner.
 * Self-registers with the container runtime registry.
 *
 * Uses @google/gemini-cli-core for native agent loop with streaming events.
 * Gemini handles tools, streaming, and context management internally.
 */
import fs from 'fs';
import path from 'path';

import {
  ContainerInput,
  drainIpcInput,
  formatTranscriptMarkdown,
  log,
  ParsedMessage,
  sanitizeFilename,
  shouldClose,
  writeOutput,
} from '../shared.js';
import { registerContainerRuntime, type QueryResult } from '../runtime-registry.js';

// Dynamic import — SDK is optional
async function loadGeminiCore() {
  const core = await import('@google/gemini-cli-core');
  return core;
}

// --- Gemini query ---

async function runGeminiQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
): Promise<QueryResult> {
  // Assemble GEMINI.md from global + group AGENT.md files
  const agentsParts: string[] = [];
  for (const dir of ['/workspace/global', '/workspace/group']) {
    for (const filename of ['AGENT.md', 'GEMINI.md', 'CLAUDE.md']) {
      const filePath = path.join(dir, filename);
      if (fs.existsSync(filePath)) {
        agentsParts.push(fs.readFileSync(filePath, 'utf-8'));
        break;
      }
    }
  }
  if (agentsParts.length > 0) {
    fs.writeFileSync(
      '/workspace/group/GEMINI.md',
      agentsParts.join('\n\n---\n\n'),
    );
    log(`Assembled GEMINI.md from ${agentsParts.length} source(s)`);
  }

  // Write MCP server config for Gemini
  const geminiConfigDir = path.join(process.env.HOME || '/home/node', '.gemini');
  fs.mkdirSync(geminiConfigDir, { recursive: true });
  const settingsPath = path.join(geminiConfigDir, 'settings.json');

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { settings = {}; }
  }
  if (!settings.mcpServers || !(settings.mcpServers as Record<string, unknown>).nanoclaw) {
    settings.mcpServers = {
      ...(settings.mcpServers as Record<string, unknown> || {}),
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    log('Wrote NanoClaw MCP config to Gemini settings.json');
  }

  const model = containerInput.model || 'gemini-2.5-flash';
  let closedDuringQuery = false;

  let ipcPolling = true;
  const pollIpc = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      closedDuringQuery = true;
      ipcPolling = false;
      return;
    }
    setTimeout(pollIpc, 500);
  };
  setTimeout(pollIpc, 500);

  try {
    // Phase 1: Use Gemini CLI subprocess for simplicity.
    // The @google/gemini-cli-core library requires complex initialization
    // (Config, AgentLoopContext, GeminiChat, Turn, Scheduler, ToolRegistry).
    // Phase 2 will use the core library directly for full streaming support.
    const { execFile } = await import('child_process');

    const resultText = await new Promise<string | null>((resolve, reject) => {
      execFile(
        'gemini',
        ['-p', prompt, '--yolo', '--model', model],
        {
          cwd: '/workspace/group',
          timeout: 120_000,
          maxBuffer: 200 * 1024,
          env: process.env,
        },
        (error, stdout, stderr) => {
          if (stderr) {
            for (const line of stderr.trim().split('\n')) {
              if (line) log(`[gemini] ${line}`);
            }
          }
          if (error && !stdout) {
            reject(new Error(error.message));
            return;
          }
          resolve(stdout.trim() || null);
        },
      );
    });

    // Archive
    if (resultText) {
      try {
        const messages: ParsedMessage[] = [
          { role: 'user', content: prompt },
          { role: 'assistant', content: resultText },
        ];
        const conversationsDir = '/workspace/group/conversations';
        fs.mkdirSync(conversationsDir, { recursive: true });
        const date = new Date().toISOString().split('T')[0];
        const name = sanitizeFilename(prompt.slice(0, 50).replace(/\n/g, ' '));
        const filePath = path.join(conversationsDir, `${date}-${name || 'conversation'}.md`);
        fs.writeFileSync(filePath, formatTranscriptMarkdown(messages, prompt.slice(0, 50), containerInput.assistantName));
        log(`Archived Gemini conversation to ${filePath}`);
      } catch (err) {
        log(`Failed to archive: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    writeOutput({ status: 'success', result: resultText, newSessionId: undefined });

    // Check for IPC messages that arrived during turn
    ipcPolling = false;
    const pendingMessages = drainIpcInput();
    if (pendingMessages.length > 0 && !closedDuringQuery) {
      log(`Processing ${pendingMessages.length} IPC message(s) that arrived during turn`);
      // TODO: Phase 2 — run follow-up turn with Gemini core library
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`Gemini error: ${error}`);
    writeOutput({ status: 'error', result: null, error });
  }

  ipcPolling = false;
  return { newSessionId: undefined, closedDuringQuery };
}

// --- Self-register ---

registerContainerRuntime('gemini', runGeminiQuery);
