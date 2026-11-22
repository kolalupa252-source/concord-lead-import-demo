import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../node_modules/@concord-ai/concord-mcp/dist/index.js', import.meta.url));
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'concord-lead-import-'));
const repo = join(scratch, 'repo');
const profile = join(scratch, 'profile');
const clients = [];
const taskId = 'lead-import-review';
const overlapTask = 'lead-import-overlap-probe';
const files = ['src/lead-import.js', 'test/lead-import.test.js'];

async function connect(id) {
  const client = new Client({ name: id, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      TEMP: scratch,
      TMP: scratch,
      USERPROFILE: profile,
      HOME: profile,
      CONCORD_REPO_ROOT: repo,
      CONCORD_ALLOWED_ROOTS: repo,
      CONCORD_AGENT_KIND: 'demo',
      CONCORD_AGENT_ID: id,
      CONCORD_TELEMETRY_DISABLED: '1',
      CONCORD_NO_UPDATE_CHECK: '1',
    },
    stderr: 'inherit',
  });
  clients.push(client);
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) {
    const detail = response.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    throw new Error(`${name} failed: ${detail}`);
  }
  return response.structuredContent;
}

try {
  await mkdir(repo);
  await mkdir(profile);
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Concord Demo', '-c', 'user.email=demo@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Initialize synthetic workspace'], { cwd: repo });
  execFileSync(process.execPath, ['--test'], { cwd: appRoot, stdio: 'inherit' });
  const tests = ['node --test (passed)'];
  const builder = await connect('demo:builder');
  const reviewer = await connect('demo:reviewer');
  const version = builder.getServerVersion()?.version;
  assert.equal(version, '0.23.0');
  const toolList = (await builder.listTools()).tools.map(({ name }) => name).sort();
  assert.deepEqual(toolList, ['finish_work', 'inspect_work', 'start_work', 'transfer_work', 'update_work']);
  console.log(`Concord MCP ${version} exposed ${toolList.length} tools over stdio.`);

  await call(builder, 'start_work', {
    task_id: taskId,
    title: 'Implement CSV validation and retry-safe lead import',
    kind: 'implementation',
    expected_files: files,
  });
  const collision = await call(reviewer, 'start_work', {
    task_id: overlapTask,
    title: 'Check the overlap warning with a second task',
    kind: 'review',
    expected_files: [files[0]],
  });
  assert.ok(collision.overlaps.length > 0);
  await call(reviewer, 'finish_work', {
    task_id: overlapTask,
    expected_version: collision.version,
    outcome: 'closed',
    what_changed: 'Observed a warning for the shared file. Probe closed without editing it.',
  });
  console.log('The second task received a file overlap warning.');

  await call(builder, 'update_work', {
    task_id: taskId,
    kind: 'decision',
    content: 'Revalidate within a SQLite write transaction to make repeated commits safe.',
  });
  const current = await call(builder, 'inspect_work', { task_id: taskId });
  const offered = await call(builder, 'transfer_work', {
    task_id: taskId,
    action: 'offer',
    expected_version: current.task.version,
    to_agent_id: 'demo:reviewer',
    what_changed: 'CSV validation and transaction-backed deduplication with tests.',
    changed_files: files,
    tests_run: tests,
  });
  const awaiting = await call(builder, 'inspect_work', { task_id: taskId });
  assert.equal(awaiting.task.agentId, 'demo:builder');
  assert.equal(awaiting.task.status, 'handoff_offered');
  console.log('The builder retained ownership while the handoff was pending.');

  const accepted = await call(reviewer, 'transfer_work', {
    task_id: taskId,
    action: 'accept',
    expected_version: offered.version,
  });
  const inReview = await call(reviewer, 'inspect_work', { task_id: taskId });
  assert.equal(inReview.task.agentId, 'demo:reviewer');
  console.log('The reviewer became the owner after accepting.');

  await call(reviewer, 'finish_work', {
    task_id: taskId,
    expected_version: accepted.version,
    outcome: 'complete',
    what_changed: 'Checked CSV validation, rollback boundaries, and duplicate-safe retry behavior.',
    changed_files: files,
    tests_run: tests,
  });
  const completed = await call(reviewer, 'inspect_work', { task_id: taskId });
  assert.equal(completed.task.status, 'complete');
  console.log('The reviewer completed the task with changed files and the passing test command.');
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
