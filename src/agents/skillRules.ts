/** Routing knowledge for the bundled skills: when each one applies, which of
 *  its reference files to attach for which topics, which tool calls make it
 *  relevant mid-run, and how to adapt its instructions to this extension.
 *  User-created skills have no rule and are matched by description instead. */

export interface ToolCallInfo {
  tool: string;
  args: Record<string, any>;
  success: boolean;
}

export interface SkillRule {
  id: string;
  /** Shown in the catalog so the model knows when to load it. */
  when: string;
  /** Request wording that means this skill applies. */
  triggers?: RegExp;
  /** Also load for any request that will change code. */
  withCodeChanges?: boolean;
  /** Never auto-load from the request — the model loads it on judgment. */
  manualOnly?: boolean;
  /** Skip if one of these skills was already selected (a more specific one wins). */
  yieldsTo?: string[];
  /** Reference files to attach alongside the skill when their topic comes up. */
  references?: { file: string; triggers: RegExp }[];
  /** A tool call that makes this skill relevant mid-run. */
  toolTrigger?: (call: ToolCallInfo) => string | null;
  /** Appended whenever the skill is loaded, to fit it to this extension. */
  adapter?: string;
}

const path = (a: Record<string, any>) => (typeof a.path === 'string' ? a.path : '');
const command = (a: Record<string, any>) => (typeof a.command === 'string' ? a.command : '');
const isWrite = (tool: string) => ['write_file', 'edit_file', 'multi_edit'].includes(tool);

