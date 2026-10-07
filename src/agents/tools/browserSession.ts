import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Browser, Page } from 'puppeteer-core';

/** Where Chrome-family browsers usually live, checked in order. */
const CANDIDATES: Record<string, string[]> = {
  linux: [
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  win32: [
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ],
};

function settings() {
  const cfg = vscode.workspace.getConfiguration('frappe-copilot.browser');
  return {
    executablePath: cfg.get<string>('executablePath', '').trim(),
    headless: cfg.get<boolean>('headless', false),
  };
}

function findBrowser(configured: string): string | null {
  if (configured) return fs.existsSync(configured) ? configured : null;
  return (CANDIDATES[process.platform] || []).find(p => p && fs.existsSync(p)) || null;
}

/** One Chrome window the agent drives, launched on first use with its own
 *  persistent profile (so a login to a live site survives between runs) and
 *  relaunched if the user closes it. */
export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;
  /** Native alert/confirm dialogs accepted since the last action, reported back. */
  dialogs: string[] = [];

  /** The page the agent is acting on, launching the browser if needed. */
  async activePage(): Promise<Page> {
    if (this.page && !this.page.isClosed() && this.browser?.connected) return this.page;
    if (!this.browser?.connected) await this.launch();
    const pages = await this.browser!.pages();
    this.attach(pages[pages.length - 1] || await this.browser!.newPage());
    return this.page!;
  }

  async tabs(): Promise<Page[]> {
    await this.activePage();
    return this.browser!.pages();
  }

  async switchTo(index: number): Promise<Page> {
    const pages = await this.tabs();
    const page = pages[index];
    if (!page) throw new Error(`No tab ${index}. Open tabs: 0-${pages.length - 1}.`);
    await page.bringToFront();
    this.attach(page);
    return page;
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.page = null;
    await b?.close().catch(() => undefined);
  }

  private async launch(): Promise<void> {
    const { executablePath, headless } = settings();
    const exe = findBrowser(executablePath);
    if (!exe) {
      throw new Error(executablePath
        ? `Browser not found at '${executablePath}' (frappe-copilot.browser.executablePath).`
        : 'No Chrome, Chromium, Edge or Brave install found. Install one, or set frappe-copilot.browser.executablePath.');
    }
    const puppeteer = await import('puppeteer-core');
    this.browser = await puppeteer.launch({
      executablePath: exe,
      headless,
      defaultViewport: headless ? { width: 1366, height: 900 } : null,
      userDataDir: path.join(os.homedir(), '.frappe-copilot', 'browser-profile'),
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    // Follow links that open a new tab (target=_blank, window.open).
    this.browser.on('targetcreated', async target => {
      const page = await target.page().catch(() => null);
      if (page) this.attach(page);
    });
    this.browser.on('disconnected', () => { this.browser = null; this.page = null; });
  }

  private attach(page: Page): void {
    if (this.page === page) return;
    this.page = page;
    if ((page as any).__fcHooked) return;
    (page as any).__fcHooked = true;
    page.on('dialog', async d => {
      this.dialogs.push(`${d.type()}: ${d.message()}`);
      await d.accept().catch(() => undefined);
    });
  }
}
