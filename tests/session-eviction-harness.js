#!/usr/bin/env node
'use strict';

/**
 * Regression cover for the 2026-08-07 field report: after linking a large
 * existing job, creating a new job failed with
 *   "mint_fence_job requires an authenticated Supabase user"
 * while the header badge still showed a signed-in name.
 *
 * Cause: _cleanupStorage() (index.html) kept only its own app keys, so under
 * localStorage quota pressure it deleted the Supabase session key
 * sb-<ref>-auth-token. authorizedHeaders() (cloud.js) then silently downgraded
 * every request to the shared API key, and mint_fence_job is the one server
 * action that refuses the shared key.
 *
 * Runs the REAL index.html storage methods and the REAL cloud.js transport in a
 * stub browser. No network, no real Supabase.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cloudSource = fs.readFileSync(path.join(root, 'cloud.js'), 'utf8');

// The app's real Supabase project ref, so the storage key under test is the one
// supabase-js actually writes on the deployed origin.
const SUPABASE_URL = 'https://kevgrhcjxspbxgovpmfl.supabase.co';
const SESSION_KEY = 'sb-kevgrhcjxspbxgovpmfl-auth-token';

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

const QUOTA_BYTES = 5 * 1024 * 1024;
function makeLocalStorage() {
  const store = new Map();
  const used = () => {
    let n = 0;
    for (const [k, v] of store) n += k.length + v.length;
    return n;
  };
  return {
    _keys: () => Array.from(store.keys()),
    get length() { return store.size; },
    key(i) { return Array.from(store.keys())[i] || null; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) {
      v = String(v);
      const after = used() - (store.has(k) ? k.length + store.get(k).length : 0) + k.length + v.length;
      if (after > QUOTA_BYTES) {
        const e = new Error("Failed to execute 'setItem' on 'Storage': quota exceeded");
        e.name = 'QuotaExceededError';
        e.code = 22;
        throw e;
      }
      store.set(k, v);
    },
    removeItem(k) { store.delete(k); },
  };
}

function seedSession(localStorage) {
  const farFuture = Math.floor(Date.now() / 1000) + 6 * 3600;
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    access_token: 'user-jwt-token',
    refresh_token: 'refresh-token',
    token_type: 'bearer',
    expires_at: farFuture,
    user: { id: '11111111-1111-4111-8111-111111111111', email: 'scoper@example.test' },
  }));
}

function makeJob(sitePlanBytes) {
  return {
    clientFirstName: 'Trevor',
    clientLastName: 'Lawsons',
    phone: '+61416096745',
    address: '3 Maryport Way, Butler WA 6036',
    runs: [{ length: 12, panels: [{ type: 'colorbond' }] }],
    gates: [],
    checklist: { photos: [] },
    sitePlanImage: sitePlanBytes ? 'data:image/png;base64,' + 'A'.repeat(sitePlanBytes) : '',
    _fieldSync: {
      localDraftId: 'draft_b301e00a',
      syncState: 'local_dirty',
      lastLocalEditAt: new Date().toISOString(),
      pendingOps: [],
    },
  };
}

// Real index.html storage methods (_cleanupStorage, save, the checkpoint ladder)
// over a quota-limited localStorage.
function buildApp(localStorage, sitePlanBytes) {
  const app = {
    job: makeJob(sitePlanBytes),
    toasts: [],
    _markLocalEdited() {},
    _persistMediaManifest() {},
    _compressJobData() { return false; },
    _hasMeaningfulLocalDraft() { return true; },
    _ensureFieldSync() { return this.job._fieldSync; },
    showToast(msg) { this.toasts.push(msg); },
  };

  const sandbox = {
    window: { app },
    localStorage,
    console: { warn() {}, log() {} },
    Date, JSON, String, Object, Error, Number,
    updateSyncDot() {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const methods = [
    ['_cleanupStorage() {', '_cleanupStorage', ''],
    ['_checkpointPayloadJob(omitSitePlan)', '_checkpointPayloadJob', 'omitSitePlan'],
    ['_writeLocalDraftCheckpoint(localDraftId, source)', '_writeLocalDraftCheckpoint', 'localDraftId, source'],
    ['save() {', 'save', ''],
  ];
  for (const [signature, name, args] of methods) {
    vm.runInContext(`window.app.${name} = function(${args}) {${methodBody(signature)}};`, sandbox);
  }
  return { app, sandbox };
}

// Boots the REAL cloud.js against the same localStorage, with a supabase stub
// that re-reads storage on every getSession() call — the behaviour proven
// against the live supabase-js v2 bundle in the diagnosis report.
function bootCloud(localStorage, options) {
  options = options || {};
  let authCallback = null;
  const window = {
    location: { search: '', href: 'https://example.test/fence', pathname: '/fence' },
    addEventListener() {},
    removeEventListener() {},
    SUPABASE_URL,
    SUPABASE_ANON_KEY: 'anon-key',
    supabase: {
      createClient() {
        return {
          auth: {
            onAuthStateChange(cb) { authCallback = cb; },
            async getSession() {
              const raw = localStorage.getItem(SESSION_KEY);
              return { data: { session: raw ? JSON.parse(raw) : null } };
            },
            async refreshSession() {
              const raw = localStorage.getItem(SESSION_KEY);
              if (!raw) return { data: { session: null }, error: new Error('Auth session missing!') };
              return { data: { session: JSON.parse(raw) } };
            },
          },
          from() {
            const chain = { select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; }, update() { return this; }, single: async () => ({ data: null, error: null }) };
            return chain;
          },
        };
      },
    },
  };
  window.top = window;

  // Enough DOM for ui.showLoginModal: overlays are tracked through
  // body.appendChild/remove, and the modal's own controls resolve to inert stub
  // elements so its wiring code can run.
  const appended = [];
  const loginEls = {};
  const document = {
    title: 'Fence Tool',
    querySelector() { return null; },
    getElementById(id) {
      if (String(id).indexOf('sw-login-') !== 0) return null;
      return loginEls[id] || (loginEls[id] = {
        id, style: {}, value: '', textContent: '', disabled: false,
        addEventListener() {}, click() {},
      });
    },
    createElement(tag) { return { tagName: tag, style: {}, remove() { this._removed = true; } }; },
    body: { appendChild(el) { appended.push(el); } },
  };

  const requests = [];
  const context = {
    window,
    document,
    navigator: { onLine: true },
    localStorage,
    URLSearchParams,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(fn) { return 1; },
    clearTimeout() {}, setInterval, clearInterval,
    TextEncoder, Promise,
    async fetch(url, init) {
      requests.push({ url: String(url), headers: (init && init.headers) || {} });
      const body = options.fetchBody ? options.fetchBody(String(url)) : { profile: { id: 'u1', name: 'Scoper', role: 'estimator', org_id: 'org-1' } };
      return { ok: true, status: 200, json: async () => body };
    },
  };

  vm.runInNewContext(cloudSource, context, { filename: 'cloud.js' });
  const cloud = window.SECUREWORKS_CLOUD;
  assert(cloud, 'cloud.js should initialise with stubs');
  const fireAuthEvent = async (event) => {
    assert(authCallback, 'cloud.js registers an auth state listener');
    const raw = localStorage.getItem(SESSION_KEY);
    await authCallback(event, raw ? JSON.parse(raw) : null);
  };
  return { cloud, requests, appended, signIn: () => fireAuthEvent('SIGNED_IN'), fireAuthEvent };
}

// Runs the REAL sign-in badge IIFE from index.html against a stub header DOM, a
// stub integration layer and the real booted cloud.js, so the session-lost
// latch is exercised exactly as the browser wires it.
function bootBadge(cloud) {
  const marker = '// ── Prominent sign-in button (header) ──';
  const idx = indexSource.indexOf(marker);
  assert(idx >= 0, 'the sign-in badge script exists in index.html');
  const start = indexSource.indexOf('(function() {', idx);
  const block = sliceBlock(indexSource, start) + ')();';

  const btnClasses = new Set();
  const btn = {
    classList: {
      add: (c) => btnClasses.add(c),
      remove: (c) => btnClasses.delete(c),
      contains: (c) => btnClasses.has(c),
    },
    title: '',
  };
  const label = { textContent: '' };
  const calls = { login: 0, logout: 0, confirm: 0 };
  let renderCb = null;
  const integ = {
    isLoggedIn: () => true, // the cached in-memory _user keeps this true after eviction
    getUser: () => ({ name: 'Scoper' }),
    onAuthChange(cb) { renderCb = cb; cb(this.isLoggedIn(), this.getUser()); },
    login() { calls.login++; },
    logout() { calls.logout++; },
  };
  const windowObj = { _swIntegration: integ, SECUREWORKS_CLOUD: cloud };
  const context = {
    window: windowObj,
    document: {
      getElementById: (id) => (id === 'swSignInBtn' ? btn : id === 'swSignInLabel' ? label : null),
    },
    setTimeout() { return 1; },
    confirm() { calls.confirm++; return false; },
    console: { log() {}, warn() {} },
  };
  vm.createContext(context);
  vm.runInContext(block, context, { filename: 'index.html#swSignInBtn' });
  assert(typeof windowObj.swSignInClick === 'function', 'the badge script installs swSignInClick');
  return {
    btnClasses,
    label,
    calls,
    repaint: (loggedIn, user) => renderCb(loggedIn, user), // what updateUI() → _notifyAuthChange() does
    click: () => windowObj.swSignInClick(),
  };
}

let failures = 0;
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  PASS: ${label}`); })
    .catch((e) => { failures++; console.log(`  FAIL: ${label}\n        ${e.message}`); });
}

async function run() {
  console.log('[session-eviction] Supabase session survives the localStorage quota sweep');

  // 1. The scout's repro step 4, inverted: the sweep removed exactly the auth
  //    token and nothing else. It must now remove the junk and keep the session.
  await check('_cleanupStorage keeps the Supabase session and still removes junk', () => {
    const localStorage = makeLocalStorage();
    seedSession(localStorage);
    localStorage.setItem('fenceJob', '{"probe":"linked job"}');
    localStorage.setItem('fenceJob:20000000-job', '{"probe":"per-job save"}');
    localStorage.setItem('fenceJob_checkpoint_draft_b301e00a', '{"probe":"checkpoint"}');
    localStorage.setItem('sw_offline_queue', '[]');
    localStorage.setItem('sw_media_manifest_job-1', '{}');
    localStorage.setItem('orphan_old_draft', 'junk');
    localStorage.setItem('patioJob', 'junk from a sibling tool on the same origin');

    const { app } = buildApp(localStorage, 0);
    app._cleanupStorage();

    assert(localStorage.getItem(SESSION_KEY) !== null, 'the Supabase session key must survive the sweep');
    assert.strictEqual(localStorage.getItem('orphan_old_draft'), null, 'unrelated junk is still removed');
    assert.strictEqual(localStorage.getItem('patioJob'), null, 'another tool\'s key is still removed');
    assert(localStorage.getItem('fenceJob') !== null, 'the primary save is kept');
    assert(localStorage.getItem('fenceJob:20000000-job') !== null, 'per-job saves (fenceJob:<id>) are kept');
    assert(localStorage.getItem('fenceJob_checkpoint_draft_b301e00a') !== null, 'checkpoints are kept');
    assert(localStorage.getItem('sw_offline_queue') !== null, 'the offline queue is kept');
    assert(localStorage.getItem('sw_media_manifest_job-1') !== null, 'the media manifest is kept');
  });

  // 2a. save() QuotaExceeded recovery — the eviction point that has existed
  //     since the July JWT cutover.
  await check('save() quota recovery leaves authorizedHeaders sending a Bearer token', async () => {
    const localStorage = makeLocalStorage();
    seedSession(localStorage);
    // Fill the origin so the ordinary save cannot land and save() enters its
    // QuotaExceeded recovery branch, exactly as it does with a fat linked job.
    let used = 0;
    for (const k of localStorage._keys()) used += k.length + localStorage.getItem(k).length;
    localStorage.setItem('orphan_ballast', 'x'.repeat(QUOTA_BYTES - used - 'orphan_ballast'.length - 64));

    const { app } = buildApp(localStorage, 0);
    app.save();
    assert(app.toasts.some((t) => /Local storage full/.test(t)), 'the quota-recovery branch actually ran');
    assert(localStorage.getItem(SESSION_KEY) !== null, 'quota recovery must not evict the session');

    const { cloud } = bootCloud(localStorage);
    const headers = await cloud.authorizedHeaders();
    assert.strictEqual(headers['Authorization'], 'Bearer user-jwt-token', 'the request still carries the user JWT');
    assert(!headers['x-api-key'], 'no silent downgrade to the shared key');
  });

  // 2b. The checkpoint ladder's cleanupFirst attempt (#65) — the eviction point
  //     that sits inside the mint preflight and defeated re-login.
  await check('checkpoint cleanupFirst attempt leaves authorizedHeaders sending a Bearer token', async () => {
    const localStorage = makeLocalStorage();
    seedSession(localStorage);
    localStorage.setItem('orphan_old_draft', 'x'.repeat(1024 * 1024));

    const { app } = buildApp(localStorage, 3 * 1024 * 1024);
    app.save();
    const wrote = app._writeLocalDraftCheckpoint('draft_b301e00a', 'server_mint_preflight');
    assert.strictEqual(wrote, true, 'the checkpoint still lands after reclaiming space');
    assert.strictEqual(localStorage.getItem('orphan_old_draft'), null, 'the cleanupFirst attempt really ran');
    assert(localStorage.getItem(SESSION_KEY) !== null, 'the mint preflight must not evict the session');

    const { cloud } = bootCloud(localStorage);
    const headers = await cloud.authorizedHeaders();
    assert.strictEqual(headers['Authorization'], 'Bearer user-jwt-token', 'the mint request would carry the user JWT');
  });

  // 3. Membership pin: a future keep-list edit cannot silently drop 'sb-'.
  await check("keepPrefixes still contains the Supabase 'sb-' prefix", () => {
    const block = extractMethod('_cleanupStorage() {');
    const match = /var keepPrefixes = \[([^\]]*)\]/.exec(block);
    assert(match, '_cleanupStorage still declares keepPrefixes');
    const prefixes = match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert(prefixes.indexOf('sb-') !== -1,
      "keepPrefixes must contain 'sb-' or a quota sweep evicts the Supabase session again");
    assert(prefixes.indexOf('fenceJob:') !== -1,
      "keepPrefixes must contain 'fenceJob:' or a quota sweep evicts per-job saves (SCOPE-24)");
  });

  // 4. The mask: a lost session must be announced, not hidden behind the cached
  //    user, and mint must fail fast with honest copy.
  await check('a downgrade while signed in announces auth:session_lost', async () => {
    const localStorage = makeLocalStorage();
    seedSession(localStorage);
    const { cloud, signIn } = bootCloud(localStorage);
    await signIn();
    assert.strictEqual(cloud.auth.isLoggedIn(), true, 'the cached user is signed in');

    let lost = 0;
    cloud.on('auth:session_lost', () => { lost += 1; });

    localStorage.removeItem(SESSION_KEY); // any eviction source: quota sweep, iOS ITP
    const headers = await cloud.authorizedHeaders();
    assert(headers['x-api-key'], 'field sync still falls back to the shared key');
    assert.strictEqual(lost, 1, 'the lost session is announced so the badge can flip to signed-out');
  });

  await check('mintFenceJob fails fast with honest copy when the session is gone', async () => {
    const localStorage = makeLocalStorage();
    seedSession(localStorage);
    const { cloud, requests, signIn } = bootCloud(localStorage);
    await signIn();
    const before = requests.length;

    localStorage.removeItem(SESSION_KEY);
    let thrown = null;
    try {
      await cloud.ghl.mintFenceJob({ requestId: 'req-1', clientFirstName: 'Trevor' });
    } catch (e) { thrown = e; }

    assert(thrown, 'mint must not be attempted without a real session');
    assert(/sign-in expired on this device/i.test(thrown.message),
      `expected honest client-side copy, got: ${thrown && thrown.message}`);
    assert(!/authenticated Supabase user/i.test(thrown.message),
      'the server transport-vocabulary 401 must never reach the operator here');
    assert.strictEqual(thrown.code, 'user_jwt_required');
    assert.strictEqual(requests.length, before, 'no mint request is sent on the shared key');
  });

  // 5. The badge latch: session loss must stay visible until a REAL session
  //    proves recovery, and the click must route honestly while latched.
  await check('the session-lost badge latch survives a cached-user repaint', async () => {
    const localStorage = makeLocalStorage();
    seedSession(localStorage);
    const { cloud, signIn } = bootCloud(localStorage);
    await signIn();
    const badge = bootBadge(cloud);
    assert(badge.btnClasses.has('signed-in'), 'the badge starts signed-in');

    localStorage.removeItem(SESSION_KEY);
    await cloud.authorizedHeaders();
    assert(badge.btnClasses.has('signed-out'), 'session loss flips the badge to signed-out');

    badge.repaint(true, { name: 'Scoper' }); // any updateUI() with the cached user
    assert(badge.btnClasses.has('signed-out'), 'a cached-user repaint must not restore the signed-in badge');
    assert(!badge.btnClasses.has('signed-in'), 'the stale signed-in class stays gone');
    assert.strictEqual(badge.label.textContent, 'Sign in to link / sync');
  });

  await check('a successful Bearer attach unlatches the badge', async () => {
    const localStorage = makeLocalStorage();
    seedSession(localStorage);
    const { cloud, signIn } = bootCloud(localStorage);
    await signIn();
    const badge = bootBadge(cloud);

    localStorage.removeItem(SESSION_KEY);
    await cloud.authorizedHeaders();
    assert(badge.btnClasses.has('signed-out'), 'the latch is set');

    seedSession(localStorage); // the session came back (re-login, connectivity restored)
    const headers = await cloud.authorizedHeaders();
    assert.strictEqual(headers['Authorization'], 'Bearer user-jwt-token', 'the request carries the user JWT again');
    assert(badge.btnClasses.has('signed-in'), 'auth:session_restored re-renders the badge signed-in');
    badge.repaint(true, { name: 'Scoper' });
    assert(badge.btnClasses.has('signed-in'), 'later repaints render normally once unlatched');
  });

  await check('a TOKEN_REFRESHED auth event unlatches the badge', async () => {
    const localStorage = makeLocalStorage();
    seedSession(localStorage);
    const { cloud, signIn, fireAuthEvent } = bootCloud(localStorage);
    await signIn();
    const badge = bootBadge(cloud);

    localStorage.removeItem(SESSION_KEY);
    await cloud.authorizedHeaders();
    assert(badge.btnClasses.has('signed-out'), 'the latch is set');

    seedSession(localStorage);
    await fireAuthEvent('TOKEN_REFRESHED'); // supabase-js refreshed the session itself
    assert(badge.btnClasses.has('signed-in'), 'a refreshed session clears the false signed-out badge');
  });

  await check('clicking the latched badge routes to login, not the sign-out confirm', async () => {
    const localStorage = makeLocalStorage();
    seedSession(localStorage);
    const { cloud, signIn } = bootCloud(localStorage);
    await signIn();
    const badge = bootBadge(cloud);

    badge.click(); // signed in, no latch: the existing sign-out confirm branch
    assert.strictEqual(badge.calls.confirm, 1, 'the normal signed-in click still offers sign-out');
    assert.strictEqual(badge.calls.login, 0);

    localStorage.removeItem(SESSION_KEY);
    await cloud.authorizedHeaders();
    badge.click(); // isLoggedIn() is still true from the cached user
    assert.strictEqual(badge.calls.login, 1, 'the first tap after session loss opens the login modal');
    assert.strictEqual(badge.calls.confirm, 1, 'no "Sign out?" confirm while the latch is set');
    assert.strictEqual(badge.calls.logout, 0, 'the operator is never routed into sign-out');
  });

  await check('the login modal stays open while the latch is set, despite the cached user', async () => {
    const localStorage = makeLocalStorage();
    seedSession(localStorage);
    const { cloud, appended, signIn } = bootCloud(localStorage);
    await signIn();

    localStorage.removeItem(SESSION_KEY);
    await cloud.authorizedHeaders(); // sets the latch
    assert.strictEqual(cloud.auth.isLoggedIn(), true, 'the cached user still reads signed-in');

    cloud.ui.showLoginModal();
    const latched = appended.filter((el) => el.id === 'sw-login-overlay')[0];
    assert(latched, 'the login modal is appended');
    assert(!latched._removed, 'the modal must not self-close on the cached isLoggedIn() — that is the dead tap');

    seedSession(localStorage);
    await cloud.authorizedHeaders(); // Bearer re-attaches, latch clears
    cloud.ui.showLoginModal();
    const restored = appended.filter((el) => el.id === 'sw-login-overlay')[1];
    assert(restored._removed, 'with a real session the already-logged-in self-close still works');
  });

  const total = 11;
  console.log(`\nSummary: ${total - failures} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
