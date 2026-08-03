# Frappe Copilot 🚀

AI-powered development assistant for **Frappe/ERPNext** running inside VS Code.
Integrates with **OpenCode Zen**, **OpenAI**, and **Anthropic** to help you build,
customize, and debug Frappe applications faster — with agentic code generation,
live bench command execution, and a visual workflow graph.


## Features

- **💻 Bench Playground (Interactive REPLs)** — Instant one-click access to open `bench console` (Python shell) and `bench mariadb` (SQL console) in integrated VS Code terminals with full Docker TTY support.
- **🗄️ Database Explorer Tree View** — Dedicated sidebar view to inspect sites, browse database tables, and view field column names & SQL data types natively.
- **⚡ Categorized Bench Commands Tree View** — Interactive sidebar to quickly browse 100+ categorized bench CLI commands and execute them on your site/container with safety confirmation gates for destructive actions.
- **🎨 No-Code DocType & Page Customization Tools** — Agent tools (`write_custom_field`, `write_property_setter`, `write_client_script`, `write_server_script`, `export_customizations`, `write_builder_page`) to inspect and edit standard DocTypes and generate Frappe Builder pages without modifying app code.
- **🤖 Multi-Agent Orchestration & Routing** — Automatically route complex requests to task-specific sub-agents (DocType/Schema Builder, Server-side Logic, Client UI, Bench/DevOps, Research, Architecture) with persistent transcripts and self-verification (e.g. running migrations and tests with self-correction loops).
- **🔑 Anthropic OAuth & Claude Code Session** — Direct OAuth login flow for Anthropic/Claude with automatic token refreshing, secure credential storage, and rate-limit handling.
- **🖼️ Multimodal OpenAI Message Support** — Send and render rich multimodal messages (including images and file attachments) in OpenAI-compatible API providers.
- **📚 Custom Developer Skills** — Create, import, and execute custom developer skills (YAML/Markdown-based checklists and instructions like `frappe-app-dev`) to standardize workflows.
- **💬 AI Chat with Streaming** — Conversational Frappe/ERPNext assistant with real-time streaming responses.
- **🔍 Auto Bench Detection** — Automatically detects your bench environment (host shell or Docker container).
- **🔄 Multi-Provider** — Switch between OpenCode Zen, OpenAI, Anthropic, and Claude Code on the fly.
- **📂 Session Management** — Multiple persistent chat sessions with message history (JSONL) and evolving context files.
- **🤖 Agentic Tool Loop** — Autonomous multi-step execution: the AI can read files, write/edit code, run commands, search the web, inspect DocTypes, and more — all with user approval for high-risk actions.
- **📊 Visual Workflow Graph** — Real-time agent execution graph rendered inside the chat panel.
- **📎 Code Mention** — Select code in any editor and insert it as a context mention (Ctrl+Alt+M / Cmd+Alt+M).
- **📄 File Upload** — Upload PDFs and text files for analysis (text extraction via pdfjs-dist).
- **🧠 RAG Vector Store** — Semantic search over Frappe documentation and code templates built into the agent context.
- **💾 Persistent Skills Memory** — The AI saves reusable patterns and checklists to `.frappe-copilot/skills_memory.md` across sessions.
- **✅ Interactive Todo List** — The AI can create, update, and track a todo list that renders in the chat UI.
- **🔧 In-Chat Settings** — Configure API key, endpoint, provider, and model directly inside the chat panel.
- **🛡️ Tool Approval System** — `write_file`, `edit_file`, and `execute_command` always prompt for user confirmation before execution.
- **🔁 Auto-Healing** — After writing or editing code files, the agent automatically validates and fixes syntax errors.
- **🧭 Schema Introspection** — Automatically queries your active Frappe site to discover installed apps and DocTypes.

## Getting Started

### 1. Install the extension

To install the extension from the compiled VSIX package:

1. Download the latest `frappe-copilot-1.2.2.vsix` asset.
2. In VS Code, press **Ctrl+Shift+P** (or **Cmd+Shift+P**) to open the Command Palette.
3. Run the command **Extensions: Install from VSIX...**.
4. Select the downloaded `.vsix` file to install it.

