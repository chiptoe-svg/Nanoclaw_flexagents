---
name: add-nanovoice
description: Add NanoVoice, an iOS voice app that talks to the NanoClaw agent over an HTTPS API. Installs the `http-api` channel on the server and guides through Tailscale Serve + iPhone setup. Triggers on "add nanovoice", "voice app", "iOS voice", "http api channel".
---

# Add NanoVoice

NanoVoice is an iOS SwiftUI app that provides hands-free, voice-first conversation with the NanoClaw agent. Speech recognition and text-to-speech run on-device (Apple Speech / AVSpeechSynthesizer). The app talks to NanoClaw over a thin HTTPS POST endpoint — the `http-api` channel — which this skill installs and wires up.

Privileged commands (`/remote-control`, `/auth`, `/model`) are intentionally blocked from the HTTP channel. Use Telegram for those.

## Phase 1: Pre-flight

### Check if already applied

Check whether the core files are present:

- `src/channels/http-api.ts`
- `ios/NanoVoice/NanoVoice.xcodeproj/`
- `import './http-api.js'` in `src/channels/index.ts`

If all three exist, the code is already applied — skip to **Phase 3: Setup**.

### Ask the user

Use `AskUserQuestion` to collect:

- Whether this Mac mini is already reachable from the iPhone via Tailscale. If not, run the Tailscale steps in `docs/macmini_setupguide.md` first and come back.
- Whether they already have a strong `HTTP_API_KEY` they'd like to reuse, or should the skill generate one.

## Phase 2: Apply Code Changes

The NanoVoice code lives on the `nanovoice-skill` branch of this repo. Merging that branch installs:

