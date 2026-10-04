'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeCodexAccountUsage, importCloudTaskUsage } = require('../../src/shared/cloudUsageImport');

function tokens(overrides = {}) {
  return { inputTokens: 10, cachedInputTokens: 3, outputTokens: 5, reasoningOutputTokens: 2, ...overrides };
}

function record(overrides = {}) {
  return {
    provider: 'openai', scopeId: 'workspace-a', taskId: 'task-a', date: '2026-10-04',
    model: 'gpt-example', revision: 1, measurement: 'reported', execution: 'cloud', tokens: tokens(),
    ...overrides
  };
}

function envelope(records = [], extra = {}) {
  return { version: 1, kind: 'cloud-task-usage', records, ...extra };
}

test('account usage preserves missing, null and explicitly reported zero', () => {
  assert.deepEqual(normalizeCodexAccountUsage({ summary: {} }).summary, { lifetimeTokens: null, peakDailyTokens: null });
  assert.deepEqual(normalizeCodexAccountUsage({ summary: { lifetimeTokens: 0, peakDailyTokens: null } }).summary,
    { lifetimeTokens: 0, peakDailyTokens: null });
  for (const result of [{ summary: {} }, { summary: {}, dailyUsageBuckets: null }]) {
    assert.equal(normalizeCodexAccountUsage(result).dailyUsageBuckets, null);
  }
  assert.deepEqual(normalizeCodexAccountUsage({ summary: {}, dailyUsageBuckets: [] }).dailyUsageBuckets, []);
  assert.throws(() => normalizeCodexAccountUsage({ summary: { lifetimeTokens: undefined } }), /safe integer/);
});

test('account usage accepts raw results and JSON-RPC results without inferring cloud or a combined total', () => {
  const result = { summary: { lifetimeTokens: 100, peakDailyTokens: 90 }, dailyUsageBuckets: [{ startDate: '2026-10-04', tokens: 30 }], threadUsage: null };
  const expected = {
    source: 'codex-account-usage', scope: 'account', execution: 'unknown', measurement: 'reported',
    canCombineWithLocal: false, realtime: false,
    summary: { lifetimeTokens: 100, peakDailyTokens: 90 }, dailyUsageBuckets: [{ startDate: '2026-10-04', tokens: 30 }]
  };
  assert.deepEqual(normalizeCodexAccountUsage(result), expected);
  assert.deepEqual(normalizeCodexAccountUsage({ id: 1, result }), expected);
  assert.equal(Object.hasOwn(expected, 'totalTokens'), false);
  assert.equal(normalizeCodexAccountUsage({ summary: { lifetimeTokens: 100, peakDailyTokens: 90 } }).dailyUsageBuckets, null);
});

test('account usage rejects malformed envelopes, errors, estimated task/thread fields and non-reported markers', () => {
  for (const bad of [null, [], 'usage', {}, { summary: null }, { summary: [] }, { result: { summary: {} } },
    { id: 1, result: null }, { id: {}, result: { summary: {} } }, { id: 1, error: { message: 'secret' } },
    { summary: {}, error: null }, { summary: {}, threadUsage: {} }, { summary: {}, threadUsage: [] },
    { summary: { estimatedTokens: 1 } }, { summary: {}, taskUsage: { tokens: 1 } },
    { summary: {}, estimatedTaskTokens: 1 }, { summary: {}, measurement: 'estimated' }]) {
    assert.throws(() => normalizeCodexAccountUsage(bad), TypeError);
  }
});

test('account counts reject strings, negatives, fractions, unsafe integers and explicit undefined', () => {
  for (const bad of ['0', -1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, undefined]) {
    for (const field of ['lifetimeTokens', 'peakDailyTokens']) {
      assert.throws(() => normalizeCodexAccountUsage({ summary: { [field]: bad } }), TypeError);
    }
    assert.throws(() => normalizeCodexAccountUsage({ summary: {}, dailyUsageBuckets: [{ startDate: '2026-10-04', tokens: bad }] }), TypeError);
  }
});

test('account daily buckets sort and deduplicate identical days but reject conflicting duplicate counts', () => {
  const first = { startDate: '2026-10-04', tokens: 2 };
  assert.deepEqual(normalizeCodexAccountUsage({ summary: {}, dailyUsageBuckets: [first, { startDate: '2026-10-03', tokens: 0 }, first] }).dailyUsageBuckets,
    [{ startDate: '2026-10-03', tokens: 0 }, first]);
  assert.throws(() => normalizeCodexAccountUsage({ summary: {}, dailyUsageBuckets: [first, { ...first, tokens: 3 }] }), /conflicting/);
});

