import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseDuckDuckGo, webSearch } from '../../agents/tools/webSearch';
import { resetStub, settings } from '../support/vscodeStub';

const RESULT = `<div class="result results_links web-result"><div class="links_main"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffrappeframework.com%2Fdocs&rut=x">Frappe <b>Docs</b></a></h2>
<a class="result__snippet" href="#">The <b>DocType</b> guide &amp; more</a></div></div></div>`;

test('DuckDuckGo results are parsed and their redirect links unwrapped', () => {
  assert.deepEqual(parseDuckDuckGo(RESULT), [
    { title: 'Frappe Docs', url: 'https://frappeframework.com/docs', snippet: 'The DocType guide & more' },
  ]);
});

test('a DuckDuckGo bot check is an error, not an empty result', () => {
  assert.throws(() => parseDuckDuckGo('<form id="challenge-form" action="//duckduckgo.com/anomaly.js"></form>'), /bot check/);
  assert.deepEqual(parseDuckDuckGo('<html><body>nothing</body></html>'), []);
});

test('a chosen API backend without a key fails with setup instructions', async () => {
  resetStub();
  settings.set('frappe-copilot.webSearch.provider', 'brave');
  const saved = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  const result = await webSearch('frappe');
  if (saved) process.env.BRAVE_API_KEY = saved;
  assert.equal(result.success, false);
  assert.match(result.output, /Set Web Search API Key/);
});
