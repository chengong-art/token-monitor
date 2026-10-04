# Cloud usage import prototype

This fork provides an offline reporting boundary, not live dot / Work Cloud task collection. It does not register a new tracked client, alter the installed widget, or feed imported usage into the existing local collector, archives, DeviceState or Hub. See [source feasibility](cloud-usage-sources.md) for the verified official sources and their limits.

## Run it in this checkout

The importer uses Node.js and no new dependencies. Supply an already authorized JSON export; it never reads credentials, scans local transcripts, calls a service, or creates a model request.

```sh
mkdir -p data/cloud-usage
node scripts/import-cloud-usage.js --kind codex-account \
  --input tests/fixtures/codex-account-usage.json \
  --output data/cloud-usage/account.json
node scripts/import-cloud-usage.js --kind cloud-task \
  --input tests/fixtures/cloud-task-usage.json \
  --output data/cloud-usage/tasks.json
```

These fixtures contain invented values and opaque fixture identifiers. Their success demonstrates the importer, not real cloud task measurement. `data/` is ignored by Git. Keep actual exports and reports private; opaque scope/task identifiers may still be sensitive. Output files use mode `0600` where supported.

Three import kinds remain separate:

| Kind | Accepted input | Result and replacement rule |
| --- | --- | --- |
| `codex-account` | The documented `account/usage/read` result, or its JSON-RPC `{ id, result }` wrapper | Whitelisted account summary and optional daily buckets. Replaces the prior account snapshot; daily values are not added to lifetime values. Execution origin is `unknown`. |
| `chatgpt-workspace` | One official Daily Usage Analytics API page | Whitelisted row dates and reported token fields from `totals`. Replaces a whole page report, never merges pages or sums client/model buckets. Execution origin is `unknown`. |
| `cloud-task` | The versioned normalized contract below | A cumulative ledger with one winning revision per authority/scope/task/day/model. Its source is an explicit import; it is not a built-in API integration. |

For `chatgpt-workspace`, use the same command with `--kind chatgpt-workspace` and the path to an authorized API response (or the synthetic `tests/fixtures/chatgpt-daily-usage.json`). Reports always have `coverage: "single-page"`; `terminalPage` means the response has no continuation, not that earlier pages have been imported. Obtain remaining pages through the official API with the same filters and grouping. This prototype does not consolidate them, follow cursors, provision an Admin key, or certify workspace entitlement. The official API reports only eligible API-priced Work/Codex token usage; omitted fields are unknown, not zero.

Null or absent account metrics stay null. Explicit zero stays zero. Account, workspace and task reports all have `realtime: false` and `canCombineWithLocal: false`. Do not sum them with each other or with local Codex JSONL usage: their coverage can overlap. Namespacing alone cannot reconcile that overlap. The existing dashboard remains a local-log view.

## Normalized cloud task contract

This is this fork's adapter contract, not an OpenAI export schema. A future authorized source adapter must establish actual token provenance and explicitly distinguish cloud execution before producing it. Setting `measurement: "reported"` in untrusted JSON does not verify authenticity. Do not convert quota percentages, credits, API cost estimates, account daily totals, message lengths, or estimated thread usage into this contract.

```json
{
  "version": 1,
  "kind": "cloud-task-usage",
  "records": [{
    "provider": "stable-metering-authority",
    "scopeId": "opaque-account-or-workspace-scope",
    "taskId": "opaque-cloud-task-id",
    "date": "2026-10-04",
    "model": "reported-model-id",
    "revision": 1,
    "execution": "cloud",
    "measurement": "reported",
    "tokens": {
      "inputTokens": 100,
      "cachedInputTokens": 20,
      "outputTokens": 30,
      "reasoningOutputTokens": 10
    }
  }]
}
```

Each record is one cumulative daily snapshot for that task/model, not a usage event or an all-time task counter copied to multiple days. `inputTokens` includes cached input; `outputTokens` includes reasoning output. The total is exactly `inputTokens + outputTokens`. Cache and reasoning counts are subsets and must not be added again. Counters and revisions must be nonnegative safe integers (revision starts at 1), dates must be real calendar days, and subsets must not exceed their parents. Missing task usage fails validation instead of becoming zero. A source unable to provide these fields cannot use this contract; the account/workspace adapters preserve their own less detailed metrics instead.

The identity is `(provider, scopeId, taskId, date, model)`, independent of import filename, device or exporter name. Use the same canonical authority and scope for exports of the same underlying meter. Two exporters assigning different authority/scope aliases can still duplicate data; an offline importer cannot prove they share a meter. Reconcile aliases in the authorized adapter before import.

Equal revisions with equal counters are idempotent. A higher revision replaces the snapshot, including an authoritative downward correction. A lower revision is ignored. Conflicting counters for the same revision within the batch or against the retained revision fail the complete transaction, preserving the previous file. Older revisions discarded by a prior import are not retained as an audit history. Unknown fields are discarded, so prompts, titles, emails and authentication data are not copied into output. This is field minimization, not a guarantee that an identifier or other accepted string contains no sensitive data.

## File and failure behavior

The CLI requires explicit input/output paths and an existing output directory. It rejects input/output aliases, output symlinks, incompatible report kinds, malformed JSON, oversized files and invalid ledgers. Input and output are each limited to 10 MiB; task ledgers have at most 10,000 identities. No output is committed after a validation failure.

Writers share a lock beside the canonical output path. A busy or abandoned `.lock` fails closed; after verifying that no importer is running, remove only that lock and retry. Valid output is written to a private temporary file and atomically renamed. This prevents partial JSON and overlapping importer writes; it is not a cross-machine database or guaranteed power-loss durability.

If the output was committed but its lock could not be cleaned up, the import remains successful and reports `cleanupWarning: "lock-cleanup-failed"`. Confirm that no importer is running before removing the remaining lock. Cleanup errors before a commit preserve the original import failure.

## Verification

```sh
node --test tests/shared/cloudUsageImport.test.js \
  tests/shared/cloudUsageImportCli.test.js \
  tests/shared/chatgptDailyUsageImport.test.js
npm run verify
```

Unit tests cover unknown versus zero, official report shapes, rejected thread estimates, safe integer/date validation, idempotence, revision replacement/correction, conflicts, scope isolation and field minimization. CLI tests exercise repeated imports, file persistence, failed-import rollback, report-kind separation, locks, alias rejection and private output permissions. Real account source availability and the remaining cloud task blocker are recorded in [the source report](cloud-usage-sources.md); fixture tests do not establish a real dot task-to-usage join.
