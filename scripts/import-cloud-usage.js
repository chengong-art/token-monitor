#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeCodexAccountUsage, importCloudTaskUsage } = require('../src/shared/cloudUsageImport');
const { normalizeChatgptDailyUsage } = require('../src/shared/chatgptDailyUsageImport');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const HELP = 'Usage: node scripts/import-cloud-usage.js --kind codex-account|chatgpt-workspace|cloud-task --input FILE --output FILE';

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--kind', '--input', '--output'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(HELP);
    }
    const key = flag.slice(2);
    if (Object.hasOwn(result, key)) throw new Error(HELP);
    result[key] = argv[i + 1];
  }
  if (!['codex-account', 'chatgpt-workspace', 'cloud-task'].includes(result.kind) || !result.input || !result.output) {
    throw new Error(HELP);
  }
  return result;
}

function readJson(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Expected a JSON file no larger than 10 MiB');
    // Bound the actual read as well as stat: a concurrent writer may grow it.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!read) break;
      bytes += read;
    }
    if (bytes > MAX_FILE_BYTES) throw new Error('Expected a JSON file no larger than 10 MiB');
    try { return JSON.parse(buffer.subarray(0, bytes).toString('utf8')); }
    catch (error) { throw new Error('Invalid JSON', { cause: error }); }
  } finally {
    fs.closeSync(fd);
  }
}

function importFile(args) {
  const input = fs.realpathSync(path.resolve(args.input));
  const requestedOutput = path.resolve(args.output);
  // Canonicalize the existing parent, so aliases share a lock and identity.
  const output = path.join(fs.realpathSync(path.dirname(requestedOutput)), path.basename(requestedOutput));
  let outputStat;
  try { outputStat = fs.lstatSync(output); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (outputStat && (!outputStat.isFile() || outputStat.isSymbolicLink())) {
    throw new Error('Output must be a regular file, not a symlink');
  }
  if (input === output || (outputStat && fs.realpathSync(output) === input)) {
    throw new Error('Input and output must be different files');
  }
  const inputStat = fs.statSync(input);
  if (outputStat && inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino) {
    throw new Error('Input and output must be different files');
  }
  const lock = `${output}.lock`;
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Output is locked; confirm no importer is running before removing its .lock file', { cause: error });
    throw error;
  }
  let temporary;
  let committed = false;
  let completion;
  try {
    const raw = readJson(input);
    let result;
    if (args.kind !== 'cloud-task') {
      const kind = args.kind === 'codex-account' ? 'codex-account-usage-report' : 'chatgpt-daily-usage-report';
      if (fs.existsSync(output)) {
        const previous = readJson(output);
        if (previous.version !== 1 || previous.kind !== kind) {
          throw new Error('Output contains another report kind');
        }
      }
      const normalize = args.kind === 'codex-account' ? normalizeCodexAccountUsage : normalizeChatgptDailyUsage;
      result = { version: 1, kind, report: normalize(raw) };
    } else {
      result = importCloudTaskUsage(raw, fs.existsSync(output) ? readJson(output) : null);
    }
    const encoded = `${JSON.stringify(result, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) throw new Error('Output would exceed the 10 MiB ledger limit');
    temporary = `${output}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, encoded, { flag: 'wx', mode: 0o600 });
    completion = { kind: result.kind, scope: result.report.scope, realtime: false, canCombineWithLocal: false };
    fs.renameSync(temporary, output);
    temporary = null;
    committed = true;
    return completion;
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
    // Cleanup cannot turn an already-committed import into a reported failure,
    // or replace the original validation/write error before a commit.
    try { fs.closeSync(lockFd); }
    catch { if (committed) completion.cleanupWarning = 'lock-cleanup-failed'; }
    try { fs.unlinkSync(lock); }
    catch (error) {
      if (committed && error.code !== 'ENOENT') completion.cleanupWarning = 'lock-cleanup-failed';
    }
  }
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) console.log(HELP);
    else console.log(JSON.stringify(importFile(args)));
    return 0;
  } catch (error) {
    // Do not echo input records, authentication responses, or private paths.
    console.error(error.code ? `Import failed (${error.code})` : `Import failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { parseArgs, importFile, main };
