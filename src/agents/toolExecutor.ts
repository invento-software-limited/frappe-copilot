import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';
import { BenchEnvironment } from '../types';
import { ToolName } from './types';
import { readConfig } from '../workspace/structure';
import { SkillsStore } from './skillsStore';

export interface ToolResult {
  success: boolean;
  output: string;
}

export class ToolExecutor {
  constructor(
    private workspaceRoot: string,
    private benchEnv: BenchEnvironment | null,
    private skillsStore: SkillsStore | null = null
  ) {}

  setBenchEnv(env: BenchEnvironment | null) {
    this.benchEnv = env;
  }

  /** Run a tool by name and arguments. `allowedTools` is the calling agent's
   *  tool allowlist — enforced here as the authoritative check regardless of
   *  what the model was prompted with, since a prompt only constrains the
   *  model's own reasoning, not adversarial content reflected back through a
   *  prior tool result (e.g. injected instructions in a fetched web page). */
  async runTool(name: string, args: Record<string, string>, allowedTools: ToolName[]): Promise<ToolResult> {
    if (!allowedTools.includes(name as ToolName)) {
      return { success: false, output: `Tool '${name}' is not permitted for this agent. Available tools: ${allowedTools.join(', ')}` };
    }
    try {
      switch (name) {
        case 'read_file':
          return await this.readFile(args.path);
        case 'write_file':
          return await this.writeFile(args.path, args.content);
        case 'edit_file':
          return await this.editFile(args.path, args.search, args.replace);
        case 'list_dir':
          return await this.listDir(args.path);
        case 'grep_search':
          return await this.grepSearch(args.query);
        case 'execute_command':
          return await this.executeCommand(args.command);
        case 'introspect_doctype':
          return await this.introspectDocType(args.doctype, args.site);
        case 'web_search':
          return await this.webSearch(args.query);
        case 'web_fetch':
          return await this.webFetch(args.url);
        case 'use_skill':
          return await this.useSkill(args.id);
        default:
          return { success: false, output: `Unknown tool: ${name}` };
      }
    } catch (e: any) {
      return { success: false, output: e.message || String(e) };
    }
  }

  private async resolvePath(relPath: string): Promise<string> {
    const activeRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || this.workspaceRoot;
    let fullPath = path.resolve(activeRoot, relPath);
    fullPath = path.normalize(fullPath);
    const normalizedRoot = path.normalize(activeRoot);
    if (!fullPath.startsWith(normalizedRoot)) {
      const choice = await vscode.window.showWarningMessage(
        `Frappe Copilot wants to access file/directory outside the workspace root: '${fullPath}'. Do you allow this?`,
        'Allow',
        'Deny'
      );
      if (choice !== 'Allow') {
        throw new Error(`Access denied: User rejected access to path '${relPath}' outside the workspace root.`);
      }
    }
    return fullPath;
  }

  async readFile(relPath: string): Promise<ToolResult> {
    if (!relPath) return { success: false, output: 'Missing path parameter' };
    const fullPath = await this.resolvePath(relPath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, output: `File not found: ${relPath}` };
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return { success: false, output: `'${relPath}' is a directory. Use list_dir tool instead.` };
    }

    // Add size guardrail: limit to 1MB
    const maxBytes = 1 * 1024 * 1024; // 1MB
    if (stat.size > maxBytes) {
      return {
        success: false,
        output: `Error: File '${relPath}' is too large (${(stat.size / 1024 / 1024).toFixed(2)}MB). Maximum allowed file size to read is 1.00MB to prevent token limit crashes.`
      };
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    return { success: true, output: content };
  }

  async writeFile(relPath: string, content: string): Promise<ToolResult> {
    if (!relPath) return { success: false, output: 'Missing path parameter' };
    const fullPath = await this.resolvePath(relPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content || '', 'utf8');
    return { success: true, output: `Successfully wrote file to ${relPath}` };
  }

