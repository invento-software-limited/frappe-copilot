import * as vscode from 'vscode';
import { ToolResult, fail, ok } from './result';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

type Backend = 'duckduckgo' | 'brave' | 'tavily' | 'searxng';

const MAX_RESULTS = 6;
const TIMEOUT_MS = 10000;
const SECRET_KEY = 'frappe-copilot.webSearch.apiKey';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Where the search API key lives — VS Code's SecretStorage, set on activation. */
let secrets: vscode.SecretStorage | null = null;
export function setWebSearchSecrets(storage: vscode.SecretStorage): void {
  secrets = storage;
}
/** Saves the key, or removes it when empty. */
export async function storeWebSearchApiKey(key: string): Promise<void> {
  if (key) await secrets?.store(SECRET_KEY, key);
  else await secrets?.delete(SECRET_KEY);
}

/** Thrown when a backend answered with a bot check instead of results. */
class BlockedError extends Error {}

/** web_search: Brave, Tavily or a SearXNG instance when configured, else
 *  DuckDuckGo's HTML page (keyless, but it blocks automated traffic at times). */
export async function webSearch(query: string): Promise<ToolResult> {
  if (!query) return fail('Missing query parameter');
  const backend = await chooseBackend();
  try {
    const hits = await search(backend, query);
    if (hits.length === 0) return ok(`No search results found for: ${query}`);
    return ok(hits.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`).join('\n\n'));
  } catch (e: any) {
    if (e instanceof BlockedError) {
      return fail(`Web search unavailable: ${e.message} Set frappe-copilot.webSearch.provider to brave, tavily or searxng (run "Frappe Copilot: Set Web Search API Key" for an API key), or use the browser tool to search.`);
    }
    return fail(`Web search error (${backend}): ${e.message || String(e)}`);
  }
}

async function chooseBackend(): Promise<Backend> {
  const configured = vscode.workspace.getConfiguration('frappe-copilot.webSearch').get<string>('provider', 'auto');
  if (configured === 'brave' || configured === 'tavily' || configured === 'searxng' || configured === 'duckduckgo') return configured;
  // auto: an API backend whenever a key is available
  if (process.env.TAVILY_API_KEY) return 'tavily';
  if (process.env.BRAVE_API_KEY || await secrets?.get(SECRET_KEY)) return 'brave';
  return 'duckduckgo';
}

async function apiKey(envVar: string): Promise<string> {
  const key = process.env[envVar] || await secrets?.get(SECRET_KEY);
  if (!key) throw new Error(`no API key — run "Frappe Copilot: Set Web Search API Key" or set ${envVar}.`);
  return key;
}

async function search(backend: Backend, query: string): Promise<SearchHit[]> {
  switch (backend) {
    case 'brave': return braveSearch(query, await apiKey('BRAVE_API_KEY'));
    case 'tavily': return tavilySearch(query, await apiKey('TAVILY_API_KEY'));
    case 'searxng': return searxngSearch(query);
    default: return parseDuckDuckGo(await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { 'User-Agent': BROWSER_UA }));
  }
}

async function braveSearch(query: string, key: string): Promise<SearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
  const data = JSON.parse(await fetchText(url, { 'Accept': 'application/json', 'X-Subscription-Token': key }));
  return (data.web?.results || []).slice(0, MAX_RESULTS)
    .map((r: any) => ({ title: r.title || '', url: r.url || '', snippet: stripTags(r.description || '') }));
}

async function tavilySearch(query: string, key: string): Promise<SearchHit[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: MAX_RESULTS }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: any = await res.json();
  return (data.results || []).map((r: any) => ({ title: r.title || '', url: r.url || '', snippet: (r.content || '').slice(0, 400) }));
}

async function searxngSearch(query: string): Promise<SearchHit[]> {
  const base = vscode.workspace.getConfiguration('frappe-copilot.webSearch').get<string>('searxngUrl', '').replace(/\/+$/, '');
  if (!base) throw new Error('set frappe-copilot.webSearch.searxngUrl to your SearXNG instance.');
  const data = JSON.parse(await fetchText(`${base}/search?q=${encodeURIComponent(query)}&format=json`, { 'Accept': 'application/json' }));
  return (data.results || []).slice(0, MAX_RESULTS)
    .map((r: any) => ({ title: r.title || '', url: r.url || '', snippet: r.content || '' }));
}

async function fetchText(url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Parses DuckDuckGo's HTML results page. A bot-check page is an error, not
 *  "no results" — otherwise the agent concludes nothing exists online. */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const flat = html.replace(/\r?\n/g, ' ');
  const hits: SearchHit[] = [];
  const blocks = /<div\s+class="[^"]*web-result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  let match;
  while ((match = blocks.exec(flat)) !== null && hits.length < MAX_RESULTS) {
    const block = match[1];
    const href = block.match(/href="([^"]+)"/);
    const title = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    if (!href || !title) continue;
    const redirect = href[1].match(/uddg=([^&]+)/);
    hits.push({
      title: stripTags(title[1]),
      url: redirect ? decodeURIComponent(redirect[1]) : href[1],
      snippet: snippet ? stripTags(snippet[1]) : '',
    });
  }
  if (hits.length === 0 && /anomaly|challenge-form|bots use DuckDuckGo/i.test(flat)) {
    throw new BlockedError('DuckDuckGo answered with a bot check instead of results.');
  }
  return hits;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();
}
