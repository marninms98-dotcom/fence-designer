#!/usr/bin/env node
'use strict';

/**
 * SCOPE-24: save + cold open + send reliability.
 *
 * Gates this harness pins:
 *  - Global `fenceJob` is no longer the live save key; saves write fenceJob:<id>
 *  - ONE-TIME migration copies the legacy key (unsaved work survives)
 *  - Cold open (no ?jobId=) does not auto-load yesterday's client
 *  - Unsaved work is offered as "Resume [client name]?" — never assumed
 *  - A job URL only loads THAT job's key
 *  - executeSendQuote still awaits saveToCloud({ requireSynced: true })
 *  - window.fenceQA still round-trips via getFencingState / loadFencingState
 *  - _isReadonlyNow / exitReadonly / forceRefresh are kept
 *  - _shouldAutoSave status list is not loosened
 *  - keepPrefixes includes fenceJob: and sb-
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const integrationSource = fs.readFileSync(path.join(root, 'integration.js'), 'utf8');

function sliceBlock(source, start) {
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('could not slice block');
}

function extractMethod(signature) {
  const start = indexSource.indexOf(signature);
  assert(start >= 0, `${signature} exists in index.html`);
  return sliceBlock(indexSource, start);
}

function methodBody(signature) {
  const block = extractMethod(signature);
  return block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'));
}

function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, name + ' exists');
  return sliceBlock(source, start);
}

function makeLocalStorage() {
  const store = new Map();
  return {
    get length() { return store.size; },
    key(i) { return Array.from(store.keys())[i] || null; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    _keys() { return Array.from(store.keys()); },
  };
}

function yesterdayJob() {
  return {
    clientFirstName: 'Yesterday',
    clientLastName: 'Ghost',
    phone: '0400000000',
    address: '9 Old Job St',
    runs: [{ length: 12, panels: [{ height: 1800 }] }],
    gates: [],
    checklist: { photos: [] },
    _fieldSync: {
      localDraftId: 'local-fence-ghost',
      syncAnchorType: 'local_only',
      syncAnchorId: null,
      syncState: 'local_dirty',
      lastLocalEditAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z',
    },
  };
}

function buildApp(localStorage, opts) {
  opts = opts || {};
  const app = {
    job: opts.job || null,
    currentRunId: null,
    _lastJobStorageKey: null,
    toasts: [],
    confirms: [],
    confirmAnswer: opts.confirmAnswer,
    _markLocalEdited() {},
    _persistMediaManifest() {},
    _compressJobData() { return false; },
    _hasMeaningfulLocalDraft() {
      const j = this.job || {};
      return !!(j.clientFirstName || j.clientLastName || j.phone || j.address ||
        (j.runs && j.runs.some((r) => r.length || (r.panels && r.panels.length))));
    },
    _ensureFieldSync() {
      if (!this.job) return null;
      if (!this.job._fieldSync) {
        this.job._fieldSync = { localDraftId: 'local-fence-new', syncAnchorType: 'local_only' };
      }
      return this.job._fieldSync;
    },
    _restoreCheckpointSitePlan(job) { return job; },
    _hydrateMediaManifest() {},
    showToast(msg) { this.toasts.push(msg); },
    _esc(s) { return String(s || ''); },
  };

  const sandbox = {
    window: { app, location: { search: opts.search || '', pathname: '/fence-designer/' } },
    localStorage,
    console: { warn() {}, log() {} },
    Date, JSON, String, Object, Error, Number, Array, URLSearchParams,
    confirm(msg) {
      app.confirms.push(msg);
      return app.confirmAnswer === true;
    },
    updateSyncDot() {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const methods = [
    ['_urlJobId() {', '_urlJobId', ''],
    ['_jobStorageId(job) {', '_jobStorageId', 'job'],
    ['_jobStorageKey(job) {', '_jobStorageKey', 'job'],
    ['_migrateLegacyFenceJobOnce() {', '_migrateLegacyFenceJobOnce', ''],
    ['_readPersistedJob() {', '_readPersistedJob', ''],
    ['_clearPersistedJob() {', '_clearPersistedJob', ''],
    ['_writeJobToStorage() {', '_writeJobToStorage', ''],
    ['_primaryJobRaw(job) {', '_primaryJobRaw', 'job'],
    ['_clientNameOf(job) {', '_clientNameOf', 'job'],
    ['_findResumeCandidate() {', '_findResumeCandidate', ''],
    ['_listLocalDraftCheckpoints() {', '_listLocalDraftCheckpoints', ''],
    ['_restoreCheckpointSitePlan(job) {', '_restoreCheckpointSitePlan', 'job'],
    ['_localDraftIsRecoverable(localDraftId) {', '_localDraftIsRecoverable', 'localDraftId'],
    ['_cleanupStorage() {', '_cleanupStorage', ''],
    ['save() {', 'save', ''],
    ['loadFromStorage() {', 'loadFromStorage', ''],
  ];
  for (const [signature, name, args] of methods) {
    vm.runInContext(`window.app.${name} = function(${args}) {${methodBody(signature)}};`, sandbox);
  }
  return { app, sandbox };
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log('  PASS: ' + label);
  } catch (e) {
    failures++;
    console.log('  FAIL: ' + label + '\n        ' + e.message);
  }
}

console.log('[scope-24] save + cold open + send reliability');

check('SAFETY: _isReadonlyNow / exitReadonly / forceRefresh still exist and forceRefresh skips localStorage', () => {
  assert(integrationSource.includes('function _isReadonlyNow()'), '_isReadonlyNow kept');
  assert(integrationSource.includes('function exitReadonly()'), 'exitReadonly kept');
  assert(integrationSource.includes('function forceRefresh()'), 'forceRefresh kept');
  const fr = extractFn(integrationSource, 'forceRefresh');
  assert(!/localStorage/.test(fr), 'forceRefresh must not touch localStorage');
  assert(/jobId=/.test(fr), 'forceRefresh keeps ?jobId=');
});

check('SAFETY: _shouldAutoSave still blocks quoted/accepted/scheduled/in_progress/completed', () => {
  const auto = extractFn(integrationSource, '_shouldAutoSave');
  assert(auto.includes('_isReadonlyNow()'), 'still uses live readonly');
  assert(/blocked = \['quoted', 'accepted', 'scheduled', 'in_progress', 'completed'\]/.test(auto),
    'status list not loosened');
});

check('SAFETY: executeSendQuote still awaits saveToCloud({ requireSynced: true }) before prepare/send', () => {
  const start = indexSource.indexOf('async function executeSendQuote()');
  assert(start >= 0, 'executeSendQuote exists');
  const body = indexSource.slice(start, start + 4000);
  assert(/saveToCloud\(\{\s*requireSynced:\s*true\s*\}\)/.test(body),
    'requireSynced still forced before send');
  const prep = body.indexOf('prepare_quote') >= 0 ? body.indexOf('prepare_quote') : body.length;
  const saveAt = body.search(/saveToCloud\(\{\s*requireSynced:\s*true\s*\}\)/);
  assert(saveAt >= 0 && saveAt < prep, 'requireSynced precedes prepare_quote in the send body');
});

check('SAFETY: window.fenceQA still assigned for getFencingState/loadFencingState', () => {
  assert(/window\.fenceQA = fenceQA;/.test(indexSource), 'window.fenceQA assigned');
  assert(/verification:\s*\(window\.fenceQA && window\.fenceQA\._verificationState\)/.test(integrationSource),
    'getFencingState still reads fenceQA');
  assert(/window\.fenceQA\._verificationState = scopeJson\.verification/.test(integrationSource),
    'loadFencingState still restores fenceQA');
});

check('SAFETY: keepPrefixes includes fenceJob: and sb-', () => {
  const block = extractMethod('_cleanupStorage() {');
  const match = /var keepPrefixes = \[([^\]]*)\]/.exec(block);
  assert(match, 'keepPrefixes declared');
  const prefixes = match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert(prefixes.indexOf('sb-') !== -1, 'sb- kept');
  assert(prefixes.indexOf('fenceJob:') !== -1, 'fenceJob: kept');
});

check('SAFETY: sent-job read-only lock still exists', () => {
  assert(integrationSource.includes('_shouldOpenFrozenViewer'), 'frozen viewer redirect kept');
  assert(/latest_frozen_scope_revision_id/.test(integrationSource), 'frozen revision id still consulted');
});

check('one-time migration copies the legacy fenceJob and unsaved work survives', () => {
  const localStorage = makeLocalStorage();
  const job = yesterdayJob();
  localStorage.setItem('fenceJob', JSON.stringify(job));
  const { app } = buildApp(localStorage, { job });
  app._migrateLegacyFenceJobOnce();
  const dest = 'fenceJob:local-fence-ghost';
  assert.strictEqual(localStorage.getItem(dest), JSON.stringify(job), 'legacy copied to per-job key');
  assert.strictEqual(localStorage.getItem('fenceJob'), null, 'legacy key removed after verified copy');
  assert.strictEqual(localStorage.getItem('fenceJob:migrated'), '1', 'migration flag set');
  const parsed = JSON.parse(localStorage.getItem(dest));
  assert.strictEqual(parsed.clientFirstName, 'Yesterday', 'in-progress client name survived');
  assert.strictEqual(parsed.phone, '0400000000', 'in-progress phone survived');
});

check('migration is a no-op when already migrated and does not clobber a newer per-job key', () => {
  const localStorage = makeLocalStorage();
  localStorage.setItem('fenceJob:migrated', '1');
  localStorage.setItem('fenceJob:local-fence-ghost', JSON.stringify({ clientFirstName: 'KeepMe' }));
  localStorage.setItem('fenceJob', JSON.stringify({ clientFirstName: 'StaleLegacy' }));
  const { app } = buildApp(localStorage, { job: yesterdayJob() });
  app._migrateLegacyFenceJobOnce();
  assert.strictEqual(JSON.parse(localStorage.getItem('fenceJob:local-fence-ghost')).clientFirstName, 'KeepMe');
});

check('save() writes fenceJob:<localDraftId>, not the global fenceJob key', () => {
  const localStorage = makeLocalStorage();
  const job = yesterdayJob();
  const { app } = buildApp(localStorage, { job });
  app.job = job;
  app.save();
  assert.strictEqual(localStorage.getItem('fenceJob'), null, 'global key is not the live save');
  const raw = localStorage.getItem('fenceJob:local-fence-ghost');
  assert(raw, 'per-job key written');
  assert.strictEqual(JSON.parse(raw).clientLastName, 'Ghost');
});

check('save() of a linked cloud job writes fenceJob:<jobId> and drops the old local key', () => {
  const localStorage = makeLocalStorage();
  const job = yesterdayJob();
  const { app } = buildApp(localStorage, { job });
  app.job = job;
  app.save();
  assert(localStorage.getItem('fenceJob:local-fence-ghost'), 'local key present first');
  app.job._fieldSync.syncAnchorType = 'job';
  app.job._fieldSync.syncAnchorId = '20000000-0000-4000-8000-000000000002';
  app.save();
  assert(localStorage.getItem('fenceJob:20000000-0000-4000-8000-000000000002'), 'cloud key written');
  assert.strictEqual(localStorage.getItem('fenceJob:local-fence-ghost'), null, 'old local key retired');
});

check('cold open with no ?jobId= does not auto-load yesterday — decline leaves a blank job', () => {
  const localStorage = makeLocalStorage();
  localStorage.setItem('fenceJob', JSON.stringify(yesterdayJob()));
  const { app } = buildApp(localStorage, { search: '', confirmAnswer: false });
  app.job = null;
  app.loadFromStorage();
  assert.strictEqual(app.job, null, 'declining resume leaves job empty');
  assert(app.confirms.some((m) => /Resume Yesterday Ghost\?/.test(m)),
    'offered Resume [client name]?, got: ' + JSON.stringify(app.confirms));
  assert(localStorage.getItem('fenceJob:local-fence-ghost'), 'unsaved work remains after decline');
});

check('cold open resume accept hydrates yesterday only after an explicit yes', () => {
  const localStorage = makeLocalStorage();
  localStorage.setItem('fenceJob', JSON.stringify(yesterdayJob()));
  const { app } = buildApp(localStorage, { search: '', confirmAnswer: true });
  app.job = null;
  app.loadFromStorage();
  assert(app.job, 'accepted resume loads the job');
  assert.strictEqual(app.job.clientFirstName, 'Yesterday');
  assert(app.confirms.some((m) => /Resume Yesterday Ghost\?/.test(m)), 'prompt used the client name');
});

check('a ?jobId= URL loads only that job\'s key, never a sibling client', () => {
  const localStorage = makeLocalStorage();
  localStorage.setItem('fenceJob:job-A', JSON.stringify({ clientFirstName: 'Alpha', runs: [], gates: [], _fieldSync: { localDraftId: 'a', syncAnchorType: 'job', syncAnchorId: 'job-A' } }));
  localStorage.setItem('fenceJob:job-B', JSON.stringify({ clientFirstName: 'Bravo', runs: [], gates: [], _fieldSync: { localDraftId: 'b', syncAnchorType: 'job', syncAnchorId: 'job-B' } }));
  const { app } = buildApp(localStorage, { search: '?jobId=job-B' });
  app.job = null;
  app.loadFromStorage();
  assert(app.job, 'job-B cache loaded');
  assert.strictEqual(app.job.clientFirstName, 'Bravo');
  assert.strictEqual(app.confirms.length, 0, 'job URL must not prompt resume of a sibling');
});

check('primary-save recoverability still sees a per-job key (checkpoint-recovery contract)', () => {
  const localStorage = makeLocalStorage();
  const job = yesterdayJob();
  const { app } = buildApp(localStorage, { job });
  app.job = job;
  app.save();
  assert.strictEqual(app._localDraftIsRecoverable('local-fence-ghost'), true);
});

check('cleanup keeps per-job keys and the legacy key, still drops junk', () => {
  const localStorage = makeLocalStorage();
  localStorage.setItem('fenceJob', '{"legacy":true}');
  localStorage.setItem('fenceJob:job-1', '{"per":true}');
  localStorage.setItem('fenceJob:migrated', '1');
  localStorage.setItem('orphan_old_draft', 'junk');
  const { app } = buildApp(localStorage, { job: yesterdayJob() });
  app._cleanupStorage();
  assert(localStorage.getItem('fenceJob'), 'legacy keep-list entry survives');
  assert(localStorage.getItem('fenceJob:job-1'), 'per-job key survives');
  assert(localStorage.getItem('fenceJob:migrated'), 'migration flag survives via fenceJob: prefix');
  assert.strictEqual(localStorage.getItem('orphan_old_draft'), null, 'junk still swept');
});

check('integration mint verification reads via _readPersistedFenceJob (not a hard-coded global key only)', () => {
  assert(integrationSource.includes('function _readPersistedFenceJob()'), 'helper exists');
  assert(!/JSON\.parse\(localStorage\.getItem\('fenceJob'\) \|\| 'null'\)/.test(
    integrationSource.replace(/function _readPersistedFenceJob\(\)[\s\S]*?\n  \}/, '')
  ), 'mint path no longer uniquely depends on the global key');
});

check('open-separately uses skipStorage so init cannot reload the ghost', () => {
  const open = extractFn(integrationSource, '_openFencingTargetSeparately');
  assert(open.includes("init({ skipStorage: true })"), 'skipStorage on open-separately');
});

if (failures) {
  console.log('\nSummary: ' + failures + ' failed');
  process.exit(1);
}
console.log('\nSummary: all passed');