### 2. Set up your API key

Run **Frappe Copilot: Set API Key** from the Command Palette, or open the chat panel
and click the settings gear icon. Your key is stored securely in VS Code's Secret Storage.

### 3. Open the chat

Run **Frappe Copilot: Open Chat** from the Command Palette, or click the status bar icon
labeled `Frappe Copilot`.

### 4. Configure your bench (automatic)

The first time you open the chat, the extension guides you through bench detection.
It auto-detects:

- **Host** — `bench` found in `$PATH`
- **Docker** — Running Frappe container detected
- **Not found** — Manual path setup via the wizard

You can re-detect at any time via **Frappe Copilot: Configure Bench Environment**.

## Commands

| Command | Description |
|---------|-------------|
| `Frappe Copilot: Open Chat` | Open the AI chat panel |
| `Frappe Copilot: Configure Bench Environment` | Auto-detect or manually configure your bench |
| `Frappe Copilot: Set API Key` | Securely store your LLM API key |
| `Frappe Copilot: New Session` | Create a new chat session |
| `Frappe Copilot: Run Bench Command...` | Browse categories and run a pre-configured bench command |
| `Frappe Copilot: Show Configuration` | Open the extension settings page |
| `Frappe Copilot: Mention Selected Code` | Insert selected editor text as a context mention into the chat |
| `Frappe Copilot: New Skill` | Create a new custom developer skill |
| `Frappe Copilot: Import Skill (.md/.zip)` | Import a custom developer skill from a Markdown template or a zip package |

## Configuration

All settings are available under `File → Preferences → Settings → Extensions → Frappe Copilot`.

### Provider Selection

```json
"frappe-copilot.provider": "opencode-zen"  // or "openai" / "anthropic" / "claude-code"
```

### Multi-Agent Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `frappe-copilot.multiAgent.enabled` | `false` | Route requests to task-specialized sub-agents and self-verify output |

### OpenCode Zen

| Setting | Default | Description |
|---------|---------|-------------|
| `frappe-copilot.opencodeZen.endpoint` | `https://opencode.ai/zen/v1` | API endpoint URL |
| `frappe-copilot.opencodeZen.model` | `deepseek-v4-flash-free` | Model to use |
| `frappe-copilot.opencodeZen.temperature` | `0.7` | LLM temperature |

### OpenAI

| Setting | Default | Description |
|---------|---------|-------------|
| `frappe-copilot.openai.endpoint` | `https://api.openai.com/v1` | API endpoint URL |
| `frappe-copilot.openai.model` | `gpt-4o` | Model to use |
| `frappe-copilot.openai.temperature` | `0.7` | LLM temperature |

### Anthropic

| Setting | Default | Description |
|---------|---------|-------------|
| `frappe-copilot.anthropic.endpoint` | `https://api.anthropic.com/v1` | API endpoint URL |
| `frappe-copilot.anthropic.model` | `claude-3-5-sonnet-latest` | Model to use |
| `frappe-copilot.anthropic.temperature` | `0.7` | LLM temperature |
| `frappe-copilot.anthropic.extendedThinking` | `false` | Enable Claude extended thinking |

### Claude Code

| Setting | Default | Description |
|---------|---------|-------------|
| `frappe-copilot.claudeCode.model` | `claude-sonnet-5` | Model to use with official Claude Code SDK |
| `frappe-copilot.claudeCode.extendedThinking` | `false` | Enable Claude extended thinking for Claude Code |

## Bench Command Safety

The extension ships with **100+ pre-configured bench commands** organized into 17 categories.
Commands flagged as **destructive** require explicit modal confirmation before execution.

