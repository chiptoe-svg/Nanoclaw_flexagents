/**
 * OpenAI Codex SDK runtime for the container agent-runner.
 * Self-registers with the container runtime registry.
 */
import fs from 'fs';
import path from 'path';
import { Codex } from '@openai/codex-sdk';

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

/** Codex-specific tool guidance — injected into AGENTS.md during assembly */
const CODEX_TOOL_GUIDANCE = `
## File and Shell Best Practices

When reading files, always use \`cat -n\` to show line numbers.
When searching file contents, use \`grep -rn\` to include line numbers and context.
For large files, read specific line ranges: \`sed -n '10,30p' file.txt\`
When listing files, use \`find\` with specific patterns rather than \`ls -R\`.
For file editing, prefer \`apply_patch\` over rewriting entire files.
`;

// --- Codex query ---

async function runCodexQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
): Promise<QueryResult> {
  // Assemble AGENTS.md from global + group AGENT.md files
  const agentsParts: string[] = [];
  for (const dir of ['/workspace/global', '/workspace/group']) {
    for (const filename of ['AGENT.md', 'CLAUDE.md']) {
      const filePath = path.join(dir, filename);
      if (fs.existsSync(filePath)) {
        agentsParts.push(fs.readFileSync(filePath, 'utf-8'));
        break;
      }
    }
  }
  agentsParts.push(CODEX_TOOL_GUIDANCE);

  if (agentsParts.length > 0) {
    fs.writeFileSync(
      '/workspace/group/AGENTS.md',
      agentsParts.join('\n\n---\n\n'),
    );
    log(`Assembled AGENTS.md from ${agentsParts.length} source(s)`);
  }

  // Write MCP server config for Codex
  const codexConfigDir = path.join(
    process.env.HOME || '/home/node',
    '.codex',
  );
  fs.mkdirSync(codexConfigDir, { recursive: true });
  const configTomlPath = path.join(codexConfigDir, 'config.toml');

  let existingConfig = '';
  if (fs.existsSync(configTomlPath)) {
    existingConfig = fs.readFileSync(configTomlPath, 'utf-8');
  }
  if (!existingConfig.includes('[mcp_servers.nanoclaw]')) {
    const mcpConfig = `
[mcp_servers.nanoclaw]
type = "stdio"
command = "node"
args = ["${mcpServerPath}"]

[mcp_servers.nanoclaw.env]
NANOCLAW_CHAT_JID = "${containerInput.chatJid}"
NANOCLAW_GROUP_FOLDER = "${containerInput.groupFolder}"
NANOCLAW_IS_MAIN = "${containerInput.isMain ? '1' : '0'}"
NANOCLAW_RUNTIME = "codex"
NANOCLAW_MODEL = "${containerInput.model || 'gpt-5.4-mini'}"
`;
    fs.writeFileSync(configTomlPath, existingConfig + mcpConfig);
    log('Wrote NanoClaw MCP config to Codex config.toml');
  }

  // Discover additional directories (Fix #3)
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) extraDirs.push(fullPath);
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  const codex = new Codex({
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: containerInput.baseUrl || process.env.OPENAI_BASE_URL,
  });

  const threadOptions = {
    model: containerInput.model || 'gpt-5.4-mini',
    workingDirectory: '/workspace/group',
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'never' as const,
    skipGitRepoCheck: true,
    additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
  };

  // Try resuming a previous thread if we have a session ID.
  // Fall back to a fresh thread if resume fails (e.g. "no rollout found").
  let thread;
  if (sessionId) {
    try {
      thread = codex.resumeThread(sessionId, threadOptions);
      log(`Resuming Codex thread: ${sessionId}`);
    } catch (err) {
      log(`Resume failed (${err instanceof Error ? err.message : String(err)}), starting fresh thread`);
      thread = codex.startThread(threadOptions);
    }
  } else {
    thread = codex.startThread(threadOptions);
  }

  let closedDuringQuery = false;
  let newSessionId: string | undefined;

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
    // Use streaming for progress visibility
    const streamedTurn = await thread.runStreamed(prompt);
    let resultText: string | null = null;
    let usage: { input_tokens: number; output_tokens: number } | null = null;

    // Build rich archive from stream events (Fix #2)
    const archiveMessages: ParsedMessage[] = [
      { role: 'user', content: prompt },
    ];
    const toolCalls: string[] = [];

    for await (const event of streamedTurn.events) {
      if (event.type === 'thread.started') {
        newSessionId = event.thread_id;
        log(`Codex thread: ${newSessionId} (new)`);
      }

      // Log and capture tool activity
      if (event.type === 'item.started') {
        const item = event.item;
        if (item.type === 'command_execution') {
          log(`[tool] Running: ${item.command}`);
          toolCalls.push(`$ ${item.command}`);
        } else if (item.type === 'mcp_tool_call') {
          log(`[tool] MCP: ${item.server}/${item.tool}`);
          toolCalls.push(`MCP: ${item.server}/${item.tool}`);
        } else if (item.type === 'web_search') {
          log(`[tool] Web search: ${item.query}`);
          toolCalls.push(`Search: ${item.query}`);
        } else if (item.type === 'file_change') {
          const paths = item.changes.map((c: { path: string }) => c.path).join(', ');
          log(`[tool] File changes: ${paths}`);
          toolCalls.push(`Files: ${paths}`);
        }
      }

      // Capture command output for archive
      if (event.type === 'item.completed' && event.item.type === 'command_execution') {
        const cmd = event.item;
        if (cmd.aggregated_output) {
          toolCalls.push(cmd.aggregated_output.slice(0, 500));
        }
      }

      if (event.type === 'item.completed' && event.item.type === 'agent_message') {
        resultText = event.item.text;
      }

      if (event.type === 'turn.completed') {
        usage = event.usage;
      }
    }

    if (!newSessionId) {
      newSessionId = thread.id || undefined;
    }

    if (usage) {
      log(`Codex usage: ${usage.input_tokens} in, ${usage.output_tokens} out`);
    }

    // Rich conversation archive (Fix #2)
    if (resultText || toolCalls.length > 0) {
      try {
        if (toolCalls.length > 0) {
          archiveMessages.push({
            role: 'assistant',
            content: `[Tool calls]\n${toolCalls.join('\n')}`,
          });
        }
        if (resultText) {
          archiveMessages.push({ role: 'assistant', content: resultText });
        }

        const conversationsDir = '/workspace/group/conversations';
        fs.mkdirSync(conversationsDir, { recursive: true });
        const date = new Date().toISOString().split('T')[0];
        const name = sanitizeFilename(prompt.slice(0, 50).replace(/\n/g, ' '));
        const filePath = path.join(conversationsDir, `${date}-${name || 'conversation'}.md`);
        fs.writeFileSync(
          filePath,
          formatTranscriptMarkdown(
            archiveMessages,
            prompt.slice(0, 50),
            containerInput.assistantName,
          ),
        );
        log(`Archived Codex conversation to ${filePath}`);
      } catch (err) {
        log(`Failed to archive: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    writeOutput({ status: 'success', result: resultText, newSessionId });

    // Check for IPC messages that arrived during this turn (Fix #1)
    // Feed them as a follow-up turn so the user's mid-turn messages
    // get processed immediately instead of waiting for next container cycle.
    ipcPolling = false;
    const pendingMessages = drainIpcInput();
    if (pendingMessages.length > 0 && !closedDuringQuery) {
      log(`Processing ${pendingMessages.length} IPC message(s) that arrived during turn`);
      const followUp = pendingMessages.join('\n');
      const followUpTurn = await thread.runStreamed(followUp);
      let followUpResult: string | null = null;

      for await (const event of followUpTurn.events) {
        if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          followUpResult = event.item.text;
        }
      }

      if (followUpResult) {
        writeOutput({ status: 'success', result: followUpResult, newSessionId });
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`Codex error: ${error}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: newSessionId || thread.id || undefined,
      error,
    });
  }

  ipcPolling = false;
  return { newSessionId, closedDuringQuery };
}

// --- Self-register ---

registerContainerRuntime('codex', runCodexQuery);
