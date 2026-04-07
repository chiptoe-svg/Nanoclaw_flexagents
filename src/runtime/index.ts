// Agent SDK self-registration barrel.
// Each import triggers the SDK module's registerAgentSdk() call.
// Install SDKs with /add-agentSDK-codex or /add-agentSDK-claude.

// claude
import './claude-runtime.js';

// codex (openai)
import './codex-runtime.js';

// gemini (google)
import './gemini-runtime.js';
