#!/usr/bin/env node
'use strict';

/**
 * Behavioral VM harness for cloud.js offline save flushing.
 * No browser, no real network, no real Supabase.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'cloud.js'), 'utf8');

function makeStorage(seed) {
  const data = new Map(Object.entries(seed || {}));
  return {
    get length() { return data.size; },
    key(i) { return Array.from(data.keys())[i] || null; },
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(k, String(v)); },
    removeItem(k) { data.delete(k); },
    clear() { data.clear(); },
  };
}

function makeSupabaseStub(sessionRef) {
  const chain = {
    select() { return this; },
    eq() { return this; },
    order() { return this; },
    limit() { return this; },
    update() { return this; },
    insert() { return Promise.resolve({ data: null, error: null }); },
    single() { return Promise.resolve({ data: null, error: null }); },
  };
  return {
    createClient() {
      return {
        auth: {
          onAuthStateChange() {},
          getSession: async () => ({ data: { session: sessionRef.value } }),
        },
        from() { return Object.create(chain); },
      };
    },
  };
}

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function makeVm(opts) {
  opts = opts || {};
  const localStorage = makeStorage(opts.storage);
  const listeners = {};
  const sessionRef = { value: opts.session === undefined ? { access_token: 'session-jwt' } : opts.session };
  const fetchCalls = [];
  const window = {
    location: { search: '', href: 'https://example.test/fence', pathname: '/fence' },
    addEventListener(event, fn) { listeners[event] = fn; },
    removeEventListener() {},
    supabase: makeSupabaseStub(sessionRef),
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
  };
  window.top = window;

  const document = {
    title: 'Fence Tool',
    querySelector() { return null; },
    getElementById() { return null; },
    createElement(tag) {
      return {
        tagName: tag,
        style: {},
        set textContent(v) { this._text = v; },
        get textContent() { return this._text || ''; },
      };
    },
    body: { appendChild() {} },
  };

  const context = {
    window,
    document,
    navigator: { onLine: opts.online !== false },
    localStorage,
    URLSearchParams,
    console: opts.console || { log() {}, warn() {}, error() {} },
    setTimeout: opts.setTimeout || setTimeout,
    clearTimeout: opts.clearTimeout || clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options: options || {} });
      if (opts.fetch) return opts.fetch(url, options || {}, fetchCalls.length);
      return response(200, { job: { id: 'job-1', current_scope_hash: 'hash-ok', current_scope_updated_at: '2026-07-10T00:00:00Z' } });
    },
    TextEncoder,
    Promise,
  };

  vm.runInNewContext(source, context, { filename: 'cloud.js' });
  return { cloud: window.SECUREWORKS_CLOUD, window, listeners, localStorage, fetchCalls, sessionRef };
}

function queueFrom(storage) {
  return JSON.parse(storage.getItem('sw_offline_queue') || '[]');
}

async function testBearerHeaders() {
  const { cloud } = makeVm();
  const headers = await cloud.authorizedHeaders({ 'X-Test': 'yes' });
  assert.strictEqual(headers.Authorization, 'Bearer session-jwt');
  assert.strictEqual(headers['Content-Type'], 'application/json');
  assert(!('x-api-key' in headers), 'authorizedHeaders must not emit x-api-key');
  assert.strictEqual(headers['X-Test'], 'yes');
}

async function testCoalescedLatestSaveFlushesOnce() {
  const { cloud, listeners, localStorage, fetchCalls } = makeVm({ online: false });
  await cloud.ghl.saveScope('job-1', { rev: 1 }, { baseScopeHash: 'server-base', client_name: 'Old' });
  await cloud.ghl.saveScope('job-1', { rev: 2 }, { baseScopeHash: 'stale-later', client_name: 'New' });
  await cloud.ghl.saveScope('job-1', { rev: 3 }, { client_phone: '+61 400 000 000' });

  let queue = queueFrom(localStorage);
  assert.strictEqual(queue.length, 1, 'multiple pending saves for one job coalesce');
  assert.deepStrictEqual(queue[0].scopeJson, { rev: 3 });
  assert.strictEqual(queue[0].meta.baseScopeHash, 'server-base', 'original server base cursor is preserved');
  assert.strictEqual(queue[0].meta.client_name, 'New', 'latest save meta is retained');

  listeners.online();
  await cloud.flushOfflineQueue();

  const saveCalls = fetchCalls.filter((c) => String(c.url).includes('action=save_scope'));
  assert.strictEqual(saveCalls.length, 1, 'reconnect flush sends one latest save');
  const body = JSON.parse(saveCalls[0].options.body);
  assert.deepStrictEqual(body.scopeJson, { rev: 3 });
  assert.strictEqual(body.meta.baseScopeHash, 'server-base');
  assert.strictEqual(queueFrom(localStorage).length, 0, 'successful flush removes resolved work');
}

async function testTransientFlushFailureRetainsWorkAndEmitsFailure() {
  const events = [];
  const { cloud, listeners, localStorage } = makeVm({
    online: false,
    fetch: async () => { throw new Error('transient down'); },
  });
  cloud.on('offline:flush', (event) => events.push(event));
  await cloud.ghl.saveScope('job-1', { rev: 1 }, { baseScopeHash: 'h1' });
  listeners.online();
  await cloud.flushOfflineQueue();

  assert.strictEqual(queueFrom(localStorage).length, 1, 'transient failure remains queued');
  assert(events.some((e) => e.status === 'failure' && /transient down/.test(e.message)), 'failure event emitted');
}

async function testConflictRetainsWorkAndEmitsConflict() {
  const events = [];
  const { cloud, listeners, localStorage } = makeVm({
    online: false,
    fetch: async () => response(409, { error: 'Scope changed in Supabase', code: 'scope_hash_conflict' }),
  });
  cloud.on('offline:flush', (event) => events.push(event));
  await cloud.ghl.saveScope('job-1', { rev: 1 }, { baseScopeHash: 'h1' });
  listeners.online();
  await cloud.flushOfflineQueue();

  assert.strictEqual(queueFrom(localStorage).length, 1, 'conflicted save remains queued for manual resolution');
  assert(events.some((e) => e.status === 'conflict' && e.code === 'scope_hash_conflict'), 'conflict event emitted');
}

async function testTypedScopeSaveErrorsPreserveRecoveryTruth() {
  for (const reason of ['scope_hash_conflict', 'scope_ref_mismatch', 'missing_scope_cursor']) {
    const { cloud } = makeVm({
      fetch: async () => response(409, {
        error: 'guard rejected save',
        reason,
        current_scope_hash: reason === 'scope_ref_mismatch' ? null : 'server-hash',
        job_id: 'job-1',
        request_id: 'request-123',
      }),
    });
    let error;
    try {
      await cloud.ghl.saveScope('job-1', { job: { ref: 'SWF-1' } }, { baseScopeHash: 'stale' });
    } catch (e) { error = e; }
    assert(error, reason + ' must reject');
    assert.strictEqual(error.name, 'ScopeSaveError');
    assert.strictEqual(error.httpStatus, 409);
    assert.strictEqual(error.reason, reason);
    assert.strictEqual(error.current_scope_hash, reason === 'scope_ref_mismatch' ? null : 'server-hash');
    assert.strictEqual(error.jobId, 'job-1');
    assert.strictEqual(error.targetJobId, 'job-1');
    assert.strictEqual(error.serverJobId, 'job-1');
    assert.strictEqual(error.requestId, 'request-123');
    assert.strictEqual(typeof error.loadServerScope, 'function', 'server scope remains behind the guarded load path');
  }
}

async function testAutosaveConflictCarriesPayloadAndStopsUnchangedRetry() {
  const scheduled = [];
  const fetchCalls = [];
  const { cloud, window } = makeVm({
    setTimeout(fn, delay) { scheduled.push({ fn, delay }); return scheduled.length; },
    clearTimeout() {},
    fetch: async (url, options) => {
      fetchCalls.push(JSON.parse(options.body));
      return response(409, { error: 'conflict', reason: 'scope_hash_conflict', current_scope_hash: 'server-hash', job_id: 'job-1' });
    },
  });
  const state = { job: { client: 'Client B', phone: '0400000000', ref: 'SWF-1', _fieldSync: { syncAnchorType: 'job', syncAnchorId: 'job-1' } }, runs: [{ name: 'B payload' }] };
  const errors = [];
  cloud.on('autosave:error', (event) => errors.push(event));
  const remembered = [];
  window._swIntegration = {
    getScopeSaveCursor: () => ({ baseScopeHash: 'wrong-A', scopeCursorReconcileV1: true }),
    _rememberScopeCursor: (job) => remembered.push(job),
  };
  cloud.startAutoSave('job-1', () => state, 30000);
  assert.strictEqual(scheduled[0].delay, 30000);
  await scheduled.shift().fn();
  assert.strictEqual(fetchCalls.length, 1, 'original refusal is the only automatic conflict attempt');
  assert.strictEqual(fetchCalls[0].meta.baseScopeHash, 'wrong-A', 'failure starts with the poisoned cursor');
  assert.strictEqual(fetchCalls[0].meta.scopeCursorReconcileV1, true, 'capable fence autosave advertises reconcile without weakening the guard');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].error.reason, 'scope_hash_conflict');
  assert.deepStrictEqual(errors[0].attemptedScope, state, 'autosave:error carries the exact target payload');
  assert.strictEqual(errors[0].retryStopped, true);
  assert.strictEqual(scheduled.length, 1, 'stopped conflict state only schedules a local edit probe');
  await scheduled.shift().fn();
  assert.strictEqual(fetchCalls.length, 1, 'unchanged conflict payload is not timer-retried');
  assert.strictEqual(errors.length, 1, 'the local edit probe re-emits nothing while blocked');
  assert.strictEqual(remembered.length, 0);
}

async function testJobSwapMidFlightDiscardsRetiredSaveResult() {
  const scheduled = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { cloud, window } = makeVm({
    setTimeout(fn, delay) { scheduled.push({ fn, delay }); return scheduled.length; },
    clearTimeout() {},
    fetch: async () => {
      await gate;
      return response(200, { job: { id: 'job-1', current_scope_hash: 'hash-old' } });
    },
  });
  const successes = [];
  const remembered = [];
  cloud.on('autosave:success', (event) => successes.push(event));
  window._swIntegration = {
    getScopeSaveCursor: () => ({}),
    _rememberScopeCursor: (job) => remembered.push(job),
  };
  cloud.startAutoSave('job-1', () => ({ job: { client: 'Client A', phone: '0400000000' } }), 30000);
  const inFlight = scheduled.shift().fn();
  cloud.stopAutoSave();
  release();
  await inFlight;
  assert.strictEqual(remembered.length, 0, 'a retired save never writes the old job cursor over the new job');
  assert.strictEqual(successes.length, 0, 'a retired save never paints Saved on the job that replaced it');
}

async function testTransportBackoffStopsAtFiveAttempts() {
  const scheduled = [];
  const { cloud, localStorage } = makeVm({
    setTimeout(fn, delay) { scheduled.push({ fn, delay }); return scheduled.length; },
    clearTimeout() {},
    fetch: async () => response(503, { error: 'gateway down', reason: 'transport_error' }),
  });
  const events = [];
  let payload = 'unchanged';
  cloud.on('autosave:error', (event) => events.push(event));
  cloud.startAutoSave('job-1', () => ({ job: { client: 'Client', phone: '0400000000' }, payload }), 30000);
  const observed = [];
  for (let i = 0; i < 5; i++) {
    const task = scheduled.shift();
    observed.push(task.delay);
    await task.fn();
  }
  assert.deepStrictEqual(observed, [30000, 30000, 120000, 300000, 300000], '30s, 2m, then 5m capped schedule');
  assert.strictEqual(events.length, 5, 'one unchanged payload gets at most five automatic attempts');
  assert.strictEqual(events[4].retryStopped, true);
  assert.strictEqual(queueFrom(localStorage).length, 1, 'transport-failing payload remains in the existing local queue');
  assert.strictEqual(scheduled.length, 1, 'stopped state only schedules a local edit probe');
  payload = 'edited';
  await scheduled.shift().fn();
  assert.strictEqual(events.length, 6, 'an edit starts a fresh transport budget');
  assert.strictEqual(events[5].transportAttempt, 1);
  cloud.stopAutoSave();
}

async function testUnownedCapableCursorIsQuarantinedBeforeFlush() {
  const events = [];
  const { cloud, listeners, localStorage, fetchCalls } = makeVm({ online: false });
  cloud.on('autosave:error', (event) => events.push(event));
  await cloud.ghl.saveScope('job-B', {
    job: { ref: 'SWF-2', client: 'Client B', _fieldSync: { syncAnchorType: 'job', syncAnchorId: 'job-B' } },
  }, {
    baseScopeHash: 'cursor-owned-by-A',
    scopeCursorJobId: 'job-A',
    scopeCursorReconcileV1: true,
  });
  let queue = queueFrom(localStorage);
  assert.strictEqual(queue[0].meta.cursorQuarantined, true);
  assert.strictEqual(queue[0].meta.baseScopeHash, undefined, 'unowned cursor bytes are not retained for replay');
  listeners.online();
  await cloud.flushOfflineQueue();
  assert.strictEqual(fetchCalls.filter((c) => String(c.url).includes('action=save_scope')).length, 0, 'quarantined cursor/payload is not written before reconcile');
  assert.strictEqual(queueFrom(localStorage).length, 1, 'quarantined local work remains ordered in the queue');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].error.reason, 'missing_scope_cursor');
  assert.strictEqual(typeof events[0].error.loadServerScope, 'function');
}

async function testOwnedCursorClearsQuarantineOnCoalesce() {
  const { cloud, listeners, localStorage, fetchCalls } = makeVm({ online: false });
  const state = (client) => ({
    job: { ref: 'SWF-3', client, _fieldSync: { syncAnchorType: 'job', syncAnchorId: 'job-B' } },
  });
  await cloud.ghl.saveScope('job-B', state('Client B'), {
    baseScopeHash: 'cursor-owned-by-A',
    scopeCursorJobId: 'job-A',
    scopeCursorReconcileV1: true,
  });
  assert.strictEqual(queueFrom(localStorage)[0].meta.cursorQuarantined, true);
  await cloud.ghl.saveScope('job-B', state('Client B edited'), {
    baseScopeHash: 'cursor-owned-by-B',
    scopeCursorJobId: 'job-B',
    scopeCursorReconcileV1: true,
  });
  const queue = queueFrom(localStorage);
  assert.strictEqual(queue.length, 1, 'the two saves coalesce into one logical action');
  assert.strictEqual(queue[0].meta.cursorQuarantined, undefined, 'a provably owned cursor clears the earlier quarantine');
  assert.strictEqual(queue[0].meta.baseScopeHash, 'cursor-owned-by-B');
  listeners.online();
  await cloud.flushOfflineQueue();
  const writes = fetchCalls.filter((c) => String(c.url).includes('action=save_scope'));
  assert.strictEqual(writes.length, 1, 'the owned cursor flushes instead of stopping for reconcile');
  assert.strictEqual(queueFrom(localStorage).length, 0);
}

async function testConcurrentFlushIsSingleFlight() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { cloud, listeners, fetchCalls } = makeVm({
    online: false,
    fetch: async () => {
      await gate;
      return response(200, { job: { id: 'job-1', current_scope_hash: 'h2' } });
    },
  });
  await cloud.ghl.saveScope('job-1', { rev: 1 }, { baseScopeHash: 'h1' });
  listeners.online();
  const a = cloud.flushOfflineQueue();
  const b = cloud.flushOfflineQueue();
  release();
  await Promise.all([a, b]);

  const saveCalls = fetchCalls.filter((c) => String(c.url).includes('action=save_scope'));
  assert.strictEqual(saveCalls.length, 1, 'concurrent flush calls share one in-flight flush');
}

async function testCursorAdvancesLegacyDuplicateQueue() {
  const legacyQueue = [
    { type: 'save_job', opId: 'old-1', createdAt: '2026-07-10T00:00:00Z', jobId: 'job-1', scopeJson: { rev: 1 }, meta: { baseScopeHash: 'h1' } },
    { type: 'save_job', opId: 'old-2', createdAt: '2026-07-10T00:00:01Z', jobId: 'job-1', scopeJson: { rev: 2 }, meta: { baseScopeHash: 'h1' } },
  ];
  const { cloud, listeners, fetchCalls } = makeVm({
    online: false,
    storage: { sw_offline_queue: JSON.stringify(legacyQueue) },
    fetch: async (url, options, n) => response(200, {
      job: {
        id: 'job-1',
        current_scope_hash: n === 1 ? 'h2' : 'h3',
        current_scope_updated_at: '2026-07-10T00:00:0' + n + 'Z',
      },
    }),
  });
  listeners.online();
  await cloud.flushOfflineQueue();

  const saveCalls = fetchCalls.filter((c) => String(c.url).includes('action=save_scope'));
  assert.strictEqual(saveCalls.length, 2, 'legacy duplicate saves still flush in order');
  assert.strictEqual(JSON.parse(saveCalls[0].options.body).meta.baseScopeHash, 'h1');
  assert.strictEqual(JSON.parse(saveCalls[1].options.body).meta.baseScopeHash, 'h2', 'newer pending save receives returned cursor');
}

async function testUnauthenticatedSaveFallsBackToSharedKey() {
  // ba5d37e contract: a logged-in-but-session-evicted field user is never
  // hard-blocked. With no session but a healthy (200) backend, saveScope now
  // legitimately SUCCEEDS via the shared x-api-key fallback rather than queuing.
  const { cloud, localStorage, fetchCalls } = makeVm({ online: true, session: null });
  const saved = await cloud.ghl.saveScope('job-1', { rev: 1 }, { baseScopeHash: 'h1' });
  assert.notStrictEqual(saved && saved.queued, true, 'save is not queued — the shared key carries it through');
  assert.strictEqual(saved.id, 'job-1', 'saveScope returns the saved job');
  assert.strictEqual(queueFrom(localStorage).length, 0, 'nothing left pending on the iPad');

  const saveCalls = fetchCalls.filter((c) => String(c.url).includes('action=save_scope'));
  assert.strictEqual(saveCalls.length, 1, 'exactly one save fetch went out');
  const headers = saveCalls[0].options.headers || {};
  const body = JSON.parse(saveCalls[0].options.body);
  assert.strictEqual(body.meta.scopeCursorReconcileV1, undefined, 'a caller that did not advertise capability remains legacy');
  assert.strictEqual(
    headers['x-api-key'],
    '097a1160f9a8b2f517f4770ebbe88dca105a36f816ef728cc8724da25b2667dc',
    'save fetch carried the shared x-api-key when no session was present'
  );
  assert(!('Authorization' in headers), 'no bearer Authorization header when the session is missing');
}

async function testExpiredJwtResponseStaysQueued() {
  const { cloud, localStorage } = makeVm({
    online: true,
    fetch: async () => response(401, { error: 'Invalid Supabase user JWT', code: 'invalid_user_jwt' }),
  });
  const saved = await cloud.ghl.saveScope('job-1', { rev: 2 }, { baseScopeHash: 'h1' });
  assert.strictEqual(saved.queued, true, 'expired login response keeps the save pending on the iPad');
  assert.strictEqual(queueFrom(localStorage).length, 1);
  assert.deepStrictEqual(queueFrom(localStorage)[0].scopeJson, { rev: 2 });
  assert.strictEqual(queueFrom(localStorage)[0].meta.baseScopeHash, 'h1');
}

async function testServerErrorQueueIsLabelledDistinctly() {
  const { cloud, localStorage } = makeVm({
    online: true,
    fetch: async () => response(500, { error: 'edge function crashed' }),
  });
  const saved = await cloud.ghl.saveScope('job-1', { rev: 3 }, { baseScopeHash: 'h1' });
  assert.strictEqual(saved.queued, true, 'a 5xx still keeps the work on the iPad');
  assert.strictEqual(saved.queuedReason, 'server_error', 'a 5xx queue is not reported as a plain offline queue');
  assert.strictEqual(queueFrom(localStorage).length, 1);

  const offline = makeVm({ online: false });
  const offlineSave = await offline.cloud.ghl.saveScope('job-1', { rev: 4 }, { baseScopeHash: 'h1' });
  assert.strictEqual(offlineSave.queuedReason, 'offline', 'a genuine offline queue keeps the offline reason');
}

async function run() {
  const tests = [
    ['bearer headers without api key', testBearerHeaders],
    ['multiple offline edits coalesce to latest save on reconnect', testCoalescedLatestSaveFlushesOnce],
    ['transient network failure retains work', testTransientFlushFailureRetainsWorkAndEmitsFailure],
    ['scope conflict retains work', testConflictRetainsWorkAndEmitsConflict],
    ['typed save errors preserve recovery truth', testTypedScopeSaveErrorsPreserveRecoveryTruth],
    ['autosave conflict carries payload and stops unchanged retry', testAutosaveConflictCarriesPayloadAndStopsUnchangedRetry],
    ['transport retries back off and stop at five attempts', testTransportBackoffStopsAtFiveAttempts],
    ['a job swap mid-flight discards the retired save result', testJobSwapMidFlightDiscardsRetiredSaveResult],
    ['unowned capable cursor is quarantined before flush', testUnownedCapableCursorIsQuarantinedBeforeFlush],
    ['owned cursor clears an earlier quarantine on coalesce', testOwnedCursorClearsQuarantineOnCoalesce],
    ['concurrent flush is single-flight', testConcurrentFlushIsSingleFlight],
    ['returned cursor advances newer pending save', testCursorAdvancesLegacyDuplicateQueue],
    ['unauthenticated online save falls back to shared key', testUnauthenticatedSaveFallsBackToSharedKey],
    ['expired login response stays queued', testExpiredJwtResponseStaysQueued],
    ['server error queue is labelled distinctly', testServerErrorQueueIsLabelledDistinctly],
  ];
  for (const [name, fn] of tests) {
    await fn();
    console.log('PASS ' + name);
  }
  console.log('\nSummary: ' + tests.length + ' passed, 0 failed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
