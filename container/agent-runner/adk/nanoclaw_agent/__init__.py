"""
NanoClaw ADK Agent — root agent definition.

Loaded by `adk api_server`. Reads persona from AGENT.md,
configures MCP tools (nanoclaw IPC), and exposes specialist
sub-agents from the Specialists section of the persona.
"""

import json
import os
import re
import sys
from pathlib import Path

from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import McpToolset, StdioConnectionParams

# --- Configuration from environment ---

MODEL = os.environ.get("NANOCLAW_MODEL", "gemini-2.5-flash")
MCP_SERVER_PATH = os.environ.get("NANOCLAW_MCP_SERVER", "")
PROVIDER_MCP_CONFIG = os.environ.get("NANOCLAW_PROVIDER_MCP_CONFIG", "")
CHAT_JID = os.environ.get("NANOCLAW_CHAT_JID", "")
GROUP_FOLDER = os.environ.get("NANOCLAW_GROUP_FOLDER", "")
IS_MAIN = os.environ.get("NANOCLAW_IS_MAIN", "0")
WORKSPACE = os.environ.get("NANOCLAW_WORKSPACE", "/workspace/group")


# --- Load persona from AGENT.md ---

def load_persona() -> str:
    """Load agent persona from AGENT.md, falling back to GEMINI.md."""
    for name in ["AGENT.md", "GEMINI.md", "CLAUDE.md"]:
        persona_path = Path(WORKSPACE) / name
        if persona_path.exists():
            return persona_path.read_text()
    return "You are a helpful assistant."


def load_global_persona() -> str:
    """Load global persona if available."""
    for name in ["AGENT.md", "GEMINI.md", "CLAUDE.md"]:
        path = Path("/workspace/global") / name
        if path.exists():
            return path.read_text()
    return ""


def parse_specialists(persona: str) -> list[LlmAgent]:
    """Parse specialist definitions from ## Specialists section."""
    specialists = []
    section = re.search(
        r"## Specialists\s*\n([\s\S]*?)(?=\n## |\Z)", persona, re.IGNORECASE
    )
    if not section:
        return specialists

    # Find all ### Heading blocks
    headings = list(
        re.finditer(r"###\s+(\w+)\s*\n([\s\S]*?)(?=\n###\s|\Z)", section.group(1))
    )
    for match in headings:
        name = match.group(1).lower()
        instruction = match.group(2).strip()
        if not instruction or name in ("how", "when"):
            continue  # Skip guidance sections
        specialists.append(
            LlmAgent(
                name=name,
                model=MODEL,
                instruction=instruction,
                description=f"{name.title()} specialist agent",
            )
        )
    return specialists


# --- Build tools ---

def build_provider_toolsets() -> list:
    """Register an McpToolset per provider whose tokens are present.

    The Node-side provider-registry resolves globs, ${tokenDir}, and
    ${env.VAR} placeholders and writes the final command/args/env for each
    available provider to NANOCLAW_PROVIDER_MCP_CONFIG. We just load and
    spawn.
    """
    toolsets = []
    if not PROVIDER_MCP_CONFIG:
        return toolsets
    try:
        with open(PROVIDER_MCP_CONFIG) as f:
            configs = json.load(f)
    except (OSError, json.JSONDecodeError) as err:
        print(
            f"[nanoclaw_agent] failed to read provider MCP config: {err}",
            file=sys.stderr,
        )
        return toolsets

    for provider_id, cfg in configs.items():
        command = cfg.get("command")
        args = cfg.get("args", [])
        env = cfg.get("env", {})
        if not command:
            continue
        toolsets.append(
            McpToolset(
                connection_params=StdioConnectionParams(
                    command=command,
                    args=args,
                    env=env,
                ),
            )
        )
        print(f"[nanoclaw_agent] registered provider MCP: {provider_id}", file=sys.stderr)

    return toolsets


def build_tools() -> list:
    """Configure MCP tools for the NanoClaw IPC server + providers."""
    tools = []
    if MCP_SERVER_PATH:
        tools.append(
            McpToolset(
                connection_params=StdioConnectionParams(
                    command="node",
                    args=[MCP_SERVER_PATH],
                    env={
                        "NANOCLAW_CHAT_JID": CHAT_JID,
                        "NANOCLAW_GROUP_FOLDER": GROUP_FOLDER,
                        "NANOCLAW_IS_MAIN": IS_MAIN,
                        "NANOCLAW_RUNTIME": "gemini",
                        "NANOCLAW_MODEL": MODEL,
                    },
                ),
            )
        )
    tools.extend(build_provider_toolsets())
    return tools


# --- Assemble the root agent ---

persona = load_persona()
global_persona = load_global_persona()
full_instruction = f"{global_persona}\n\n---\n\n{persona}" if global_persona else persona

specialists = parse_specialists(persona)

root_agent = LlmAgent(
    name="nanoclaw",
    model=MODEL,
    instruction=full_instruction,
    description="NanoClaw personal assistant",
    tools=build_tools(),
    sub_agents=specialists if specialists else None,
)
