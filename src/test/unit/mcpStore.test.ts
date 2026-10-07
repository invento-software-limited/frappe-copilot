import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The store keeps a global config under the home directory — point it at a
// temp dir before the module loads (each test file runs in its own process).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
 
const { MCPStore } = require('../../mcp/store') as typeof import('../../mcp/store');

test('a malformed mcp.json is never overwritten', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mcp-'));
  const fp = path.join(ws, '.frappe-copilot');
  fs.mkdirSync(fp);
  const broken = '{ "servers": [ { "id": "manual:db", "name": "db", } ] }';
  fs.writeFileSync(path.join(fp, 'mcp.json'), broken);

  const warn = console.warn, error = console.error;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    const store = new MCPStore(fp, ws);
    assert.deepEqual(store.listServers().filter(s => s.source === 'manual'), []);
    store.addServer({ name: 'new', transport: 'stdio', command: 'x', enabled: true } as any);
  } finally {
    console.warn = warn;
    console.error = error;
  }
  assert.equal(fs.readFileSync(path.join(fp, 'mcp.json'), 'utf-8'), broken);
  fs.rmSync(ws, { recursive: true });
  fs.rmSync(home, { recursive: true, force: true });
});
