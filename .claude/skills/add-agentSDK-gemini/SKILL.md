---
name: add-agentSDK-gemini
description: Add Google Gemini agent SDK. Free tier available (60 req/min). Built-in tools, MCP support, 11 lifecycle hooks. Authenticates via API key.
---

# Add Gemini Agent SDK

Adds Google Gemini runtime support. After installation, groups can use `runtime: 'gemini'` for Gemini models (2.5 Pro, Flash, Flash Lite).

## Phase 1: Pre-flight

Check if already applied:

```bash
ls src/runtime/gemini-runtime.ts 2>/dev/null && echo "ALREADY_INSTALLED" || echo "NOT_INSTALLED"
```

If already installed, skip to Phase 3 (Configure).

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch origin skill/add-agentSDK-gemini
git merge origin/skill/add-agentSDK-gemini --no-edit
```

### Build

```bash
npm install && npm run build && ./container/build.sh
```

## Phase 3: Configure

### Authentication

Get a free API key from https://aistudio.google.com/apikey

Add to `.env`:
```bash
echo 'GEMINI_API_KEY=<your-key>' >> .env
```

Free tier: 60 requests/minute, 1000/day. No payment method required.

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

Set a group to Gemini runtime:
```sql
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = '{\"runtime\":\"gemini\"}' WHERE jid = '...';"
```

Or use `/model gemini-2.5-flash` in Telegram.

Send a message. Check `/auth` shows Gemini status.

## Removal

```bash
git log --oneline --all | grep "add Gemini"
git revert <commit> -m 1
npm install && npm run build && ./container/build.sh
```
