'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeCodexAccountUsage, importCloudTaskUsage } = require('../../src/shared/cloudUsageImport');
const { normalizeChatgptDailyUsage } = require('../../src/shared/chatgptDailyUsageImport');

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
    realtime: false, canCombineWithLocal: false, taskCount: 2, recordCount: 2, totalTokens: 45,
    inputTokens: 30, cachedInputTokens: 23, outputTokens: 15, reasoningOutputTokens: 12,
    creationSources: {
      manual: { taskCount: 0, recordCount: 0, totalTokens: 0 },
      dot: { taskCount: 0, recordCount: 0, totalTokens: 0 },
      unknown: { taskCount: 2, recordCount: 2, totalTokens: 45 }
    },
    attributionConflictTaskCount: 0,
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

test('manual and dot synthetic cloud snapshots remain independent and partition deduplicated totals', () => {
  // Invented offline values exercise the adapter contract, not live task usage.
  const result = importCloudTaskUsage(envelope([
    record({ taskId: 'manual-fixture', creationSource: 'manual' }),
    record({ taskId: 'manual-fixture', creationSource: 'manual', date: '2026-10-03',
      tokens: tokens({ inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 }) }),
    record({ taskId: 'dot-fixture', creationSource: 'dot',
      tokens: tokens({ inputTokens: 20, cachedInputTokens: 2, outputTokens: 10 }) }),
    record({ taskId: 'unknown-fixture' })
  ]));
  assert.equal(result.report.taskCount, 3);
  assert.equal(result.report.recordCount, 4);
  assert.equal(result.report.totalTokens, 90);
  assert.deepEqual(result.report.creationSources, {
    manual: { taskCount: 1, recordCount: 2, totalTokens: 45 },
    dot: { taskCount: 1, recordCount: 1, totalTokens: 30 },
    unknown: { taskCount: 1, recordCount: 1, totalTokens: 15 }
  });
  assert.equal(result.report.attributionConflictTaskCount, 0);
  for (const row of result.records) {
    assert.equal(row.execution, 'cloud');
    assert.equal(row.creationSourceConflict, false);
  }
  for (const field of ['taskCount', 'recordCount', 'totalTokens']) {
    assert.equal(Object.values(result.report.creationSources).reduce((sum, bucket) => sum + bucket[field], 0), result.report[field]);
  }
});

test('absent, null, undefined and explicit unknown creation sources normalize without guessing from metadata', () => {
  for (const raw of [record(), record({ creationSource: null }), record({ creationSource: undefined }), record({ creationSource: 'unknown' })]) {
    raw.title = 'Manually created dot-delegated task';
    raw.source = 'manual';
    raw.provider = 'dot-provider';
    raw.taskId = 'manual-task';
    raw.localPresence = true;
    const result = importCloudTaskUsage(envelope([raw]));
    assert.equal(result.records[0].creationSource, 'unknown');
    assert.equal(result.records[0].creationSourceConflict, false);
    assert.deepEqual(result.report.creationSources.unknown, { taskCount: 1, recordCount: 1, totalTokens: 15 });
    assert.equal(result.report.attributionConflictTaskCount, 0);
    assert.equal(Object.hasOwn(result.records[0], 'localPresence'), false);
    assert.equal(Object.hasOwn(result.records[0], 'source'), false);
    assert.equal(Object.hasOwn(result.records[0], 'title'), false);
  }
});

test('legacy version-one ledgers gain unknown attribution and ignore untrusted prior source summaries', () => {
  const previous = importCloudTaskUsage(envelope([record()]));
  delete previous.records[0].creationSource;
  delete previous.records[0].creationSourceConflict;
  previous.report.creationSources = { manual: { taskCount: 999, recordCount: 999, totalTokens: 999 } };
  previous.report.attributionConflictTaskCount = 999;
  const untouched = JSON.stringify(previous);
  const result = importCloudTaskUsage(envelope(), previous);
  assert.equal(result.version, 1);
  assert.equal(result.records[0].creationSource, 'unknown');
  assert.equal(result.records[0].creationSourceConflict, false);
  assert.deepEqual(result.report.creationSources, {
    manual: { taskCount: 0, recordCount: 0, totalTokens: 0 },
    dot: { taskCount: 0, recordCount: 0, totalTokens: 0 },
    unknown: { taskCount: 1, recordCount: 1, totalTokens: 15 }
  });
  assert.equal(result.report.attributionConflictTaskCount, 0);
  assert.equal(JSON.stringify(previous), untouched);
});

