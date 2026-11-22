import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { openLeadStore } from '../src/lead-import.js';
import { createLeadServer } from '../src/server.js';

test('HTTP preview, commit and retry agree with the persisted lead list', async (context) => {
  const store = openLeadStore(':memory:');
  const server = createLeadServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const csv = 'name,email,source\nRiley,riley@example.com,Web\nRiley,RILEY@example.com,Web\nBad,invalid,Web';
  const post = (endpoint, body, contentType = 'text/csv') => fetch(base + endpoint, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  const list = async () => (await (await fetch(base + '/api/leads')).json()).leads;

  const preview = await post('/api/import/preview', csv);
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).counts, { ready: 1, duplicate: 1, invalid: 1 });
  assert.deepEqual(await list(), []);

  const commit = await post('/api/import/commit', csv);
  assert.equal(commit.status, 200);
  assert.equal((await commit.json()).inserted, 1);
  const retry = await post('/api/import/commit', csv);
  assert.equal((await retry.json()).inserted, 0);
  assert.deepEqual(await list(), [{ name: 'Riley', email: 'riley@example.com', source: 'Web' }]);

  const malformed = await post('/api/import/preview', 'bad header');
  assert.equal(malformed.status, 400);
  const tooLarge = await post('/api/import/preview', 'x'.repeat(256 * 1024 + 1));
  assert.equal(tooLarge.status, 413);
  const wrongType = await post('/api/import/preview', csv, 'text/plain');
  assert.equal(wrongType.status, 415);
});
