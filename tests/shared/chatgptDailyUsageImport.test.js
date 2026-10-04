'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_DAILY_USAGE_ROWS,
  normalizeChatgptDailyUsage
} = require('../../src/shared/chatgptDailyUsageImport');

const START = 1_759_276_800;
const END = START + 86_400;

function report(totals = {}, overrides = {}) {
  return {
    object: 'page',
    data: [{ object: 'workspace.usage.result', start_time: START, end_time: END, totals }],
    has_more: false,
    next_page: null,
    ...overrides
  };
}

test('projects only reported totals and removes identity, cost, attribution and cursor', () => {
  const page = report({
    uncached_text_input_tokens: 110,
    cached_text_input_tokens: 220,
    text_output_tokens: 55,
    text_total_tokens: 385,
    credits: 3,
    cost_usd: 0.25,
    estimated_cost_usd: 0.12
  });
  Object.assign(page.data[0], {
    user_id: 'fixture-user',
    actor: { user_id: 'fixture-user', email: 'fixture@example.invalid' },
    clients: [{ client_id: 'UNKNOWN_CLIENT', text_total_tokens: 900 }],
    models: [{ model: 'unknown-model', text_total_tokens: 800 }],
    code_attribution: { lines_of_code: { added: 12 } },
    raw: 'fixture-only raw field'
  });
  const before = structuredClone(page);
  assert.deepEqual(normalizeChatgptDailyUsage(page), {
    source: 'chatgpt-daily-usage',
    scope: 'workspace-report-page',
    execution: 'unknown',
    measurement: 'reported',
    realtime: false,
    canCombineWithLocal: false,
    coverage: 'single-page',
    terminalPage: true,
    rows: [{
      startTime: START,
      endTime: END,
      tokens: { uncachedInputTokens: 110, cachedInputTokens: 220, outputTokens: 55, totalTokens: 385 }
    }]
  });
  assert.deepEqual(page, before);
});

test('missing and explicit null tokens remain unknown while reported zero stays zero', () => {
  const result = normalizeChatgptDailyUsage(report({ cached_text_input_tokens: null, text_output_tokens: 0 }));
  assert.deepEqual(result.rows[0].tokens, {
    uncachedInputTokens: null, cachedInputTokens: null, outputTokens: 0, totalTokens: null
  });
});

test('does not invent a total from components or read thread estimates and client totals', () => {
  const page = report({ uncached_text_input_tokens: 3, cached_text_input_tokens: 4, text_output_tokens: 5 });
  page.threadUsage = { groups: [{ totalTokens: 999 }], estimatedUsageCreditsMicros: 100 };
  page.data[0].clients = [{ text_total_tokens: 999 }];
  page.data[0].models = [{ text_total_tokens: 999 }];
  assert.equal(normalizeChatgptDailyUsage(page).rows[0].tokens.totalTokens, null);
  assert.throws(() => normalizeChatgptDailyUsage({ summary: {}, threadUsage: page.threadUsage }), /page.object/);
  const estimatedRow = report();
  estimatedRow.data[0].object = 'thread.usage';
  assert.throws(() => normalizeChatgptDailyUsage(estimatedRow), /workspace.usage.result/);
});

test('retains repeated daily rows without merging users or counting duplicated pages', () => {
  const page = report({ text_total_tokens: 20 });
  page.data.push(structuredClone(page.data[0]));
  const result = normalizeChatgptDailyUsage(page);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].tokens.totalTokens, 20);
  assert.equal(result.rows[1].tokens.totalTokens, 20);
  assert.notEqual(result.rows[0], result.rows[1]);
  assert.equal(Object.hasOwn(result, 'totalTokens'), false);
});

test('marks partial pages and removes the continuation cursor', () => {
  const result = normalizeChatgptDailyUsage(report({}, { has_more: true, next_page: 'fixture-cursor' }));
  assert.equal(result.coverage, 'single-page');
  assert.equal(result.terminalPage, false);
  assert.equal(Object.hasOwn(result, 'next_page'), false);
  assert.equal(JSON.stringify(result).includes('fixture-cursor'), false);
  for (const cursor of [null, '', ' ', 5, {}, undefined]) {
    assert.throws(() => normalizeChatgptDailyUsage(report({}, { has_more: true, next_page: cursor })));
  }
});

test('distinguishes an empty page from missing or malformed data and pagination', () => {
  assert.deepEqual(normalizeChatgptDailyUsage(report({}, { data: [] })).rows, []);
  for (const data of [undefined, null, {}, '[]']) {
    assert.throws(() => normalizeChatgptDailyUsage(report({}, { data })), /page.data/);
  }
  for (const has_more of [undefined, null, 0, 'false']) {
    assert.throws(() => normalizeChatgptDailyUsage(report({}, { has_more })), /page.has_more/);
  }
  assert.throws(() => normalizeChatgptDailyUsage(report({}, { next_page: undefined })), /page.next_page/);
  for (const page of [null, [], 'page']) assert.throws(() => normalizeChatgptDailyUsage(page), /object/);
  assert.throws(() => normalizeChatgptDailyUsage(report({}, { data: new Array(1) })), /object/);
  for (const row of [null, [], 'row']) {
    assert.throws(() => normalizeChatgptDailyUsage(report({}, { data: [row] })), /object/);
  }
  assert.throws(() => normalizeChatgptDailyUsage(report(null)), /totals/);
  assert.throws(() => normalizeChatgptDailyUsage(report([])), /totals/);
});

test('rejects unaligned, fractional, unsafe or nonnumeric day boundaries and day spans', () => {
  for (const value of [START + 1, START + 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, String(START), null]) {
    for (const key of ['start_time', 'end_time']) {
      const page = report();
      page.data[0][key] = value;
      assert.throws(() => normalizeChatgptDailyUsage(page), /UTC-midnight/);
    }
  }
  for (const end of [START, START - 86_400, START + 172_800]) {
    const page = report();
    page.data[0].end_time = end;
    assert.throws(() => normalizeChatgptDailyUsage(page), /exactly one UTC day/);
  }
});

test('rejects every malformed reported token field without coercion or rounding', () => {
  const fields = ['uncached_text_input_tokens', 'cached_text_input_tokens', 'text_output_tokens', 'text_total_tokens'];
  for (const field of fields) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '5', false, {}, []]) {
      assert.throws(() => normalizeChatgptDailyUsage(report({ [field]: value })), /nonnegative safe integer/);
    }
    assert.equal(Object.values(normalizeChatgptDailyUsage(report({ [field]: Number.MAX_SAFE_INTEGER })).rows[0].tokens).includes(Number.MAX_SAFE_INTEGER), true);
  }
});

test('bounds imported report pages without truncation', () => {
  const row = report().data[0];
  assert.equal(normalizeChatgptDailyUsage(report({}, { data: Array(MAX_DAILY_USAGE_ROWS).fill(row) })).rows.length, MAX_DAILY_USAGE_ROWS);
  assert.throws(() => normalizeChatgptDailyUsage(report({}, { data: Array(MAX_DAILY_USAGE_ROWS + 1).fill(row) })), /at most/);
});
