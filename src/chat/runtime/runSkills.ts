import { SkillRouter, SkillPick, RunSkillState } from '../../agents/skillRouter';
import { SkillsStore } from '../../agents/skillsStore';
import { ChatUi } from '../chatUi';

/** Which skills a run has loaded: the ones auto-picked for the request at its
 *  start (kept in the system prompt so it stays cache-stable across steps)
 *  and the ones the agent loads or is pointed at along the way. */
export class RunSkills {
  /** Auto-selected skill content for the run in flight. */
  context = '';
  private state = new RunSkillState();
  private preloaded: ReadonlySet<string> = new Set();

  constructor(private router: SkillRouter | null, private store: SkillsStore | null, private ui: ChatUi) {}

  /** Preloads the skills (and relevant reference files) this request needs
   *  and announces each in the chat. */
  begin(userMessage: string): void {
    this.state = new RunSkillState();
    this.preloaded = new Set();
    this.context = this.pick(userMessage);
  }

  /** Catalog section for the system prompt, or '' with no skills library. */
  catalogSection(): string {
    const catalog = this.router?.buildCatalog(this.preloaded);
    if (!catalog) return '';
    return `\n\n### Available Skills\nEach line says when the skill applies. Before starting work of a kind listed here, load the matching skill with 'use_skill' (unless it is already loaded below); a skill may list reference files — load only the ones your task needs:\n\n${catalog}`;
  }

  /** Extra tool output after a call: the adapter for a skill just loaded,
   *  and a hint at a skill the call made relevant. */
  afterToolCall(tool: string, args: Record<string, any>, success: boolean): string {
    let extra = '';
    if (success && tool === 'use_skill' && args.id) {
      const meta = this.store?.listSkills().find(s => s.id === args.id);
      this.ui.say('skillEvent', { kind: 'loaded', id: args.id, name: meta?.name || args.id, auto: false });
      extra += this.router?.adapterFor(String(args.id)) || '';
    }
    return extra + (this.router?.observe({ tool, args, success }, this.state) || '');
  }

  private pick(userMessage: string): string {
    if (!this.router) return '';
    let picked: SkillPick[] = [];
    try {
      picked = this.router.selectForRequest(userMessage);
    } catch (e) {
      console.error('Auto skill selection failed:', e);
      return '';
    }
    if (picked.length === 0) return '';
    for (const s of picked) {
      this.state.loaded.add(s.id);
      this.ui.say('skillEvent', { kind: 'loaded', id: s.id, name: s.name, auto: true, reason: s.reason });
    }
    this.preloaded = new Set(this.state.loaded);
    return `\n\n### Auto-Loaded Skills\nSelected for this request — treat them as authoritative for the topics they cover, and don't load them again with use_skill:\n\n` +
      picked.map(s => `--- [${s.id.includes('/') ? 'Skill reference' : 'Skill'}: ${s.id}] (${s.reason}) ---\n${s.content}`).join('\n\n');
  }
}