test('invalid or ambiguous creation labels and malformed conflict markers are rejected atomically', () => {
  const baseline = importCloudTaskUsage(envelope([record()]));
  const untouched = JSON.stringify(baseline);
  for (const creationSource of ['local', 'ambiguous', 'manual/dot', 'Manual', '', true, 1, [], {}]) {
    assert.throws(() => importCloudTaskUsage(envelope([record({ creationSource })]), baseline), /creationSource must be/);
  }
  for (const creationSourceConflict of [null, 'true', 'false', 0, 1, {}, []]) {
    assert.throws(() => importCloudTaskUsage(envelope([record({ creationSourceConflict })]), baseline), /creationSourceConflict must be boolean/);
  }
  for (const creationSource of ['manual', 'dot']) {
    assert.throws(() => importCloudTaskUsage(envelope([record({ creationSource, creationSourceConflict: true })]), baseline), /requires unknown/);
  }
  const invalidPrevious = { ...baseline, records: [record({ creationSource: 'local' })] };
  assert.throws(() => importCloudTaskUsage(envelope([record({ revision: 2 })]), invalidPrevious), /creationSource must be/);
  assert.equal(JSON.stringify(baseline), untouched);
});

test('creation source never participates in snapshot identity or counter conflict rules', () => {
  const manual = record({ creationSource: 'manual' });
  const dot = record({ creationSource: 'dot' });
  const result = importCloudTaskUsage(envelope([manual, dot, record()]));
  assert.equal(result.report.taskCount, 1);
  assert.equal(result.report.recordCount, 1);
  assert.equal(result.report.totalTokens, 15);
  assert.equal(result.records[0].creationSource, 'unknown');
  assert.equal(result.records[0].creationSourceConflict, true);
  assert.deepEqual(result.report.creationSources.unknown, { taskCount: 1, recordCount: 1, totalTokens: 15 });
  assert.equal(result.report.attributionConflictTaskCount, 1);
  assert.deepEqual(importCloudTaskUsage(envelope([dot, manual])), result);
  assert.deepEqual(importCloudTaskUsage(envelope([manual, dot]), result), result);
});

test('unknown snapshots are enriched by known source declarations across imports and stale revisions', () => {
  const baseline = importCloudTaskUsage(envelope([
    record({ revision: 5 }), record({ model: 'another-model', date: '2026-10-03' })
  ]));
  const stale = record({ creationSource: 'manual', revision: 1,
    tokens: tokens({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }) });
  const enriched = importCloudTaskUsage(envelope([stale]), baseline);
  assert.equal(enriched.report.totalTokens, 30);
  assert.equal(enriched.records.find(row => row.model === 'gpt-example').revision, 5);
  assert.ok(enriched.records.every(row => row.creationSource === 'manual' && row.creationSourceConflict === false));
  assert.deepEqual(enriched.report.creationSources.manual, { taskCount: 1, recordCount: 2, totalTokens: 30 });
  assert.equal(enriched.report.creationSources.unknown.totalTokens, 0);
  assert.ok(baseline.records.every(row => row.creationSource === 'unknown'));
  const sameRevision = importCloudTaskUsage(envelope([record(), record({ creationSource: 'dot' })]));
  assert.equal(sameRevision.records[0].creationSource, 'dot');
  assert.equal(sameRevision.report.totalTokens, 15);
  assert.deepEqual(importCloudTaskUsage(envelope([record({ creationSource: 'dot' }), record()])), sameRevision);
});

