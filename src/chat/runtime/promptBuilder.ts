import { Message } from '../../types';
import { buildSystemPrompt } from '../../agents/prompts';
import { schemaSummary } from '../../agents/tools/contextTools';
import { buildCrossAgentContext } from '../../workspace/crossAgentMemory';
import { hydrateImages } from '../attachments';
import type { AgentRuntime } from './agentRuntime';
import { RunScope } from './types';

/** Builds the message list for one model call: the agent's system prompt plus
 *  the conversation so far. */
export class PromptBuilder {
  /** Unfinished task list from an earlier run, injected into this run's context. */
  todoContext = '';
  private ragCache: { query: string; text: string } | null = null;

  constructor(private rt: AgentRuntime) {}

  async build(scope: RunScope, native: boolean): Promise<Message[]> {
    const { agent } = scope;
    // Static boilerplate (identity, guidelines, tool docs) is kept apart from
    // the per-turn tail so providers that cache a prompt prefix (see
    // Message.staticPrefixLength) keep hitting the cache on the big part.
    const staticPart = buildSystemPrompt(agent, native);
    const dynamicPart = await this.dynamicContext(scope, native);
    return hydrateImages([
      { role: 'system', content: staticPart + dynamicPart, staticPrefixLength: staticPart.length },
      ...scope.baseHistory,
      ...scope.localHistory,
    ]);
  }

  private async dynamicContext(scope: RunScope, native: boolean): Promise<string> {
    const { project } = this.rt.deps;
    // Native-tool models pull knowledge on demand (search_knowledge); XML-mode
    // models are usually weaker at that, so they still get it injected.
    const rag = native ? '' : await this.injectedKnowledge(scope.userMessage);
    return rag +
      schemaSummary(project.schema) +
      this.rt.skills.catalogSection() +
      this.mcpCatalog(scope) +
      // What other AI agents already recorded about this project, so this one
      // doesn't rediscover known issues or contradict past decisions.
      buildCrossAgentContext(scope.root) +
      this.rt.skills.context +
      this.todoContext;
  }

  private mcpCatalog(scope: RunScope): string {
    const mcp = this.rt.deps.mcp;
    if (!mcp || !scope.agent.allowedTools.includes('call_mcp_tool')) return '';
    const catalog = mcp.buildCatalog();
    if (!catalog) return '';
    return `\n\n### Available MCP Tools\nCheck this list before falling back to grep/read_file/web_search for anything one of these tools already covers — call it proactively via 'call_mcp_tool' with the server id and tool name shown below, don't wait to be asked by name:\n\n${catalog}`;
  }

  /** Knowledge-base snippets for XML-protocol models. Cached per query so a
   *  multi-step run embeds once and keeps a byte-identical system prompt. */
  private async injectedKnowledge(query: string): Promise<string> {
    const store = this.rt.deps.project.vectorStore;
    if (!store) return '';
    if (this.ragCache?.query === query) return this.ragCache.text;
    let text = '';
    try {
      const results = await store.search(query, 6);
      if (results.length > 0) {
        text = `\n\n### Retrieved Knowledge Base Context\nRetrieved from framework docs, this workspace's own code, your notes, skills, and other agents' memory — use it to follow correct APIs and this project's existing patterns:\n\n` +
          results.map(r => `--- [Source: ${r.source}] ---\n${r.text}`).join('\n\n');
      }
    } catch (e) {
      console.error('Failed to run vector search:', e);
    }
    this.ragCache = { query, text };
    return text;
  }
}
