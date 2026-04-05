/**
 * OpenAIRuntime — AgentRuntime implementation using OpenAI chat completions.
 *
 * The agent loop runs on the HOST (not inside a container).
 * All tool calls go through ToolExecutor, which routes container-mandatory
 * tools (bash, write, edit) to ContainerManager → tool-runner container.
 *
 * A tool-runner container is acquired at the start of each session and
 * kept alive for the duration. The container provides the sandboxed
 * execution environment for risky operations.
 */
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

import { GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

import type {
  AgentEvent,
  AgentRuntime,
  AgentRuntimeConfig,
  ContainerManager,
  RuntimeId,
  ToolDefinition,
  ToolExecutor,
} from './types.js';

const DEFAULT_MODEL = 'gpt-4.1';
const MAX_TURNS = 50; // safety limit on tool-call loops

export class OpenAIRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'openai';

  private containerManager: ContainerManager | null = null;
  private groupFolder: string | null = null;
  private shouldStop = false;

  async *run(
    prompt: string,
    config: AgentRuntimeConfig,
  ): AsyncGenerator<AgentEvent> {
    this.containerManager = config.containerManager;
    this.groupFolder = config.group.folder;
    this.shouldStop = false;

    const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

    const envSecrets = readEnvFile([
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
    ]);
    const client = new OpenAI({
      apiKey: envSecrets.OPENAI_API_KEY || undefined,
      baseURL: envSecrets.OPENAI_BASE_URL || undefined,
    });

    // Get tools from ToolExecutor and convert to OpenAI format
    const toolDefs = config.toolExecutor.getTools({
      runtime: this.id,
      isMain: config.isMain,
    });
    const openaiTools = toolDefs.map(toOpenAITool);

    // Build system prompt
    const systemPrompt = buildSystemPrompt(config);

    // Acquire a tool-runner container for sandboxed operations
    let containerId: string | undefined;
    try {
      const session = await config.containerManager.acquire({
        group: config.group,
        runtime: this.id,
      });
      containerId = session.containerId;
      logger.info(
        { group: config.group.name, containerId },
        'Tool-runner container acquired for OpenAI runtime',
      );
    } catch (err) {
      logger.warn(
        { group: config.group.name, err },
        'Failed to acquire tool-runner container — container tools will be unavailable',
      );
    }

    // Message history for this session
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ];

    let turns = 0;
    const allToolCalls: AgentEvent['toolCalls'] = [];

    try {
      while (turns < MAX_TURNS && !this.shouldStop) {
        turns++;

        const response = await client.chat.completions.create({
          model,
          messages,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
        });

        const choice = response.choices[0];
        if (!choice) {
          yield {
            type: 'error',
            runtime: this.id,
            error: 'No response from OpenAI',
          };
          return;
        }

        const message = choice.message;
        messages.push(message);

        // If the model wants to call tools
        if (choice.finish_reason === 'tool_calls' && message.tool_calls) {
          for (const toolCall of message.tool_calls) {
            // Only handle function tool calls (skip custom tool calls)
            if (!('function' in toolCall)) continue;
            const toolName = toolCall.function.name;
            let toolArgs: Record<string, unknown>;
            try {
              toolArgs = JSON.parse(toolCall.function.arguments);
            } catch {
              toolArgs = {};
            }

            logger.debug(
              { tool: toolName, group: config.group.name },
              'OpenAI tool call',
            );

            const startTime = Date.now();
            let result;
            try {
              result = await config.toolExecutor.execute({
                name: toolName,
                arguments: toolArgs,
                context: {
                  groupFolder: config.group.folder,
                  chatJid: config.chatJid,
                  isMain: config.isMain,
                  containerId,
                },
              });
            } catch (err) {
              result = {
                content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
                isError: true,
              };
            }

            const durationMs = Date.now() - startTime;
            allToolCalls?.push({
              name: toolName,
              durationMs,
              isError: result.isError || false,
            });

            logger.debug(
              {
                tool: toolName,
                durationMs,
                isError: result.isError,
                group: config.group.name,
              },
              'OpenAI tool result',
            );

            // Feed result back to the model
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result.content,
            });
          }
          // Loop back to get the model's next response
          continue;
        }

        // Model produced a text response — we're done
        const textResult = message.content || null;

        yield {
          type: 'result',
          runtime: this.id,
          result: textResult,
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        };
        return;
      }

      // Hit max turns
      if (turns >= MAX_TURNS) {
        yield {
          type: 'error',
          runtime: this.id,
          error: `Agent loop exceeded ${MAX_TURNS} turns`,
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(
        { group: config.group.name, error, runtime: this.id },
        'OpenAI runtime error',
      );
      yield {
        type: 'error',
        runtime: this.id,
        error,
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      };
    }
  }

  sendFollowUp(_text: string): boolean {
    // TODO: Implement mid-run message injection for OpenAI runtime.
    // The current run() loop is synchronous (request → response → tools → repeat).
    // Follow-up messages would need an async queue that the loop checks between turns.
    return false;
  }

  close(): void {
    this.shouldStop = true;
    if (this.containerManager && this.groupFolder) {
      this.containerManager.closeSession(this.groupFolder);
    }
  }

  shouldClearSession(_error: string): boolean {
    // OpenAI sessions are ephemeral (no persistent session files).
    // No stale session detection needed.
    return false;
  }
}

// --- Helpers ---

function toOpenAITool(
  def: ToolDefinition,
): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters as OpenAI.FunctionParameters,
    },
  };
}

function buildSystemPrompt(config: AgentRuntimeConfig): string {
  const parts: string[] = [];

  parts.push(
    `You are ${config.assistantName}, a helpful AI assistant.`,
  );
  parts.push('You have access to tools for file operations, shell commands, web search, and messaging.');
  parts.push('Use tools when needed to help the user. Be concise and helpful.');

  if (config.isMain) {
    parts.push(
      'You are the main agent with elevated privileges. You can register groups and manage tasks for other groups.',
    );
  }

  if (config.isScheduledTask) {
    parts.push(
      'This is an automated scheduled task, not a live conversation.',
    );
  }

  // Load group instructions if they exist
  try {
    const groupDir = path.join(GROUPS_DIR, config.group.folder);
    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      const instructions = fs.readFileSync(claudeMdPath, 'utf-8');
      parts.push('\n--- Group Instructions ---\n');
      parts.push(instructions);
    }
  } catch {
    // ignore missing instructions
  }

  return parts.join('\n');
}
