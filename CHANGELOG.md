# Changelog

## [1.2.0] - 2026-08-02

### Added

- **Bench Playground (Interactive REPLs)** — Added a Playground view containing options to open `bench console` (Python shell) and `bench mariadb` (SQL console) in integrated VS Code terminals, fully supporting TTY forwarding for Docker environments.
- **Persistent Database Explorer** — Built a new Database Tree View that dynamically displays all tables and columns (with their SQL types) for any site in the bench via native and secure Frappe DB CLI abstraction.
- **Categorized Bench Commands View** — Added a sidebar view with grouped bench commands and a one-click setup action to configure or update the bench environment.
- **Interactive Container & Site Selectors** — Replaced automated docker container detection with a dynamic QuickPick selector, and added drop-down site-selection menus for site-dependent commands.

### Changed

- **Refined Site Detection** — Excluded configuration/text files (like `apps.txt`, `currentsite.txt`, `.json`, etc.) from showing up as sites in selection lists.

## [1.1.0] - 2026-07-30

### Added

- **No-Code DocType Customization Tools** — New agent tools (`list_customizations`, `write_custom_field`, `write_property_setter`, `write_client_script`, `write_server_script`, `export_customizations`) to inspect and customize standard DocTypes directly on the site database (Custom Fields, Property Setters, Client Scripts, Server Scripts) without touching app code, plus exporting those customizations to versioned JSON files.
- **Frappe Builder Page Generation** — New `write_builder_page` tool and a dedicated "Design / Web Builder" agent that generates and edits Frappe Builder page designs (landing pages, portal pages) from a prompt.
- **Configurable Extended Thinking Budget** — New `frappe-copilot.claudeCode.thinkingBudgetTokens` setting to control the token budget for Claude extended thinking.

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