| Category | Safe Commands | Destructive Commands |
|----------|---------------|---------------------|
| `init` | `init`, `find-benches`, `src` | `drop`, `migrate-env` |
| `app` | `get-app`, `new-app`, `list-apps`, `validate-dependencies` | `install-app`, `uninstall-app`, `remove-app`, `pip` |
| `site` | `new-site`, `browse`, `list-sites`, `add-system-manager` | `migrate`, `reinstall`, `drop-site`, `restore`, `set-password` |
| `backup` | `backup`, `backup-all-sites` | None |
| `config` | `show-config`, `config http-timeout`, `config dns-multitenant` | `set-config`, `remove-common-config` |
| `database` | `console`, `describe-database-table`, `sqlite` | `mariadb`, `database`, `postgres`, `run-patch`, `trim-database` |
| `doctype` | `new-doctype`, `reload-doctype`, `export-fixtures`, `data-import` | `reset-perms`, `bulk-rename` |
| `build` | `build`, `watch`, `serve` | None |
| `test` | `run-tests`, `run-parallel-tests`, `run-ui-tests` | None |
| `scheduler` | `scheduler status`, `doctor`, `worker`, `schedule` | `purge-jobs` |
| `translation` | `download-translations` | None |
| `update` | `update --pull` | `update`, `switch-to-branch`, `switch-to-develop` |
| `setup` | `setup nginx`, `setup backups`, `setup procfile`, `setup redis` | `setup-production`, `setup-firewall`, `setup-requirements`, `setup-sudoers` |
| `install` | None | All (`install-prerequisites`, `install-mariadb`, etc.) |
| `network` | `set-ssl-certificate`, `set-ssl-key` | `set-nginx-port`, `set-url-root`, `set-mariadb-host` |
| `production` | `renew-lets-encrypt`, `setup systemd` | `disable-production`, `setup-role`, `setup-ssh-port` |
| `utility` | `clear-cache`, `restart`, `start`, `version`, `jupyter`, `ngrok` | `execute`, `destroy-all-sessions` |

## Agent Tools

When you send a message, the AI can autonomously invoke the following tools in a loop
(up to 10 steps) until it has completed your request:

| Tool | Description | Requires Approval |
|------|-------------|-------------------|
| `read_file` | Read file contents | ❌ No |
| `write_file` | Create or overwrite a file | ✅ Yes |
| `edit_file` | Search-and-replace edit an existing file | ✅ Yes |
| `list_dir` | List directory contents | ❌ No |
| `grep_search` | Text search across the codebase | ❌ No |
| `execute_command` | Run any terminal command | ✅ Yes |
| `introspect_doctype` | Query Frappe site for DocType schema fields, links, badges | ❌ No |
| `ask_clarification` | Show a popup asking you questions (blocks until answered) | ❌ No |
| `update_todo_list` | Create/update a visual todo list | ❌ No |
| `web_search` | Search the web via DuckDuckGo | ❌ No |
| `web_fetch` | Fetch and clean text from a URL | ❌ No |

After every `write_file` or `edit_file`, the agent automatically runs syntax validation
(`python -m py_compile` for `.py`, `node -c` for `.js`) and reports any compilation errors.

## Workspace Structure

