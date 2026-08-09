import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { exec, spawn } from 'child_process';
import { BenchEnvironment } from '../types';
import { ToolName } from './types';
import { readConfig } from '../workspace/structure';
import { SkillsStore } from './skillsStore';
import { isAutoApprove } from './approvalMode';
import { MCPManager } from '../mcp/manager';

export interface ToolResult {
  success: boolean;
  output: string;
}

export class ToolExecutor {
  constructor(
    private workspaceRoot: string,
    private benchEnv: BenchEnvironment | null,
    private skillsStore: SkillsStore | null = null,
    private mcpManager: MCPManager | null = null
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
        case 'list_customizations':
          return await this.listCustomizations(args.doctype, args.site);
        case 'write_custom_field':
          return await this.writeCustomField(args);
        case 'write_property_setter':
          return await this.writePropertySetter(args);
        case 'write_client_script':
          return await this.writeClientScript(args);
        case 'write_server_script':
          return await this.writeServerScript(args);
        case 'write_builder_page':
          return await this.writeBuilderPage(args);
        case 'export_customizations':
          return await this.exportCustomizations(args);
        case 'web_search':
          return await this.webSearch(args.query);
        case 'web_fetch':
          return await this.webFetch(args.url);
        case 'use_skill':
          return await this.useSkill(args.id);
        case 'call_mcp_tool':
          return await this.callMcpTool(args);
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
    // A bare startsWith(normalizedRoot) is a broken containment check: it
    // treats any path that merely shares the root as a *string prefix* as
    // "inside" it — e.g. root '/home/user/frappe-copilot' would silently
    // admit '/home/user/frappe-copilot-secrets/config.json' with no warning
    // at all, since that string does start with the root. Requiring an exact
    // match or a path-separator boundary closes that off.
    if (fullPath !== normalizedRoot && !fullPath.startsWith(normalizedRoot + path.sep)) {
      if (isAutoApprove()) return fullPath;
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

    // Size guardrail: a 1MB file is ~250k tokens in a single tool result, which
    // alone can blow a step's context budget. 150KB (~35k tokens) still covers
    // any real source file while keeping one read_file call from dominating the prompt.
    const maxBytes = 150 * 1024;
    if (stat.size > maxBytes) {
      return {
        success: false,
        output: `Error: File '${relPath}' is too large (${(stat.size / 1024).toFixed(0)}KB). Maximum allowed file size to read is ${(maxBytes / 1024).toFixed(0)}KB to prevent token limit crashes. Use grep_search to find relevant sections instead of reading the whole file.`
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

  /** Falls back to config.json's defaultSite when the model didn't pass one
   *  explicitly. Shared by every tool that hits the live site's database. */
  private resolveSite(site?: string): string | null {
    if (site) return site;
    const config = readConfig();
    return config?.defaultSite || null;
  }

  /** Runs arbitrary Python code against the site.
   *
   * `bench execute` only accepts a dotted module path (e.g. `frappe.db.get_tables`)
   * — there is no `--command` flag. To run ad-hoc code we therefore write it
   * into a temporary `.py` file that exports a single `execute()` function
   * (the convention `bench execute` calls), invoke it, then delete the file.
   *
   * The temp module is nested inside the `frappe` app's own package
   * (`apps/frappe/frappe/_fc_tmp_*.py`), NOT dropped directly under `apps/`.
   * `bench execute <path>` resolves through `frappe.get_attr()`, which requires
   * the leading dotted segment to be the name of an *installed app*
   * (`frappe.get_installed_apps()`) before it will even attempt the import —
   * a bare `apps/_fc_tmp_xxx.py` file has no such segment, so it always threw
   * `AppNotInstalledError`, which `bench execute` then silently swallows and
   * retries as a raw `eval()`, surfacing a confusing `NameError` instead.
   * `frappe` is guaranteed to be installed on every site, so nesting under it
   * satisfies that check on both host and Docker.
   *
   * The file is written differently depending on the bench environment:
   *  - host  → written directly via Node's `fs`
   *  - docker → piped in via `docker exec ... sh -c 'echo <base64> | base64 -d > path'`
   *
   * `code` is a semicolon-joined Python one-liner. We embed it verbatim inside
   * `exec(...)` so splitting on `;` is never needed and the code is always
   * valid regardless of what characters appear inside string literals. */
  private async runPythonOneLiner(site: string, code: string): Promise<ToolResult> {
    const stem = `_fc_tmp_${Date.now()}`;
    const tmpName = `${stem}.py`;
    const execMethod = `frappe.${stem}.execute`;

    // exec() runs arbitrary statement code (unlike eval which only handles expressions).
    const fileContent = [
      '# Auto-generated by Frappe Copilot — deleted after use',
      '',
      'def execute():',
      `    exec(${JSON.stringify(code)})`,
    ].join('\n') + '\n';

    if (this.benchEnv?.type === 'docker' && this.benchEnv.containerId && this.benchEnv.benchDir) {
      const containerId = this.benchEnv.containerId;
      const benchDir = this.benchEnv.benchDir;
      const remotePath = `${benchDir}/apps/frappe/frappe/${tmpName}`;

      // Write file content into the container using python3 to avoid shell quoting issues
      const b64Content = Buffer.from(fileContent, 'utf-8').toString('base64');
      const writeCmd = `docker exec ${containerId} sh -c 'echo ${b64Content} | base64 -d > ${remotePath}'`;
      const writeResult = await this.executeCommand(writeCmd);
      if (!writeResult.success) {
        return { success: false, output: `Failed to write temp script to container: ${writeResult.output}` };
      }

      const execCmd = `bench --site ${site} execute ${execMethod}`;
      const result = await this.executeCommand(execCmd);

      // Clean up regardless of success
      await this.executeCommand(`docker exec ${containerId} rm -f ${remotePath}`);
      return result;
    } else {
      // Host environment: write via Node fs into the frappe app's package dir
      const benchEnvDir = (this.benchEnv && this.benchEnv.type !== 'not-found') ? this.benchEnv.benchDir : undefined;
      const benchDir = benchEnvDir || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.workspaceRoot);
      const localPath = path.join(benchDir, 'apps', 'frappe', 'frappe', tmpName);

      try {
        fs.writeFileSync(localPath, fileContent, 'utf8');
      } catch (e: any) {
        return { success: false, output: `Failed to write temp script to '${localPath}': ${e.message}` };
      }

      const execCmd = `bench --site ${site} execute ${execMethod}`;
      const result = await this.executeCommand(execCmd);

      // Clean up
      try { fs.unlinkSync(localPath); } catch { /* ignore cleanup errors */ }
      return result;
    }
  }

  /** Base64-encodes a JSON payload for safe embedding in a Python one-liner —
   *  see runPythonOneLiner. The base64 alphabet has no shell or Python-string
   *  metacharacters, so this is the one part of the generated command that
   *  never needs escaping regardless of what the payload contains. */
  private b64Json(payload: unknown): string {
    return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
  }

  async introspectDocType(doctype: string, site?: string): Promise<ToolResult> {
    if (!doctype) return { success: false, output: 'Missing doctype parameter' };
    const activeSite = this.resolveSite(site);
    if (!activeSite) {
      return {
        success: false,
        output: 'Error: No site provided and no default site configured in config.json. Please configure a default site first.'
      };
    }

    // Escaping a single quote by hand (as this used to do) is unsafe: it
    // only handles a literal `'` and never touches backslashes, so a doctype
    // value ending in a bare `\` still escapes the closing quote it produces
    // (`'foo\'` reads as an unterminated string in Python), letting whatever
    // follows in the one-liner be reinterpreted as code — a real code-
    // injection path since `introspect_doctype` isn't gated by any approval
    // prompt. Route the value through base64, like every write_* tool below
    // already does, so no character in it is ever shell/Python-meaningful.
    const b64 = this.b64Json(doctype);
    const pythonCode = `import frappe, json, base64; dt = json.loads(base64.b64decode('${b64}').decode('utf-8')); m = frappe.get_meta(dt); print(json.dumps({'name': m.name, 'module': m.module, 'issingle': m.issingle, 'istable': m.istable, 'is_submittable': m.is_submittable, 'title_field': m.title_field, 'fields': [{'fieldname': f.fieldname, 'fieldtype': f.fieldtype, 'label': f.label, 'options': f.options, 'reqd': f.reqd, 'in_list_view': f.in_list_view} for f in m.fields], 'links': [{'link_doctype': l.link_doctype, 'link_fieldname': l.link_fieldname, 'group': l.group} for l in getattr(m, 'links', [])], 'states': [{'title': s.title, 'color': s.color} for s in getattr(m, 'states', [])]}, indent=2))`;

    return await this.runPythonOneLiner(activeSite, pythonCode);
  }

  /** Lists everything already customizing a DocType outside its own app code —
   *  Custom Fields, Property Setters, Client Scripts, and DocType-Event Server
   *  Scripts. Always call this before write_custom_field/write_property_setter/
   *  write_client_script/write_server_script so a new customization doesn't
   *  silently duplicate or conflict with one that already exists. */
  async listCustomizations(doctype: string, site?: string): Promise<ToolResult> {
    if (!doctype) return { success: false, output: 'Missing doctype parameter' };
    const activeSite = this.resolveSite(site);
    if (!activeSite) {
      return { success: false, output: 'Error: No site provided and no default site configured in config.json. Please configure a default site first.' };
    }

    const b64 = this.b64Json(doctype);
    const code = `import frappe, json, base64; dt = base64.b64decode('${b64}').decode('utf-8'); print(json.dumps({'custom_fields': frappe.get_all('Custom Field', filters={'dt': dt}, fields=['name', 'fieldname', 'fieldtype', 'label', 'insert_after', 'reqd', 'options'], order_by='idx'), 'property_setters': frappe.get_all('Property Setter', filters={'doc_type': dt}, fields=['name', 'field_name', 'property', 'value', 'property_type']), 'client_scripts': frappe.get_all('Client Script', filters={'dt': dt}, fields=['name', 'view', 'enabled']), 'server_scripts': frappe.get_all('Server Script', filters={'reference_doctype': dt}, fields=['name', 'script_type', 'doctype_event', 'enabled'])}, indent=2, default=str))`;

    return await this.runPythonOneLiner(activeSite, code);
  }

  /** Creates or updates a Custom Field. Frappe's own create_custom_field
   *  helper (what Customize Form calls) only *creates* — if the fieldname
   *  already exists on this doctype it silently no-ops instead of updating.
   *  So this bypasses that helper and does the same upsert pattern used for
   *  write_client_script/write_server_script instead: look up any existing
   *  doc, fall back to a fresh one, apply the fields, save() (which inserts
   *  or updates depending on whether the doc is new — a single expression
   *  works for both, unlike trying to branch update() vs create() as two
   *  separate statements inside one semicolon-joined line). Pass `module`
   *  (the target app module, e.g. one you'd get from list_dir on an app's
   *  modules.txt) so a later export_customizations call can scope its export
   *  correctly instead of sweeping up every Custom Field on the doctype
   *  regardless of who created it. */
  async writeCustomField(args: Record<string, string>): Promise<ToolResult> {
    const { doctype, fieldname, fieldtype } = args;
    if (!doctype || !fieldname || !fieldtype) {
      return { success: false, output: 'Missing required parameter(s): doctype, fieldname, fieldtype' };
    }
    const activeSite = this.resolveSite(args.site);
    if (!activeSite) {
      return { success: false, output: 'Error: No site provided and no default site configured in config.json. Please configure a default site first.' };
    }

    const df: Record<string, unknown> = { fieldname, fieldtype };
    if (args.label) df.label = args.label;
    if (args.options) df.options = args.options;
    if (args.insert_after) df.insert_after = args.insert_after;
    if (args.reqd !== undefined) df.reqd = args.reqd;
    if (args.read_only !== undefined) df.read_only = args.read_only;
    if (args.in_list_view !== undefined) df.in_list_view = args.in_list_view;
    if (args.depends_on) df.depends_on = args.depends_on;
    if (args.description) df.description = args.description;
    if (args.default !== undefined) df.default = args.default;
    if (args.module) df.module = args.module;

    const b64 = this.b64Json({ doctype, df });
    const code = `import frappe, json, base64; payload = json.loads(base64.b64decode('${b64}').decode('utf-8')); dt = payload['doctype']; df = payload['df']; existing = frappe.db.get_value('Custom Field', {'dt': dt, 'fieldname': df['fieldname']}, 'name'); doc = frappe.get_doc('Custom Field', existing) if existing else frappe.new_doc('Custom Field'); doc.dt = dt; doc.update(df); doc.save(); frappe.db.commit(); print(json.dumps({'success': True, 'doctype': dt, 'fieldname': df['fieldname'], 'created': not existing}))`;

    return await this.runPythonOneLiner(activeSite, code);
  }

  /** Creates or updates a Property Setter — the DB-level override behind
   *  every "change an existing field/doctype property without touching app
   *  code" customization (e.g. making a standard field mandatory, hiding a
   *  section, changing a label). Omit fieldname for a doctype-level property
   *  (e.g. autoname, title_field). Calls frappe.make_property_setter with its
   *  real signature — a single args dict plus a keyword-only `module`, not
   *  the older positional (doctype, fieldname, property, value, ...) form.
   *  Property Setter's own validate() hook deletes any existing row for the
   *  same (doctype, fieldname, property) before inserting the new one, so
   *  this is already a safe upsert without needing an explicit exists-check
   *  the way write_custom_field does. */
  async writePropertySetter(args: Record<string, string>): Promise<ToolResult> {
    const { doctype, property, value } = args;
    if (!doctype || !property || value === undefined) {
      return { success: false, output: 'Missing required parameter(s): doctype, property, value' };
    }
    const activeSite = this.resolveSite(args.site);
    if (!activeSite) {
      return { success: false, output: 'Error: No site provided and no default site configured in config.json. Please configure a default site first.' };
    }

    const payload = {
      doctype,
      fieldname: args.fieldname || null,
      property,
      value,
      property_type: args.property_type || undefined,
      module: args.module || null,
    };
    const b64 = this.b64Json(payload);
    const code = `import frappe, json, base64; payload = json.loads(base64.b64decode('${b64}').decode('utf-8')); frappe.make_property_setter({'doctype': payload['doctype'], 'fieldname': payload['fieldname'], 'doctype_or_field': 'DocType' if not payload['fieldname'] else 'DocField', 'property': payload['property'], 'value': payload['value'], 'property_type': payload.get('property_type')}, module=payload.get('module')); frappe.db.commit(); print(json.dumps({'success': True}))`;

    return await this.runPythonOneLiner(activeSite, code);
  }

  /** Materializes a DocType's Custom Fields + Property Setters from the site's
   *  database into a versioned JSON file under the target app module (the same
   *  effect as Customize Form's "Export Customizations" button) — this is what
   *  actually gets write_custom_field/write_property_setter's changes into git
   *  instead of leaving them only in this one site's DB. Requires developer_mode
   *  on the site (frappe.modules.utils.export_customizations enforces this
   *  itself); the error message says so plainly if it isn't set. `apply_module_export_filter`
   *  scopes the export to rows whose own `module` field matches, so pairing this
   *  with a `module` on write_custom_field/write_property_setter matters — without
   *  it, every customization on the doctype from any source gets swept into one file. */
  async exportCustomizations(args: Record<string, string>): Promise<ToolResult> {
    const { doctype, module } = args;
    if (!doctype || !module) {
      return { success: false, output: 'Missing required parameter(s): doctype, module' };
    }
    const activeSite = this.resolveSite(args.site);
    if (!activeSite) {
      return { success: false, output: 'Error: No site provided and no default site configured in config.json. Please configure a default site first.' };
    }

    const payload = {
      doctype,
      module,
      sync_on_migrate: args.sync_on_migrate !== undefined ? args.sync_on_migrate : 1,
      with_permissions: args.with_permissions !== undefined ? args.with_permissions : 0,
      apply_module_export_filter: args.apply_module_export_filter !== undefined ? args.apply_module_export_filter : 1,
    };
    const b64 = this.b64Json(payload);
    const code = `import frappe, json, base64; from frappe.modules.utils import export_customizations; payload = json.loads(base64.b64decode('${b64}').decode('utf-8')); path = export_customizations(payload['module'], payload['doctype'], sync_on_migrate=payload['sync_on_migrate'], with_permissions=payload['with_permissions'], apply_module_export_filter=payload['apply_module_export_filter']); frappe.db.commit(); print(json.dumps({'success': True, 'path': path}))`;

    return await this.runPythonOneLiner(activeSite, code);
  }

  /** Creates or updates the (dt, view) Client Script — Frappe allows at most
   *  one per DocType per view, so this looks up any existing record first
   *  and updates it in place rather than creating a duplicate. */
  async writeClientScript(args: Record<string, string>): Promise<ToolResult> {
    const { doctype, script } = args;
    if (!doctype || !script) {
      return { success: false, output: 'Missing required parameter(s): doctype, script' };
    }
    const activeSite = this.resolveSite(args.site);
    if (!activeSite) {
      return { success: false, output: 'Error: No site provided and no default site configured in config.json. Please configure a default site first.' };
    }

    const payload = {
      doctype,
      script,
      view: args.view || 'Form',
      enabled: args.enabled !== undefined ? args.enabled : 1,
    };
    const b64 = this.b64Json(payload);
    const code = `import frappe, json, base64; payload = json.loads(base64.b64decode('${b64}').decode('utf-8')); existing = frappe.db.get_value('Client Script', {'dt': payload['doctype'], 'view': payload['view']}, 'name'); doc = frappe.get_doc('Client Script', existing) if existing else frappe.new_doc('Client Script'); doc.dt = payload['doctype']; doc.view = payload['view']; doc.script = payload['script']; doc.enabled = payload['enabled']; doc.save(); frappe.db.commit(); print(json.dumps({'success': True, 'name': doc.name, 'created': not existing}))`;

    return await this.runPythonOneLiner(activeSite, code);
  }

  /** Creates or updates a Server Script, keyed by its script_name (Server
   *  Script autonames from that field, so it doubles as a stable identity for
   *  the update-in-place lookup). Defaults to a 'DocType Event' script — pass
   *  doctype + doctype_event for that type, or api_method for an 'API' type
   *  script. Server Scripts run arbitrary Python against the live site the
   *  instant they're enabled; the caller must treat this as at least as
   *  high-risk as execute_command, not merely as a "customization". */
  async writeServerScript(args: Record<string, string>): Promise<ToolResult> {
    const { name, script } = args;
    if (!name || !script) {
      return { success: false, output: 'Missing required parameter(s): name, script' };
    }
    const activeSite = this.resolveSite(args.site);
    if (!activeSite) {
      return { success: false, output: 'Error: No site provided and no default site configured in config.json. Please configure a default site first.' };
    }

    const payload: Record<string, unknown> = {
      script_name: name,
      script,
      script_type: args.script_type || 'DocType Event',
      enabled: args.enabled !== undefined ? args.enabled : 1,
    };
    if (args.doctype) payload.reference_doctype = args.doctype;
    if (args.doctype_event) payload.doctype_event = args.doctype_event;
    if (args.api_method) payload.api_method = args.api_method;
    if (args.event_frequency) payload.event_frequency = args.event_frequency;

    const b64 = this.b64Json(payload);
    const code = `import frappe, json, base64; payload = json.loads(base64.b64decode('${b64}').decode('utf-8')); existing = frappe.db.get_value('Server Script', {'script_name': payload['script_name']}, 'name'); doc = frappe.get_doc('Server Script', existing) if existing else frappe.new_doc('Server Script'); doc.update(payload); doc.save(); frappe.db.commit(); print(json.dumps({'success': True, 'name': doc.name, 'created': not existing}))`;

    return await this.runPythonOneLiner(activeSite, code);
  }

  /** Expands one node of Frappe Builder's compact YAML block schema (el/id/name/
   *  style/attrs/text/c/m_style/t_style/classes) into the full block object its
   *  frontend expects (element/blockId/blockName/baseStyles/attributes/innerHTML/
   *  children/mobileStyles/tabletStyles/classes) — mirrors expand_yaml_to_block
   *  in the Builder app's own ai_page_generator.py so a Builder Page's `blocks`
   *  field ends up byte-for-byte the same shape whether it was generated there
   *  or here. */
  private expandYamlToBlock(node: unknown): unknown {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const n = node as Record<string, any>;
    const children = Array.isArray(n.c)
      ? n.c.filter((c: unknown) => c && typeof c === 'object' && !Array.isArray(c)).map((c: unknown) => this.expandYamlToBlock(c))
      : [];
    const block: Record<string, any> = {
      element: n.el || 'div',
      blockName: n.name || '',
      baseStyles: (n.style && typeof n.style === 'object') ? n.style : {},
      attributes: (n.attrs && typeof n.attrs === 'object') ? n.attrs : {},
      children,
    };
    const renames: [string, string][] = [
      ['id', 'blockId'],
      ['text', 'innerHTML'],
      ['m_style', 'mobileStyles'],
      ['t_style', 'tabletStyles'],
      ['classes', 'classes'],
    ];
    for (const [yamlKey, blockKey] of renames) {
      if (n[yamlKey] !== undefined) block[blockKey] = n[yamlKey];
    }
    return block;
  }

  /** Creates or updates a Builder Page's `blocks` field (the same field Frappe
   *  Builder's own AI page generator writes) from the compact YAML block tree
   *  the model produces, upserted by page_name the same way write_client_script
   *  upserts by (dt, view). The YAML->block expansion happens here in TS rather
   *  than in the Python one-liner because runPythonOneLiner can't hold a
   *  recursive function definition in a single semicolon-joined statement —
   *  only the already-expanded JSON crosses the shell/Python boundary via
   *  b64Json, so the Python side is a plain upsert-and-save. */
  async writeBuilderPage(args: Record<string, string>): Promise<ToolResult> {
    const { page_name, blocks } = args;
    if (!page_name || !blocks) {
      return { success: false, output: 'Missing required parameter(s): page_name, blocks' };
    }
    const activeSite = this.resolveSite(args.site);
    if (!activeSite) {
      return { success: false, output: 'Error: No site provided and no default site configured in config.json. Please configure a default site first.' };
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(blocks);
    } catch (e: any) {
      return { success: false, output: `Invalid YAML in 'blocks': ${e.message || String(e)}` };
    }
    const root = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, any> | undefined;
    if (!root || typeof root !== 'object') {
      return {
        success: false,
        output: "'blocks' must parse to a YAML mapping describing the root block (el/id/style/c/...), per the Design/Web Builder agent's schema."
      };
    }
    if (!root.id) root.id = 'root';
    const expandedRoot = this.expandYamlToBlock(root);

    const payload = {
      page_name,
      route: args.route || null,
      title: args.title || null,
      published: args.published !== undefined ? Number(args.published) : null,
      blocks_json: JSON.stringify([expandedRoot]),
    };
    const b64 = this.b64Json(payload);
    const code = `import frappe, json, base64; payload = json.loads(base64.b64decode('${b64}').decode('utf-8')); existing = frappe.db.get_value('Builder Page', {'page_name': payload['page_name']}, 'name'); doc = frappe.get_doc('Builder Page', existing) if existing else frappe.new_doc('Builder Page'); doc.page_name = payload['page_name']; doc.route = payload['route'] or doc.route; doc.page_title = payload['title'] or doc.page_title; doc.published = payload['published'] if payload['published'] is not None else doc.published; doc.blocks = payload['blocks_json']; doc.save(); frappe.db.commit(); print(json.dumps({'success': True, 'name': doc.name, 'route': doc.route, 'created': not existing}))`;

    return await this.runPythonOneLiner(activeSite, code);
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

  /** Dispatches a call_mcp_tool invocation to the connected MCP server. `arguments`
   *  arrives as a JSON string (this app's tool-call protocol is flat XML-ish
   *  tags, not native structured function calling) and is parsed into the
   *  object the MCP client actually sends. */
  async callMcpTool(args: Record<string, string>): Promise<ToolResult> {
    if (!this.mcpManager) return { success: false, output: 'No MCP servers configured for this workspace.' };
    const { server, tool } = args;
    if (!server || !tool) return { success: false, output: 'Missing required parameter(s): server, tool' };

    let parsedArgs: Record<string, unknown> = {};
    if (args.arguments && args.arguments.trim()) {
      try {
        parsedArgs = JSON.parse(args.arguments);
      } catch (e: any) {
        return { success: false, output: `'arguments' must be valid JSON: ${e.message}` };
      }
    }
    return await this.mcpManager.callTool(server, tool, parsedArgs);
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
