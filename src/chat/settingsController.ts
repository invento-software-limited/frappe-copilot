import * as vscode from 'vscode';
import { LLMProvider } from '../providers/interface';
import { runClaudeOAuthFlow } from '../providers/anthropicOAuth';
import { getApprovalMode, ApprovalMode } from '../agents/approvalMode';
import { ChatUi } from './chatUi';
import { ModelSettings } from './modelSettings';

/** Provider-specific methods not every LLMProvider implements. */
type ConfigurableProvider = LLMProvider & {
  hasApiKey?(): Promise<boolean>;
  setApiKey?(key: string): Promise<void>;
  getAuthMode?(): Promise<string>;
  refreshConfig?(): void;
};

const ENDPOINT_SECTIONS: Record<string, { section: string; fallback: string }> = {
  openai: { section: 'frappe-copilot.openai', fallback: 'https://api.openai.com/v1' },
  anthropic: { section: 'frappe-copilot.anthropic', fallback: 'https://api.anthropic.com/v1' },
  'opencode-zen': { section: 'frappe-copilot.opencodeZen', fallback: 'https://opencode.ai/zen/v1' },
};

function activeProviderId(): string {
  return vscode.workspace.getConfiguration('frappe-copilot').get<string>('provider', 'opencode-zen');
}

/** The settings panel: provider, endpoint, API key / Claude OAuth login, and approval mode. */
export class SettingsController {
  private pendingOAuthCode: ((code: string) => void) | null = null;
  private provider: ConfigurableProvider;

  constructor(provider: LLMProvider, private ui: ChatUi, private models: ModelSettings) {
    this.provider = provider as ConfigurableProvider;
  }

  async hasApiKey(): Promise<boolean> {
    try { return !!(await this.provider.hasApiKey?.()); } catch { return false; }
  }

  /** Shown when the provider has no usable credentials — Claude Code logs in outside this extension. */
  noAuthMessage(): string {
    return activeProviderId() === 'claude-code'
      ? '⚠️ Claude Code SDK not available — run `claude` in a terminal once to log in, then try again.'
      : '⚠️ Set your API key via Command Palette → Frappe Copilot: Set API Key';
  }

  /** Handles a settings message from the webview; false when it isn't one. */
  async handle(msg: any): Promise<boolean> {
    switch (msg.type) {
      case 'getSettings': await this.sendSettings(activeProviderId()); return true;
      case 'setApiKey': await this.setApiKey(msg.key); return true;
      case 'startClaudeOAuth': await this.startOAuth(); return true;
      case 'submitClaudeOAuthCode': if (msg.code) this.resolveOAuth(String(msg.code).trim()); return true;
      case 'cancelClaudeOAuth': this.resolveOAuth(''); return true;
      case 'setEndpoint': await this.setEndpoint(msg.endpoint); return true;
      case 'setProvider': await this.setProvider(msg.provider); return true;
      case 'setApprovalMode': await this.setApprovalMode(msg.mode); return true;
      case 'getApprovalMode': this.ui.say('approvalMode', { mode: getApprovalMode() }); return true;
      default: return false;
    }
  }

  private async sendSettings(providerId: string, hasKey?: boolean): Promise<void> {
    let authMode: string | undefined;
    try { authMode = await this.provider.getAuthMode?.(); } catch { authMode = undefined; }
    this.ui.say('settingsLoaded', {
      hasKey: hasKey ?? await this.hasApiKey(),
      endpoint: endpointFor(providerId),
      provider: providerId,
      authMode,
    });
  }

  private async setApiKey(key: unknown): Promise<void> {
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (!trimmed) {
      this.ui.say('apiKeyStatus', { ok: false, msg: 'API key cannot be empty.' });
      return;
    }
    await this.provider.setApiKey?.(trimmed);
    this.ui.say('apiKeyStatus', { ok: true, msg: 'API key saved successfully.' });
    this.ui.say('status', 'ready');
    vscode.window.showInformationMessage('Frappe Copilot: API key saved.');
  }

  private async startOAuth(): Promise<void> {
    try {
      const manualCode = new Promise<string>(resolve => { this.pendingOAuthCode = resolve; });
      const rawKey = await runClaudeOAuthFlow(authUrl => this.ui.say('claudeOAuthStarted', { authUrl }), manualCode);
      if (!rawKey) return;
      await this.provider.setApiKey?.(rawKey);
      this.ui.say('apiKeyStatus', { ok: true, msg: 'OAuth login successful.' });
      this.ui.say('status', 'ready');
      await this.sendSettings(activeProviderId(), true);
      vscode.window.showInformationMessage('Frappe Copilot: Claude OAuth login successful!');
    } catch (e: any) {
      console.error('Claude OAuth flow failed:', e);
      this.ui.say('apiKeyStatus', { ok: false, msg: `Login failed: ${e.message || e}` });
      vscode.window.showErrorMessage(`Claude OAuth login failed: ${e.message || e}`);
    } finally {
      this.pendingOAuthCode = null;
    }
  }

  private resolveOAuth(code: string): void {
    this.pendingOAuthCode?.(code);
    this.pendingOAuthCode = null;
  }

  private async setEndpoint(endpoint: unknown): Promise<void> {
    const trimmed = typeof endpoint === 'string' ? endpoint.trim() : '';
    if (!trimmed) return;
    const providerId = activeProviderId();
    if (providerId === 'claude-code') {
      this.ui.say('apiKeyStatus', { ok: true, msg: 'Claude Code resolves its own endpoint — nothing to save.' });
      return;
    }
    const { section } = ENDPOINT_SECTIONS[providerId] || ENDPOINT_SECTIONS['opencode-zen'];
    await vscode.workspace.getConfiguration(section).update('endpoint', trimmed, vscode.ConfigurationTarget.Global);
    this.provider.refreshConfig?.();
    this.models.endpointChanged();
    this.ui.say('apiKeyStatus', { ok: true, msg: 'Endpoint saved.' });
  }

  private async setProvider(providerId: unknown): Promise<void> {
    if (typeof providerId !== 'string' || !providerId) return;
    await vscode.workspace.getConfiguration('frappe-copilot').update('provider', providerId, vscode.ConfigurationTarget.Global);
    this.provider.refreshConfig?.();
    this.models.providerChanged();
    const hasKey = await this.hasApiKey();
    await this.sendSettings(providerId, hasKey);
    await this.models.sendModels(true);
    this.ui.say('status', hasKey ? 'ready' : 'no-key');
  }

  /** Stored globally so the choice survives switching between benches/apps. */
  private async setApprovalMode(value: unknown): Promise<void> {
    const mode: ApprovalMode = value === 'auto' ? 'auto' : 'ask';
    await vscode.workspace.getConfiguration('frappe-copilot').update('approvalMode', mode, vscode.ConfigurationTarget.Global);
    this.ui.say('approvalMode', { mode });
    this.ui.chat('system', mode === 'auto'
      ? '⚡ **Auto mode on.** File writes, edits, commands, and verification will run without asking. Changes are still checkpointed, so a run can be reverted.'
      : '🛡️ **Ask mode on.** High-risk actions will pause for your approval.');
  }
}

/** Claude Code has no direct endpoint — the SDK resolves auth and routing itself. */
function endpointFor(providerId: string): string {
  if (providerId === 'claude-code') return '';
  const { section, fallback } = ENDPOINT_SECTIONS[providerId] || ENDPOINT_SECTIONS['opencode-zen'];
  return vscode.workspace.getConfiguration(section).get<string>('endpoint', fallback);
}
