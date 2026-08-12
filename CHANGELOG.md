# Changelog

## [1.8.2] - 2026-08-11

### Fixed

- **MCP Tools Never Picked Up Unless Named Explicitly** — The "MCP Tools Catalog" system-prompt guideline and its inline "Available MCP Tools" header only ever explained *how* to call `call_mcp_tool` (server id, tool name, arguments), never *when* — unlike the Skills Catalog guideline right next to it ("When a catalog entry looks relevant..."), there was no trigger condition telling the model to check the catalog on its own. Every agent (including the General fallback) already has `call_mcp_tool` in its allowlist, so this wasn't a wiring/routing issue — the model simply defaulted to grep/read_file/general knowledge and only reached for a connected server when the user named it directly. Both the guideline (`src/agents/prompts.ts`) and the inline catalog header (`src/chat/panel.ts`) now instruct checking the catalog *before* falling back to other tools and calling a matching tool proactively, without waiting to be asked by name.

## [1.8.1] - 2026-08-11

### Fixed

- **`scaffold_doctype` Called a `bench new-doctype` Command That Doesn't Exist** — Verified against the full `bench --help` command listing (host + framework commands) that Frappe framework has no `new-doctype` CLI subcommand at all, and none of the currently installed apps register one via `bench_commands` hooks either — every call failed with `Error: No such command: new-doctype`. Rewrote `scaffoldDoctype` to insert the `DocType` document directly through the ORM via `bench execute` (the same temp-module mechanism `introspect_doctype` uses), which is what actually generates the JSON/`.py` controller/`.js`/test files — `DocType.on_update()` calls `export_doc()` + `make_controller_template()` under the hood, gated on `developer_mode`, the same path the Desk "New DocType" dialog itself triggers. Added optional `module` (auto-detected when the app has exactly one Module Def, otherwise reported explicitly instead of guessed) and `site` (falls back to the configured default site) parameters. Also fixes a related bug caught while live-testing the rewrite: the default permission row's `'import': 1` bit throws `check_if_importable`'s `ValidationError` unless `doc.allow_import` is also set, which a fresh DocType never has — dropped from the default set. Removed the now-dead `new-doctype` template from the manual Bench Commands picker, which pointed at the same nonexistent command.

## [1.8.0] - 2026-08-11

### Added

- **Gemini/Antigravity MCP Server Discovery** — The MCP Servers view now also discovers servers from Gemini CLI/Antigravity's global `~/.gemini/config/mcp_config.json` (`mcpServers`, same per-entry shape as `.mcp.json`), tagged with a new amber "Gemini" badge alongside the existing VS Code and `.mcp.json` sources. Discovered entries default to disabled, same as the other sources.
- **Cross-Agent Project Memory** — Each agent turn now folds in a read-only digest of what other AI coding tools have already recorded about the project — currently DevMind's `.devmind/memory/*.md` (decisions, known issues, failed attempts, project history) — into the system prompt's dynamic tail, framed explicitly as background rather than instructions. Empty files are skipped and total size is capped (6,000 chars, 2,000 per file) so one chatty memory log can't crowd out the rest of the prompt. New known-agent folders can be added with a one-line entry in `crossAgentMemory.ts`.

### Fixed

- **MCP `${workspace.path}` / `${workspaceFolder}` Placeholders Never Resolved** — Servers discovered from another host's own mcp.json (e.g. Antigravity's `~/.gemini/config/mcp_config.json`) can use that host's `${workspace.path}`-style placeholder for "the open project," which only *that* host substitutes before spawning. `MCPManager` was forwarding the literal placeholder text straight through to the spawned process, which resolved it as a relative path against the extension host's own cwd instead of the workspace — e.g. `graphify`'s `graph_stats`/`get_node`/`query_graph` all failing to find `${workspace.path}/graphify-out/graph.json` under the user's home directory. `MCPManager` now substitutes `${workspace.path}`, `${workspaceFolder}`, and `${workspaceRoot}` with the real workspace root in `command`, `args`, `cwd`, `url`, and `env`/`headers` before connecting, and defaults stdio `cwd` to the workspace root when a discovered entry doesn't set one.

## [1.7.1] - 2026-08-09

### Fixed

