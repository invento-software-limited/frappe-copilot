# Changelog

## [1.12.2] - 2026-10-07

### Fixed

- **Skills Picked With "/" Were Invisible and Bloated the History** — Choosing a skill from the "/" menu pasted its whole text (16 KB for `frappe-report-dashboard-builder`) into the message as hidden content: the user's bubble showed nothing, the Skills row didn't list it, every later turn resent it as history, and a reloaded chat showed the full text in the bubble. The message now carries just the skill id; the skill is loaded into the agent's instructions with a note to follow its workflow, listed in the Skills row as "you asked for it", shown as a 📎 chip on the message, and kept loaded for the rest of the session. Older messages with pasted skill text display as a chip too.
- **Naming a Skill Didn't Load It** — Typing a skill's id in the message ("frappe-report-dashboard-builder use this skill", or `/frappe-report-dashboard-builder` inline) was ignored, since skills were only auto-picked by their descriptions. An exact id, as a whole word, now loads that skill like a "/" pick.
- **A Run Could End With No Answer** — When the model replied with only hidden thinking (no text, no tool call), the run ended silently with nothing saved, leaving just "Worked for …". An empty reply is now nudged to continue (up to twice); after that the run stops with a visible note.

## [1.12.1] - 2026-10-07

### Fixed

- **New Chat Button Closed the Chat** — The new-chat icon ran the same command as the toolbar's chat toggle, which closes the Secondary Side Bar when it's already showing, so the chat disappeared and had to be reopened. Opening a session from history and **Mention Code** had the same problem. These now only bring the chat into view (its visible side bar, else its editor tab) and never close it; the toolbar icon still toggles.
- **`<invoke>` Markup in Replies** — In the text tool protocol, some models (e.g. DeepSeek via OpenCode Zen) write tool calls in their own `<invoke name="…"><parameter name="…">` syntax instead of `<tool_call>`. The raw markup showed in the chat, the calls didn't run, and the model needed a correction round trip to repeat them. Those calls now run directly (including `｜DSML｜`-prefixed tags and `<function_calls>` wrappers); a stray `<invoke>` next to a real `<tool_call>` is ignored so nothing runs twice; and the chat hides both syntaxes — in live replies, while a block is still streaming in, and in reopened history.

## [1.12.0] - 2026-10-07

### Added

- **Accept / Reject Review of Agent Edits** (`src/review/`) — Every file the agent changes (`write_file`, `edit_file`, `multi_edit`) is tracked against what it looked like before the agent touched it. Edits still land on disk right away (migrations and tests run against them); you then keep or undo them:
  - *Review bar* above the chat input — each changed file with `+added -removed` line counts, a "new" tag for created files and its folder; click to open a before/after diff, hover for per-file ✓ / ✕; **Accept all** / **Reject all** (asks first). Rejecting a created file deletes it.
  - *In the editor* — added lines highlighted, removed lines marked with the old text on hover, and **Accept / Reject** CodeLens buttons on every hunk plus **Accept file / Reject file / Open diff** at the top. `Alt+Enter` accepts and `Shift+Alt+Backspace` rejects the hunk under the cursor.
  - Pending reviews persist in `.frappe-copilot/review.json` and accumulate across runs — the baseline is always the file as you last accepted it. Toggle with `frappe-copilot.reviewChanges` (default on).