```
.frappe-copilot/
├── config.json                  # Workspace configuration (bench env, default site, API settings)
├── sessions/                    # Chat sessions (visible in VS Code TreeView sidebar)
│   └── session-{id}/
│       ├── context.md           # Persistent evolving context for the session
│       └── messages.jsonl       # Full message history (JSONL)
├── docs/
│   └── vector_store.json        # Auto-generated RAG embedding index
├── agents/
│   └── graph.json               # Current agent workflow graph state
├── uploads/                     # Uploaded files (PDFs, etc.) for analysis
├── skills_memory.md             # Persistent AI memory — learned patterns & checklists
└── schema_index.json            # Cached Frappe site schema (apps + DocTypes)
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code Extension                         │
│                                                             │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────────┐  │
│  │  Chat     │   │  Session     │   │  TreeView          │  │
│  │  Panel    │◄──│  Manager     │◄──│  (Sessions)        │  │
│  │ (Webview) │   │ (file-based) │   │                    │  │
│  └────┬──────┘   └──────────────┘   └────────────────────┘  │
│       │                                                      │
│  ┌────▼─────────────────────────────────────────────────┐   │
│  │           DynamicProvider (Gateway)                    │   │
│  │  ┌────────────┐  ┌──────────┐  ┌────────────────┐    │   │
│  │  │ OpenCodeZen │  │  OpenAI  │  │   Anthropic    │    │   │
│  │  └────────────┘  └──────────┘  └────────────────┘    │   │
│  └───────────────────────────────────────────────────────┘   │
│       │                                                      │
│  ┌────▼─────────────────────────────────────────────────┐   │
│  │           Agent Orchestrator (Tool Loop)               │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐  │   │
│  │  │ Tool     │ │ Vector   │ │ Graph    │ │ Bench   │  │   │
│  │  │ Executor │ │ Store    │ │ Store    │ │ Executor│  │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └─────────┘  │   │
│  └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

Frappe Copilot is designed as a layered system:

1. **DynamicProvider (Gateway)** — Unified interface that routes to one of three LLM providers (OpenCode Zen, OpenAI, Anthropic) based on user settings. Each provider implements `chat()`, `chatStream()`, `isAvailable()`, and optional `getEmbeddings()`.

2. **Agent Orchestrator** — The core loop that runs inside `ChatPanel.runOrchestrator()`. It sends conversation history + RAG context + skills memory to the LLM, parses `<tool_call>` XML tags from the response, executes approved tools, appends results, and loops (up to 10 iterations) until the task is complete.

3. **Bench Executor** — Routes resolved commands to either the host shell or a Docker container (`docker exec -w {benchDir} {containerId} bench ...`). Supports both synchronous execution (captured output) and streaming (spawn with live output callbacks).

4. **Bench Detector** — Multi-strategy detection: (a) user-configured paths from settings, (b) `which bench` on the host, (c) Docker container scanning by name patterns (`frappe`, `backend`, etc.), (d) interactive fallback asking the user.

5. **Session Manager** — File-based CRUD for chat sessions. Each session is a directory containing `context.md` (evolving context summary) and `messages.jsonl` (conversation history). Implements VS Code `TreeDataProvider` for the sidebar.

6. **Vector Store** — Builds a RAG index from `assets/docs/*.md` (Frappe API docs) and `assets/templates/*.{py,js}` (boilerplate templates). Supports semantic cosine-similarity search via embeddings or keyword overlap fallback.

7. **Graph Store** — Persists the agent workflow execution graph as `agents/graph.json`. Tracks nodes, edges, status, and progress — rendered in real-time inside the chat panel.

8. **Intake Pipeline** — File reader pipeline that extracts text from uploaded files (PDF via pdfjs-dist, text/code via direct read), splits into chunks, and returns structured content for the agent.

## Development

```bash
npm install        # Install dependencies
npm run compile    # Compile TypeScript
npm run watch      # Watch mode for development
```

### Project Structure

```
src/
├── agents/
│   ├── graphStore.ts        # Workflow graph persistence
│   ├── prompts.ts           # System prompts for the LLM
│   ├── toolExecutor.ts      # Agent tool execution engine
│   └── vectorStore.ts       # RAG embedding store (docs + templates)
├── bench/
│   ├── commands.ts          # 100+ pre-configured bench CLI commands
│   ├── detector.ts          # Bench environment auto-detection
│   └── executor.ts          # Command execution (host/Docker)
├── chat/
│   ├── panel.ts             # Webview chat panel + agent orchestrator
│   └── webview/
│       ├── chat.html        # Chat webview UI
│       └── graph.html       # Workflow graph webview UI
├── intake/
│   ├── extractor.ts         # PDF/text file content extraction
│   ├── fileReader.ts        # Unified file reading API
│   └── splitter.ts          # Text chunking for parallel analysis
├── providers/
│   ├── interface.ts         # LLMProvider interface
│   ├── dynamic.ts           # Provider router (opencode-zen/openai/anthropic)
│   ├── opencode-zen.ts      # OpenCode Zen API implementation
│   ├── openai.ts            # OpenAI API implementation
│   └── anthropic.ts         # Anthropic API implementation
├── session/
│   ├── manager.ts           # Session CRUD + TreeView provider
│   └── store.ts             # File-based session persistence
├── workspace/
│   └── structure.ts         # .frappe-copilot workspace initialization & config
├── extension.ts             # VS Code extension activation
└── types.ts                 # TypeScript type definitions
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

## License

MIT © [Invento Software Limited](https://github.com/invento-software-limited)