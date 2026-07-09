#!/usr/bin/env node
'use strict';

/**
 * CP3 frontend offline-sync/media harness.
 * No browser, no network. Static assertions for the field promise:
 * an iPad can keep a local draft/media record while Wi-Fi drops, reconnect
 * flushes through an auditable queue, and stale cloud saves cannot silently
 * overwrite a newer Supabase scope.
 */

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const index = read('index.html');
const integration = read('integration.js');
const cloud = read('cloud.js');

const passes = [];
const failures = [];
function record(id, ok, evidence) {
  (ok ? passes : failures).push({ id, evidence });
}
function has(text, pattern) {
  return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
}

record(
  'offline queue has durable ids, timestamps, persisted job-id map and audit journal',
  has(cloud, 'var _offlineJobIdMap = {}') &&
    has(cloud, 'function _newOpId') &&
    has(cloud, 'createdAt') &&
    has(cloud, 'sw_offline_job_id_map') &&
    has(cloud, 'sw_offline_journal') &&
    has(cloud, 'function _recordOfflineJournal') &&
    has(cloud, 'getOfflineState'),
  'cloud.js persists queue, local->cloud job map, and journal entries'
);

record(
  'GHL saveScope queues local scope saves when offline or fetch fails',
  /async saveScope\(jobId, scopeJson, meta\)[\s\S]{0,260}if \(!_online\)[\s\S]{0,120}_queueScopeSave/.test(cloud) &&
    /catch\(e\)[\s\S]{0,240}saveScope network failure; queued local scope save[\s\S]{0,160}_queueScopeSave/.test(cloud) &&
    /delete requestMeta\._flushAttempt/.test(cloud),
  'field saves do not wait until the end to discover there is no sync target; they are queued with clean meta'
);

record(
  'offline flush maps local jobs before dependent save_job actions and records failures',
  /action\.type === 'create_job'[\s\S]{0,260}_offlineJobIdMap\[localJob\.id\] = created\.id/.test(cloud) &&
    /action\.type === 'save_job'[\s\S]{0,220}localJobIdMap\[action\.jobId\] \|\| action\.jobId/.test(cloud) &&
    /_recordOfflineJournal\(action, 'failed'/.test(cloud) &&
    /_enqueue\(action\)/.test(cloud),
  'create_job establishes the cloud id before save_job; failed flushes stay queued and visible'
);

record(
  'loaded cloud jobs carry a server scope cursor for later save preconditions',
  /loadJob\(jobId\)[\s\S]{0,900}current_scope_hash/.test(cloud) &&
    /current_scope_updated_at/.test(cloud) &&
    /function _rememberScopeCursor/.test(integration) &&
    /getScopeSaveCursor/.test(integration),
  'load_job hash/updated_at is retained in integration and shared with autosave/manual save'
);

record(
  'manual save and autosave attach baseScopeHash before writing to Supabase',
  /_attachScopeSaveCursor\(meta\)/.test(integration) &&
    /meta\.baseScopeHash = _baseScopeHash/.test(integration) &&
    /getScopeSaveCursor\(\)[\s\S]{0,180}meta\.baseScopeHash = cursor\.baseScopeHash/.test(cloud) &&
    /_rememberScopeCursor\(savedJob\)/.test(cloud),
  'both save paths carry the loaded server hash and advance it only after a successful save'
);

record(
  'scope hash conflicts are typed and cannot show success',
  /err\.code = data\.code/.test(cloud) &&
    /err\.details = data/.test(cloud) &&
    /function _isScopeHashConflict/.test(integration) &&
    /scope_hash_conflict/.test(integration) &&
    /Your iPad draft stayed local/.test(integration),
  '409 scope_hash_conflict becomes an explicit sync-conflict message, not a green save'
);

record(
  'queued offline saves show pending sync and cannot release/sign off',
  /scopeQueuedLocally/.test(integration) &&
    /if \(!scopeQueuedLocally\) _rememberScopeCursor\(savedJob\)/.test(integration) &&
    /Saved on iPad — pending sync/.test(integration) &&
    /sync_required: reconnect to Wi-Fi before creating the job or sending the quote/.test(integration) &&
    /el\.textContent = message \|\| 'Saved locally \(offline\)'/.test(cloud),
  'manual offline save is honest local/pending state; release requires reconnect before job/quote actions'
);

record(
  'autosave queued local is not reported as cloud success',
  /if \(savedJob && savedJob\.queued\) \{[\s\S]{0,120}emit\('autosave:queued'/.test(cloud) &&
    /else \{[\s\S]{0,160}_rememberScopeCursor\(savedJob\)[\s\S]{0,120}emit\('autosave:success'/.test(cloud) &&
    /cloud\.on\('autosave:queued'/.test(integration) &&
    /Saved on iPad — pending sync/.test(integration),
  'autosave has a distinct queued event/status and only emits success after a real cloud save'
);

record(
  'post-upload re-save does not swallow scope hash conflicts',
  /Scope re-save with cloudUrls queued locally; pending sync/.test(integration) &&
    /catch\(e\) \{[\s\S]{0,80}if \(_isScopeHashConflict\(e\)\) throw e/.test(integration),
  'cloudUrl persistence re-save can be non-blocking for ordinary failures, but stale scope conflicts block final success'
);

record(
  'inline GHL contact path remembers the loaded job cursor before autosave starts',
  /_rememberScopeCursor\(existingJob\)/.test(index) &&
    /_connectJob\(existingJob \? existingJob\.id : null/.test(index),
  'inline client-name GHL launch passes existing job cursor into integration before connecting the job'
);

record(
  'previous scope and URL/GHL load paths use cursor-aware GHL load/find seams',
  /var job = await cloud\.ghl\.loadJob\(jobId\)/.test(integration) &&
    /_rememberScopeCursor\(job\)/.test(integration) &&
    /_rememberScopeCursor\(existingJob\)/.test(integration) &&
    /_rememberScopeCursor\(sbJob\)/.test(integration),
  'previous-scope, URL, direct Supabase and GHL lookup paths remember the save cursor'
);

record(
  'cloud media reload is idempotent and refreshes the local media manifest',
  /alreadyLoaded = window\.sitePhotos\.some/.test(integration) &&
    /existing\.cloudId === p\.id/.test(integration) &&
    /existing\.cloudUrl === p\.storage_url/.test(integration) &&
    /_persistMediaManifest/.test(integration),
  'opening the same job repeatedly does not append duplicate cloud photos and persists cloud URLs'
);

record(
  'media manifest survives quota cleanup and reload hydrates photos/video',
  /_mediaManifestKey\(\)/.test(index) &&
    /_persistMediaManifest\(\)/.test(index) &&
    /_hydrateMediaManifest\(\)/.test(index) &&
    /sw_media_manifest_/.test(index) &&
    /Do not overwrite sw_media_manifest_/.test(index) &&
    /videoCloudUrl/.test(index) &&
    /videoNeedsReattach/.test(index),
  'localStorage manifest is a separate durable breadcrumb from the heavy fenceJob payload'
);

record(
  'cleanup keeps offline sync and media breadcrumbs',
  /sw_offline_queue/.test(index) &&
    /sw_offline_job_id_map/.test(index) &&
    /sw_offline_journal/.test(index) &&
    /sw_media_manifest_/.test(index),
  'cleanup preserves queue/map/journal/manifest keys'
);

console.log('CP3 Fence offline-journal/media harness');
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
