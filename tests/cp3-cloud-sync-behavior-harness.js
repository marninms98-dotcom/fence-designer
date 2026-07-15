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
    setTimeout,
    clearTimeout,
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
  return { cloud: window.SECUREWORKS_CLOUD, listeners, localStorage, fetchCalls, sessionRef };
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

async function run() {
  const tests = [
    ['bearer headers without api key', testBearerHeaders],
    ['multiple offline edits coalesce to latest save on reconnect', testCoalescedLatestSaveFlushesOnce],
    ['transient network failure retains work', testTransientFlushFailureRetainsWorkAndEmitsFailure],
    ['scope conflict retains work', testConflictRetainsWorkAndEmitsConflict],
    ['concurrent flush is single-flight', testConcurrentFlushIsSingleFlight],
    ['returned cursor advances newer pending save', testCursorAdvancesLegacyDuplicateQueue],
    ['unauthenticated online save falls back to shared key', testUnauthenticatedSaveFallsBackToSharedKey],
    ['expired login response stays queued', testExpiredJwtResponseStaysQueued],
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
