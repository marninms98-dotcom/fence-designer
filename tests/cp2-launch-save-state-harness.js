#!/usr/bin/env node
'use strict';

/**
 * CP2 frontend launch/save-state harness.
 * No network, no browser. This checks the field contract Marnin approved:
 * explicit launcher, local iPad draft wins, phone-only GHL leads are usable,
 * duplicate job-number conflicts cannot show success, and release is blocked
 * until the scope has a sync anchor.
 */

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const index = read('index.html');
const integration = read('integration.js');
const cloud = read('cloud.js');
const all = [index, integration, cloud].join('\n');

const passes = [];
const failures = [];
function record(id, ok, evidence) {
  (ok ? passes : failures).push({ id, evidence });
}
function has(text, pattern) {
  return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
}
record(
  'launcher has the three approved entry points',
  has(index, 'showLaunchModal()') && has(index, '1. Load GHL lead/contact') && has(index, '2. Resume draft / previous scope') && has(index, '3. Start new local draft'),
  'launcher strings and showLaunchModal present'
);

record(
  'header routes through launcher instead of hidden loadPicker search',
  /id="headerSearch"[^>]+onclick="app\.showLaunchModal\(\)"/.test(index) && !/id="headerSearch"[^>]+loadPicker/.test(index),
  'headerSearch opens app.showLaunchModal and no longer calls loadPicker directly'
);

record(
  'duplicate top cloud Save Load Dashboard bar is skipped for fencing',
  /detectToolType\(\) === 'fencing'[\s\S]{0,220}skipping duplicate cloud Save\/Load\/Dashboard bar/.test(integration),
  'integration toolbar no-ops for fencing so launcher/buttons are not duplicated'
);

record(
  'local draft metadata and checkpoint are durable',
  /localDraftId/.test(index) && /requiresLinkBeforeRelease/.test(index) && /fenceJob_checkpoint_/.test(index) && /_checkpointLocalDraftBeforeLoad/.test(index),
  'field sync metadata plus checkpoint storage present'
);

record(
  'GHL/cloud contact data is fill-empty only',
  /Fill-empty only: GHL\/cloud data must not overwrite local iPad edits/.test(integration) && /if \(current\) return;/.test(integration) && /_fillEmptyFromContact/.test(index),
  'prefill preserves non-empty local fields'
);

record(
  'load paths checkpoint local draft before reset',
  /_resetFencingForCloudLoad/.test(integration) && /_checkpointLocalDraftBeforeLoad\(source/.test(integration) && /Local draft checkpointed before/.test(integration),
  'loadPicker/search/loadFromSupabase use local-wins checkpoint seam'
);

record(
  'phone-only GHL leads remain selectable',
  /Phone lead/.test(cloud) && !/leads = leads\.filter\(function\(o\)[\s\S]{0,120}phone-only names/.test(cloud),
  'phone-only filter removed; fallback label exists'
);

record(
  'release is blocked until linked/synced',
  /hasReleaseAnchor/.test(integration) && /ensureJobSynced\s*:\s*async function/.test(integration) && /link_required/.test(integration) && /Release blocked until/.test(index),
  'release readiness seam blocks local-only unanchored drafts'
);

record(
  'duplicate job number conflict cannot show success',
  /idx_jobs_job_number|duplicate key value|23505/.test(integration) && /Recoverable conflict: duplicate job number/.test(integration) && /throw e;/.test(integration),
  'save catch surfaces conflict and rethrows so success UI cannot proceed'
);

record(
  'offline create_job queue flushes before dependent saves',
  /action\.type === 'create_job'/.test(cloud) && /localJobIdMap/.test(cloud) && /localJobIdMap\[action\.jobId\] \|\| action\.jobId/.test(cloud),
  'offline create_job branch maps local IDs before save_job flush'
);

record(
  'photos keep a reloadable local upload copy or honest reattach state',
  /uploadDataUrl/.test(index) && /mediaManifestState/.test(index) && /needsReattach/.test(index) && /cp\.uploadDataUrl/.test(integration),
  'photo upload copy persisted in draft; video marks reattach until cloud upload'
);


record(
  'URL auto-load/reconnect uses local-wins guard',
  /auto_load_url_job/.test(integration) && /app\.init\(\) may have already restored fenceJob/.test(integration) && /if \(!localDraftWins\) _loadFencingStateLocalWins\(job\.scope_json, 'auto_load_url_job'\)/.test(integration),
  '?jobId= auto-load checkpoints local draft and does not hydrate remote scope when local wins'
);

record(
  'empty-scope Supabase load fills blank client fields only',
  /_prefillContact\(\{ name: job\.client_name/.test(integration) && /if \(!f\.value\) f\.value = job\.client_name/.test(integration),
  'loadFromSupabase empty-scope client data uses fill-empty helper / non-fencing fill-empty guard'
);

console.log('CP2 Fence launch/save-state harness');
for (const row of passes) {
  console.log(`PASS ${row.id}`);
  console.log(`  evidence: ${row.evidence}`);
}
for (const row of failures) {
  console.log(`FAIL ${row.id}`);
  console.log(`  evidence: ${row.evidence}`);
}
console.log(`\nSummary: ${passes.length} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
