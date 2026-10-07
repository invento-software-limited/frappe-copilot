import * as vscode from 'vscode';
import { LLMProvider } from '../providers/interface';
import { AgentDefinition } from '../agents/types';
import { capsFor, clampEffort, isEffortLevel, EffortLevel, EFFORT_LEVELS } from '../providers/modelCaps';
import { contextWindowFor } from '../session/contextBudget';
import { ChatUi } from './chatUi';

/** The model picker, reasoning effort and tool-calling protocol for the chat. */
export class ModelSettings {
  /** The picker's choice; empty means the provider's configured default. */
  private activeModel = '';
  /** Set when the model rejects native tool calling — falls back to the XML protocol. */
  private nativeToolsDisabled = false;
  /** Set when the model rejects images — tool screenshots go text-only. */
  private toolImagesDisabled = false;
  private modelCache: { provider: string; models: string[]; fetchedAt: number } | null = null;

  constructor(private provider: LLMProvider, private ui: ChatUi) {}

  /** Explicit picker choice only — passed to the provider as an override. */
  get selectedModel(): string {
    return this.activeModel;
  }

  /** The model being used right now — the picker's choice, else the provider default. */
  currentModel(): string {
    return this.activeModel || this.provider.getModelId?.() || '';
  }

  contextWindow(): number {
    return contextWindowFor(this.currentModel());
  }

  select(model: string): void {
    this.activeModel = model;
    this.nativeToolsDisabled = false;
    this.toolImagesDisabled = false;
    this.sendEffort();
  }

  /** The provider or its endpoint changed — the old pick and fallback no longer apply. */
  providerChanged(): void {
    this.activeModel = '';
    this.nativeToolsDisabled = false;
    this.toolImagesDisabled = false;
  }

  endpointChanged(): void {
    this.nativeToolsDisabled = false;
  }

  /** Native tool calling when the provider supports it and the user hasn't
   *  opted out; otherwise the XML text protocol. */
  useNativeTools(): boolean {
    if (this.nativeToolsDisabled) return false;
    const enabled = vscode.workspace.getConfiguration('frappe-copilot').get<boolean>('nativeToolCalling', true);
    return enabled && !!this.provider.supportsNativeTools?.();
  }

  disableNativeTools(): void {
    this.nativeToolsDisabled = true;
  }

  /** Whether tool results may carry images (screenshots, image files). */
  toolImagesEnabled(): boolean {
    if (this.toolImagesDisabled) return false;
    return vscode.workspace.getConfiguration('frappe-copilot').get<boolean>('toolImages', true);
  }

  disableToolImages(): void {
    this.toolImagesDisabled = true;
  }

  /** The user's effort choice, or undefined to use the model's default. */
  effortSetting(): EffortLevel | undefined {
    const v = vscode.workspace.getConfiguration('frappe-copilot').get<string>('effort', '');
    return isEffortLevel(v) ? v : undefined;
  }

  /** Effort for one agent run: the user's choice (or the model default),
   *  capped by the agent — read-only explore sub-agents don't need depth. */
  effortFor(agent: AgentDefinition): EffortLevel | undefined {
    const caps = capsFor(this.currentModel());
    const chosen = this.effortSetting();
    if (!agent.maxEffort) return chosen;
    const base = chosen ?? caps.defaultEffort;
    if (!base) return chosen;
    return EFFORT_LEVELS.indexOf(base) > EFFORT_LEVELS.indexOf(agent.maxEffort) ? clampEffort(agent.maxEffort, caps) : chosen;
  }

  async setEffort(value: unknown): Promise<void> {
    const level = isEffortLevel(value) ? value : '';
    await vscode.workspace.getConfiguration('frappe-copilot').update('effort', level, vscode.ConfigurationTarget.Global);
    this.sendEffort();
  }

  /** What the effort picker should offer for the current model. */
  sendEffort(): void {
    const caps = capsFor(this.currentModel());
    this.ui.say('effortInfo', {
      levels: caps.effortLevels,
      recommended: caps.defaultEffort || null,
      effort: this.effortSetting() || null,
    });
  }

  /** Sends the provider's model list to the picker. Cached per provider so
   *  reopening the panel is instant; `force` pulls a fresh list from the API. */
  async sendModels(force: boolean): Promise<void> {
    const provider = this.provider.name;
    if (force || !this.modelCache || this.modelCache.provider !== provider) {
      try {
        const models = this.provider.getModels ? await this.provider.getModels() : [];
        this.modelCache = { provider, models, fetchedAt: Date.now() };
      } catch (e: any) {
        this.ui.say('modelsList', { models: this.modelCache?.models || [], error: e.message || String(e) });
        return;
      }
    }
    const { models, fetchedAt } = this.modelCache;
    const configured = this.provider.getModelId?.();
    const activeModel = this.activeModel || (configured && models.includes(configured) ? configured : configured || models[0]);
    this.ui.say('modelsList', { models, activeModel, fetchedAt, provider });
    this.sendEffort();
  }
}
