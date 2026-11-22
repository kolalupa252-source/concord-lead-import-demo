import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openLeadStore, ValidationError } from '../src/lead-import.js';

const SAMPLE_CSV = [
  '\uFEFFname,email,source',
  '"Ellis, Robin",ROBIN@example.com,Event',
  'Robin Ellis,robin@example.com,Referral',
  'Sam,invalid-email,Website',
  'Morgan,morgan@example.com,Referral',
  'One column only',
].join('\r\n');

test('previews quoted data, duplicates and invalid rows without persisting the result', (t) => {
  const store = openLeadStore(':memory:');
  t.after(() => store.close());

  const result = store.preview(SAMPLE_CSV);
  assert.deepEqual(result.counts, { ready: 2, duplicate: 1, invalid: 2 });
  assert.equal(result.inserted, 0);
  assert.deepEqual(result.rows[0], {
    line: 2,
    name: 'Ellis, Robin',
    email: 'robin@example.com',
    source: 'Event',
    status: 'ready',
    reason: '',
  });
  assert.match(result.rows[1].reason, /repeats/);
  assert.match(result.rows[2].reason, /valid email/);
  assert.match(result.rows[4].reason, /three columns/);
  assert.deepEqual(store.list(), []);
});

test('commits the valid subset in input order and skips repeated imports', (t) => {
  const store = openLeadStore(':memory:');
  t.after(() => store.close());

  const first = store.commit(SAMPLE_CSV);
  assert.equal(first.inserted, 2);
  assert.deepEqual(first.counts, { ready: 2, duplicate: 1, invalid: 2 });

  const repeated = store.commit(SAMPLE_CSV);
  assert.equal(repeated.inserted, 0);
  assert.deepEqual(repeated.counts, { ready: 0, duplicate: 3, invalid: 2 });
  assert.match(repeated.rows[0].reason, /already in the lead list/);
  assert.deepEqual(store.list(), [
    { name: 'Ellis, Robin', email: 'robin@example.com', source: 'Event' },
    { name: 'Morgan', email: 'morgan@example.com', source: 'Referral' },
  ]);
});

test('rechecks the persisted lead list when a second connection imports after preview', () => {
  const directory = mkdtempSync(join(tmpdir(), 'concord-lead-import-'));
  const filename = join(directory, 'leads.sqlite');
  const first = openLeadStore(filename);
  const second = openLeadStore(filename);
  const csv = 'name,email,source\nTaylor,taylor@example.com,Event';

  try {
    assert.equal(first.preview(csv).counts.ready, 1);
    assert.equal(second.commit(csv).inserted, 1);
    assert.equal(first.commit(csv).inserted, 0);
    assert.equal(first.list().length, 1);
  } finally {
    first.close();
    second.close();
    unlinkSync(filename);
    rmdirSync(directory);
  }
});

test('accepts reordered headers, blank lines and multiline quoted records', (t) => {
  const store = openLeadStore(':memory:');
  t.after(() => store.close());

  for (const newline of ['\n', '\r\n']) {
    const csv = [
      '\uFEFFSource, Email, Name',
      '',
      '"Event',
      'booth",lee@example.com,Léa',
      'Website,kai@example.com,Kai',
    ].join(newline);
    const report = store.preview(csv);

    assert.deepEqual(report.rows.map(({ line }) => line), [3, 5]);
    assert.equal(report.rows[0].source, `Event${newline}booth`);
    assert.equal(report.rows[0].name, 'Léa');
    assert.equal(report.counts.ready, 2);
  }
});

test('rejects malformed quotes, missing or duplicate headers, and oversized files', (t) => {
  const store = openLeadStore(':memory:');
  t.after(() => store.close());

  assert.throws(() => store.commit('name,email,source\n"Unclosed,unclosed@example.com,Event'), {
    name: 'ValidationError',
    message: /Malformed CSV.*line 2/,
  });
  assert.throws(() => store.preview('name,email,email'), ValidationError);
  assert.throws(() => store.preview('name,email'), ValidationError);
  assert.throws(() => store.preview('x'.repeat(256 * 1024 + 1)), /256 KiB/);

  const rows = Array.from({ length: 501 }, (_, i) => `Lead ${i},lead${i}@example.com,Event`);
  assert.equal(store.preview(['name,email,source', ...rows.slice(0, 500)].join('\n')).counts.ready, 500);
  assert.throws(() => store.preview(['name,email,source', ...rows].join('\n')), /500 rows/);
  assert.deepEqual(store.list(), []);
});