export const SKILL_RULES: SkillRule[] = [
  {
    id: 'frappe-app-dev',
    when: 'any Frappe/ERPNext work: DocTypes, fields, controllers, hooks, whitelisted APIs, permissions, jobs, reports, client scripts, or bench tasks',
    triggers: /\b(doc ?types?|controllers?|hooks?(\.py)?|whitelist(ed)?|frappe\.\w+|bench|custom fields?|property setters?|mandatory|validat\w*|permissions?|roles?|schedul\w*|background jobs?|enqueue|reports?|print formats?|workspaces?|portal|web ?forms?|child tables?|naming series|fixtures?|patch(es)?|migrat\w*|sites?|client scripts?|server scripts?|endpoints?|apis?|erpnext|frappe)\b/i,
    references: [
      { file: 'references/controllers.md', triggers: /\b(validat\w*|before_\w+|after_\w+|on_(submit|cancel|update|trash)|lifecycle|controllers?|on save|hook into)\b/i },
      { file: 'references/doctypes.md', triggers: /\b(new doc ?type|create (a |the )?doc ?type|fields?|child tables?|naming|autoname|mandatory|custom fields?|property setters?)\b/i },
      { file: 'references/api.md', triggers: /\b(whitelist(ed)?|endpoints?|apis?|frappe\.call|rest)\b/i },
      { file: 'references/database.md', triggers: /\b(frappe\.(db|qb)|quer(y|ies)|sql|get_all|get_list|get_value|orm)\b/i },
      { file: 'references/hooks.md', triggers: /\b(hooks?\.py|doc_events|override\w*|fixtures?|app_include)\b/i },
      { file: 'references/permissions.md', triggers: /\b(permissions?|roles?|access|has_permission|403|forbidden|user permissions?)\b/i },
      { file: 'references/background-jobs.md', triggers: /\b(enqueue|background|schedul\w*|cron|daily|hourly|every (day|morning|night|hour|week))\b/i },
      { file: 'references/frontend-desk.md', triggers: /\b(client scripts?|form scripts?|frm\.|list ?view|buttons? on|desk ui|form view|dialogs?)\b/i },
      { file: 'references/realtime.md', triggers: /\b(realtime|websockets?|socket\.?io|publish_realtime)\b/i },
      { file: 'references/caching.md', triggers: /\b(cach\w+|redis)\b/i },
      { file: 'references/new-app.md', triggers: /\b(new app|create (an |the )?app|scaffold\w* (an |the )?app)\b/i },
      { file: 'references/site-management.md', triggers: /\b(new site|create (a )?site|install[- ]app|drop site|restore)\b/i },
      { file: 'references/testing.md', triggers: /\b(tests?|run-tests|coverage)\b/i },
    ],
  },
  {
    id: 'frappe-testing-standards',
    when: 'writing or changing tests, adding test coverage, or running bench run-tests',
    triggers: /\b(tests?|testing|coverage|unittest|frappetestcase|run-tests)\b/i,
    toolTrigger: ({ tool, args }) => {
      if (isWrite(tool) && /(^|\/)test_[^/]+\.py$/.test(path(args))) return 'you are editing a test file';
      if (tool === 'execute_command' && /\brun-tests\b/.test(command(args))) return 'you are running tests';
      return null;
    },
  },
  {
    id: 'quality-code-review',
    when: 'reviewing a diff, PR, or code for correctness, security, or performance',
    triggers: /\b(review\w*|audit|secur\w*|vulnerab\w*|injection|xss|csrf|pull request|PR|before (i|we) merge|code quality)\b/i,
  },
  {
    id: 'code-style',
    when: 'writing, editing, or refactoring any code',
    withCodeChanges: true,
    triggers: /\b(refactor\w*|clean ?up|messy|split (this|the|it)|too long|long file|code style|readab\w*)\b/i,
  },
  {
    id: 'frappe-release-workflow',
    when: 'version bumps, changelogs, commits, tags, branches, and releases',
    triggers: /\b(releases?|changelog|bump (the )?version|version bump|semver|git tag|tag (a |the )?release|commit\w*|push (it|this|that|the changes|to \w+)|release branch|ship (it|this))\b/i,
    toolTrigger: ({ tool, args }) =>
      tool === 'execute_command' && /\bgit (commit|tag|push)\b/.test(command(args)) ? 'you are committing or tagging' : null,
  },
  {
    id: 'frappe-documentation-standards',
    when: 'documenting DocTypes or controllers, docstrings, JSDoc, or docs/ pages',
    triggers: /\b(document (this|the|it|all)|documentation|docstrings?|jsdoc|write (the )?docs)\b/i,
    toolTrigger: ({ tool, args }) =>
      isWrite(tool) && /(^|\/)docs?\/[^/]+\.md$/.test(path(args)) ? 'you are writing documentation' : null,
  },
  {
    id: 'erpnextdesign',
    when: 'designing or mocking up UI that should look like Frappe/ERPNext Desk',
    triggers: /\b((look|looks|feel|match\w*|like|style) (like )?(frappe|erpnext|the desk)|desk (ui|look|style)|erpnext (style|look|theme|ui)|mock ?ups?|prototypes?)\b/i,
  },
  {
    id: 'ui-design',
    when: 'general UI/UX: layout, spacing, typography, color, polish (when no Frappe-specific design applies)',
    triggers: /\b(ui|ux|layout|spacing|typography|visual\w*|polish|landing page|redesign|look (better|nicer)|colou?rs?)\b/i,
    yieldsTo: ['erpnextdesign'],
  },
  {
    id: 'frappe-docker-bench',
    when: 'the bench runs in Docker and you need container-level commands (logs, shell, non-bench tools)',
    triggers: /\b(docker|containers?|compose)\b/i,
    adapter: 'Frappe Copilot note: execute_command already runs any command starting with `bench` inside the detected container — write plain `bench --site <site> …`, never wrap it in `docker exec` yourself. Use the docker patterns above only for non-bench commands that must run inside the container.',
  },
  {
    id: 'capture-solutions',
    when: 'right after you solved something that took several failed attempts — save the fix so it is not rediscovered',
    manualOnly: true,
    adapter: 'Frappe Copilot note: save captures with write_file to `.frappe-copilot/knowledge/<kebab-name>.md` (that folder is indexed for search_knowledge), not to ~/.claude.',
  },
];

/** Requests that will change code — gates `withCodeChanges` skills. */
export const CODE_CHANGE = /\b(add|create|implement|fix|build|write|change|update|refactor|modify|rename|remove|delete|make|extend|scaffold|wire|hook up)\b/i;