test('dates require exact UTC days, including leap-year calendar validation', () => {
  for (const bad of ['2026-02-29', '2024-02-30', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-01',
    '2026-01-00', '2026-1-01', '2026-10-04T00:00:00Z', ' 2026-10-04', '2026-10-04 ', 20261004, null]) {
    assert.throws(() => normalizeCodexAccountUsage({ summary: {}, dailyUsageBuckets: [{ startDate: bad, tokens: 0 }] }), /UTC date/);
    assert.throws(() => importCloudTaskUsage(envelope([record({ date: bad })])), /UTC date/);
  }
  for (const date of ['2024-02-29', '2000-02-29', '2026-12-31']) {
    assert.equal(importCloudTaskUsage(envelope([record({ date })])).records[0].date, date);
  }
});

test('account whitelist drops sensitive metadata and never echoes secret values on validation failures', () => {
  const secret = 'PRIVATE_PROMPT_AND_CREDENTIAL';
  const result = normalizeCodexAccountUsage({
    summary: { lifetimeTokens: 10, peakDailyTokens: 5, title: secret, email: secret },
    dailyUsageBuckets: [{ startDate: '2026-10-04', tokens: 5, rawPrompt: secret, auth: secret }],
    email: secret, auth: { accessToken: secret }, rawPrompt: secret, threadUsage: null
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.throws(() => normalizeCodexAccountUsage({ summary: { lifetimeTokens: secret } }), error => !error.message.includes(secret));
});

test('cloud report counts input plus output once, with cached/reasoning subsets reported separately', () => {
  const result = importCloudTaskUsage(envelope([record(), record({ taskId: 'task-b', date: '2026-10-03', tokens: tokens({ inputTokens: 20, cachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 10 }) })]));
  assert.deepEqual(result.report, {
    source: 'cloud-task-import', scope: 'task-day', execution: 'cloud', measurement: 'reported',
    realtime: false, canCombineWithLocal: false, recordCount: 2, totalTokens: 45,
    inputTokens: 30, cachedInputTokens: 23, outputTokens: 15, reasoningOutputTokens: 12,
    daily: [{ date: '2026-10-03', totalTokens: 30 }, { date: '2026-10-04', totalTokens: 15 }]
  });
});

test('empty and explicitly zero cloud snapshots remain distinct from missing usage', () => {
  assert.equal(importCloudTaskUsage(envelope()).report.recordCount, 0);
  const zero = record({ tokens: tokens({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }) });
  const result = importCloudTaskUsage(envelope([zero]));
  assert.equal(result.report.recordCount, 1);
  assert.equal(result.report.totalTokens, 0);
  assert.deepEqual(result.report.daily, [{ date: '2026-10-04', totalTokens: 0 }]);
  for (const missing of [undefined, null, {}, { inputTokens: 0, outputTokens: 0 }]) {
    assert.throws(() => importCloudTaskUsage(envelope([record({ tokens: missing })])), TypeError);
  }
});

test('cloud records reject metadata-only, quota-only, local, estimated and unsupported envelopes', () => {
  for (const bad of [null, [], {}, { version: 2, kind: 'cloud-task-usage', records: [] },
    { version: 1, kind: 'codex-account-usage', records: [] }, envelope(null), envelope({}),
    envelope([record({ measurement: 'estimated' })]), envelope([record({ execution: 'local' })]),
    envelope([record({ measurement: undefined })]), envelope([record({ execution: undefined })]),
    envelope([{ provider: 'openai', taskId: 'task-a', title: 'Cloud task' }]),
    envelope([record({ tokens: undefined, quotaRemaining: 50 })]),
    envelope([record({ estimatedTokens: 10 })]), envelope([record({ threadUsage: { tokens: 10 } })]),
    envelope([record({ tokens: tokens({ estimatedUsage: 15 }) })]), envelope([], { measurement: 'estimated' })]) {
    assert.throws(() => importCloudTaskUsage(bad), TypeError);
  }
});

test('cloud token components require non-negative safe integers and valid subset relationships', () => {
  for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']) {
    for (const bad of ['1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, null, undefined]) {
      assert.throws(() => importCloudTaskUsage(envelope([record({ tokens: tokens({ [field]: bad }) })])), TypeError);
    }
  }
  assert.throws(() => importCloudTaskUsage(envelope([record({ tokens: tokens({ cachedInputTokens: 11 }) })])), /subset of inputTokens/);
  assert.throws(() => importCloudTaskUsage(envelope([record({ tokens: tokens({ reasoningOutputTokens: 6 }) })])), /subset of outputTokens/);
});

test('cloud identities are bounded opaque strings and revisions are positive safe integers', () => {
  for (const field of ['provider', 'scopeId', 'taskId', 'model']) {
    for (const bad of ['', ' \t', 'a'.repeat(201), 1, null, undefined]) {
      assert.throws(() => importCloudTaskUsage(envelope([record({ [field]: bad })])), TypeError);
    }
    assert.equal(importCloudTaskUsage(envelope([record({ [field]: 'a'.repeat(200) })])).records[0][field], 'a'.repeat(200));
    assert.equal(importCloudTaskUsage(envelope([record({ [field]: ' Case-sensitive id ' })])).records[0][field], ' Case-sensitive id ');
  }
  for (const bad of [0, -1, '1', 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    assert.throws(() => importCloudTaskUsage(envelope([record({ revision: bad })])), /revision/);
  }
});

test('same snapshot imports deduplicate within and across exports independent of export/device metadata', () => {
  const first = importCloudTaskUsage(envelope([record({ exportName: 'first', deviceId: 'laptop' }), record({ exportName: 'second', deviceId: 'desktop' })], { filename: 'first.json' }));
  const second = importCloudTaskUsage(envelope([record({ exporter: 'another-exporter', exportName: 'third', deviceId: 'phone' })], { filename: 'second.json' }), first);
  assert.equal(first.report.recordCount, 1);
  assert.deepEqual(second, first);
  assert.equal(second.report.totalTokens, 15);
});

test('higher revision snapshots replace rather than add, including downward corrections', () => {
  const first = importCloudTaskUsage(envelope([record()]));
  const grown = importCloudTaskUsage(envelope([record({ revision: 2, tokens: tokens({ inputTokens: 30, outputTokens: 20 }) })]), first);
  const corrected = importCloudTaskUsage(envelope([record({ revision: 3, tokens: tokens({ inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, reasoningOutputTokens: 0 }) })]), grown);
  assert.equal(first.report.totalTokens, 15);
  assert.equal(grown.report.totalTokens, 50);
  assert.equal(corrected.report.totalTokens, 5);
  assert.equal(corrected.records[0].revision, 3);
  assert.equal(corrected.report.recordCount, 1);
});

test('stale revisions are ignored and latest snapshot selection is independent of import order', () => {
  const newer = record({ revision: 3, tokens: tokens({ inputTokens: 50 }) });
  const older = record({ revision: 1, tokens: tokens({ inputTokens: 2, cachedInputTokens: 0 }) });
  const baseline = importCloudTaskUsage(envelope([newer]));
  assert.deepEqual(importCloudTaskUsage(envelope([older]), baseline), baseline);
  assert.deepEqual(importCloudTaskUsage(envelope([newer, older])), importCloudTaskUsage(envelope([older, newer])));
});

test('same-revision conflicts fail atomically even when another snapshot or later revision came first', () => {
  const baseline = importCloudTaskUsage(envelope([record()]));
  const untouched = JSON.stringify(baseline);
  const conflict = record({ tokens: tokens({ inputTokens: 11 }) });
  for (const records of [[record({ taskId: 'task-b' }), conflict], [record({ revision: 2 }), conflict]]) {
    assert.throws(() => importCloudTaskUsage(envelope(records), baseline), /conflicting/);
    assert.equal(JSON.stringify(baseline), untouched);
  }
  assert.throws(() => importCloudTaskUsage(envelope([record({ revision: 3 }), record(), conflict])), /conflicting/);
  assert.throws(() => importCloudTaskUsage(envelope([record(), conflict, record({ revision: 3 })])), /conflicting/);
});

test('all four component counts participate in same-revision conflict detection', () => {
  for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']) {
    const changed = record({ tokens: tokens({ [field]: tokens()[field] + 1 }) });
    assert.throws(() => importCloudTaskUsage(envelope([record(), changed])), /conflicting/);
  }
});

test('provider, scope, task, day and model isolate snapshots with delimiter-safe identities', () => {
  const independent = [record(), record({ provider: 'another-authority' }), record({ scopeId: 'workspace-b' }),
    record({ taskId: 'task-b' }), record({ date: '2026-10-03' }), record({ model: 'another-model' }),
    record({ provider: 'a,b', scopeId: 'c' }), record({ provider: 'a', scopeId: 'b,c' })];
  const result = importCloudTaskUsage(envelope(independent));
  assert.equal(result.report.recordCount, 8);
  assert.equal(result.report.totalTokens, 120);
  assert.deepEqual(importCloudTaskUsage(envelope(independent.reverse())), result);
});

test('per-record and aggregate totals fail on overflow while maximum safe counts remain valid', () => {
  const maximum = record({ tokens: tokens({ inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }) });
  assert.equal(importCloudTaskUsage(envelope([maximum])).report.totalTokens, Number.MAX_SAFE_INTEGER);
  assert.throws(() => importCloudTaskUsage(envelope([record({ tokens: tokens({ inputTokens: Number.MAX_SAFE_INTEGER }) })])), RangeError);
  assert.throws(() => importCloudTaskUsage(envelope([maximum, record({ taskId: 'task-b' })])), RangeError);
  const baseline = importCloudTaskUsage(envelope([maximum]));
  const untouched = JSON.stringify(baseline);
  assert.throws(() => importCloudTaskUsage(envelope([record({ taskId: 'task-b', date: '2026-10-03' })]), baseline), RangeError);
  assert.equal(JSON.stringify(baseline), untouched);
});

test('unknown sensitive fields are dropped from all cloud persistence levels and input objects stay independent', () => {
  const secret = 'PRIVATE_PROMPT_AUTH_EMAIL_TITLE';
  const raw = record({ rawPrompt: secret, auth: { token: secret }, email: secret, title: secret,
    tokens: tokens({ rawPrompt: secret, auth: secret }), totalTokens: 900 });
  const input = envelope([raw], { rawPrompt: secret, auth: secret, title: secret });
  const inputCopy = JSON.stringify(input);
  const first = importCloudTaskUsage(input);
  assert.equal(JSON.stringify(first).includes(secret), false);
  assert.equal(first.report.totalTokens, 15);
  assert.equal(JSON.stringify(input), inputCopy);
  first.records[0].tokens.inputTokens = 100;
  assert.equal(raw.tokens.inputTokens, 10);
  const baseline = importCloudTaskUsage(input);
  baseline.auth = secret;
  baseline.records[0].email = secret;
  baseline.report = { totalTokens: 900, rawPrompt: secret };
  const next = importCloudTaskUsage(envelope(), baseline);
  assert.equal(JSON.stringify(next).includes(secret), false);
  assert.equal(next.report.totalTokens, 15);
  next.records[0].tokens.inputTokens = 50;
  assert.equal(baseline.records[0].tokens.inputTokens, 10);
  assert.throws(() => importCloudTaskUsage(envelope([record({ provider: secret.repeat(20) })])), error => !error.message.includes(secret));
});

test('previous ledger records are strictly revalidated and corrupt ledgers never reset or hide behind replacement', () => {
  const first = importCloudTaskUsage(envelope([record()]));
  const maximum = record({ taskId: 'max', tokens: tokens({ inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }) });
  const malformed = [{}, [], { ...first, version: 2 }, { ...first, kind: 'cloud-task-usage' },
    { ...first, records: null }, { ...first, records: [record({ tokens: null })] },
    { ...first, records: [record({ measurement: 'estimated' })] },
    { ...first, records: [record(), record()] }, { ...first, records: [record(), record({ revision: 2 })] },
    { ...first, records: [maximum, record()] }];
  for (const previous of malformed) {
    const untouched = JSON.stringify(previous);
    assert.throws(() => importCloudTaskUsage(envelope([record({ revision: 100 }), record({ taskId: 'max', revision: 100 })]), previous));
    assert.equal(JSON.stringify(previous), untouched);
  }
  assert.deepEqual(importCloudTaskUsage(envelope(), undefined), importCloudTaskUsage(envelope()));
  assert.equal(importCloudTaskUsage(envelope(), { ...first, report: null }).report.totalTokens, 15);
});

test('records arrays and merged ledgers are bounded to 10000 snapshots', () => {
  const zeroTokens = tokens({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
  const records = Array.from({ length: 10000 }, (_, index) => record({ taskId: `task-${index}`, tokens: zeroTokens }));
  const baseline = importCloudTaskUsage(envelope(records));
  assert.equal(baseline.report.recordCount, 10000);
  assert.throws(() => importCloudTaskUsage(envelope([...records, record()])), /10000/);
  assert.throws(() => importCloudTaskUsage(envelope([record({ taskId: 'another-task' })]), baseline), /10000/);
  assert.throws(() => importCloudTaskUsage(envelope(), { ...baseline, records: [...records, record()] }), /10000/);
  assert.equal(importCloudTaskUsage(envelope([record({ taskId: 'task-0', revision: 2, tokens: zeroTokens })]), baseline).report.recordCount, 10000);
});
