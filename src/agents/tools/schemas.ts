import { ToolSpec } from '../../types';
import { ToolName } from '../types';
import { TOOL_DOCS } from '../toolDocs';

type Props = Record<string, any>;

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });
const SITE = str('Site name. Omit to use the configured default site.');

function schema(properties: Props, required: string[] = []): Record<string, any> {
  return { type: 'object', properties, required };
}

/** Input schemas for native tool calling. Keys mirror the XML tags in
 *  TOOL_DOCS, so both protocols reach ToolExecutor with the same args. */
const PARAMETERS: Record<ToolName, Record<string, any>> = {
  read_file: schema({
    path: str('File path, relative to the workspace root.'),
    offset: int('1-based line to start from. Only for files too long to read at once.'),
    limit: int('Number of lines to read (default 2000).'),
  }, ['path']),
  write_file: schema({
    path: str('File path, relative to the workspace root.'),
    content: str('Complete file content.'),
  }, ['path', 'content']),
  edit_file: schema({
    path: str('File path, relative to the workspace root.'),
    search: str('Exact text to replace, copied from read_file output without the line-number prefix.'),
    replace: str('Replacement text.'),
    replace_all: bool('Replace every occurrence instead of requiring a unique match.'),
  }, ['path', 'search', 'replace']),
  multi_edit: schema({
    path: str('File path, relative to the workspace root.'),
    edits: {
      type: 'array',
      description: 'Edits applied in order; all succeed or none are written.',
      items: schema({
        search: str('Exact text to replace.'),
        replace: str('Replacement text.'),
        replace_all: bool('Replace every occurrence.'),
      }, ['search', 'replace']),
    },
  }, ['path', 'edits']),
  list_dir: schema({ path: str('Directory path, relative to the workspace root. Defaults to the root.') }),
  grep_search: schema({
    pattern: str('Regular expression (ripgrep syntax). Escape literal braces/parens.'),
    path: str('File or directory to search. Defaults to the workspace root.'),
    glob: str('Filter files by glob, e.g. "*.py" or "**/doctype/**/*.json".'),
    type: str('Filter by file type, e.g. py, js, ts, json, html, css.'),
    output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'content (default): matching lines; files_with_matches: paths only; count: matches per file.' },
    case_insensitive: bool('Case-insensitive match.'),
    context: int('Lines of context around each match (content mode, max 10).'),
    head_limit: int('Max result lines to return (default 200).'),
  }, ['pattern']),
  glob: schema({
    pattern: str('Glob pattern, e.g. "**/hooks.py" or "**/doctype/*/*.json".'),
    path: str('Directory to search in. Defaults to the workspace root.'),
  }, ['pattern']),
  execute_command: schema({
    command: str('Shell command. Commands starting with "bench" run in the detected bench environment.'),
    timeout: int('Timeout in seconds (default 1200, max 3600).'),
    run_in_background: bool('Start without waiting (servers, watchers). Poll with command_output.'),
  }, ['command']),
  command_output: schema({
    id: str('Background command id returned by execute_command.'),
    filter: str('Optional regex; only matching lines are returned.'),
  }, ['id']),
  task: schema({
    subagent_type: str('Sub-agent type id (see description), e.g. explore.'),
    description: str('3-5 word summary shown to the user.'),
    prompt: str('Complete, self-contained brief, including what to report back.'),
  }, ['subagent_type', 'description', 'prompt']),
  search_knowledge: schema({
    query: str('Natural-language question or topic.'),
    limit: int('Max results (default 6).'),
  }, ['query']),
  list_doctypes: schema({ filter: str('Case-insensitive substring to filter DocType names.') }),
  kill_command: schema({ id: str('Background command id to stop.') }, ['id']),
  introspect_doctype: schema({ doctype: str('DocType name.'), site: SITE }, ['doctype']),
  list_customizations: schema({ doctype: str('DocType name.'), site: SITE }, ['doctype']),
  ask_clarification: schema({ questions: str('Numbered questions; options as "- " bullets under a question (see description).') }, ['questions']),
  update_todo_list: schema({
    todos: {
      type: 'array',
      description: 'The complete list (it replaces the previous one).',
      items: schema({
        content: str('The task, imperative form, e.g. "Add validation to Sales Visit".'),
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
        activeForm: str('Present-continuous form shown while it runs, e.g. "Adding validation to Sales Visit".'),
      }, ['content', 'status']),
    },
  }, ['todos']),
  web_search: schema({ query: str('Search query.') }, ['query']),
  web_fetch: schema({ url: str('Full URL to fetch.') }, ['url']),
  use_skill: schema({ id: str('Skill id from the catalog, or "<skill-id>/<reference path>".') }, ['id']),
  write_custom_field: schema({
    doctype: str('Target DocType.'), fieldname: str('Field name, e.g. custom_region.'), fieldtype: str('Frappe field type.'),
    label: str('Label.'), options: str('Link target or newline-separated Select options.'), insert_after: str('Fieldname to insert after.'),
    reqd: str('0 or 1.'), read_only: str('0 or 1.'), in_list_view: str('0 or 1.'), depends_on: str('eval: condition.'),
    description: str('Field description.'), default: str('Default value.'), module: str('Owning module, for export_customizations.'), site: SITE,
  }, ['doctype', 'fieldname', 'fieldtype']),
  write_property_setter: schema({
    doctype: str('Target DocType.'), fieldname: str('Field name; omit for a doctype-level property.'), property: str('Property name.'),
    value: str('New value.'), property_type: str('Data, Check, Int, Select, Text, ...'), module: str('Owning module.'), site: SITE,
  }, ['doctype', 'property', 'value']),
  export_customizations: schema({
    doctype: str('DocType to export.'), module: str('App module to export into.'), sync_on_migrate: str('0 or 1 (default 1).'),
    with_permissions: str('0 or 1 (default 0).'), apply_module_export_filter: str('0 or 1 (default 1).'), site: SITE,
  }, ['doctype', 'module']),
  write_client_script: schema({
    doctype: str('Target DocType.'), script: str('JavaScript source.'), view: str('Form or List (default Form).'), enabled: str('0 or 1.'), site: SITE,
  }, ['doctype', 'script']),
  write_server_script: schema({
    name: str('Script name (upsert key).'), script: str('Python source.'), script_type: str('DocType Event, API, Scheduler Event, or Permission Query.'),
    doctype: str('Reference DocType.'), doctype_event: str('e.g. Before Save.'), api_method: str('API endpoint path.'),
    event_frequency: str('e.g. Daily.'), enabled: str('0 or 1.'), site: SITE,
  }, ['name', 'script']),
  write_builder_page: schema({
    page_name: str('Unique page key.'), blocks: str('YAML block tree (see description).'), route: str('URL path.'),
    title: str('Page title.'), published: str('0 or 1.'), site: SITE,
  }, ['page_name', 'blocks']),
  call_mcp_tool: schema({
    server: str('Server id from the MCP catalog.'), tool: str('Tool name from the catalog.'),
    arguments: { type: 'object', description: 'Arguments object for the MCP tool.' },
  }, ['server', 'tool']),
  scaffold_app: schema({
    app_name: str('snake_case app name.'), app_title: str('Title.'), app_description: str('Description.'),
    app_publisher: str('Publisher.'), app_email: str('Email.'), app_license: str('License.'), branch_name: str('Git branch.'),
  }, ['app_name']),
  scaffold_doctype: schema({
    name: str('DocType name.'), app: str('Target app.'), module: str('Module (auto-detected when the app has one).'), site: SITE,
  }, ['name', 'app']),
};

/** Builds the native tool list for an agent's allowlist. */
export function buildToolSpecs(tools: ToolName[]): ToolSpec[] {
  return tools.map(name => ({ name, description: describe(name), parameters: PARAMETERS[name] }));
}

/** The tool's prose doc without its XML "Format:" example. */
function describe(name: ToolName): string {
  return TOOL_DOCS[name].split(/\nFormat:\n/)[0].trim();
}