- **Browser Tools** — `browser` (navigate, read the page, scroll, back/forward/reload, wait, tabs, screenshot) and `browser_action` (click, type, select, hover, upload, press, evaluate) drive a real Chrome/Chromium/Edge/Brave through `puppeteer-core` (no browser download). Pages are read as a text outline whose `[n]` refs are clicked or filled; every action returns the updated outline. Cross-origin iframes are outlined too; `upload` only accepts workspace files. `browser_action` needs approval in ask mode. The window is visible by default and keeps a persistent profile in `~/.frappe-copilot/browser-profile`, so a login done once is reused. Settings: `frappe-copilot.browser.executablePath`, `frappe-copilot.browser.headless`.
- **Images in Tool Results** — Browser screenshots and `read_file` on a png/jpg/gif/webp reach the model as images it can look at, on every provider. Only the latest two screenshot turns are kept in context. A model that rejects images is switched to text-only for the session. Setting: `frappe-copilot.toolImages`.
- **Web Search Backends** — `frappe-copilot.webSearch.provider` selects Brave Search, Tavily, a SearXNG instance (`webSearch.searxngUrl`) or DuckDuckGo; `auto` (default) uses Brave/Tavily when a key is set. New command **Frappe Copilot: Set Web Search API Key** stores the key in VS Code secret storage (`BRAVE_API_KEY` / `TAVILY_API_KEY` env vars also work).
- **Run Usage and Limits** — Input/output tokens of the request in flight show in the status line and in the "Worked for …" line. `frappe-copilot.runLimits.pauseAfterSteps` (default 100) and `runLimits.pauseAfterTokens` (default off) pause a long run and ask Continue / Stop; each Continue doubles the limit, and the stop button also ends the pause.
- **Full Run History When Reopening a Chat** — Saved runs now show the steps they streamed live — intermediate text, collapsed reasoning, and tool calls with status and output — instead of only the final answer behind "Show sub-agent steps". A `task` call shows its sub-agent's own steps nested inside its card.
- **Test Suite and CI** — `npm test` runs 52 tests on Node's built-in runner (no new framework): unit tests plus integration tests that drive the agent runtime and the chat panel with a scripted model through a lightweight `vscode` stub (`src/test/support/`). ESLint (flat config, `typescript-eslint`) is set up for `npm run lint`. A new CI workflow runs build, lint and tests on pushes to `main` and pull requests; the release workflow runs them before packaging.

### Fixed

- **Reopening the Chat Mid-run Lost the Stream** — A chat closed and reopened (or switched away from and back) while the agent was working showed only saved messages and none of the run in progress. Every event of the run in flight is now kept and replayed on reopen — streamed text, tool cards with their real start times, running command output, the run timer — and streaming continues from there. Approvals or questions still waiting reappear with working buttons; answered ones don't.
- **A Run's Stream Leaked Into Other Sessions** — Switching sessions mid-run rendered the running reply into the session now on screen, and could attach its "revert this prompt" link to the wrong message. Run events now only reach the session they belong to; other sessions just show the agent as busy.
- **`web_search` Reported "No Results" When Blocked** — DuckDuckGo increasingly answers automated requests with a bot check, which was returned as a successful empty search, so the agent concluded nothing existed online. It's now an error that says how to configure another backend or use the browser tool.
- **A Corrupt Line Emptied a Whole Session** — One unparsable line in `messages.jsonl` or a run transcript (e.g. from an interrupted write) made the entire history read as empty. Only that line is skipped now, with a warning; session store failures are logged instead of swallowed.
- **A Typo in `mcp.json` Could Wipe Its Servers** — An unreadable MCP config read as "no servers", and the next add/update rewrote the file with only the new entry. An unreadable file is now never overwritten, and the error is logged.
- **Site Schema Never Refreshed at Startup** — the startup schema load ran before the tool executor existed and always failed silently; it now runs once the executor is ready.

### Changed

- **Chat Panel Split Up** — `src/chat/panel.ts` (2,181 lines) is now a 280-line webview host. The agent run lives in `src/chat/runtime/` (orchestrator, loop, step, tool calls, verification, sub-agents, pipeline, streaming, prompt building, run limits); approvals, model settings, compaction, settings/auth, revert, checkpoints and attachments are separate modules in `src/chat/`. No file in `src/chat` exceeds 300 lines.
- Removed dead code flagged by lint (an unused bench-detection function and unused imports) and the stray `pdf-test.mjs` scratch script.

## [1.11.0] - 2026-10-06

### Added

