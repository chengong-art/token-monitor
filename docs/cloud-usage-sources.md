# Cloud usage data sources

Checked on **2026-10-04** against fetched official OpenAI documentation, the public Admin API reference and its [raw OpenAPI schema](https://chatgpt.com/public/admin/api-reference/openapi.json) (`openapi: 3.0.2`, `info.version: 2.5.37`). Codex source links below are pinned to `afb436df8b70bb5bc57b86d9a3e829968988cd21`, the default-branch revision returned during this check. No private logs, credentials, or authenticated usage exports were used for this research.

Official reporting exists, but this check does **not** establish access to actual usage for each dot-delegated cloud task. Account and workspace aggregates, thread estimates, active engine events, and local log collection have different coverage. This offline adapter does not provide live cloud-task statistics.

## Candidate sources

| Source | Verified public contract | Access and remaining gap |
| --- | --- | --- |
| [Unified Daily Usage Analytics](https://learn.chatgpt.com/codex/enterprise/analytics-api) | Reports daily eligible ChatGPT, Work, and Codex text-token usage at workspace/user scope. The detailed contract is below. | Requires an enabled workspace endpoint and a workspace-scoped Admin key with `enterprise.analytics.usage.read`. `codex.enterprise.analytics.read` does not grant this access. No current-user entitlement or live export was verified. There is no task/run or cloud/local execution dimension in this response. |
| [App-server account token activity](https://learn.chatgpt.com/docs/app-server#7-token-usage-chatgpt) | `account/usage/read` without `threadId` returns nullable account summary metrics and optional `dailyUsageBuckets: [{startDate, tokens}]`. | Requires Codex-service-backed authentication; ChatGPT, agent identity and personal access token modes are among the documented modes. API-key-only/Bedrock authentication does not work for this method. Cloud-task coverage and execution attribution are not promised by the account summary contract. |
| [App-server per-thread parameters](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/app-server-protocol/schema/typescript/v2/GetAccountTokenUsageParams.ts) and [response](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/app-server-protocol/schema/typescript/v2/GetAccountTokenUsageResponse.ts) | Optional `threadId` requests a `threadUsage` response explicitly described as estimated usage. [Groups](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/app-server-protocol/schema/typescript/v2/ThreadUsageBreakdownGroup.ts) include nullable input, cached input, output and total tokens alongside estimated credits. | These fields exist; claiming that no per-thread fields exist would be incorrect. Their availability and exact token semantics for Work cloud task IDs were not verified. Estimated credits/USD are not actual charges. A missing response is unavailable, not zero. This adapter does not promote this estimate response to actual task usage. |
| [Active app-server events](https://learn.chatgpt.com/docs/app-server#turn-events) | `thread/tokenUsage/updated` reports usage for an active thread. The pinned [event schema](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsageUpdatedNotification.ts) carries thread/turn IDs, with [total/last token breakdowns](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsage.ts). | This is an integration with an active Codex engine, not evidence that arbitrary dot/Work cloud tasks can be enumerated or read. The app-server command/transports also carry experimental support limitations in the documentation. |
| [Codex cloud list](https://learn.chatgpt.com/docs/developer-commands#codex-cloud-list) | Its documented JSON contains `tasks` and an optional `cursor`, with task identity, status, environment, summary and attempt metadata. | The fetched command contract has no token counters. Task metadata alone cannot recover actual usage. |
| Existing local collector | Scans local sources using the repository's existing collector. | A locally visible thread or synced cloud task title does not prove that the cloud execution's token events exist locally. Source locations and execution locations must remain separate. |

Rate-limit percentages from `account/rateLimits/read` represent quota windows, not token counters. Credit usage, token usage, estimated USD, and invoices also remain distinct; see [Work usage and cost](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-usage-and-cost).

## Exact Daily Usage input

The fetched [operation reference](https://chatgpt.com/public/admin/api-reference#operation/get-analytics-workspaces-workspace-id-usage) defines `GET https://api.chatgpt.com/v1/analytics/workspaces/{workspace_id}/usage`. Its `DailyUsagePage` schema requires `object`, `data`, `has_more` and `next_page`:

```js
{
  object: 'page',
  data: [{
    object: 'workspace.usage.result',
    start_time: 1759276800,
    end_time: 1759363200,
    totals: {
      uncached_text_input_tokens: 110,
      cached_text_input_tokens: 220,
      text_output_tokens: 55,
      text_total_tokens: 385
    }
    // Official rows also carry user_id, actor and clients; models are optional.
  }],
  has_more: false,
  next_page: null
}
```

`start_time` and `end_time` are Unix-second UTC day boundaries, inclusive/exclusive respectively. The default grouping is per user/day; `group=workspace` selects workspace/day. The page does not echo enough request context to establish its grouping after identity is stripped.

The four token measures are optional. Work/Codex fields cover eligible API-priced usage; absence does not mean zero. Totals may differ from the sum of client-attributed tokens because attribution can be unavailable, and model buckets may span products/clients. Reports can be revised as delayed usage arrives. These facts prohibit reconstructing cloud-only totals by summing client or model rows.

When `has_more` is true, pass `next_page` as the next request's `page`, preserving grouping and other query parameters. API `limit` is 1–30,000, default 1,000. This importer uses a stricter 10,000-row bound, so larger pages must be re-exported with a smaller limit. No importer here requests an endpoint or creates/stores an Admin key.

## Offline projection and duplicate counting

`normalizeChatgptDailyUsage(page)` in `src/shared/chatgptDailyUsageImport.js` validates the counter-bearing projection rather than every official schema field. Identity and client metadata are intentionally not required for an already-redacted export. It requires the page/row type discriminators, an actual data array, boolean pagination, a string/null cursor, aligned safe-integer UTC day timestamps and exactly one-day spans. Partial pages require a nonempty cursor. Numeric token values must be nonnegative safe integers; missing/null values become `null` and explicit zero remains zero.

The only output rows are `{startTime, endTime, tokens: {uncachedInputTokens, cachedInputTokens, outputTokens, totalTokens}}`, from `totals` alone. The adapter removes identities, actors, emails, credits, USD amounts, raw content, clients, models and cursors. It never infers a missing total, substitutes thread estimates, merges equal dates or adds pages.

Output provenance is `source: 'chatgpt-daily-usage'`, `scope: 'workspace-report-page'`, `execution: 'unknown'`, `measurement: 'reported'`, `realtime: false` and `canCombineWithLocal: false`. `coverage: 'single-page'` declares the imported scope. `terminalPage: true` means this page reports no further page; it does not prove that preceding pages were imported or that all cloud tasks are covered.

The main task separately confirmed that the existing installed app-server can return an account summary/daily response through its public `account/usage/read` method. That read-only availability check does not establish cloud-only coverage or individual dot-task attribution; it does not change the unknown execution origin above.

Daily rows may be multiple users with identical dates; redacted pages contain no reliable row identity. Preserve rows as a snapshot and replace an earlier imported snapshot instead of appending or accumulating repeated exports. Keep this report separate from local counters and task-level imports. A real end-to-end cloud-task result still needs an authorized dataset with verified task/run attribution, exact token semantics and source coverage; that evidence is not present in the public contracts checked here.

## Verified implementation outcome

The isolated implementation starts from upstream `189d54da7c74ebc605530f505185df9d7b4c3363` and leaves the installed widget and its local collector unchanged.

| Check | Result |
| --- | --- |
| Real source read | The bundled Codex CLI 0.160.0 accepted the documented initialize handshake and `account/usage/read`. It returned numeric lifetime/peak metrics and daily buckets. The actual response passed `normalizeCodexAccountUsage` in memory. No raw response, account identity or actual counter values are committed. No model turn was started. |
| Cloud-task attribution | Still unverified. The real account response has no validated cloud/local or individual dot-task join. No per-thread estimate was queried or imported. |
| Workspace authorization | Public schema verified; the current account's workspace Admin scope and endpoint entitlement were not verified. No Admin key was created or stored. Workspace tests use synthetic fixtures. |
| New adapter and CLI checks | 39 tests pass: official report projections, unknown/zero distinctions, duplicate snapshots, revisions and downward correction, conflicts and file rollback, subset counting, unsafe values, privacy projection, pagination, alias/lock handling, and successful commit status despite cleanup failure. |
| Required repository verification | `npm run verify` passes on Node.js 25.9.0: lint passes, 5,747 tests pass, 2 are skipped, none fail. Existing loopback/process/native-watcher integration tests require host permissions rather than the restrictive sandbox; no persistent security setting was changed. |
| Generated Worker state | `npm run update:hub-build` reports the registry current and synchronizes the closure without generated-file changes. The offline import modules do not enter that closure or the Hub totals. |
| Independent review | Source semantics and CLI persistence were reviewed separately. The identified post-commit lock-cleanup status issue was corrected and covered by tests before the final full verification. |

The delivered feature is an offline import and adaptation boundary. A supported, authorized source with actual dot/cloud task attribution, exact token semantics, and reconcilable identities is still needed before wiring a live collector or combining cloud usage with local totals. This is a source/provenance gap, not a claim that no reporting APIs exist.
