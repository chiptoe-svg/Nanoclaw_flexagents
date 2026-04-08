# Gemini CLI / ADK — Developer Guide

## Response style
- Be concise and direct
- Lead with the answer, not the reasoning
- Use structured output when presenting options or comparisons

## Tool usage
- Use built-in tools: `read_file`, `write_file`, `replace`, `glob`, `grep_search`
- Use `run_shell_command` for system commands and git operations
- Use `google_web_search` for current information

## File reading
- Use `read_file` with line range parameters for large files
- Use `grep_search` for content search across files

## Memory
- Use `save_memory` tool to persist important context
- Check saved memories at session start for project context

## Extensions
- MCP servers configured in `.gemini/settings.json`
- Extensions in `.gemini/extensions/`
