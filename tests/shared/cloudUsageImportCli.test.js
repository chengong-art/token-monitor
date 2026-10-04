'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { importFile } = require('../../scripts/import-cloud-usage');

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'scripts/import-cloud-usage.js');
const TASK = path.join(ROOT, 'tests/fixtures/cloud-task-usage.json');
const ACCOUNT = path.join(ROOT, 'tests/fixtures/codex-account-usage.json');
const WORKSPACE = path.join(ROOT, 'tests/fixtures/chatgpt-daily-usage.json');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-usage-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(kind, input, output) {
  return spawnSync(process.execPath, [CLI, '--kind', kind, '--input', input, '--output', output], { encoding: 'utf8' });
}

test('CLI persists a cloud ledger, reimport is idempotent, and a revision replaces it', (t) => {
  const dir = setup(t);
  const output = path.join(dir, 'ledger.json');
  const first = run('cloud-task', TASK, output);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), {
    kind: 'cloud-task-usage-ledger', scope: 'task-day', realtime: false, canCombineWithLocal: false
  });
  const before = fs.readFileSync(output, 'utf8');
  assert.equal(run('cloud-task', TASK, output).status, 0);
  assert.equal(fs.readFileSync(output, 'utf8'), before);
  assert.equal(JSON.parse(before).report.totalTokens, 130);
  const newer = JSON.parse(fs.readFileSync(TASK, 'utf8'));
  newer.records[0].revision = 2;
  newer.records[0].tokens.outputTokens = 50;
  const input = path.join(dir, 'revision.json');
  fs.writeFileSync(input, JSON.stringify(newer));
  assert.equal(run('cloud-task', input, output).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).report.totalTokens, 150);
  assert.equal(fs.existsSync(`${output}.lock`), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});

test('invalid or conflicting input leaves the previous output intact and removes the lock', (t) => {
  const dir = setup(t);
  const output = path.join(dir, 'ledger.json');
  assert.equal(run('cloud-task', TASK, output).status, 0);
  const before = fs.readFileSync(output, 'utf8');
  const conflicting = JSON.parse(fs.readFileSync(TASK, 'utf8'));
  conflicting.records[0].tokens.outputTokens = 80;
  const input = path.join(dir, 'conflict.json');
  fs.writeFileSync(input, JSON.stringify(conflicting));
  assert.equal(run('cloud-task', input, output).status, 1);
  assert.equal(fs.readFileSync(output, 'utf8'), before);
  assert.equal(fs.existsSync(`${output}.lock`), false);
  fs.writeFileSync(input, '{bad json private-fixture-text');
  const failed = run('cloud-task', input, output);
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr.includes('private-fixture-text'), false);
  assert.equal(fs.readFileSync(output, 'utf8'), before);
});

test('account imports remain separate and replace a whole snapshot rather than adding daily to lifetime', (t) => {
  const dir = setup(t);
  const output = path.join(dir, 'account.json');
  assert.equal(run('codex-account', ACCOUNT, output).status, 0);
  const saved = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(saved.report.scope, 'account');
  assert.equal(saved.report.execution, 'unknown');
  assert.equal(saved.report.summary.lifetimeTokens, 1234567);
  assert.deepEqual(saved.report.dailyUsageBuckets, [{ startDate: '2026-06-18', tokens: 12345 }]);
  assert.equal(run('codex-account', ACCOUNT, output).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), saved);
  assert.equal(run('cloud-task', TASK, output).status, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), saved);
});