- **Router/Planner Lost the Thread Mid-Conversation** — 1.7.0's `formatHistory` optimization cut every transcript turn to its **first** 300 characters before handing it to the router and planner. An assistant turn in the session log is a whole agent run's summary, and the part that resolves a follow-up (which DocType was created, which file path was written, what was left as a TODO) lives in its *closing* lines — so a head-only cut discarded exactly the context the classifier needed. Follow-ups like "now add a validation to that doctype" were then routed on the bare words alone, frequently landing on a specialist with no `write_file`/`edit_file` in its allowlist (`architecture`, `research`, `design`), which surfaced as the assistant explaining instead of editing — i.e. appearing to have forgotten the conversation. Turns are now trimmed from the **middle**, preserving both head and tail, with the two newest turns given a 4,000-character budget and older turns 1,200. Worst-case router overhead for the 6-turn window stays bounded (~13k characters) so the bulk of 1.7.0's saving is retained. Only affects `frappe-copilot.multiAgent.enabled` (default `false`); the agent's own conversation history via `buildEffectiveHistory()` was never truncated.
- **`grepSearch` Kept Appending After Declaring Output Truncated** — When the 15,000-character output cap was reached mid-file, `totalOutputChars` was left un-saturated before the early `return`, which only unwound one level of the recursive directory walk. Every enclosing call's `totalOutputChars >= maxOutputChars` guard therefore still evaluated false, so sibling directories continued contributing shorter matches *after* the result had already been flagged truncated — producing output that both exceeded the cap and misrepresented where it stopped.

### Chore

- `package-lock.json` version realigned with `package.json` (it had drifted a release behind at `1.6.0`).

## [1.7.0] - 2026-08-09

### Performance & Optimization

- **Tool Context Size Limits & Truncation Guardrails** — Implemented strict output size limits across core tool execution logic (`grepSearch`, `listDir`, `executeCommand`, `webFetch`, and `callMcpTool`) to prevent context window overflow errors and excessive token consumption when analyzing large codebases:
  - `grepSearch`: Added 250-character line length truncation, max 10 matches per file, 15,000 character output limit, and auto-exclusion of binary/minified/lock files (`.min.js`, `package-lock.json`, `.map`).
  - `listDir`: Capped directory entries to 100 with an informative subpath truncation notice.
  - `executeCommand`: Capped stdout and stderr stream buffers to 15,000 characters each while preserving trailing output for error tracebacks.
  - `webFetch` & `callMcpTool`: Enforced 15,000 and 20,000 character safety output caps respectively.
- **Agent Router Context Truncation** — Updated `formatHistory` in `AgentRouter` to truncate historical transcript turns to 300 characters during multi-agent classification calls, cutting router token overhead by 80-90%.
- **Vector Store RAG Keyword Filtering** — Enhanced `VectorStore` keyword search with stop-word filtering and a `0.25` relevance threshold to eliminate low-relevance documentation context dumps into agent prompts.

## [1.6.0] - 2026-08-09

### Added

- **Global-Scope MCP Servers** — MCP server configs can now be saved with a Global scope (persisted to `~/.frappe-copilot/mcp.json`) in addition to the existing per-workspace scope, and connected automatically regardless of which workspace is open. The "MCP Servers" Webview's Add/Edit form now has a working Scope selector (Workspace/Global) — previously the dropdown existed in the HTML but `buildConfigFromForm()` never read it, so every save silently persisted to the workspace file no matter what was picked.

### Fixed

- **`MCPStore` Never Read a Home-Directory Config** — `readManual()` and related store logic only ever looked at `<workspace_root>/.frappe-copilot/mcp.json`; a server saved directly to `~/.frappe-copilot/mcp.json` was invisible to `MCPManager.initialize()` no matter how many times the window was reloaded. Fixed by adding dual-file read/write (workspace + global) so servers saved to either location are discovered and connected at activation.

## [1.5.0] - 2026-08-07

### Added

- **Multi-Stage Plan Approval & Durable Plans** — A proposed multi-stage plan now stops for explicit user approval (approve/reject/revise) *before any stage runs*, independent of the ask/auto tool-approval setting (which only ever governed individual high-risk tool calls inside an already-running stage). Approved plans are written to `.frappe-copilot/plans/` as durable Markdown, with per-stage `COMMENT:` feedback re-fed into a dedicated revision pass (`reviseStagesWithComments`) that rewrites only the commented-on stages.
- **`scaffold_app` / `scaffold_doctype` Agent Tools** — New DocTypes and apps are now created via `bench new-app` / `bench new-doctype` directly (reusing the existing command templates) instead of the model hand-authoring `hooks.py`/`setup.py`/DocType JSON from scratch. `scaffold_app` verifies the app actually landed on disk rather than trusting the exit code alone. Wired into the DocType/Schema Builder and Bench/DevOps agents.
- **PDF Diagram/Image Extraction for Document Intake** — Uploaded PDFs now have embedded diagrams/screenshots extracted alongside text (via `pngjs`) and sent to the model as vision attachments, with per-page text tracking so large-document chunking attaches the right images to the right chunk. The chunk merger now also explicitly surfaces cross-section relationships (e.g. a DocType introduced in one section, extended in another) instead of losing them across chunk boundaries. Configurable via `frappe-copilot.intake.extractImages` / `maxExtractedImages`.
- **Richer Clarification Popup** — `ask_clarification` questions can now render as single-select (radio) or multi-select (checkbox) options, mark one option `(recommended)` for a pre-selected, badge-highlighted default, and offer a free-text "Other" option that reveals a text field in place — instead of every question forcing free text or a plain unweighted choice.

