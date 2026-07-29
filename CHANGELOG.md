# Changelog

## [1.0.0] - 2026-07-29

### Added

- **Agent Routing & Persistent Sub-Agent Transcripts** — Advanced multi-agent pipeline routing to specialist sub-agents with persistent logs and self-verification loops.
- **Skill-Based Tool Retrieval** — Integrated a dynamic retrieval and execution system for custom developer skills (like `frappe-app-dev`).
- **Anthropic OAuth & Claude Code Integration** — Native OAuth login for Anthropic/Claude with automatic session token refreshing and rate limit handling.
- **Multimodal OpenAI Message Support** — Comprehensive support for sending and rendering rich multimodal messages (including images and file attachments) in OpenAI-compatible API providers.

### Changed

- **Optimized Packaging** — Reorganized webview assets to dedicated directories and updated `.vscodeignore` to exclude source files, significantly reducing the compiled VSIX bundle size.

## [0.1.0] - 2025-01-01

### Added

- **OpenCode Zen provider integration** — OpenAI-compatible API client with streaming support
- **Bench environment detection** — Automatic detection of bench on host or inside frappe_docker containers
- **Bench command registry** — 20+ pre-configured bench commands across 9 categories
- **Bench executor** — Command execution with confirmation for destructive operations
- **Chat webview panel** — Conversational AI interface with model switching
- **Session management** — Multiple persistent sessions per project with context.md and message history
- **Workspace structure** — `.frappe-copilot/` directory auto-initialization
- **Status bar integration** — Quick access to Frappe Copilot from VS Code status bar
- **Settings** — Configurable endpoint, model, temperature, and bench paths
