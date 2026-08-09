import * as fs from 'fs';
import * as path from 'path';
import { getFrappeCopilotPath } from '../workspace/structure';

/** A plan durably written to .frappe-copilot/plans/ — see writePlanFile.
 *  `relPath` is workspace-relative (forward-slashed) for display in chat;
 *  `absPath` is what file operations (read/append) actually use. */
export interface PlanRecord {
  fileName: string;
  relPath: string;
  absPath: string;
}

export interface PipelineStagePlan {
  agentId: string;
  label: string;
  task: string;
}

interface WritePlanOptionsBase {
  title: string;
  sessionId: string;
  sessionName: string;
  promptId?: string;
}

type WritePlanOptions =
  | (WritePlanOptionsBase & { kind: 'pipeline'; stages: PipelineStagePlan[] })
  | (WritePlanOptionsBase & { kind: 'architecture'; body: string });

function slugify(text: string, maxLen = 50): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'plan').slice(0, maxLen);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Each stage is preceded by a `<!-- stage:N -->` marker so a user comment
 *  added under it can be tied back to that exact stage — see
 *  parsePlanComments(). The instructions block is written into the file
 *  itself (not just shown in the UI) since this is a plain .md file the user
 *  may come back to and edit directly, without the chat panel open. */
function renderPipelinePlan(opts: WritePlanOptionsBase & { stages: PipelineStagePlan[] }, revision = 0): string {
  const stagesMd = opts.stages
    .map((s, i) => `<!-- stage:${i} -->\n${i + 1}. **${s.label}** (\`${s.agentId}\`) — ${s.task}`)
    .join('\n');
  const revisionLine = revision > 0 ? `- Revision: ${revision}\n` : '';
  return `# Plan: ${opts.title}\n\n` +
    `- Session: ${opts.sessionName} (\`${opts.sessionId}\`)\n` +
    `- Created: ${new Date().toISOString()}\n` +
    revisionLine +
    `- Status: pending approval\n\n` +
    `## Stages\n${stagesMd}\n\n` +
    `## How to request changes\n` +
    `To ask Copilot to revise a specific stage, add a line directly below it starting with ` +
    `\`COMMENT:\` (e.g. \`COMMENT: also add a permission check for the HR Manager role\`), ` +
    `save this file, then click **Revise from comments** on the plan card in the chat panel.\n`;
}

function renderArchitecturePlan(opts: WritePlanOptionsBase & { body: string }): string {
  return `# Plan: ${opts.title}\n\n` +
    `- Session: ${opts.sessionName} (\`${opts.sessionId}\`)\n` +
    `- Created: ${new Date().toISOString()}\n\n` +
    `${opts.body}\n`;
}

/** Writes a plan to .frappe-copilot/plans/<timestamp>-<slug>.md (creating the
 *  directory lazily so it works for workspaces initialized before this
 *  feature existed too, not just freshly-initialized ones). Returns null if
 *  no workspace is open — the caller should degrade gracefully (skip the
 *  file link, don't block execution on it) rather than fail the whole run
 *  over a missing durable record. */
export function writePlanFile(opts: WritePlanOptions): PlanRecord | null {
  const fcPath = getFrappeCopilotPath();
  if (!fcPath) return null;

  const plansDir = path.join(fcPath, 'plans');
  if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });

  const fileName = `${timestamp()}-${slugify(opts.title)}.md`;
  const absPath = path.join(plansDir, fileName);
  const workspaceRoot = path.dirname(fcPath);
  const relPath = path.relative(workspaceRoot, absPath).split(path.sep).join('/');

  const body = opts.kind === 'pipeline' ? renderPipelinePlan(opts) : renderArchitecturePlan(opts);

  try {
    fs.writeFileSync(absPath, body, 'utf-8');
  } catch {
    return null;
  }
  return { fileName, relPath, absPath };
}

/** Rewrites an already-written pipeline plan file in place with a new stage
 *  list (same path — a revision is a correction to the same plan, not a new
 *  one) and bumps the revision counter shown in the file. Used by the
 *  "Revise from comments" flow once the model has produced updated stages
 *  from the user's `COMMENT:` lines. */
export function updatePlanFile(record: PlanRecord, opts: WritePlanOptionsBase & { stages: PipelineStagePlan[] }, revision: number): void {
  const body = renderPipelinePlan(opts, revision);
  try {
    fs.writeFileSync(record.absPath, body, 'utf-8');
  } catch {
    // Best-effort — the in-memory stage list (what actually drives execution)
    // is already updated regardless of whether the file rewrite succeeds.
  }
}

/** A user's `COMMENT:` line tied back to the stage it was written under
 *  (see the `<!-- stage:N -->` markers renderPipelinePlan emits). */
export interface PlanComment {
  stageIndex: number;
  comment: string;
}

/** Reads a pipeline plan file back off disk and collects every `COMMENT:`
 *  line, associating each with the nearest preceding `<!-- stage:N -->`
 *  marker. A comment typed above the first marker or with no marker at all
 *  is dropped rather than guessed at — silently misattributing feedback to
 *  the wrong stage would be worse than ignoring it. */
export function parsePlanComments(absPath: string): PlanComment[] {
  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }

  const comments: PlanComment[] = [];
  let currentStage: number | null = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const stageMatch = line.match(/^<!--\s*stage:(\d+)\s*-->$/);
    if (stageMatch) {
      currentStage = Number(stageMatch[1]);
      continue;
    }
    const commentMatch = line.match(/^(?:>\s*)?COMMENT:\s*(.+)$/i);
    if (commentMatch && currentStage !== null) {
      comments.push({ stageIndex: currentStage, comment: commentMatch[1].trim() });
    }
    // A blank "## " heading line ends the Stages section — stop attributing
    // stray COMMENT: lines below it (e.g. one accidentally left under "How
    // to request changes") to whatever stage happened to be last.
    if (line.startsWith('## ') && line !== '## Stages') {
      currentStage = null;
    }
  }
  return comments;
}

/** Records the user's approve/reject decision on a pipeline plan by rewriting
 *  its "Status: pending approval" line (falls back to appending a decision
 *  block if that line is somehow missing, so this never throws away the
 *  decision over a format mismatch). */
export function appendPlanDecision(absPath: string, decision: 'approved' | 'rejected'): void {
  try {
    let content = fs.readFileSync(absPath, 'utf-8');
    const stamp = new Date().toISOString();
    if (content.includes('- Status: pending approval')) {
      content = content.replace('- Status: pending approval', `- Status: ${decision} (${stamp})`);
    } else {
      content += `\n\n---\nDecision: ${decision} (${stamp})\n`;
    }
    fs.writeFileSync(absPath, content, 'utf-8');
  } catch {
    // Best-effort — a filesystem hiccup here shouldn't block the actual
    // approve/reject flow, only the durability of its record.
  }
}

/** Strips markdown/code-mention noise from a user message (or a plan title
 *  candidate) down to a short, presentable label. Shared by plan titling and
 *  session auto-naming, which both need the same cleanup. */
export function deriveTitle(text: string, maxLen = 60): string {
  let firstLine = text.split('\n')[0].trim();
  const mentionIdx = firstLine.indexOf('### Code Mention:');
  if (mentionIdx !== -1) {
    firstLine = firstLine.substring(0, mentionIdx).trim();
  }
  firstLine = firstLine.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  firstLine = firstLine.replace(/[*_`#]/g, '').trim();
  if (!firstLine) firstLine = 'plan';
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + '...' : firstLine;
}
