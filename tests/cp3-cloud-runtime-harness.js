#!/usr/bin/env node
'use strict';

/**
 * CP3 runtime harness for the cloud offline-save seam.
 * Runs cloud.js in a stub browser with navigator.onLine=false.
 * No network, no real Supabase/GHL.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'cloud.js'), 'utf8');

function makeStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key(i) { return Array.from(data.keys())[i] || null; },
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(k, String(v)); },
    removeItem(k) { data.delete(k); },
    clear() { data.clear(); },
  };
}

function makeSupabaseStub() {
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
          getSession: async () => ({ data: { session: null } }),
        },
        from() { return Object.create(chain); },
      };
    },
  };
}

async function run() {
  const localStorage = makeStorage();
  let fetchCalls = 0;
  let intervalFn = null;
  const window = {
    location: { search: '', href: 'https://example.test/fence', pathname: '/fence' },
    addEventListener() {},
    removeEventListener() {},
    supabase: makeSupabaseStub(),
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
  };
  window.top = window;

  const document = {
    title: 'Fence Tool',
    querySelector() { return null; },
    getElementById() { return null; },
    createElement(tag) { return { tagName: tag, style: {}, set textContent(v) { this._text = v; }, get textContent() { return this._text || ''; } }; },
    body: { appendChild() {} },
  };

  const context = {
    window,
    document,
    navigator: { onLine: false },
    localStorage,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    setInterval(fn) { intervalFn = fn; return 1; },
    clearInterval() {},
    fetch: async () => { fetchCalls += 1; throw new Error('network should not be called while offline'); },
    TextEncoder,
    Promise,
  };

  vm.runInNewContext(source, context, { filename: 'cloud.js' });
  const cloud = window.SECUREWORKS_CLOUD;
  assert(cloud, 'cloud module should initialise with stubs');
  assert.strictEqual(cloud.isOnline(), false, 'cloud starts offline');

  let queuedEvents = 0;
  let successEvents = 0;
  let remembered = 0;
  cloud.on('autosave:queued', () => { queuedEvents += 1; });
  cloud.on('autosave:success', () => { successEvents += 1; });
  window._swIntegration = {
    getScopeSaveCursor: () => ({ baseScopeHash: 'hash-loaded-on-ipad' }),
    _rememberScopeCursor: () => { remembered += 1; },
  };

  cloud.startAutoSave('job-1', () => ({
    job: {
      clientFirstName: '',
      clientLastName: '',
      phone: '+61 400 000 000',
      address: '1 Field Rd',
    },
  }), 1);
  assert(intervalFn, 'startAutoSave should register an interval callback');
  await intervalFn();

  assert.strictEqual(fetchCalls, 0, 'offline autosave must not call fetch');
  assert.strictEqual(queuedEvents, 1, 'offline autosave emits queued event');
  assert.strictEqual(successEvents, 0, 'offline autosave must not emit cloud success');
  assert.strictEqual(remembered, 0, 'queued save must not advance server cursor');

  const queue = JSON.parse(localStorage.getItem('sw_offline_queue'));
  assert.strictEqual(queue.length, 1, 'one save_job op queued');
  assert.strictEqual(queue[0].type, 'save_job');
  assert.strictEqual(queue[0].meta.baseScopeHash, 'hash-loaded-on-ipad');
  assert(!('_flushAttempt' in queue[0].meta), 'queued meta must not persist flush attempt flag');

  const journal = JSON.parse(localStorage.getItem('sw_offline_journal'));
  assert.strictEqual(journal.length, 1, 'one journal entry written');
  assert.strictEqual(journal[0].status, 'queued');

  console.log('CP3 cloud runtime harness');
  console.log('PASS phone-only offline autosave queues local save without cloud success');
  console.log('PASS queued save preserves baseScopeHash and journal entry');
  console.log('\nSummary: 2 passed, 0 failed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
