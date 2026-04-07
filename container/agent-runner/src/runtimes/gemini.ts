/**
 * Google Gemini CLI runtime for the container agent-runner.
 * Self-registers with the container runtime registry.
 *
 * Uses Gemini CLI with --output-format stream-json for structured
 * streaming events. Captures tool calls, file changes, and reasoning
 * for logging and archiving.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

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

  // Write MCP server config for Gemini CLI
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

  // Discover additional directories
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) extraDirs.push(fullPath);
    }
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
    const { resultText, toolCalls } = await runGeminiStreaming(prompt, model);

    // Rich conversation archive with tool activity
    const archiveMessages: ParsedMessage[] = [
      { role: 'user', content: prompt },
    ];
    if (toolCalls.length > 0) {
      archiveMessages.push({
        role: 'assistant',
        content: `[Tool calls]\n${toolCalls.join('\n')}`,
      });
    }
    if (resultText) {
      archiveMessages.push({ role: 'assistant', content: resultText });
    }

    if (archiveMessages.length > 1) {
      try {
        const conversationsDir = '/workspace/group/conversations';
        fs.mkdirSync(conversationsDir, { recursive: true });
        const date = new Date().toISOString().split('T')[0];
        const name = sanitizeFilename(prompt.slice(0, 50).replace(/\n/g, ' '));
        const filePath = path.join(conversationsDir, `${date}-${name || 'conversation'}.md`);
        fs.writeFileSync(
          filePath,
          formatTranscriptMarkdown(archiveMessages, prompt.slice(0, 50), containerInput.assistantName),
        );
        log(`Archived Gemini conversation to ${filePath}`);
      } catch (err) {
        log(`Failed to archive: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    writeOutput({ status: 'success', result: resultText, newSessionId: undefined });

    // Post-turn follow-ups
    ipcPolling = false;
    const pendingMessages = drainIpcInput();
    if (pendingMessages.length > 0 && !closedDuringQuery) {
      log(`Processing ${pendingMessages.length} IPC message(s) that arrived during turn`);
      const followUp = pendingMessages.join('\n');
      try {
        const followUpResult = await runGeminiStreaming(followUp, model);
        if (followUpResult.resultText) {
          writeOutput({ status: 'success', result: followUpResult.resultText, newSessionId: undefined });
        }
      } catch (err) {
        log(`Follow-up error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`Gemini error: ${error}`);
    writeOutput({ status: 'error', result: null, error });
  }

  ipcPolling = false;
  return { newSessionId: undefined, closedDuringQuery };
}

// --- Streaming CLI execution with JSON event parsing ---

function runGeminiStreaming(
  prompt: string,
  model: string,
): Promise<{ resultText: string | null; toolCalls: string[] }> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--yolo',
      '--model', model,
      '--output-format', 'stream-json',
    ];

    log(`Running: gemini --model ${model} --output-format stream-json`);

    const proc = spawn('gemini', args, {
      cwd: '/workspace/group',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resultText: string | null = null;
    const toolCalls: string[] = [];
    let stderr = '';
    let jsonBuffer = '';

    // Parse streaming JSON events from stdout
    proc.stdout.on('data', (chunk: Buffer) => {
      jsonBuffer += chunk.toString();

      // Split by newlines — each line is a JSON event
      const lines = jsonBuffer.split('\n');
      jsonBuffer = lines.pop() || ''; // keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          processEvent(event, toolCalls);

          // Capture final text content
          if (event.type === 'content' && event.value) {
            resultText = (resultText || '') + event.value;
          }
          // Also check for message/text patterns
          if (event.text) {
            resultText = event.text;
          }
          if (event.type === 'result' && event.content) {
            resultText = event.content;
          }
        } catch {
          // Not JSON — might be raw text output
          if (line.trim() && !line.startsWith('{')) {
            resultText = (resultText || '') + line;
          }
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // Parse stderr for tool activity (fallback if JSON doesn't capture it)
      for (const stderrLine of text.trim().split('\n')) {
        if (!stderrLine) continue;
        if (stderrLine.includes('Running:') || stderrLine.includes('Executing:')) {
          const toolInfo = stderrLine.trim();
          log(`[tool] ${toolInfo}`);
          toolCalls.push(toolInfo);
        } else if (stderrLine.includes('Reading') || stderrLine.includes('Writing') || stderrLine.includes('Searching')) {
          log(`[tool] ${stderrLine.trim()}`);
          toolCalls.push(stderrLine.trim());
        } else {
          log(`[gemini] ${stderrLine}`);
        }
      }
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Gemini CLI timed out after 120s'));
    }, 120_000);

    proc.on('close', (code) => {
      clearTimeout(timeout);

      // Process any remaining buffer
      if (jsonBuffer.trim()) {
        try {
          const event = JSON.parse(jsonBuffer);
          processEvent(event, toolCalls);
          if (event.type === 'content' && event.value) {
            resultText = (resultText || '') + event.value;
          }
          if (event.text) resultText = event.text;
        } catch {
          if (jsonBuffer.trim() && !resultText) {
            resultText = jsonBuffer.trim();
          }
        }
      }

      if (code !== 0 && !resultText) {
        reject(new Error(`Gemini CLI exited with code ${code}: ${stderr.slice(-200)}`));
        return;
      }

      resolve({ resultText, toolCalls });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// --- Event processing ---

function processEvent(event: Record<string, unknown>, toolCalls: string[]): void {
  const type = event.type as string;

  if (type === 'tool_call_request' || type === 'toolCallRequest') {
    const value = event.value as Record<string, unknown> | undefined;
    const name = value?.name || value?.tool || 'unknown';
    log(`[tool] Call: ${name}`);
    toolCalls.push(`Tool: ${name}`);
  }

  if (type === 'tool_call_response' || type === 'toolCallResponse') {
    const value = event.value as Record<string, unknown> | undefined;
    const name = value?.name || 'unknown';
    const output = value?.output || value?.result;
    const outputStr = typeof output === 'string' ? output.slice(0, 200) : JSON.stringify(output)?.slice(0, 200);
    log(`[tool] Result: ${name} → ${outputStr}`);
    if (outputStr) toolCalls.push(`${name}: ${outputStr}`);
  }

  if (type === 'thought') {
    const value = event.value as Record<string, unknown> | undefined;
    const text = value?.text || value?.summary || '';
    if (text) log(`[thought] ${String(text).slice(0, 100)}`);
  }

  if (type === 'finished') {
    const value = event.value as Record<string, unknown> | undefined;
    const usage = value?.usageMetadata as Record<string, number> | undefined;
    if (usage) {
      log(`Gemini usage: ${usage.promptTokenCount || 0} in, ${usage.candidatesTokenCount || 0} out`);
    }
  }

  if (type === 'error') {
    const value = event.value as Record<string, unknown> | undefined;
    const error = value?.error || value?.message || 'unknown error';
    log(`[error] ${String(error).slice(0, 200)}`);
  }
}

// --- Self-register ---

registerContainerRuntime('gemini', runGeminiQuery);
