# Frappe Copilot 🚀

AI-powered development assistant for Frappe/ERPNext. Integrates with **OpenCode Zen** to help you build, customize, and debug Frappe applications faster.

## Features

- **💬 AI Chat** — Conversational Frappe/ERPNext assistant powered by OpenCode Zen
- **🔍 Bench Detection** — Automatically detects bench environment (host or Docker)
- **⚡ Bench Commands** — Pre-configured bench commands with confirmation gates for destructive operations
- **📂 Session Management** — Multiple sessions per project, each with persistent context
- **🔧 Model Switching** — Switch between different AI models on the fly

## Getting Started

### 1. Install the extension

Install Frappe Copilot from the VS Code marketplace, or load it from source:
```bash
npm install
npm run compile
```
Then press `F5` to launch the Extension Development Host.

### 2. Configure OpenCode Zen

Set your OpenCode Zen API key and endpoint in VS Code settings:

- `frappe-copilot.opencodeZen.endpoint` — default: `https://opencode.ai/zen/v1`
- `frappe-copilot.opencodeZen.model` — default: `deepseek-v4-flash-free`
- `frappe-copilot.opencodeZen.temperature` — default: `0.7`

> **API Key**: For security, set your API key via VS Code's Secret Storage
> (Command Palette → "Frappe Copilot: Set API Key").

### 3. Open the chat

Run the command **Frappe Copilot: Open Chat** from the command palette, or click the
status bar icon.

### 4. Detect your bench

Run **Frappe Copilot: Detect Bench Environment** to automatically find your bench
(whether on the host or in a Docker container).

## Commands

| Command | Description |
|---------|-------------|
| `Frappe Copilot: Open Chat` | Open the AI chat panel |
| `Frappe Copilot: Detect Bench Environment` | Auto-detect bench (host/Docker) |
| `Frappe Copilot: New Session` | Create a new chat session |
| `Frappe Copilot: Run Bench Command...` | Pick and run a pre-configured bench command |
| `Frappe Copilot: Show Configuration` | Open extension settings |

## Bench Command Safety

Commands are categorized as **destructive** or **non-destructive**:

- ✅ **Non-destructive**: `build`, `watch`, `backup`, `run-tests`, `console`, `version`, `list-apps`, `clear-cache`
- ⚠️ **Destructive** (requires confirmation): `migrate`, `reinstall`, `install-app`, `uninstall-app`, `restore`, `db-console`, `set-config`

## Workspace Structure

```
.frappe-copilot/
├── config.json          # Project configuration
├── sessions/            # Chat sessions
│   └── session-{id}/
│       ├── context.md   # Persistent session context
│       └── messages.jsonl  # Message history
├── docs/                # (reserved) Epic/Story/Feature/Task docs
└── agents/              # (reserved) Agent configurations
```

## Development

```bash
npm install        # Install dependencies
npm run compile    # Compile TypeScript
npm run watch      # Watch mode
```

## Architecture

Frappe Copilot is designed as a layered system:

1. **Provider Gateway** — Unified interface for LLM providers (currently OpenCode Zen)
2. **Bench Bridge** — Host/Docker-abstracted bench command execution
3. **Session Manager** — Persistent, file-based chat sessions
4. **Agent Orchestrator** — (planned) Multi-agent code generation pipeline

## License

MIT
