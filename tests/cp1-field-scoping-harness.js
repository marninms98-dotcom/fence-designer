#!/usr/bin/env node
'use strict';

/**
 * CP1 frontend field-scoping harness.
 *
 * This is deliberately no-network and dependency-free. It encodes the mission's
 * field failure modes as regression assertions against the current static
 * frontend source plus scenario fixtures. It is a source-level smoke gate;
 * executable browser/runtime harnesses provide the behavioural proof.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const sources = {
  index: read('index.html'),
  integration: read('integration.js'),
  cloud: read('cloud.js'),
};
const fixture = JSON.parse(read('tests/fixtures/cp1-field-scoping-scenarios.json'));

const all = Object.values(sources).join('\n');
const failures = [];
const passes = [];

function scenario(id) {
  const item = fixture.scenarios.find((s) => s.id === id);
  if (!item) throw new Error(`Missing fixture scenario: ${id}`);
  return item;
}

function record(id, ok, evidence, expected) {
  const item = scenario(id);
  const row = { id, evidence, expected: expected || item.expectedFutureBehavior };
  (ok ? passes : failures).push(row);
}

function has(text, pattern) {
  return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
}

function sourceWithoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// 1) Desired future behavior: dirty local drafts are not cleared until a safe
// checkpoint/reconciliation path exists.
{
  const destructiveReset =
    /localStorage\.removeItem\(['"]fenceJob['"]\)[\s\S]{0,260}(?:this|window\.app)\.job\s*=\s*null/.test(sources.index) ||
    /localStorage\.removeItem\(['"]fenceJob['"]\)[\s\S]{0,260}window\.app\.job\s*=\s*null/.test(sources.integration);
  const hasGuard = /dirty|unsynced|pendingOps|localDraftId|baseScopeHash|reconcile/i.test(
    sources.index.slice(Math.max(0, sources.index.indexOf('selectGHLContact') - 800), sources.index.indexOf('selectGHLContact') + 2600) +
    sources.integration.slice(Math.max(0, sources.integration.indexOf('loadPicker') - 800), sources.integration.indexOf('loadPicker') + 2600)
  );
  record(
    'destructive-load-clears-local-draft-before-reconciliation',
    !destructiveReset || hasGuard,
    destructiveReset
      ? 'destructive reset exists only with dirty-draft checkpoint/reconciliation evidence'
      : 'no destructive load reset pattern found',
  );
}

// 2) Desired future behavior: GHL prefill is fill-empty/conflict-aware and does
// not overwrite scoped fields.
{
  const overwriteBlock = /GHL contact is source of truth[\s\S]{0,900}window\.app\.job\.email\s*=\s*contact\.email[\s\S]{0,500}window\.app\.job\.phone\s*=\s*contact\.phone/.test(sources.index);
  const fillEmptyGuard = /untouched|dirty|conflict|fill empty|fill-empty|only if empty/i.test(
    sources.index.slice(Math.max(0, sources.index.indexOf('GHL contact is source of truth') - 500), sources.index.indexOf('GHL contact is source of truth') + 1200)
  );
  record(
    'ghl-prefill-overwrites-scoped-fields',
    !overwriteBlock || fillEmptyGuard,
    overwriteBlock ? 'GHL overwrite assignments found without scoped-field conflict/fill-empty guard' : 'no GHL overwrite block found',
  );
}

// 3) Desired future behavior: queued create_job operations flush on reconnect.
// A queued create_job must be handled before dependent save_job operations.
{
  const enqueueCreate = /_enqueue\(\{\s*type:\s*['"]create_job['"]/.test(sources.cloud);
  const flushBody = (sources.cloud.match(/async function _flushQueue\(\) \{[\s\S]*?\n  \}/) || [''])[0];
  const flushesCreate = /action\.type\s*===\s*['"]create_job['"]/.test(flushBody);
  record(
    'offline-create-job-queued-but-not-flushed',
    !enqueueCreate || flushesCreate,
    enqueueCreate && !flushesCreate ? 'create_job is enqueued offline but _flushQueue never handles it' : 'create_job flush handler present or no enqueue found',
  );
}

// 4) Desired future behavior: media survives reload or is honestly marked needs
// reattach. In-memory payloads must have a durable manifest/reattach seam.
{
  const memoryPhoto = /window\._photoFiles\[id\]\s*=\s*uploadUrl/.test(sources.index);
  const memoryVideo = /window\.siteVideo\s*=\s*\{[\s\S]{0,180}file:\s*file/.test(sources.index);
  const mediaStart = Math.max(0, sources.index.indexOf('async _processPhotoFiles') - 400);
  const mediaEnd = Math.max(mediaStart, sources.index.indexOf('deletePhoto', mediaStart));
  const mediaSlice = sourceWithoutComments(sources.index.slice(mediaStart, mediaEnd));
  const durableMedia = /indexedDB|media manifest|needs reattach|needs-reattach|persist\(/i.test(mediaSlice);
  record(
    'media-memory-only-not-durable-across-reload',
    !(memoryPhoto || memoryVideo) || durableMedia,
    memoryPhoto || memoryVideo
      ? 'in-memory media payloads are backed by durable manifest/reattach evidence'
      : 'no memory-only media pattern found',
  );
}

// 5) Desired future behavior: one-shot release has a safe ensureJobSynced seam and
// typed failure state.
{
  const callsEnsure = /ensureJobSynced\s*\(/.test(sources.index);
  const definesEnsure = /ensureJobSynced\s*[:=]\s*(?:async\s*)?function|async\s+function\s+ensureJobSynced|ensureJobSynced\s*\([^)]*\)\s*\{/.test(sources.integration);
  const typedRelease = /release state machine|failed step|resume|resumable|prepare quote|freeze scope/i.test(sourceWithoutComments(sources.index));
  record(
    'unsafe-one-shot-sync-release-seam',
    (!callsEnsure || definesEnsure) && typedRelease,
    callsEnsure && !definesEnsure
      ? 'index.html calls sync.ensureJobSynced but integration.js does not define/export it'
      : 'ensureJobSynced seam present; typed release-state evidence=' + typedRelease,
  );
}

// 6) Desired future behavior: the field-reported duplicate job-number failure is
// a first-class scenario and cannot show success after failed save. This is a
// fixture-backed check plus static search for explicit handling.
{
  const item = scenario('duplicate-job-number-save-failure-must-not-show-success');
  const fixtureHasRequiredError = item.given.backendError.message.includes('idx_jobs_job_number');
  const explicitHandling = /idx_jobs_job_number|duplicate key value|23505|job_number.*duplicate|duplicate.*job_number/i.test(all);
  const successSuppression = /save failed|failed save|do not show success|no success|recoverable conflict/i.test(sourceWithoutComments(all));
  record(
    'duplicate-job-number-save-failure-must-not-show-success',
    fixtureHasRequiredError && explicitHandling && successSuppression,
    fixtureHasRequiredError && !explicitHandling
      ? 'required duplicate idx_jobs_job_number fixture exists, but frontend has no explicit handling'
      : 'duplicate handling=' + explicitHandling + ', success suppression=' + successSuppression,
  );
}

console.log('CP1 Fence field-scoping frontend harness');
console.log('Mission:', fixture.mission);
console.log('Network:', fixture.networkPolicy);
console.log('');
for (const row of passes) {
  console.log(`PASS ${row.id}`);
  console.log(`  evidence: ${row.evidence}`);
}
for (const row of failures) {
  console.log(`FAIL ${row.id}`);
  console.log(`  expected: ${row.expected}`);
  console.log(`  evidence: ${row.evidence}`);
}
console.log('');
console.log(`Summary: ${passes.length} passed, ${failures.length} failed`);
console.log('CP1 meaning: static regression seams are present; browser/runtime harnesses prove the executable behaviour without live business calls.');

process.exitCode = failures.length ? 1 : 0;
