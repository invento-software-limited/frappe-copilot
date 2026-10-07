import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { SkillsStore } from '../../agents/skillsStore';
import { SkillRouter } from '../../agents/skillRouter';
import { RunSkills } from '../../chat/runtime/runSkills';
import { buildHarness, say, Harness } from '../support/fakes';

const SKILL_BODY = '# Report builder\n\nAlways start by asking which DocType holds the data. MARKER-REPORT-WORKFLOW';

/** A harness whose skill library holds one user skill bundle. */
function withSkills(replies: Parameters<typeof buildHarness>[0]): Harness & { router: SkillRouter } {
  const h = buildHarness(replies);
  const dataDir = path.join(h.root, '..', 'data');
  const dir = path.join(dataDir, 'skills', 'frappe-report-dashboard-builder');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: frappe-report-dashboard-builder\ndescription: Build Frappe reports and dashboards from a business question.\n---\n${SKILL_BODY}\n`);
  const store = new SkillsStore(dataDir);
  const router = new SkillRouter(store);
  (h.runtime as any).skills = new RunSkills(router, store, h.runtime.deps.ui);
  (h.runtime.deps.project as any).skillRouter = router;
  return Object.assign(h, { router });
}

const systemPrompt = (h: Harness, call: number) => h.provider.requests[call].messages[0].content;

test('a skill picked with "/" is loaded, saved on the message, and announced', async () => {
  const h = withSkills([say('On it.')]);
  try {
    await h.runtime.orchestrator.run('create an employee task report', undefined, ['frappe-report-dashboard-builder']);
    assert.match(systemPrompt(h, 0), /MARKER-REPORT-WORKFLOW/);
    assert.match(systemPrompt(h, 0), /explicitly asked you to use 'frappe-report-dashboard-builder'/);
    const [userMsg] = h.sessions.readMessages(h.sessions.activeSession!.id);
    assert.deepEqual(userMsg.skills, ['frappe-report-dashboard-builder']);
    assert.equal(userMsg.content, 'create an employee task report');   // no pasted skill text
    const event = h.ui.ofType('skillEvent').find(e => e.id === 'frappe-report-dashboard-builder');
    assert.equal(event.auto, false);
  } finally { h.cleanup(); }
});

test('naming a skill in the message loads it too', async () => {
  const h = withSkills([say('On it.')]);
  try {
    await h.runtime.orchestrator.run('frappe-report-dashboard-builder use this skill');
    assert.match(systemPrompt(h, 0), /MARKER-REPORT-WORKFLOW/);
    assert.deepEqual(h.sessions.readMessages(h.sessions.activeSession!.id)[0].skills, ['frappe-report-dashboard-builder']);
    assert.deepEqual(h.router.mentionedIn('try /frappe-report-dashboard-builder now'), ['frappe-report-dashboard-builder']);
    assert.deepEqual(h.router.mentionedIn('frappe-report-dashboard-builder-v2 is different'), []);
  } finally { h.cleanup(); }
});

test('a requested skill stays loaded for later turns in the session', async () => {
  const h = withSkills([say('Started.'), say('Continued.')]);
  try {
    await h.runtime.orchestrator.run('build the report', undefined, ['frappe-report-dashboard-builder']);
    await h.runtime.orchestrator.run('now add a monthly filter');
    assert.match(systemPrompt(h, 1), /MARKER-REPORT-WORKFLOW/);
  } finally { h.cleanup(); }
});

test('an empty reply is nudged instead of ending the run silently', async () => {
  const h = buildHarness([say(''), say('Here is the answer.')]);
  try {
    await h.runtime.orchestrator.run('hi');
    assert.match(h.provider.requests[1].messages.at(-1)!.content, /Your last reply was empty/);
    assert.equal(h.sessions.readMessages(h.sessions.activeSession!.id).at(-1)!.content, 'Here is the answer.');
  } finally { h.cleanup(); }
});

test('repeated empty replies stop the run with a visible note', async () => {
  const h = buildHarness([say(''), say(''), say('')]);
  try {
    await h.runtime.orchestrator.run('hi');
    assert.equal(h.provider.requests.length, 3);
    assert.match(h.sessions.readMessages(h.sessions.activeSession!.id).at(-1)!.content, /empty reply 3 times in a row/);
  } finally { h.cleanup(); }
});
