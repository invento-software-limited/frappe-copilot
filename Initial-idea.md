# Frappe Copilot — VS Code Extension Architecture

A multi-provider, agentic VS Code extension that turns raw requirements (prompts, PDFs, prototypes, screenshots) into a structured Frappe app development pipeline: requirement analysis → brainstorming → Epic/Story/Feature/Task documentation → parallel agent-driven code generation → bench execution → validation.

---

## 1. Design goals

- **Provider-agnostic**: swap between Anthropic, OpenAI, Azure OpenAI, Google, or local models (Ollama) per role, not just globally.
- **Multi-modal intake**: accept a PDF spec, a Figma/prototype export, screenshots, or a one-line prompt, and normalize them into a single requirement representation.
- **Human-in-the-loop planning**: the extension asks clarifying questions before committing to a plan — it doesn't just guess.
- **Traceable documentation**: every piece of generated code should be traceable back to a Task → Feature → Story → Epic, stored as readable markdown in the repo, not hidden in a chat log.
- **Deep Frappe awareness**: the assistant should know Frappe's conventions (DocTypes, hooks, controllers, client scripts, permissions, bench CLI, migrations) well enough to generate idiomatic code, not generic Python/JS.
- **Agent specialization**: one large "do everything" agent produces mediocre code. Narrow, tool-scoped agents per artifact type produce better, more reviewable output.
- **Safety**: nothing destructive (migrate, drop, delete) runs without explicit confirmation; API keys never touch plaintext settings.

---

## 2. Layered overview

| Layer                                                | Responsibility                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Presentation** (VS Code extension host + Webviews) | Chat UI, document tree, diff/approval UI, settings, terminal integration                   |
| **Orchestration core**                               | Intake normalization, clarification loop, planning, task graph, agent dispatch             |
| **Agent layer**                                      | Specialized LLM-driven workers, one per Frappe artifact type                               |
| **Knowledge layer**                                  | RAG store of Frappe/ERPNext docs + live introspection of the current bench/site            |
| **Execution layer**                                  | Bench CLI / `bench console` bridge, file writer, sandboxed command runner                  |
| **Provider gateway**                                 | Unified LLM interface abstracting Anthropic/OpenAI/local providers, per-role model routing |
| **Storage**                                          | Workspace-local docs, task state, embeddings, secrets                                      |

---

## 3. Component breakdown

### 3.1 VS Code extension (presentation layer)