- **Native Tool Calling** — Agents now call tools through each provider's function-calling API (Anthropic `tool_use`/`tool_result` blocks, OpenAI/OpenCode Zen `tool_calls` + `role: tool` messages) instead of hand-written `<tool_call>` XML. Every tool has a JSON schema (`src/agents/tools/schemas.ts`); arguments arrive typed, and malformed-tag retries no longer apply. Signed extended-thinking blocks are replayed on tool turns as Anthropic requires, and DeepSeek-style `reasoning_content` is echoed back in tool loops. Unanswered tool calls (e.g. after an abort) are patched with a synthetic result so the transcript stays valid. New setting `frappe-copilot.nativeToolCalling` (default on); the Claude Code provider and any model that rejects `tools` fall back to the XML protocol automatically.
- **Parallel Read-only Tools** — Consecutive read-only calls in one step (`read_file`, `grep_search`, `glob`, `list_dir`, `introspect_doctype`, `web_fetch`, …) run concurrently. Tool events carry a `callId` so each parallel call updates its own card in the chat UI.
- **`glob` Tool** — Find files by pattern (`**/doctype/*/*.json`), newest first.
- **`multi_edit` Tool** — Several search/replace edits to one file, applied atomically.
- **Background Commands** — `execute_command` takes `run_in_background` (for `bench start`, `bench watch`, dev servers) plus a `timeout`; new `command_output` and `kill_command` tools poll and stop them. Background processes are killed on extension deactivate.
- **Sub-agents (`task` tool)** — The main agent can delegate a self-contained brief to a sub-agent that runs in a fresh context and returns one report: a new read-only `explore` type (several run in parallel) or any specialist (DocType Builder, Server Logic, Client UI, DevOps, Research, Architecture, Design). Sub-agents can't ask the user, touch the todo list, or nest; their file edits join the parent run's checkpoint so revert still covers them, and each run's transcript is saved like any other.
- **Main Agent Frappe Essentials** — The default (general) agent now carries a compact Frappe playbook distilled from the specialists (scaffold first, introspect before changing DocTypes, customizations + export for standard DocTypes, migrate/tests after changes) plus delegation guidance, so it no longer depends on routing for domain knowledge. `multiAgent.enabled` routing is now documented as a legacy mode.
- **On-demand Context Tools** — `search_knowledge` (knowledge-base search) and `list_doctypes` (filterable site DocType list) replace injecting RAG results and the site's full DocType list (~11k+ chars on an ERPNext site) into every step's system prompt. The prompt now carries a one-line site summary; RAG is still injected for XML-protocol models, once per run instead of re-embedding every step.
- **Context-window-aware Budgeting** — Providers report real token usage (Anthropic `message_start`/`message_delta`, OpenAI `stream_options.include_usage`); the context badge shows the last call's real prompt size against the model's window (auto-detected from the model id, or `frappe-copilot.contextWindowTokens`). Past 60% of the window, older tool output and large already-applied write inputs in a run are cleared (newest kept); past 85%, only the newest is kept. Conversation compaction is offered at 50% of the window (or the explicit `compaction.thresholdTokens`) and runs automatically past 80%; the compaction call itself trims the transcript to fit.
- **Claude-style Chat UI** — Redesigned the chat webview after Claude desktop: assistant replies render as flat text and user messages as right-aligned bubbles (timeline dots removed); tool calls are compact one-line rows (status dot, name, key argument, duration) that expand on click; edits awaiting approval expand into a card with the diff and Approve/Reject; reasoning collapses into "Thought for Ns"; the composer is a rounded box with attach, approval mode, model picker, and a send/stop button; minimal header with a token badge (`23k / 200k`); simpler welcome screen with suggestion chips. Esc interrupts a running agent.
- **Live Model Picker** — A searchable model picker in the composer (keyboard navigable, newest models tagged "latest") with a **Refresh** button that pulls the current list from the provider API and shows when it was last fetched. Lists are cached per provider; the provider's configured model is selected by default. Anthropic now requests `/models?limit=1000` (previously only the first 20 came back) sorted newest first; OpenAI lists all chat-capable families (`gpt-*`, `o*`, `chatgpt-*`, newest first) and excludes embedding/audio/image models. Fallback lists include `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-fable-5-1`.
- **Run & Tool Timers** — A status line ("✻ Working · 1m 05s · Running command …  esc to interrupt") counts the whole prompt across steps, tools, and approvals instead of resetting every step, and leaves "Worked for 1m 05s" under the reply when the run ends. Each tool row shows a live duration while running (approval wait excluded) and its final time when done.
- **Skill Router** — The agent now knows when to load which skill (`src/agents/skillRules.ts`, `src/agents/skillRouter.ts`):
  - *Request-time selection* — every bundled skill has explicit trigger rules on top of its description, so a request can load several skills at once (e.g. "add a validation and run its tests" → `frappe-app-dev` + `frappe-testing-standards` + `code-style`), within a 40KB budget. `code-style` loads for any code-changing request, as its description asks; `ui-design` steps aside when `erpnextdesign` applies. User skills still match by description.
  - *Reference files* — the relevant `frappe-app-dev` references load alongside it (`controllers.md` for validations, `permissions.md` + `api.md` for a 403 on a whitelisted method, `background-jobs.md` for scheduled work…), at most two per skill.
  - *Mid-run hints* — when a tool call makes an unloaded skill relevant (editing `test_*.py` or running `run-tests`, `git commit`/`tag`/`push`, writing `docs/*.md`), the tool result ends with a one-line `[Skill hint]`. After 3+ failed commands or edits followed by a success, it suggests `capture-solutions`.
  - *Extension adapters* — `frappe-docker-bench` is told that `execute_command` already routes `bench …` into the container (no hand-written `docker exec`); `capture-solutions` saves to `.frappe-copilot/knowledge/` (indexed for `search_knowledge`) instead of `~/.claude`.
  - *Catalog* — "Available Skills" now says when each skill applies and marks those already loaded; the system prompt tells the agent to load a skill before moving into its area.
  - *UI* — loaded skills appear as one row of chips (reference files dashed) instead of a line per skill; hovering shows why each was loaded.