test('CLI refuses a busy ledger, hardlink input/output, and symlink output', (t) => {
  const dir = setup(t);
  const output = path.join(dir, 'ledger.json');
  fs.writeFileSync(`${output}.lock`, '');
  assert.equal(run('cloud-task', TASK, output).status, 1);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.lock`), true);
  fs.unlinkSync(`${output}.lock`);
  const input = path.join(dir, 'input.json');
  fs.copyFileSync(TASK, input);
  fs.linkSync(input, output);
  assert.equal(run('cloud-task', input, output).status, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(input, 'utf8')), JSON.parse(fs.readFileSync(TASK, 'utf8')));
  fs.unlinkSync(output);
  if (process.platform !== 'win32') {
    fs.symlinkSync(input, output);
    assert.equal(run('cloud-task', input, output).status, 1);
    assert.equal(fs.lstatSync(output).isSymbolicLink(), true);
  }
});

test('workspace pages replace without aggregation, remove identities, and label only the terminal page', (t) => {
  const dir = setup(t);
  const output = path.join(dir, 'workspace.json');
  assert.equal(run('chatgpt-workspace', WORKSPACE, output).status, 0);
  const before = fs.readFileSync(output, 'utf8');
  const report = JSON.parse(before).report;
  assert.equal(report.execution, 'unknown');
  assert.equal(report.coverage, 'single-page');
  assert.equal(report.terminalPage, false);
  assert.deepEqual(report.rows[0].tokens, {
    uncachedInputTokens: 110, cachedInputTokens: 220, outputTokens: 55, totalTokens: 385
  });
  assert.equal(/fixture-user|fixture@example|fixture-cursor|cost_usd/.test(before), false);
  assert.equal(run('chatgpt-workspace', WORKSPACE, output).status, 0);
  assert.equal(fs.readFileSync(output, 'utf8'), before);
  const page = JSON.parse(fs.readFileSync(WORKSPACE, 'utf8'));
  page.has_more = false;
  page.next_page = null;
  page.data[0].totals = { text_total_tokens: 0 };
  const input = path.join(dir, 'terminal-page.json');
  fs.writeFileSync(input, JSON.stringify(page));
  assert.equal(run('chatgpt-workspace', input, output).status, 0);
  const after = JSON.parse(fs.readFileSync(output, 'utf8')).report;
  assert.equal(after.terminalPage, true);
  assert.deepEqual(after.rows[0].tokens, {
    uncachedInputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: 0
  });
  const saved = fs.readFileSync(output, 'utf8');
  page.has_more = true;
  page.next_page = '';
  fs.writeFileSync(input, JSON.stringify(page));
  assert.equal(run('chatgpt-workspace', input, output).status, 1);
  assert.equal(fs.readFileSync(output, 'utf8'), saved);
  assert.equal(run('codex-account', ACCOUNT, output).status, 1);
  assert.equal(fs.readFileSync(output, 'utf8'), saved);
});

test('CLI rejects invalid flags and oversized input without writing output', (t) => {
  const dir = setup(t);
  const input = path.join(dir, 'large.json');
  const output = path.join(dir, 'ledger.json');
  const fd = fs.openSync(input, 'w');
  fs.ftruncateSync(fd, 10 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  assert.equal(run('cloud-task', input, output).status, 1);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.lock`), false);
  const invalid = spawnSync(process.execPath, [CLI, '--kind', 'cloud-task', '--input', TASK, '--output', output, '--input', TASK], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(fs.existsSync(output), false);
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
});

test('a committed import stays successful when lock cleanup fails and reports the remaining lock', (t) => {
  const dir = setup(t);
  const output = path.join(dir, 'ledger.json');
  const lock = path.join(fs.realpathSync(dir), 'ledger.json.lock');
  const original = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (file === lock) throw Object.assign(new Error('fixture cleanup failure'), { code: 'EACCES' });
    return original(file);
  };
  let result;
  try { result = importFile({ kind: 'cloud-task', input: TASK, output }); }
  finally { fs.unlinkSync = original; }
  assert.equal(result.cleanupWarning, 'lock-cleanup-failed');
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).report.totalTokens, 130);
  assert.equal(fs.existsSync(`${output}.lock`), true);
});

test('pre-commit validation failures retain their cause even when lock cleanup also fails', (t) => {
  const dir = setup(t);
  const input = path.join(dir, 'invalid.json');
  const output = path.join(dir, 'ledger.json');
  const lock = path.join(fs.realpathSync(dir), 'ledger.json.lock');
  fs.writeFileSync(input, '{invalid');
  const original = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (file === lock) throw Object.assign(new Error('fixture cleanup failure'), { code: 'EACCES' });
    return original(file);
  };
  try {
    assert.throws(() => importFile({ kind: 'cloud-task', input, output }), { message: 'Invalid JSON' });
  } finally { fs.unlinkSync = original; }
  assert.equal(fs.existsSync(output), false);
});
