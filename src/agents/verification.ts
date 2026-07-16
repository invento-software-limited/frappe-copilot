import * as fs from 'fs';
import * as path from 'path';

export type TouchedFileKind = 'doctype-json' | 'controller-py' | 'client-js' | 'other';

export interface TouchedFile {
  path: string;
  kind: TouchedFileKind;
  app?: string;
  doctype?: string;
}

export interface VerificationOutcome {
  ran: boolean;
  passed: boolean;
  roundsUsed: number;
  missingTestNotes: string[];
  lastError?: string;
  skippedReason?: string;
}

export const VERIFY_MAX_ROUNDS = 2;
export const VERIFY_FIX_STEP_BUDGET = 4;

function toTitleCase(slug: string): string {
  return slug.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function resolveApp(relPath: string): string | undefined {
  const match = relPath.replace(/\\/g, '/').match(/^apps\/([^/]+)\//);
  return match ? match[1] : undefined;
}

/** Reads a DocType JSON's real `name` field (Frappe's --doctype flag needs the
 *  exact display name, e.g. "Loyalty Point Entry", not the snake_case folder slug). */
function readDocTypeName(absPath: string, slug: string): string {
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.name === 'string' && parsed.name) return parsed.name;
  } catch {
    // fall through to slug fallback
  }
  return toTitleCase(slug);
}

/** Classifies a written/edited file so the verification phase knows whether a
 *  migrate and/or scoped test run is relevant. Never model-invoked — called
 *  directly by the harness right after a successful write_file/edit_file. */
export function classifyTouchedFile(relPath: string, absPath: string): TouchedFile {
  const normalized = relPath.replace(/\\/g, '/');
  const app = resolveApp(normalized);

  const doctypeJsonMatch = normalized.match(/\/doctype\/([^/]+)\/\1\.json$/);
  if (doctypeJsonMatch) {
    const slug = doctypeJsonMatch[1];
    return { path: relPath, kind: 'doctype-json', app, doctype: readDocTypeName(absPath, slug) };
  }

  const doctypeFolderMatch = normalized.match(/\/doctype\/([^/]+)\/([^/]+)$/);
  if (doctypeFolderMatch && normalized.endsWith('.py')) {
    const slug = doctypeFolderMatch[1];
    const siblingJson = path.join(path.dirname(absPath), `${slug}.json`);
    const doctype = fs.existsSync(siblingJson) ? readDocTypeName(siblingJson, slug) : toTitleCase(slug);
    return { path: relPath, kind: 'controller-py', app, doctype };
  }
  if (doctypeFolderMatch && normalized.endsWith('.js')) {
    const slug = doctypeFolderMatch[1];
    const siblingJson = path.join(path.dirname(absPath), `${slug}.json`);
    const doctype = fs.existsSync(siblingJson) ? readDocTypeName(siblingJson, slug) : toTitleCase(slug);
    return { path: relPath, kind: 'client-js', app, doctype };
  }

  if (normalized.endsWith('.py')) {
    return { path: relPath, kind: 'controller-py', app };
  }
  if (normalized.endsWith('.js')) {
    return { path: relPath, kind: 'client-js', app };
  }
  return { path: relPath, kind: 'other', app };
}

export interface TestCommand {
  description: string;
  command: (site: string) => string;
}

export interface VerificationPlan {
  shouldMigrate: boolean;
  app?: string;
  testCommands: TestCommand[];
  missingTestNotes: string[];
}

const migrateCmd = (site: string) => `bench --site ${site} migrate`;
const testDoctypeCmd = (site: string, app: string, doctype: string) =>
  `bench --site ${site} run-tests --app ${app} --doctype "${doctype}"`;
const testModuleCmd = (site: string, modulePath: string) =>
  `bench --site ${site} run-tests --module ${modulePath}`;

/** Derives the dotted module path Frappe's `run-tests --module` expects from a
 *  workspace-relative .py path, e.g. "apps/my_app/my_app/api/points.py" ->
 *  "my_app.api.points". */
function toDottedModule(relPath: string, app: string): string | null {
  const normalized = relPath.replace(/\\/g, '/');
  const marker = `apps/${app}/`;
  const idx = normalized.indexOf(marker);
  if (idx === -1) return null;
  const rest = normalized.slice(idx + marker.length).replace(/\.py$/, '');
  return rest.split('/').join('.');
}

/** Resolves the most-touched app across a run, picks the narrowest test scope
 *  it can find an actual test_*.py for, and never falls back to a blind
 *  full-app test run — a missing test just gets noted, not papered over. */
export function buildVerificationPlan(touchedFiles: TouchedFile[], root: string): VerificationPlan {
  const shouldMigrate = touchedFiles.some(f => f.kind === 'doctype-json');

  const appCounts = new Map<string, number>();
  for (const f of touchedFiles) {
    if (f.app) appCounts.set(f.app, (appCounts.get(f.app) || 0) + 1);
  }
  let app: string | undefined;
  let bestCount = 0;
  for (const [candidate, count] of appCounts) {
    if (count > bestCount) { app = candidate; bestCount = count; }
  }

  const testCommands: TestCommand[] = [];
  const missingTestNotes: string[] = [];
  const seenDoctypes = new Set<string>();
  const seenModules = new Set<string>();

  for (const f of touchedFiles) {
    if ((f.kind === 'doctype-json' || f.kind === 'controller-py') && f.doctype && f.app) {
      if (seenDoctypes.has(f.doctype)) continue;
      seenDoctypes.add(f.doctype);
      const slug = f.doctype.toLowerCase().replace(/\s+/g, '_');
      const testFile = path.join(root, path.dirname(f.path), `test_${slug}.py`);
      if (fs.existsSync(testFile)) {
        testCommands.push({
          description: `run-tests --doctype "${f.doctype}"`,
          command: (site) => testDoctypeCmd(site, f.app!, f.doctype!),
        });
      } else {
        missingTestNotes.push(
          `No test coverage found for DocType '${f.doctype}' — verification only confirms it compiles and migrates cleanly, not behavior.`
        );
      }
    } else if (f.kind === 'controller-py' && !f.doctype && f.app) {
      const testFile = path.join(root, path.dirname(f.path), `test_${path.basename(f.path, '.py')}.py`);
      const modulePath = toDottedModule(f.path, f.app);
      if (modulePath && !seenModules.has(modulePath) && fs.existsSync(testFile)) {
        seenModules.add(modulePath);
        testCommands.push({
          description: `run-tests --module ${modulePath}`,
          command: (site) => testModuleCmd(site, modulePath),
        });
      } else if (modulePath && !seenModules.has(modulePath)) {
        seenModules.add(modulePath);
        missingTestNotes.push(`No test coverage found for '${f.path}' — verification only confirms it compiles and migrates cleanly, not behavior.`);
      }
    }
  }

  return { shouldMigrate, app, testCommands, missingTestNotes };
}

export { migrateCmd };