test('unknown later labels cannot erase known attribution while higher counter revisions still replace snapshots', () => {
  const baseline = importCloudTaskUsage(envelope([record({ creationSource: 'manual' })]));
  const grown = importCloudTaskUsage(envelope([record({ revision: 2, creationSource: null,
    tokens: tokens({ inputTokens: 30, outputTokens: 20 }) })]), baseline);
  assert.equal(grown.report.totalTokens, 50);
  assert.equal(grown.records[0].creationSource, 'manual');
  assert.equal(grown.records[0].creationSourceConflict, false);
  assert.deepEqual(grown.report.creationSources.manual, { taskCount: 1, recordCount: 1, totalTokens: 50 });
  const corrected = importCloudTaskUsage(envelope([record({ revision: 3, creationSource: 'dot',
    tokens: tokens({ inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, reasoningOutputTokens: 0 }) })]), grown);
  assert.equal(corrected.report.totalTokens, 5);
  assert.equal(corrected.report.recordCount, 1);
  assert.equal(corrected.records[0].revision, 3);
  assert.equal(corrected.records[0].creationSource, 'unknown');
  assert.equal(corrected.records[0].creationSourceConflict, true);
  assert.deepEqual(corrected.report.creationSources.unknown, { taskCount: 1, recordCount: 1, totalTokens: 5 });
  assert.equal(corrected.report.attributionConflictTaskCount, 1);
});

test('conflicting declarations across dates and models mark every winning snapshot of that task unknown', () => {
  const baseline = importCloudTaskUsage(envelope([
    record({ creationSource: 'manual' }), record({ taskId: 'unrelated', creationSource: 'dot' })
  ]));
  const result = importCloudTaskUsage(envelope([
    record({ creationSource: 'dot', date: '2026-10-03' }),
    record({ model: 'another-model', creationSource: 'unknown' })
  ]), baseline);
  const conflicted = result.records.filter(row => row.taskId === 'task-a');
  assert.equal(conflicted.length, 3);
  assert.ok(conflicted.every(row => row.creationSource === 'unknown' && row.creationSourceConflict === true));
  assert.equal(result.records.find(row => row.taskId === 'unrelated').creationSource, 'dot');
  assert.equal(result.records.find(row => row.taskId === 'unrelated').creationSourceConflict, false);
  assert.equal(result.report.taskCount, 2);
  assert.equal(result.report.totalTokens, 60);
  assert.deepEqual(result.report.creationSources.unknown, { taskCount: 1, recordCount: 3, totalTokens: 45 });
  assert.deepEqual(result.report.creationSources.dot, { taskCount: 1, recordCount: 1, totalTokens: 15 });
  assert.equal(result.report.attributionConflictTaskCount, 1);
});

test('stale counter snapshots can disclose a whole-task attribution conflict without changing the winning counters', () => {
  const baseline = importCloudTaskUsage(envelope([record({ revision: 5, creationSource: 'manual' })]));
  const result = importCloudTaskUsage(envelope([record({ revision: 1, creationSource: 'dot',
    tokens: tokens({ inputTokens: 50 }) })]), baseline);
  assert.equal(result.records[0].revision, 5);
  assert.equal(result.report.totalTokens, 15);
  assert.equal(result.records[0].creationSource, 'unknown');
  assert.equal(result.records[0].creationSourceConflict, true);
  assert.equal(result.report.attributionConflictTaskCount, 1);
});

test('attribution conflicts survive ledger serialization and cannot be erased by a later known declaration', () => {
  let ledger = importCloudTaskUsage(envelope([record({ creationSource: 'manual' }), record({ creationSource: 'dot' })]));
  ledger = JSON.parse(JSON.stringify(ledger));
  for (const incoming of [[], [record({ creationSource: 'manual', revision: 2 })],
    [record({ creationSource: 'dot', model: 'another-model' })], [record({ creationSource: 'unknown', revision: 3 })]]) {
    ledger = importCloudTaskUsage(envelope(incoming), ledger);
    assert.ok(ledger.records.every(row => row.creationSource === 'unknown' && row.creationSourceConflict === true));
    assert.equal(ledger.report.attributionConflictTaskCount, 1);
    assert.equal(ledger.report.creationSources.manual.totalTokens, 0);
    assert.equal(ledger.report.creationSources.dot.totalTokens, 0);
    assert.equal(ledger.report.creationSources.unknown.totalTokens, ledger.report.totalTokens);
  }
  const flagged = importCloudTaskUsage(envelope([
    record({ creationSourceConflict: true }), record({ model: 'another-model', creationSource: 'manual' })
  ]));
  assert.ok(flagged.records.every(row => row.creationSource === 'unknown' && row.creationSourceConflict === true));
  assert.equal(flagged.report.attributionConflictTaskCount, 1);
});

