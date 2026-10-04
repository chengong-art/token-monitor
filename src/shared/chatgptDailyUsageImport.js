'use strict';

const MAX_DAILY_USAGE_ROWS = 10_000;
const UTC_DAY_SECONDS = 86_400;
const TOKEN_FIELDS = [
  ['uncached_text_input_tokens', 'uncachedInputTokens'],
  ['cached_text_input_tokens', 'cachedInputTokens'],
  ['text_output_tokens', 'outputTokens'],
  ['text_total_tokens', 'totalTokens']
];

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function utcDayBoundary(value, name) {
  if (!Number.isSafeInteger(value) || value % UTC_DAY_SECONDS !== 0) {
    throw new TypeError(`${name} must be a safe integer UTC-midnight Unix timestamp`);
  }
}

function optionalToken(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer, null, or absent`);
  }
  return value;
}

// Project one official report page, never a cumulative ledger. Per-user and
// workspace rows can share dates, so neither dates nor redacted rows are IDs.
function normalizeChatgptDailyUsage(page) {
  record(page, 'page');
  if (page.object !== 'page') throw new TypeError('page.object must be page');
  if (!Array.isArray(page.data) || page.data.length > MAX_DAILY_USAGE_ROWS) {
    throw new TypeError(`page.data must be an array of at most ${MAX_DAILY_USAGE_ROWS} rows`);
  }
  if (typeof page.has_more !== 'boolean') throw new TypeError('page.has_more must be boolean');
  if (page.next_page !== null && typeof page.next_page !== 'string') {
    throw new TypeError('page.next_page must be a string or null');
  }
  if (page.has_more && (page.next_page === null || !page.next_page.trim())) {
    throw new TypeError('partial pages require a nonempty page.next_page');
  }

  const rows = Array.from(page.data, (row, index) => {
    const name = `page.data[${index}]`;
    record(row, name);
    if (row.object !== 'workspace.usage.result') {
      throw new TypeError(`${name}.object must be workspace.usage.result`);
    }
    utcDayBoundary(row.start_time, `${name}.start_time`);
    utcDayBoundary(row.end_time, `${name}.end_time`);
    if (row.end_time - row.start_time !== UTC_DAY_SECONDS) {
      throw new TypeError(`${name} must span exactly one UTC day`);
    }
    record(row.totals, `${name}.totals`);
    const tokens = {};
    for (const [input, output] of TOKEN_FIELDS) {
      tokens[output] = optionalToken(row.totals[input], `${name}.totals.${input}`);
    }
    return { startTime: row.start_time, endTime: row.end_time, tokens };
  });

  return {
    source: 'chatgpt-daily-usage',
    scope: 'workspace-report-page',
    execution: 'unknown',
    measurement: 'reported',
    realtime: false,
    canCombineWithLocal: false,
    coverage: 'single-page',
    terminalPage: !page.has_more,
    rows
  };
}

module.exports = { MAX_DAILY_USAGE_ROWS, normalizeChatgptDailyUsage };