- **Effort Control** — An effort picker next to the model (Faster ↔ Smarter slider; low / medium / high / extra high / max, with the model's default marked "Recommended"; arrow keys and drag work). Saved in `frappe-copilot.effort` (empty = model default). Sent as `output_config.effort` to Claude (Anthropic and Claude Code providers), clamped to what each model supports (e.g. no `xhigh` on Sonnet/Opus 4.6, no effort on Haiku 4.5), and as `reasoning_effort` to OpenAI reasoning models (gpt-5, o-series). The picker hides for models without effort. Read-only `explore` sub-agents are capped at `medium`. Model capabilities live in `src/providers/modelCaps.ts`.
- **Message Queue** — Pressing Enter while the agent is working queues the message (shown above the composer, removable) instead of stopping the run; it's sent when the run finishes. Stop with the stop button or Esc.
- **"Always allow" on Approvals** — Approval cards add "Always allow", which skips further prompts for that tool until a new session.
- **Task List Rework** (`src/agents/todos.ts`):
  - *Stays in sync* — after 6 tool calls without a todo update while items are open, the next tool result carries a short reminder listing them. If the agent tries to finish with open items, it is sent back once to complete, cancel, or continue them.
  - *Survives stops* — when a run ends (stopped, errored, or finished) with items open, in-progress items return to pending and the list is marked unfinished. The next run starts with that list in its context, so the copilot picks it up or replaces it instead of forgetting it. A fully finished list is cleared when the next run starts.
  - *Persisted per session* in `.frappe-copilot/sessions/<id>/todos.json`, so it survives reloads and session switches.
  - *Structured tool input* — `update_todo_list` takes `todos: [{content, status, activeForm}]` (pending / in_progress / completed / cancelled) with Claude Code-style usage rules in its description; the old YAML `tasks` text and `- [x]` checklists are still accepted.
  - *New UI* — the boxed panel at the top of the chat is replaced by a compact card above the composer: progress ring, the current task (its present-tense form also drives the status line), "2 of 4", checkmarks with strike-through, collapsible. It hides once everything is done, and a run that ends with open items shows "Run ended with N open" with a **Clear** button.
- **"How to Work" System Prompt Section** — Explore before editing, keep a todo list for multi-step work, make focused changes in the surrounding style, verify with tests/migrate, and report failures honestly.

### Fixed

- **Current Claude Models Rejected the Anthropic Provider's Requests** — "Extended thinking" sent `thinking: {type: "enabled", budget_tokens}` and a default `temperature: 0.7`; both are 400s on Opus 5.5, Opus 5, Sonnet 5.x, Fable and Opus 4.7/4.8. Requests now use adaptive thinking (`display: "summarized"`, so thinking text actually streams) on 4.6+ models, budget thinking only on older ones, temperature only where accepted, and a 64K output ceiling for streamed agent steps. Small non-streaming helper calls (routing, compaction) on always-thinking models get room to think and `low` effort. The Claude Code provider had the same thinking bug and is fixed the same way. OpenAI reasoning models (gpt-5, o-series) no longer get a custom temperature.
- **Thinking Blocks Dropped or Edited** — The Anthropic provider dropped thinking blocks from history whenever the setting was off, though Opus 5.5 and Sonnet 5.x always think, and client-side trimming rewrote old tool results; current models reject tool turns with dropped or edited thinking. Thinking blocks are now always replayed, and old tool results are cleared server-side with context editing (`clear_tool_uses_20250919`, beta `context-management-2025-06-27`), falling back to client-side trimming only if an endpoint rejects it.
- **Site Tools Failed With "No default site configured"** — `introspect_doctype`, `list_customizations`, the `write_*` customization tools, `scaffold_doctype`, and post-run verification only used `defaultSite` from `.frappe-copilot/config.json`, which was only ever saved as a side effect of running a command from the bench-command picker. On a Docker bench the `sites/` folder isn't visible on the host either. A new `SiteResolver` (`src/bench/siteResolver.ts`) now falls back to asking the bench itself (inside the container for Docker): `sites/currentsite.txt`, then `default_site` in `common_site_config.json`, then the only site. It saves what it finds, strips the `* ` marker `bench list-sites` adds (some configs had `"* fieldforce.localhost"` saved), and explains what's wrong when it can't decide (several sites, container not running, no sites).
- **Site Schema Never Loaded** — the startup schema load ran `bench execute --command …`, a flag `bench execute` doesn't have, so `list_doctypes` and the prompt's site summary never had data. It now uses the same one-liner path as `introspect_doctype` (with a large internal output cap; the ~1,000 DocType names exceed the 15K tool-output cap), and `list_doctypes` retries the load if the bench wasn't up at startup.
- **`introspect_doctype` Lost Its Header on Big DocTypes** — pretty-printed meta for DocTypes like User or Sales Invoice exceeded the 15K output cap, and the cap keeps the tail, so the name/module/flags were cut. Output is now compact (one line per field, empty values dropped): User went from >15K truncated to 6.4K complete.
- **Wrong Context Window for Current Claude Models** — Opus 4.6+, Sonnet 4.6+, Sonnet 5.x, Opus 5.x and Fable were sized at 200K instead of 1M, so the token badge, compaction thresholds and tool-output clearing kicked in far too early.
- **Refusals Looked Like Empty Answers** — `stop_reason: "refusal"` now adds a visible note instead of silently ending the run.
- **Stopping a Run Could Hang It** — Stopping while an approval or clarification was pending left the run waiting forever; those now resolve as rejected/cancelled. Stop also kills a running foreground command (e.g. a long `bench migrate`) instead of leaving it running.
- **Claude Code Provider Rejected New Models** — The bundled `@anthropic-ai/claude-agent-sdk` (0.3.208) ships its own Claude Code 2.1.208, which refuses newer models like `claude-opus-5-5` ("version 2.1.280 or newer is required"); the CLI's suggested `claude update` can't fix it because the SDK never uses the system install. Upgraded the SDK to 0.3.291 (bundles Claude Code 2.1.291), added `frappe-copilot.claudeCode.executablePath` to run your own `claude` binary instead, and replaced that error with advice that matches the bundled-CLI setup.
- **Permanent Errors Retried Five Times** — The agent loop retried every stream error, including ones that can never succeed (unsupported model, bad credentials, invalid request, HTTP 400/401/403/404). Those now stop the run immediately with one clear error; overload, rate-limit and network errors still retry. A failed stream no longer leaves a duplicate error bubble next to the error message.

### Changed

- **Branding** — The chat UI uses Frappe Copilot's own logo (`assets/icon.svg`) and its blue/yellow palette throughout.
- **`read_file`** — Output is line-numbered (`cat -n` style) and pages with `offset`/`limit` (2000 lines per read) instead of refusing files over 150KB.
- **`edit_file` / `write_file`** — Refuse to modify a file the agent hasn't read, or one that changed on disk since its last read. `edit_file` gains `replace_all`, recovers from line-number prefixes and trailing-whitespace mismatches, preserves CRLF endings, and returns a numbered snippet of the result. Approval cards now show a diff for `edit_file` and `multi_edit`.
- **`grep_search`** — Regex search via ripgrep (VS Code's bundled binary, else `rg` on PATH, else a pure-JS fallback) with `path`, `glob`, `type`, `case_insensitive`, `context`, `head_limit`, and `output_mode` (`content` / `files_with_matches` / `count`); respects `.gitignore`. The old substring `query` argument still works.
- **`execute_command`** — Foreground commands time out after 20 minutes by default (whole process group is killed).
- Tool docs moved from `prompts.ts` to `src/agents/toolDocs.ts`; file/search/shell tools split out of `toolExecutor.ts` into `src/agents/tools/`.
- Session token estimates now count tool-call and tool-result payloads.
- Chat webview keeps per-stream state, so parallel sub-agent replies stream into separate bubbles; stream errors now render in the failed bubble (previously a no-op).

## [1.10.0] - 2026-09-21

### Added

- **Secondary Side Bar (Agent Panel) Integration** — Registered `ChatPanel` as a `WebviewViewProvider` (`frappe-copilot.agentChat`) docked in the secondary side bar (`frappe-copilot-agent`), allowing Frappe Copilot to run as an embedded agent side panel with `retainContextWhenHidden: true`.
- **Open Chat in Editor Tab** — Added command `frappe-copilot.openChatInTab` and header icon (`$(link-external)`) to easily pop out or reveal the chat in an editor tab column (`ViewColumn.Two`).
- **Global Keybinding & Toggle Behavior** — Bound `Ctrl+Alt+B` (`Cmd+Alt+B` on macOS) to `frappe-copilot.start`. Triggering it toggles the auxiliary side bar closed when already focused, or focuses the agent panel when hidden.
- **View Title Bar Quick Actions** — Added "New Session" (`$(add)`) and "Open Chat in Editor Tab" buttons directly to the secondary sidebar header.

## [1.9.2] - 2026-09-03

### Fixed

- **Thought Process Panel Rendered as an Unformatted Text Block** — The reasoning/thought panel in `assets/webview/chat.html` set the streamed content via `element.textContent` under `white-space: pre-wrap`, so `#`/`-`/`**bold**` markers were never converted to real markup — unlike the main answer bubble, which already runs the same text through the existing `md()` markdown-to-HTML renderer. Reasoning is now rendered through `md()` too (both mid-stream and on completion), and `.thought-body` gets its own heading/paragraph/list spacing (14px above headings, 10px paragraph gaps, 5–6px list-item spacing) instead of inheriting the tighter defaults tuned for regular chat bubbles, so multi-section reasoning summaries read as a structured document instead of a dense wall of text.
- **`introspect_doctype` Missing from the Research / Read-only Agent** — `src/agents/definitions/research.ts`'s `allowedTools` omitted `introspect_doctype` and `list_customizations`, even though both are pure reads (`frappe.get_meta()` / `frappe.get_all()`, no writes) already whitelisted for every other specialist agent (`architecture`, `serverLogic`, `devopsDebug`, `doctypeBuilder`, `clientUi`). Any DocType-introspection request routed to Research fell back to grepping and reading the raw DocType JSON by hand, missing live Custom Fields/Property Setters the JSON source doesn't contain. Added both tools to the allowlist and a prompt line telling the agent to prefer them over manual file reads.

## [1.9.1] - 2026-08-13

### Fixed

- **Response Truncation & Token Budget Guardrails** — Resolved premature output cutting on large reasoning or code generation steps:
  - Increased `ChatPanel` streaming `maxTokens` step ceiling from `8,192` to `16,384`.
  - Updated OpenCode Zen provider default `max_tokens` from `4,096` to `8,192`.
  - Re-allocated Anthropic provider token limits when extended thinking is enabled, reserving `thinkingBudgetTokens + 8,192` (minimum `16,384` total) so extended thinking does not exhaust the available completion tokens.

## [1.9.0] - 2026-08-12

### Added

- **Unified Knowledge Base & Vector Store Engine** — Re-architected `VectorStore` into a comprehensive project-wide retrieval engine:
  - Multi-source indexing across framework docs, templates, workspace code (`.py`, `.js`, `.json`), user notes (`.frappe-copilot/knowledge`), developer skills, and cross-agent memory (`.devmind/memory`).
  - Added `.frappe-copilot/knowledge/` directory auto-seeding with `README.md`.
  - Incremental, hash-based indexing per document so unchanged files bypass re-embedding.
  - Automatic workspace file-system watcher to auto-resync the knowledge base index on file changes.
  - Hybrid search algorithm combining vector embeddings cosine similarity with term overlap lexical scoring.

## [1.8.3] - 2026-08-12

### Added

- **Live Streaming Command Output in Chat UI** — Extended `ToolExecutor.executeCommand` with stdout/stderr chunk callbacks via `child_process.spawn`. `execute_command` tool calls and `self-verify` loops now stream long-running command output (e.g. `bench migrate`, `bench run-tests`, `bench build`) directly into the chat UI in real time instead of leaving the tool card silent until completion.

### Fixed

- **Panel Webview View Provider Refactor & Fixes** — Restored proper secondary column layout (`ViewColumn.Two`) for `ChatPanel` webview, removed dead `webviewView` references, and improved error handling during command execution.

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