  async editFile(relPath: string, search: string, replace: string): Promise<ToolResult> {
    if (!relPath) return { success: false, output: 'Missing path parameter' };
    if (search === undefined || replace === undefined) {
      return { success: false, output: 'Missing search or replace parameters' };
    }
    const fullPath = await this.resolvePath(relPath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, output: `File not found: ${relPath}` };
    }
    const originalContent = fs.readFileSync(fullPath, 'utf8');

    const normalize = (str: string) => str.replace(/\r\n/g, '\n');
    const normalizedOriginal = normalize(originalContent);
    const normalizedSearch = normalize(search);
    const normalizedReplace = normalize(replace);

    if (!normalizedOriginal.includes(normalizedSearch)) {
      return {
        success: false,
        output: `Error: The search block was not found in '${relPath}'. Make sure your search block matches the file content exactly, including spaces and newlines.`
      };
    }

    const occurrences = normalizedOriginal.split(normalizedSearch).length - 1;
    if (occurrences > 1) {
      return {
        success: false,
        output: `Error: The search block is not unique. Found ${occurrences} occurrences in '${relPath}'. Please include more surrounding lines of context to make it unique.`
      };
    }

    const newContent = normalizedOriginal.replace(normalizedSearch, () => normalizedReplace);
    fs.writeFileSync(fullPath, newContent, 'utf8');
    return { success: true, output: `Successfully edited ${relPath}` };
  }

  async listDir(relPath: string = '.'): Promise<ToolResult> {
    const fullPath = await this.resolvePath(relPath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, output: `Directory not found: ${relPath}` };
    }
    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) {
      return { success: false, output: `'${relPath}' is a file. Use read_file instead.` };
    }
    const files = fs.readdirSync(fullPath);
    const details = files.map(file => {
      const filePath = path.join(fullPath, file);
      const fileStat = fs.statSync(filePath);
      const isDir = fileStat.isDirectory();
      return `${isDir ? '📁' : '📄'} ${file}${isDir ? '/' : ''}`;
    });
    return { success: true, output: details.join('\n') || '(empty directory)' };
  }

  async grepSearch(query: string): Promise<ToolResult> {
    if (!query) return { success: false, output: 'Missing query parameter' };
    const activeRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || this.workspaceRoot;
    const results: string[] = [];
    const maxResults = 50;

    const searchDir = (dir: string) => {
      if (results.length >= maxResults) return;
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        return; // Ignore unreadable directories
      }

      for (const file of files) {
        if (results.length >= maxResults) return;
        const fullPath = path.join(dir, file);
        const relPath = path.relative(activeRoot, fullPath);
        const pathParts = relPath.split(path.sep);

        // Skip binary, temporary, package, or massive dependency/cache directories
        const skipDirs = [
          'node_modules', '.git', 'out', 'dist', '.frappe-copilot', 
          '.claude', 'assets', 'env', '.venv', 'venv', 
          '__pycache__', '.vscode', 'develop-src', 'sites/assets',
          '.github', '.egg-info', 'build', 'htmlcov'
        ];

        if (skipDirs.some(p => {
          if (p.includes('/')) {
            return relPath.replace(/\\/g, '/').includes(p);
          }
          return pathParts.includes(p);
        })) {
          continue;
        }

        try {
          const stat = fs.lstatSync(fullPath);
          if (stat.isSymbolicLink()) {
            continue; // Skip symlinks to avoid duplicate matches and loops
          }

          if (stat.isDirectory()) {
            searchDir(fullPath);
          } else if (stat.isFile()) {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (content.includes('\0')) continue; // Skip binary files

            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
                if (results.length >= maxResults) return;
              }
            }
          }
        } catch {
          // Ignore unreadable files or stats errors
        }
      }
    };

    searchDir(activeRoot);
    return {
      success: true,
      output: results.join('\n') || `No matches found for '${query}'`
    };
  }

  async executeCommand(commandStr: string): Promise<ToolResult> {
    if (!commandStr) return { success: false, output: 'Missing command parameter' };

    const activeRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || this.workspaceRoot;
    let fullCommand = commandStr;
    const isBench = commandStr.trim().startsWith('bench');
    let cwdDir = activeRoot;

    if (isBench && this.benchEnv) {
      if (this.benchEnv.type === 'host') {
        if (this.benchEnv.benchDir) {
          cwdDir = this.benchEnv.benchDir;
        }
      } else if (this.benchEnv.type === 'docker') {
        const containerId = this.benchEnv.containerId;
        const workdir = this.benchEnv.benchDir;
        fullCommand = `docker exec -w ${workdir} ${containerId} ${commandStr}`;
      }
    }

    // Detect if we are on a Windows host running commands on a WSL UNC share path
    let isWsl = false;
    let wslDistro = '';
    let wslCwd = '';

    const match = cwdDir.match(/^\\\\wsl(?:\.localhost|\$)?\\([^\\]+)\\(.*)$/i);
    if (match) {
      isWsl = true;
      wslDistro = match[1];
      wslCwd = '/' + match[2].replace(/\\/g, '/');
    }

    return new Promise((resolve) => {
      const maxBuffer = 10 * 1024 * 1024; // 10MB buffer
      const options: any = { maxBuffer };
      let cmdToRun = fullCommand;

      if (isWsl) {
        // Wrap command in wsl shell executor to support docker and python utilities inside the WSL environment
        cmdToRun = `wsl -d ${wslDistro} --cd "${wslCwd}" -- ${fullCommand}`;
      } else {
        options.cwd = cwdDir;
        if (process.platform === 'win32') {
          options.shell = 'powershell.exe';
        }
      }

      exec(cmdToRun, options, (error, stdout, stderr) => {
        const limitOutput = (text: string, limit: number = 50000) => {
          if (!text) return '';
          if (text.length <= limit) return text;
          return `... (truncated ${text.length - limit} characters) ...\n` + text.slice(-limit);
        };

        const cleanStdout = limitOutput(typeof stdout === 'string' ? stdout : stdout.toString('utf8'));
        const cleanStderr = limitOutput(typeof stderr === 'string' ? stderr : stderr.toString('utf8'));

        const output = [
          cleanStdout ? `STDOUT:\n${cleanStdout}` : '',
          cleanStderr ? `STDERR:\n${cleanStderr}` : ''
        ].filter(Boolean).join('\n');

        if (error) {
          resolve({
            success: false,
            output: `Command failed with exit code ${error.code || 1}\n\n${output}`
          });
        } else {
          resolve({
            success: true,
            output: output || '(command executed successfully with no output)'
          });
        }
      });
    });
  }

  private escapePath(p: string): string {
    if (process.platform === 'win32') {
      return p.includes(' ') ? `"${p}"` : p;
    }
    return p.replace(/([^a-zA-Z0-9._/-])/g, '\\$1');
  }

  async introspectDocType(doctype: string, site?: string): Promise<ToolResult> {
    if (!doctype) return { success: false, output: 'Missing doctype parameter' };

    let activeSite = site;
    if (!activeSite) {
      const config = readConfig();
      if (config && config.defaultSite) {
        activeSite = config.defaultSite;
      }
    }

    if (!activeSite) {
      return {
        success: false,
        output: 'Error: No site provided and no default site configured in config.json. Please configure a default site first.'
      };
    }

    const safeDocType = doctype.replace(/'/g, "\\'");
    // Single-line python code using single quotes internally so it has no shell escaping issues when wrapped in double quotes
    const pythonCode = `import frappe, json; m = frappe.get_meta('${safeDocType}'); print(json.dumps({'name': m.name, 'module': m.module, 'issingle': m.issingle, 'istable': m.istable, 'is_submittable': m.is_submittable, 'title_field': m.title_field, 'fields': [{'fieldname': f.fieldname, 'fieldtype': f.fieldtype, 'label': f.label, 'options': f.options, 'reqd': f.reqd, 'in_list_view': f.in_list_view} for f in m.fields], 'links': [{'link_doctype': l.link_doctype, 'link_fieldname': l.link_fieldname, 'group': l.group} for l in getattr(m, 'links', [])], 'states': [{'title': s.title, 'color': s.color} for s in getattr(m, 'states', [])]}, indent=2))`;

    const command = `bench --site ${activeSite} execute --command "${pythonCode.replace(/"/g, '\\"')}"`;
    return await this.executeCommand(command);
  }

  async webSearch(query: string): Promise<ToolResult> {
    if (!query) return { success: false, output: 'Missing query parameter' };
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) {
        return { success: false, output: `Search request failed with status: ${response.status}` };
      }
      const html = await response.text();
      const htmlClean = html.replace(/\r?\n/g, ' ');
      const resultRegex = /<div\s+class="[^"]*web-result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
      
      const results: { title: string; url: string; snippet: string }[] = [];
      let match;
      while ((match = resultRegex.exec(htmlClean)) !== null && results.length < 5) {
        const block = match[1];
        const urlMatch = block.match(/href="([^"]+)"/);
        const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
        const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

        if (urlMatch && titleMatch) {
          const rawUrl = urlMatch[1];
          let cleanUrl = rawUrl;
          if (rawUrl.includes('uddg=')) {
            const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
            if (uddgMatch) {
              cleanUrl = decodeURIComponent(uddgMatch[1]);
            }
          }
          const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
          const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
          results.push({ title, url: cleanUrl, snippet });
        }
      }

      if (results.length === 0) {
        return { success: true, output: `No search results found for: ${query}` };
      }

      const formatted = results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`).join('\n\n');
      return { success: true, output: formatted };
    } catch (e: any) {
      return { success: false, output: `Web search error: ${e.message || String(e)}` };
    }
  }

  async useSkill(id: string): Promise<ToolResult> {
    if (!id) return { success: false, output: 'Missing id parameter' };
    if (!this.skillsStore) return { success: false, output: 'Skills system not initialized for this workspace.' };
    const content = this.skillsStore.readSkill(id);
    if (content === null) return { success: false, output: `No skill found with id '${id}'.` };
    return { success: true, output: content };
  }

  async webFetch(urlStr: string): Promise<ToolResult> {
    if (!urlStr) return { success: false, output: 'Missing url parameter' };
    try {
      let targetUrl = urlStr.trim();
      if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
      }
      
      const response = await fetch(targetUrl, {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) {
        return { success: false, output: `Fetch request failed with status: ${response.status}` };
      }
      const html = await response.text();
      
      let text = html.replace(/<(script|style|head|iframe|svg|noscript)[^>]*>([\s\S]*?)<\/\1>/gi, '');
      
      text = text.replace(/<\/div>/gi, '\n');
      text = text.replace(/<\/p>/gi, '\n\n');
      text = text.replace(/<br\s*\/?>/gi, '\n');
      text = text.replace(/<(h[1-6]|li|tr|th|td)[^>]*>/gi, '\n* ');
      text = text.replace(/<[^>]+>/g, '');
      
      text = text.replace(/&nbsp;/g, ' ')
                 .replace(/&lt;/g, '<')
                 .replace(/&gt;/g, '>')
                 .replace(/&amp;/g, '&')
                 .replace(/&quot;/g, '"')
                 .replace(/&#39;/g, "'");

      const cleanedLines = text.split('\n')
        .map(line => line.trim())
        .filter((line, i, arr) => line !== '' || (i > 0 && arr[i-1] !== ''));
      
      const cleanText = cleanedLines.join('\n').slice(0, 40000);
      return { success: true, output: cleanText || '(empty page content)' };
    } catch (e: any) {
      return { success: false, output: `Web fetch error: ${e.message || String(e)}` };
    }
  }
}