- `src/channels/http-api.ts` — `HttpApiChannel` with self-registration via `registerChannel`
- `import './http-api.js'` appended to the channel barrel (`src/channels/index.ts`)
- `src/index.ts` — rejection of `/remote-control` when `msg.sender === 'http-user'` (the HTTP API's synthetic sender)
- `ios/NanoVoice/` — the SwiftUI app (`NanoVoiceApp.swift`, `ContentView.swift`, `NanoClawClient.swift`, `SpeechManager.swift`, `Info.plist`, Xcode project)

### Merge the skill branch

The skill branch ships with this fork under `origin/nanovoice-skill`. Merge it into `main`:

```bash
git checkout main
git fetch origin
git merge origin/nanovoice-skill || {
  git checkout --theirs package-lock.json 2>/dev/null
  git add package-lock.json 2>/dev/null
  git merge --continue
}
```

If the merge reports conflicts, read the conflicted files and understand the intent of both sides before resolving.

If this skill is ever extracted to a standalone repo (e.g. `clemson-cs/nanoclaw-nanovoice`), add it as a remote and merge from there instead:

```bash
git remote add nanovoice <url-of-standalone-repo>
git fetch nanovoice main
git merge nanovoice/main
```

### Validate code changes

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Generate and install the API key

If the user doesn't have a key yet, generate one:

```bash
openssl rand -hex 32
```

Add to `.env`:

```bash
HTTP_API_KEY=<generated-key>
HTTP_API_PORT=3100
HTTP_API_BIND=127.0.0.1
```

Keep `HTTP_API_BIND=127.0.0.1` unless you are intentionally exposing NanoClaw on a network without a TLS front-end. Tailscale Serve (next step) terminates TLS on the tailnet interface and proxies to `127.0.0.1:3100`, so the server never needs a public bind.

Lock `.env`:

```bash
chmod 600 .env
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Expose NanoClaw over HTTPS (Tailscale Serve)

Tailscale prerequisites (MagicDNS and HTTPS Certificates) should already be enabled from the core Mac mini setup. If not, see `docs/macmini_setupguide.md` first.

On the Mac mini:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:3100
tailscale serve status
```

Confirm the status shows `https://<macmini>.<tailnet>.ts.net` proxying to `127.0.0.1:3100`. Tailscale handles the Let's Encrypt cert automatically.

### Restart NanoClaw

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# Linux: systemctl --user restart nanoclaw
```

Channels auto-enable when their credentials are present — setting `HTTP_API_KEY` is enough to activate the `http-api` channel.

### Install the iOS app

1. Open `ios/NanoVoice/NanoVoice.xcodeproj` in Xcode.
2. Under **Signing & Capabilities** for the `NanoVoice` target, select your Apple ID team and let Xcode auto-provision a bundle ID. For personal use, a free Apple ID is fine (7-day provisioning refresh).
3. Plug in the iPhone, select it as the run target, and build-and-run once to install.
4. On the iPhone, approve microphone and speech-recognition permissions when prompted.
5. Ensure the **Tailscale** iOS app is installed and signed in with the same identity as the Mac mini; confirm `Settings → VPN` shows Tailscale Connected.

### Configure the server in NanoVoice

In the NanoVoice app → **Settings → Add Server**:

- **Name:** anything descriptive (e.g. "Office mini").
- **URL:** `https://<macmini>.<tailnet>.ts.net` — must be **https**, must use the Tailscale MagicDNS hostname (not an IP).
- **API Key:** the `HTTP_API_KEY` from `.env`.

Tap **Test Connection** — a green checkmark means the path is working end-to-end (TLS cert, Tailscale routing, loopback proxy, Bearer auth, agent round-trip).

## Phase 4: Verify

Ask the user to:

1. From the iPhone, tap the mic and say something simple — "what time is it?" — and confirm they hear a spoken response.
2. From the iPhone, say "/remote-control" — the response should be *"Remote Control is not available over the HTTP API."* If they get back a `claude.ai/code` URL, the HTTP block didn't apply; re-check `src/index.ts handleRemoteControl` and rebuild.
3. On a laptop on the same tailnet, run:

```bash
KEY=<HTTP_API_KEY>
HOST=https://<macmini>.<tailnet>.ts.net

# Should succeed
curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"text":"ping"}' "$HOST/api/message"

# Should 401 — key-in-body is no longer accepted
curl -sS -H 'Content-Type: application/json' \
  -d "{\"text\":\"ping\",\"apiKey\":\"$KEY\"}" "$HOST/api/message"

# Should fail to connect from off-tailnet (loopback bind is correct)
curl -sS --max-time 3 "http://<macmini-campus-ip>:3100/api/message"
```

## Troubleshooting

### NanoVoice says "Invalid API key"

- Confirm `HTTP_API_KEY` in `.env` matches what's entered in the app.
- Confirm `.env` was synced: `diff .env data/env/env`.
- Check the Bearer header is actually going out — the app uses `Authorization: Bearer <key>`. Body-only auth is rejected by design.

### Connection times out

- `tailscale status` on both devices — confirm both are online in the same tailnet.
- `tailscale serve status` on the Mac mini — confirm the HTTPS route is active.
- `lsof -iTCP:3100 -sTCP:LISTEN` — NanoClaw must be listening on `127.0.0.1:3100`.

### `/remote-control` still returns a URL via voice

- Confirm the block in `src/index.ts handleRemoteControl` tests `msg.sender === 'http-user'`.
- Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`.

### Cert not trusted on iPhone

- You should be getting a real Let's Encrypt cert via Tailscale — nothing to install. If iOS reports an untrusted cert, you're probably hitting the Mac mini's campus IP rather than the MagicDNS hostname. Change the URL in NanoVoice to `https://<macmini>.<tailnet>.ts.net`.

## Removal

To remove NanoVoice and the HTTP API channel, revert the merge:

```bash
# Find the merge commit from the skill install
git log --merges --grep='nanovoice' -n 1
# Revert it (creates an inverse commit — non-destructive)
git revert -m 1 <merge-commit-sha>
```

Then clean up the runtime side:

1. Remove `HTTP_API_KEY`, `HTTP_API_PORT`, `HTTP_API_BIND` from `.env` and `data/env/env`
2. Remove the Tailscale Serve route: `sudo tailscale serve --https=443 off`
3. Rebuild and restart: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
4. Remove the app from the iPhone

## Operational notes

- **Rotate `HTTP_API_KEY`** whenever a phone holding it is lost or replaced. Update `.env`, sync to `data/env/env`, rebuild, and re-enter the new key in NanoVoice.
- **Privileged commands stay on Telegram.** `/remote-control`, `/auth`, `/model`, and `/chatid` are blocked or nonsensical via voice. This is intentional: NanoVoice is a conversation surface, not a control plane.
- **Backups.** The iOS app stores `HTTP_API_KEY` in `UserDefaults` today (Keychain migration is on the roadmap). Don't include unencrypted iTunes/Finder backups of the phone in uncontrolled locations.
- **Future hardening** items tracked but not yet done:
  - Move the iOS `apiKey` to Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
  - Per-device API keys (one shared key today — losing a phone means rotating everyone's).
  - `sender-allowlist.ts` integration for `/remote-control` on Telegram.
