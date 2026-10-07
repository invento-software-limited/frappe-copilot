import { SkillsStore } from './skillsStore';
import { SKILL_RULES, SkillRule, CODE_CHANGE, ToolCallInfo } from './skillRules';

export interface SkillPick {
  /** Skill id, or '<skill>/<reference path>' for an attached reference file. */
  id: string;
  name: string;
  reason: string;
  content: string;
  /** The user asked for this skill (picked with "/" or named it). */
  requested?: boolean;
}

/** Skills the agent has loaded or been pointed at during one run. */
export class RunSkillState {
  readonly loaded = new Set<string>();
  readonly hinted = new Set<string>();
  failures = 0;
}

const MAX_SKILLS = 4;
const MAX_REFS_PER_SKILL = 2;
const MAX_CONTEXT_CHARS = 40_000;
const STRUGGLE_FAILURES = 3;
const CAPTURE_SKILL = 'capture-solutions';

/** Decides which skills a request needs, which reference files to attach,
 *  and when a tool call mid-run makes another skill relevant. Bundled skills
 *  route by explicit rules (skillRules.ts); user skills by description. */
export class SkillRouter {
  private rules = new Map<string, SkillRule>(SKILL_RULES.map(r => [r.id, r]));

  constructor(private store: SkillsStore) {}

  /** Skills to preload for a request, most specific first, within a size budget. */
  selectForRequest(message: string, requested: string[] = []): SkillPick[] {
    const available = new Map(this.store.listSkills().map(s => [s.id, s]));
    const asked = [...new Set([...requested, ...this.mentionedIn(message)])].filter(id => available.has(id));
    const chosen: { id: string; reason: string }[] = [];
    const add = (id: string, reason: string) => {
      if (available.has(id) && !chosen.some(c => c.id === id) && !asked.includes(id)) chosen.push({ id, reason });
    };

    for (const rule of SKILL_RULES) {
      const m = !rule.manualOnly && rule.triggers ? message.match(rule.triggers) : null;
      if (m) add(rule.id, `request mentions "${m[0]}"`);
    }
    for (const meta of this.store.suggestSkills(message, 2)) {
      if (!this.rules.has(meta.id)) add(meta.id, 'matches its description');
    }
    if (CODE_CHANGE.test(message)) {
      for (const rule of SKILL_RULES) if (rule.withCodeChanges) add(rule.id, 'request changes code');
    }

    const ids = new Set([...asked, ...chosen.map(c => c.id)]);
    const kept = chosen
      .filter(c => !(this.rules.get(c.id)?.yieldsTo || []).some(other => ids.has(other)))
      .slice(0, Math.max(0, MAX_SKILLS - asked.length));
    const askedPicks = asked.map(id => ({ id, reason: 'you asked for it', requested: true }));
    return this.loadWithReferences([...askedPicks, ...kept], message, available);
  }

  /** Skill ids the message names outright — "use frappe-report-dashboard-builder"
   *  or "/frappe-report-dashboard-builder" — matched as whole words. */
  mentionedIn(message: string): string[] {
    const text = message.toLowerCase();
    return this.store.listSkills()
      .map(s => s.id)
      .filter(id => id.length >= 4 && new RegExp(`(^|[^\\w-])/?${escapeRegExp(id.toLowerCase())}($|[^\\w-])`).test(text));
  }

  /** Called after every tool call. Returns a one-line hint to append to the
   *  tool result when the call makes an unloaded skill relevant. */
  observe(call: ToolCallInfo, state: RunSkillState): string | null {
    if (call.tool === 'use_skill' && call.success && typeof call.args.id === 'string') {
      state.loaded.add(call.args.id);
    }
    const hint = this.toolHint(call, state) || this.struggleHint(call, state);
    if (hint) state.hinted.add(hint.id);
    return hint ? `\n\n[Skill hint] ${hint.reason} — the '${hint.id}' skill covers this (${this.whenFor(hint.id)}). Load it with use_skill before continuing.` : null;
  }

  /** Extension-specific note appended whenever a skill is loaded. */
  adapterFor(id: string): string {
    const adapter = this.rules.get(id)?.adapter;
    return adapter ? `\n\n---\n${adapter}` : '';
  }

  /** "Available Skills" listing with when-to-load guidance for each. */
  buildCatalog(preloaded: ReadonlySet<string>): string {
    return this.store.listSkills()
      .map(s => `- ${s.id}${preloaded.has(s.id) ? ' (already loaded below)' : ''}: load when ${this.whenFor(s.id)}`)
      .join('\n');
  }

  private loadWithReferences(
    picks: { id: string; reason: string; requested?: boolean }[],
    message: string,
    available: Map<string, { name: string }>
  ): SkillPick[] {
    const out: SkillPick[] = [];
    let budget = MAX_CONTEXT_CHARS;
    // A skill the user asked for always loads, even past the budget.
    const take = (id: string, name: string, reason: string, raw: string | null, requested = false) => {
      if (!raw || raw.startsWith('Error:') || (raw.length > budget && !requested)) return false;
      budget = Math.max(0, budget - raw.length);
      out.push({ id, name, reason, content: raw, ...(requested ? { requested } : {}) });
      return true;
    };

    for (const p of picks) {
      const name = available.get(p.id)?.name || p.id;
      if (!take(p.id, name, p.reason, this.withAdapter(p.id, this.store.readSkill(p.id)), p.requested)) continue;
      const refs = (this.rules.get(p.id)?.references || []).filter(r => r.triggers.test(message)).slice(0, MAX_REFS_PER_SKILL);
      for (const ref of refs) {
        const refId = `${p.id}/${ref.file}`;
        take(refId, refId, `reference for ${p.id}`, this.store.readSkill(refId));
      }
    }
    return out;
  }

  private toolHint(call: ToolCallInfo, state: RunSkillState): { id: string; reason: string } | null {
    if (!call.success) return null;
    for (const rule of SKILL_RULES) {
      if (!rule.toolTrigger || this.seen(rule.id, state) || !this.exists(rule.id)) continue;
      const reason = rule.toolTrigger(call);
      if (reason) return { id: rule.id, reason: capitalize(reason) };
    }
    return null;
  }

  /** After several failed commands/edits, a success means a fix worth saving. */
  private struggleHint(call: ToolCallInfo, state: RunSkillState): { id: string; reason: string } | null {
    const effortful = ['execute_command', 'edit_file', 'multi_edit', 'write_file'].includes(call.tool);
    if (!effortful) return null;
    if (!call.success) {
      state.failures++;
      return null;
    }
    if (state.failures < STRUGGLE_FAILURES || this.seen(CAPTURE_SKILL, state) || !this.exists(CAPTURE_SKILL)) return null;
    return { id: CAPTURE_SKILL, reason: `That worked after ${state.failures} failed attempts` };
  }

  private whenFor(id: string): string {
    const rule = this.rules.get(id);
    if (rule) return rule.when;
    const meta = this.store.listSkills().find(s => s.id === id);
    return (meta?.description || meta?.name || id).replace(/\s+/g, ' ').trim();
  }

  private withAdapter(id: string, content: string | null): string | null {
    return content ? content + this.adapterFor(id) : content;
  }

  private seen(id: string, state: RunSkillState): boolean {
    return state.loaded.has(id) || state.hinted.has(id);
  }

  private exists(id: string): boolean {
    return this.store.listSkills().some(s => s.id === id);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
