import * as vscode from 'vscode';
import { LLMProvider } from '../providers/interface';
import { SessionManager } from '../session/manager';
import { Session } from '../types';
import { estimateMessagesTokens, buildCompactionPrompt, DEFAULT_COMPACTION_THRESHOLD_TOKENS } from '../session/compaction';
import { ChatUi } from './chatUi';
import { ModelSettings } from './modelSettings';

/** Compact automatically past this share. */
const AUTO_COMPACT_AT = 0.8;

/** Keeps the context badge current and shrinks a session's history before it
 *  crowds out the system prompt and tool output. */
export class CompactionController {
  private compacting = false;

  constructor(
    private ui: ChatUi,
    private sessions: SessionManager,
    private provider: LLMProvider,
    private models: ModelSettings
  ) {}

  /** Updates the token badge and offers — or past AUTO_COMPACT_AT forces —
   *  compaction. Called after every turn and after loading a session. */
  reportSessionSize(session: Session): void {
    const effective = this.sessions.buildEffectiveHistory(session.id);
    const estimatedTokens = estimateMessagesTokens(effective);
    const window = this.models.contextWindow();
    this.ui.say('tokenUsage', { estimatedTokens, budget: window });

    if (estimatedTokens > window * AUTO_COMPACT_AT && !this.compacting) {
      this.ui.chat('system', `🗜️ Conversation is using ${Math.round(estimatedTokens / window * 100)}% of the context window — compacting automatically.`);
      void this.compact(session);
      return;
    }
    const autoOffer = vscode.workspace.getConfiguration('frappe-copilot').get<boolean>('compaction.autoOffer', true);
    const thresholdTokens = this.threshold(window);
    if (autoOffer && estimatedTokens > thresholdTokens) {
      this.ui.say('compactionOffered', { estimatedTokens, thresholdTokens });
    }
  }

  /** "Summarize and replace": one LLM call summarizes the raw history into the
   *  session's context.md. messages.jsonl is never touched — only what
   *  buildEffectiveHistory() sends to the model from now on shrinks. */
  async compact(session: Session): Promise<void> {
    const allMessages = this.sessions.readMessages(session.id);
    if (allMessages.length === 0 || this.compacting) return;
    this.compacting = true;
    this.ui.chat('system', '🗜️ Compacting conversation...');
    try {
      // ~4 chars/token; leave room for the summary itself.
      const { system, user } = buildCompactionPrompt(allMessages, Math.floor(this.models.contextWindow() * 0.6 * 4));
      const response = await this.provider.chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { maxTokens: 4000, temperature: 0 }
      );
      const summary = response.content.trim();
      if (!summary) {
        this.ui.chat('error', 'Compaction failed: empty summary returned.');
        return;
      }
      this.sessions.writeCompactionState(session.id, {
        compactedThroughCount: allMessages.length,
        summary,
        compactedAt: new Date().toISOString(),
      });
      this.sessions.updateContext(session.id, summary);
      this.ui.say('compactionApplied', { summary });
      this.reportSessionSize(session);
    } catch (e: any) {
      this.ui.chat('error', `Compaction failed: ${e.message || String(e)}`);
    } finally {
      this.compacting = false;
    }
  }

  /** The configured threshold, with an absolute default for cost control. */
  private threshold(window: number): number {
    return vscode.workspace.getConfiguration('frappe-copilot').get<number>(
      'compaction.thresholdTokens',
      Math.min(DEFAULT_COMPACTION_THRESHOLD_TOKENS, Math.round(window * 0.5))
    );
  }
}