### Fixed

- **`bench new-app` Silently Executing on the Host Instead of Docker** — `scaffold_app`'s command template (`printf "...\n" | bench new-app {app-name}`) doesn't start with the literal word `bench`, so the router that decides whether to prefix a command with `docker exec` (`executeCommand`'s `isBench` check) missed it entirely and let it fall through to the raw host shell, where `bench` isn't installed (`'bench' is not recognized...`). Broadened the detection to catch `bench` after a pipe, and made the Docker branch wrap piped/chained commands in `sh -c '...'` so the whole pipeline runs inside the container instead of splitting at the host shell.

## [1.4.0] - 2026-08-06

### Added

- **MCP (Model Context Protocol) Server Integration** — New "MCP Servers" sidebar Webview to connect, manage, and browse external MCP servers (local `stdio` processes or remote `http`) directly from the extension, via `Frappe Copilot: Add MCP Server (Local)`, `Frappe Copilot: Add MCP Server (Remote)`, and `Frappe Copilot: Refresh MCP Servers`.
- **`call_mcp_tool` Agent Tool** — Agents can now discover and invoke tools exposed by connected MCP servers through a catalog injected into the system prompt ("Available MCP Tools"), treating server responses as untrusted data the same way `web_fetch` results are handled.
- **Cacheable System Prompt Split** — Split the system prompt into a stable static prefix (agent identity, guidelines, tool docs) and a per-turn dynamic suffix (RAG/schema/skills/MCP catalogs), passed to the Claude Agent SDK via `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` so the larger static portion keeps hitting the prompt cache even as the dynamic content changes turn to turn.

### Fixed

- **`bench execute` Temp Script Resolution** — Nested the temporary Python module used by `introspect_doctype` and other one-liner tools inside the `frappe` app's own package (`apps/frappe/frappe/_fc_tmp_*.py`) instead of directly under `apps/`. `bench execute`'s `frappe.get_attr()` resolver requires the leading dotted segment to be an installed app before attempting the import; a bare `apps/_fc_tmp_xxx.py` path failed that check silently and fell back to a confusing raw `NameError` instead of running the script.

## [1.3.2] - 2026-08-03

### Fixed

- **Active Site Asterisk (`*`) Sanitization in Site Quick Pick & Console Tools** — Automatically sanitized active site markers (`*`) returned by `bench list-sites` when listing available sites for commands and interactive console triggers, preventing shell execution syntax errors (`bench --site * site.name`).

## [1.3.1] - 2026-08-03

### Changed

- **Non-Replacing Side Panel Chat View** — Configured chat window to open in a dedicated editor panel column beside active code files (`ViewColumn.Beside`). Prevents code files from overwriting/replacing the chat panel when opened, allowing side-by-side editing while keeping a single unified activity bar icon for sessions and tools.

## [1.3.0] - 2026-08-03

### Added

- **Responsive Webview Grid Views** — Converted `Bench Commands`, `Skills`, and `Database Explorer` sidebar views into modern, responsive Webview Grid UIs featuring interactive cards, top action bars, badges, and real-time search filtering.
- **Top Frequently Used Commands Grid** — Highlighted top bench commands (`clear-cache`, `migrate`, `restart`, `get-app`, `install-app`) at the top of the Bench Commands Webview grid with glowing cards and quick execution triggers.
- **Skills Grid Explorer** — Added a visual card grid for built-in and workspace skills with search, source badges (`Built-in` vs `Custom`), and one-click file opening.
- **Interactive Database Explorer Webview** — Integrated site selector, instant table search, expandable schema inspector cards with datatype badges (`VARCHAR`, `INT`, `DATETIME`, etc.), and quick-launch terminal buttons for `MariaDB` and `Python` consoles.

## [1.2.2] - 2026-08-03

### Fixed

- **Database Tree View Site Name Sanitization** — Fixed errors when inspecting database tables/columns for active sites marked with an asterisk (`* site.name`) or when header strings (`Available sites:`) are returned by `bench list-sites`. Cleaned site names automatically before executing site-dependent database commands.

## [1.2.1] - 2026-08-02

### Fixed

- **`Introspect DocType` always failing** — `bench execute` does not have a `--command` flag; it only accepts a dotted Python module path as its positional argument. The `runPythonOneLiner` helper was incorrectly generating `bench execute --command "..."` which bench's Click CLI parsed as an unknown command and threw `No such command: <garbled>`. Fixed by writing the Python code to a timestamped temp file (`apps/_fc_tmp_<ts>.py`) that exports a proper `execute()` function (the convention `bench execute` calls) and deleting it immediately after. Docker environments write the file via `base64 | docker exec` to bypass all shell-quoting issues.

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