test('task attribution keys isolate authorities and scopes and do not collide on embedded delimiters', () => {
  const result = importCloudTaskUsage(envelope([
    record({ creationSource: 'manual' }), record({ scopeId: 'workspace-b', creationSource: 'dot' }),
    record({ provider: 'another-authority', creationSource: 'dot' }),
    record({ provider: 'a,b', scopeId: 'c', creationSource: 'manual' }),
    record({ provider: 'a', scopeId: 'b,c', creationSource: 'dot' })
  ]));
  assert.equal(result.report.taskCount, 5);
  assert.equal(result.report.attributionConflictTaskCount, 0);
  assert.deepEqual(result.report.creationSources.manual, { taskCount: 2, recordCount: 2, totalTokens: 30 });
  assert.deepEqual(result.report.creationSources.dot, { taskCount: 3, recordCount: 3, totalTokens: 45 });
  assert.ok(result.records.every(row => row.creationSourceConflict === false));
});

test('same-revision counter conflicts remain atomic when creation declarations also differ', () => {
  const baseline = importCloudTaskUsage(envelope([record({ creationSource: 'manual' })]));
  const untouched = JSON.stringify(baseline);
  assert.throws(() => importCloudTaskUsage(envelope([
    record({ taskId: 'new-task', creationSource: 'dot' }),
    record({ creationSource: 'dot', tokens: tokens({ inputTokens: 11 }) })
  ]), baseline), /conflicting counts/);
  assert.equal(JSON.stringify(baseline), untouched);
  assert.equal(baseline.records[0].creationSource, 'manual');
  assert.equal(baseline.records[0].creationSourceConflict, false);
});

test('source buckets preserve maximum safe counts and fail overflowing imports without changing attribution', () => {
  const maximum = record({ creationSource: 'manual', tokens: tokens({ inputTokens: Number.MAX_SAFE_INTEGER,
    cachedInputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, reasoningOutputTokens: 0 }) });
  const zero = record({ taskId: 'dot-task', creationSource: 'dot',
    tokens: tokens({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }) });
  const baseline = importCloudTaskUsage(envelope([maximum, zero]));
  assert.equal(baseline.report.totalTokens, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(baseline.report.creationSources.manual, { taskCount: 1, recordCount: 1, totalTokens: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(baseline.report.creationSources.dot, { taskCount: 1, recordCount: 1, totalTokens: 0 });
  const untouched = JSON.stringify(baseline);
  assert.throws(() => importCloudTaskUsage(envelope([record({ taskId: 'another-task', creationSource: 'dot' })]), baseline), RangeError);
  assert.equal(JSON.stringify(baseline), untouched);
});

test('manual and dot declarations do not make missing usage or local execution importable', () => {
  for (const creationSource of ['manual', 'dot']) {
    assert.throws(() => importCloudTaskUsage(envelope([record({ creationSource, tokens: undefined })])), /tokens must be an object/);
    assert.throws(() => importCloudTaskUsage(envelope([record({ creationSource, execution: 'local' })])), /execution must be cloud/);
    assert.throws(() => importCloudTaskUsage(envelope([{ creationSource, taskId: 'metadata-only', title: 'Synthetic task' }])), TypeError);
  }
});

test('account and workspace DTOs never turn creation declarations or aggregate totals into task attribution', () => {
  const account = normalizeCodexAccountUsage({
    summary: { lifetimeTokens: 15, peakDailyTokens: 15, creationSource: 'manual' },
    dailyUsageBuckets: [{ startDate: '2026-10-04', tokens: 15, creationSource: 'dot', taskId: 'synthetic-task' }],
    creationSource: 'manual'
  });
  const workspace = normalizeChatgptDailyUsage({ object: 'page', has_more: false, next_page: null,
    creationSource: 'dot', data: [{ object: 'workspace.usage.result', start_time: 0, end_time: 86400,
      creationSource: 'manual', taskId: 'synthetic-task', totals: { text_total_tokens: 15 } }] });
  for (const report of [account, workspace]) {
    assert.equal(report.execution, 'unknown');
    assert.equal(Object.hasOwn(report, 'creationSource'), false);
    assert.equal(Object.hasOwn(report, 'creationSources'), false);
    assert.equal(Object.hasOwn(report, 'taskCount'), false);
    assert.equal(JSON.stringify(report).includes('synthetic-task'), false);
    assert.throws(() => importCloudTaskUsage(report), /envelope must have version/);
  }
});
