/**
 * Specialist subagent runner.
 *
 * Runs a subtask using a specialist persona via the current container runtime.
 * Called by the run_specialist MCP tool. Works with all runtimes:
 *
 * - Claude: spawns a fresh query() with the specialist persona as system prompt
 * - Codex: creates a new thread with the specialist persona in AGENTS.md
 * - Gemini: runs gemini CLI with the specialist persona prepended to the prompt
 *
 * Specialist personas are defined in AGENT.md (as guidance for the main agent)
 * and optionally as standalone files in /workspace/group/specialists/<name>.md
 * for detailed instructions.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { log } from './shared.js';

const SPECIALISTS_DIR = '/workspace/group/specialists';
const AGENT_MD_PATH = '/workspace/group/AGENT.md';

/**
 * Load specialist persona by name.
 * First checks specialists/<name>.md, then falls back to parsing
 * the ## Specialists section of AGENT.md for an inline definition.
 */
export function loadSpecialistPersona(name: string): string | null {
  // Sanitize name to prevent path traversal
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeName) return null;

  // Check dedicated persona file first
  const personaFile = path.join(SPECIALISTS_DIR, `${safeName}.md`);
  if (fs.existsSync(personaFile)) {
    return fs.readFileSync(personaFile, 'utf-8');
  }

  // Fall back to inline definition in AGENT.md
  if (fs.existsSync(AGENT_MD_PATH)) {
    const agentMd = fs.readFileSync(AGENT_MD_PATH, 'utf-8');
    const persona = extractInlineSpecialist(agentMd, safeName);
    if (persona) return persona;
  }

  return null;
}

/**
 * Extract a specialist definition from AGENT.md.
 * Looks for ### <Name> under ## Specialists and captures until the next heading.
 */
function extractInlineSpecialist(markdown: string, name: string): string | null {
  const pattern = new RegExp(
    `###\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|\\n##\\s|$)`,
    'i',
  );
  const match = markdown.match(pattern);
  return match ? match[1].trim() : null;
}

/**
 * List available specialists (from both files and AGENT.md).
 */
export function listSpecialists(): string[] {
  const names = new Set<string>();

  // From specialist files
  if (fs.existsSync(SPECIALISTS_DIR)) {
    for (const file of fs.readdirSync(SPECIALISTS_DIR)) {
      if (file.endsWith('.md')) {
        names.add(file.replace(/\.md$/, ''));
      }
    }
  }

  // From AGENT.md inline definitions
  if (fs.existsSync(AGENT_MD_PATH)) {
    const content = fs.readFileSync(AGENT_MD_PATH, 'utf-8');
    const specialistsSection = content.match(
      /## Specialists\s*\n([\s\S]*?)(?=\n## |$)/i,
    );
    if (specialistsSection) {
      const headings = specialistsSection[1].matchAll(/###\s+(\w+)/g);
      for (const m of headings) {
        names.add(m[1].toLowerCase());
      }
    }
  }

  return [...names].sort();
}

// --- Runtime-specific subquery implementations ---

/**
 * Run a specialist subtask via the Codex SDK.
 * Creates a fresh thread with the specialist persona.
 */
async function runCodexSpecialist(
  persona: string,
  task: string,
  model: string,
): Promise<string> {
  // Dynamic import to avoid requiring the SDK when using other runtimes
  const { Codex } = await import('@openai/codex-sdk');

  const codex = new Codex({
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
  });

  // Write a temporary AGENTS.md with the specialist persona
  const agentsMdPath = '/workspace/group/AGENTS.md';
  const originalAgentsMd = fs.existsSync(agentsMdPath)
    ? fs.readFileSync(agentsMdPath, 'utf-8')
    : null;

  fs.writeFileSync(agentsMdPath, persona);

  try {
    const thread = codex.startThread({
      model,
      workingDirectory: '/workspace/group',
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
    });

    const turn = await thread.runStreamed(task);
    let result: string | null = null;

    for await (const event of turn.events) {
      if (event.type === 'item.completed' && event.item.type === 'agent_message') {
        result = event.item.text;
      }
    }

    return result || '(no response from specialist)';
  } finally {
    // Restore original AGENTS.md
    if (originalAgentsMd !== null) {
      fs.writeFileSync(agentsMdPath, originalAgentsMd);
    } else {
      try { fs.unlinkSync(agentsMdPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Run a specialist subtask via the Gemini CLI.
 * Prepends the specialist persona to the prompt.
 */
async function runGeminiSpecialist(
  persona: string,
  task: string,
  model: string,
): Promise<string> {
  const fullPrompt = `${persona}\n\n---\n\nTask: ${task}`;

  return new Promise((resolve, reject) => {
    const args = ['-p', fullPrompt, '--yolo', '--model', model];
    const proc = spawn('gemini', args, {
      cwd: '/workspace/group',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Specialist timed out after 90s'));
    }, 90_000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`Gemini specialist exited ${code}: ${stderr.slice(-200)}`));
        return;
      }
      resolve(stdout.trim() || '(no response from specialist)');
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// --- Public API ---

/**
 * Run a specialist subtask using the current container runtime.
 * The runtime is detected from the environment (set by the main agent runner).
 */
export async function runSpecialist(
  specialistName: string,
  task: string,
  runtime: string,
  model: string,
): Promise<string> {
  const persona = loadSpecialistPersona(specialistName);
  if (!persona) {
    const available = listSpecialists();
    return `Unknown specialist "${specialistName}". Available: ${available.join(', ') || 'none defined. Add specialist definitions to AGENT.md or create files in specialists/'}`;
  }

  log(`[specialist] Running ${specialistName} via ${runtime} (model: ${model})`);

  try {
    if (runtime === 'codex') {
      return await runCodexSpecialist(persona, task, model);
    } else if (runtime === 'gemini') {
      return await runGeminiSpecialist(persona, task, model);
    } else {
      // Claude uses native agent teams (TeamCreate/SendMessage).
      // This fallback handles the case where Claude calls the MCP tool
      // instead of using its native orchestration.
      // We run it as a simple Gemini-style prompt prepend via the Claude CLI.
      return await runClaudeSpecialistFallback(persona, task);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[specialist] ${specialistName} failed: ${msg}`);
    return `Specialist "${specialistName}" failed: ${msg}`;
  }
}

/**
 * Claude fallback: if the agent calls the MCP tool instead of using
 * TeamCreate, run a quick subquery with the specialist persona.
 */
async function runClaudeSpecialistFallback(
  persona: string,
  task: string,
): Promise<string> {
  // Use the Claude CLI in non-interactive mode
  const fullPrompt = `${persona}\n\n---\n\nTask: ${task}`;

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', fullPrompt, '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch'], {
      cwd: '/workspace/group',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Specialist timed out after 90s'));
    }, 90_000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`Claude specialist exited ${code}`));
        return;
      }
      resolve(stdout.trim() || '(no response from specialist)');
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
