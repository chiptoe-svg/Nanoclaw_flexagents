# Voice App for NanoClaw — Implementation Prompt

Build a lightweight iOS app that provides voice-based conversation with the NanoClaw agent (like Grok's voice interface). The app should feel like talking to a person — tap to talk, hear the response spoken back.

## What exists already
- NanoClaw agent running on a Mac, accessible via Telegram bot (@ClemsonGCagentbot)
- Whisper voice transcription already working for Telegram voice notes
- Agent responds via text in Telegram
- Agent has MCP tools (email, calendar, tasks, todo lists, reminders)

## Architecture — Direct (no middleware server)

The iOS app handles the voice pipeline directly:

1. **Record** — AVAudioEngine captures audio when user holds mic button (or VAD detects speech)
2. **Transcribe** — Send audio to OpenAI Whisper API → get text
3. **Send to agent** — HTTP POST to a NanoClaw endpoint (add a lightweight HTTP channel, or use the Telegram Bot API to send a message and poll for response)
4. **Receive response** — Get agent's text reply
5. **Speak** — Send text to OpenAI TTS API (or ElevenLabs) → stream audio playback

## iOS App (SwiftUI)

Minimal UI:
- Large mic button (push-to-talk, or toggle for hands-free with VAD)
- Scrolling conversation history (transcribed text + agent responses)
- Waveform/pulse animation while listening or speaking
- Settings: server URL, voice selection, auto-listen toggle

~4 files: ContentView, AudioRecorder, VoicePipeline, Settings

## NanoClaw HTTP Channel

Add a simple HTTP endpoint to NanoClaw (similar to how Telegram channel works):
- POST /api/message — send text, get agent response
- Auth via API key or token
- Returns agent's text response (synchronous or webhook callback)

This could be a new channel type (`/add-http-api`) or just a minimal Express endpoint in src/channels/.

## Key decisions
- Push-to-talk vs VAD (voice activity detection) — start with push-to-talk, add VAD later
- Streaming TTS vs wait-for-complete — streaming feels much more responsive
- Where to run: Mac only (Tailscale/Cloudflare tunnel) vs cloud proxy
- CarPlay support — add later as a CarPlay scene

## Latency budget
- Record: 0ms (real-time)
- Whisper transcription: ~1-2s
- Agent response: ~5-15s (container spin-up + LLM)
- TTS: ~1s (streaming)
- Total: ~7-18s first response, faster on subsequent (container reuse)

## References
- Grok iOS app voice interface (inspiration for UX)
- OpenAI Whisper API: https://platform.openai.com/docs/guides/speech-to-text
- OpenAI TTS API: https://platform.openai.com/docs/guides/text-to-speech
- ElevenLabs API (alternative TTS, more natural voices)