- **Activation**: detects a Frappe bench workspace (`apps/`, `sites/`, `Procfile`, `apps.txt`) and activates bench-aware features; otherwise runs in "new app" mode.
- **Chat/brainstorm panel** (Webview): conversational surface for intake, clarification, and iterative refinement — reuses the same panel across the whole pipeline so context isn't lost.
- **Intake panel**: drag-and-drop for PDFs/images, a "paste prototype link" field, and a free-text prompt box. Multiple inputs can be combined into one requirement session.
- **Docs tree view**: a custom Tree View mirroring `Epic → Story → Feature → Task`, backed by the markdown files on disk, with status badges (Draft / Approved / In Progress / Done / Failed).
- **Task detail + diff view**: clicking a task opens its spec plus a diff view of agent-proposed file changes (VS Code's native diff editor), with Approve / Request changes / Regenerate actions.
- **Terminal integration**: agents that need to run `bench` commands do so through a dedicated VS Code terminal (or pseudo-terminal API) so the user always sees exactly what ran.
- **Settings UI**: provider selection per agent role, model choice, cost/budget caps, RAG source management.
- **Secrets**: all provider API keys stored via `vscode.SecretStorage`, never in `settings.json`.

### 3.2 Intake & requirement analyzer

- Normalizes heterogeneous input into a single `RequirementDraft` object:
  - PDFs → text + layout extraction (tables, headings) via a PDF parser; images embedded in the PDF go through vision.
  - Prototype images/screenshots → vision-model description (layout, components, implied data fields) — this is where a vision-capable provider matters.
  - Free-text prompts → used as-is, merged with any uploaded material.
- Runs a **gap analysis**: compares the draft against a checklist of what a Frappe app spec needs (DocTypes and fields, relationships, permissions/roles, workflows, reports, integrations, UI customizations) and flags missing pieces.
- Produces a first-pass **PRD-lite** document plus a list of open questions.

### 3.3 Brainstorming / clarification agent

- Surfaces the open questions from the gap analysis as a conversational back-and-forth in the chat panel (not a giant form).
- Proposes trade-offs where relevant (e.g., "should approvals be a Workflow or a custom status field with permission rules?") rather than silently picking one.
- Loop continues until the user explicitly approves the requirement doc, or explicitly says "proceed with assumptions" — at which point assumptions are written into the doc so they're auditable later.

### 3.4 Planning engine (Epic → Story → Feature → Task)

- Decomposes the approved requirement doc into a hierarchy, each level a markdown file with YAML front-matter for structured fields (see §4 data model):
  - **Epic**: a business capability (e.g., "Vendor management").
  - **Story**: a user-facing outcome within the epic (e.g., "As a purchase manager, I can approve vendor onboarding").
  - **Feature**: a technical slice of a story (e.g., "Vendor Approval workflow", "Vendor DocType + validations").
  - **Task**: an atomic, agent-executable unit (e.g., "Create `Vendor` DocType with fields X/Y/Z", "Add `validate()` hook enforcing unique GSTIN").
- Each Task is tagged with an **artifact type** (DocType, Server Script, Client Script, Report, Workflow, Permission Rule, API Endpoint, Page/UI, Patch/Migration, Test) — this tag is what routes it to the right specialist agent.
- Tasks declare dependencies (`depends_on: [task-ids]`) so the orchestrator can build a DAG and parallelize independent work.

### 3.5 Agent orchestrator

- Walks the task DAG, dispatches ready tasks (no pending dependencies) to the matching specialist agent, and tracks status.
- Runs a configurable number of agents **in parallel** (default: capped by provider rate limits), each in an isolated context so unrelated tasks don't pollute each other's prompts.
- On agent failure or a failing bench command, retries with the error appended to context (bounded retry count) before flagging for human review.
- Emits progress events consumed by the Docs Tree view and status bar.

### 3.6 Specialist agent roster

Each agent is a narrow system prompt + a curated toolset + relevant RAG context, not a generic "write code" call.

| Agent                      | Scope                                                                                | Key tools                                        |
| -------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| **DocType agent**          | Generates/edits `doctype.json`, naming series, fields, child tables                  | File writer, RAG (DocType schema conventions)    |
| **Server script agent**    | Python controller logic (`validate`, `on_submit`, hooks, whitelisted methods)        | File writer, bench console (dry-run)             |
| **Client script agent**    | Form scripts, client-side validations, custom buttons                                | File writer, RAG (Frappe JS API)                 |
| **Workflow agent**         | Workflow States/Actions, permission-based transitions                                | File writer, RAG (Workflow doctype conventions)  |
| **Permission agent**       | Role Permission Manager rules, `permission_query_conditions`, `has_permission` hooks | File writer                                      |
| **Report/Dashboard agent** | Query Reports, Script Reports, Dashboard Charts                                      | File writer                                      |
| **API/Integration agent**  | REST endpoints, `frappe.whitelist()` methods, external integrations                  | File writer, web fetch (for 3rd-party API docs)  |
| **UI/Desk agent**          | Custom Pages, Web Forms, Portal pages, list/form view customization                  | File writer                                      |
| **Migration/patch agent**  | `patches.txt` entries, data migration scripts                                        | File writer, bench console                       |
| **Test agent**             | Frappe test cases (`FrappeTestCase`), fixtures                                       | File writer, bench execution (`bench run-tests`) |

Agents write files directly into the app's module structure, then request execution (see 3.7) rather than executing commands themselves — keeping a clean separation between "propose" and "apply."

### 3.7 Execution layer (bench bridge)

- A thin service that translates an agent's intent (e.g., "create DocType X", "run migrations", "run tests for module Y") into actual `bench` / `frappe` console commands, executed in the VS Code integrated terminal or a pseudo-terminal.
- **Safe by default**: read-only and additive commands (`bench console` introspection, `bench run-tests`, `bench build`) run automatically; destructive or state-changing ones (`bench migrate`, `bench --site x reinstall`, deleting DocTypes) require an explicit user confirmation dialog.
- Captures stdout/stderr and feeds errors back into the originating agent's context for a self-correction pass.
- Detects the active site/bench automatically from the workspace, but lets the user pick when multiple sites exist.

### 3.8 Frappe knowledge base (RAG)

Two complementary sources:

1. **Static corpus**: Frappe/ERPNext framework docs, bench CLI reference, hooks.py reference, ORM patterns (`frappe.get_doc`, `frappe.db.*`), DocType JSON schema, REST API reference — chunked and embedded once, shipped or built on first run.
2. **Live introspection**: on demand, queries the actual bench (`bench console` or REST) for the current site's existing DocTypes, custom fields, and installed apps, so generated code stays consistent with what's already there rather than guessing or duplicating.

Retrieval is scoped per agent role — a Permission agent pulls permission-system docs, a Report agent pulls Query Report examples, etc. — to keep prompts small and relevant.

### 3.9 LLM provider gateway

- Single interface: `complete(role, messages, tools?) → response`, `embed(text) → vector`, `vision(image, prompt) → response`.
- Adapters for Anthropic, OpenAI/Azure OpenAI, Google Gemini, and local models via Ollama — added as pluggable modules so new providers don't touch orchestration code.
- **Per-role model routing**: e.g., planning/brainstorming uses a stronger reasoning model, boilerplate DocType generation uses a cheaper/faster one, vision tasks route to a vision-capable model regardless of the default provider.
- Centralized cost/token tracking with a configurable budget cap per session.

### 3.10 Storage & state

- Everything lives in the workspace by default so it's reviewable and diffable in git — no hidden server-side state required for a single-developer setup:
  - `.frappe-copilot/docs/` — Epic/Story/Feature/Task markdown files.
  - `.frappe-copilot/state/tasks.db` — SQLite task DAG + status + agent logs.
  - `.frappe-copilot/rag/` — local vector store (e.g., SQLite + `sqlite-vec`, or a lightweight embedded vector DB) for the knowledge base and project-specific embeddings.
  - `.frappe-copilot/uploads/` — original PDFs/images the requirement was built from.

---

## 4. Data model (sketch)

```yaml
# Epic (.frappe-copilot/docs/epics/EPIC-001.md front-matter)
id: EPIC-001
title: Vendor management
status: approved         # draft | approved | in_progress | done
owner_agent: null
stories: [STORY-001, STORY-002]

# Story
id: STORY-001
epic: EPIC-001
title: As a purchase manager, I can approve vendor onboarding
acceptance_criteria:
  - Vendor cannot be used in a PO until approved
features: [FEAT-001]

# Feature
id: FEAT-001
story: STORY-001
title: Vendor Approval workflow
tasks: [TASK-001, TASK-002, TASK-003]

# Task
id: TASK-001
feature: FEAT-001
artifact_type: doctype        # doctype | server_script | client_script | workflow | permission | report | api | ui | patch | test
title: Create Vendor DocType
status: pending                # pending | in_progress | needs_review | approved | failed
depends_on: []
assigned_agent: doctype_agent
generated_files: []
notes: ""
```

---

## 5. End-to-end workflow

1. **Intake** — user drops a PDF/prototype/prompt into the panel.
2. **Analysis** — requirement analyzer extracts a draft PRD + gap list.
3. **Clarify** — brainstorming agent asks targeted questions in chat until the user approves.
4. **Plan** — planning engine writes Epic/Story/Feature/Task markdown files into `.frappe-copilot/docs/`.
5. **Review plan** — user reviews/edits the task tree before generation starts (can reorder, merge, split, or delete tasks).
6. **Dispatch** — orchestrator builds the task DAG, sends ready tasks to specialist agents in parallel, each grounded with RAG context + live site introspection.
7. **Generate** — each agent proposes file changes; shown as a diff for approval (or auto-applied if the user has enabled auto-approve for low-risk artifact types).
8. **Execute** — approved changes trigger the relevant bench commands (migrate, install app, run tests) through the execution layer, with confirmation for destructive ones.
9. **Validate** — test agent runs `bench run-tests` for touched modules; failures loop back to the originating agent with the error attached.
10. **Done** — task marked complete, docs tree updates, next dependent tasks unlock.

---

## 6. Suggested tech stack

| Concern            | Recommendation                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Extension host     | TypeScript, VS Code Extension API                                                                                                  |
| Webviews           | React (chat panel, docs tree detail, diff approval UI)                                                                             |
| Orchestration core | Node.js, runs inside the extension host process (no separate server needed for local/solo use)                                     |
| Task state         | SQLite (via `better-sqlite3` or `sql.js`)                                                                                          |
| Vector store       | `sqlite-vec` or `vectra` (pure-JS, no external service) for local RAG                                                              |
| PDF parsing        | `pdf-parse` / `pdfjs-dist` for text, render-to-image + vision model for layout-heavy pages                                         |
| Bench bridge       | Child process spawning `bench`/`frappe` CLI in the workspace's Python venv, or VS Code `Pseudoterminal` API for a visible terminal |
| Provider SDKs      | Official Anthropic/OpenAI SDKs behind the gateway interface; Ollama via local HTTP for offline use                                 |
| Secrets            | `vscode.SecretStorage`                                                                                                             |

If you later want multi-developer/team collaboration (shared task boards, shared agent runs), the orchestration core can be extracted into a small local or cloud backend service that multiple VS Code clients talk to — but that's not required for a single-developer MVP.

---

## 7. Security & safety notes

- Destructive bench commands (`migrate`, `reinstall`, `drop-site`, DocType deletion) always require explicit confirmation, shown with the exact command that will run.
- API keys live only in `SecretStorage`; never written to `.frappe-copilot/` (which is expected to be git-committed for doc traceability).
- Generated code is never silently applied — it always passes through the diff/approval UI unless the user opts into auto-approve for specific, low-risk artifact types (e.g., test files).
- Cost/token budget caps prevent runaway multi-agent runs from an unbounded bill.

---

## 8. Phased roadmap

**MVP**

- Single-provider (pick one, e.g., Anthropic) chat + prompt-only intake (no PDF/image yet).
- Manual Epic/Story/Task doc generation, no parallel agents — one agent handles all artifact types sequentially.
- Direct file writes + manual `bench migrate` (no automated execution layer yet).

**V1**

- Multi-provider gateway with per-role routing.
- PDF + image intake with vision-based analysis.
- Specialist agents per artifact type, running in parallel with a real task DAG.
- Bench execution bridge with confirmation gates.
- Local RAG over Frappe docs.

**V2**

- Live site introspection for context grounding.
- Auto-approve rules, cost budgeting, richer diff/review UX.
- Optional shared backend for team-based multi-user workflows.

---

## 9. Open decisions worth pinning down early

- **Execution autonomy**: do agents get to run `bench migrate`/tests autonomously (with logging), or is every command gated behind a click? This materially changes the execution-layer design.
- **Single-developer vs. team**: if multiple people will use this against a shared bench, you'll want the backend extracted out of the extension host sooner rather than later.
- **Provider defaults & budget**: which provider is the default for each agent role, and what's an acceptable per-session cost ceiling?
- **Existing app vs. new app**: does the MVP need to handle "customize an existing Frappe app" (introspect + extend) as well as "scaffold a new app from scratch," or can V1 focus on one?
